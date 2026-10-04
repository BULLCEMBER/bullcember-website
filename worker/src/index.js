// BULLCEMBER live-data proxy.
//
// WHY THIS EXISTS: the site's numbers used to come only from data/*.json, refreshed
// by a cron that GitHub actually delivers about 7% of the time (median gap ~3.5h).
// The obvious fix — let the browser read chain directly — is exactly what took the
// site down on 2026-08-25: the Helius key was hardcoded in index.html, anyone could
// lift it, and credit burn scaled with traffic until the quota hit "max usage reached".
//
// So the key lives here as a secret binding and never reaches a browser, and every
// response is cached at the edge. That second part is the one that matters: with
// s-maxage below, a thousand concurrent visitors collapse into ~3 upstream calls a
// minute. Credit burn is bounded by TIME, not by traffic — which is the property the
// 2026-08-25 setup lacked.
//
// The browser still paints data/*.json first and treats everything here as a
// best-effort top-up, so if this Worker is down, unreachable, or never deployed,
// the site renders exactly as it did before.

const MINT = "EUpN7RE7YLXmtF4FDuE4j7hqDhoogGqnbnKCcq3Upump";
// pump.fun bonding curve PDA. Pre-graduation every trade goes through it.
const CURVE = "CrFq4zNsEAEZqdmJWy9aWarZDSb1FLx64RbfUW7mVbvJ";
// The PumpSwap pool pump.fun reports for this mint. It does not exist until the
// curve graduates; reading it before then just returns no transactions.
const POOL = "598LgNU99ZQmPCNkfdF93eEmSkvtshgPPjnQ2ebatuWZ";
// This launch is quoted in PUMP, not SOL: the curve takes PUMP in and creator
// fees are paid out in PUMP. A buyback therefore spends PUMP, not lamports.
const PUMP = "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn";
// The dev has also bought back straight out of USDC (37Y8iyDR..., 155 USDC).
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const DEV = "BXrU6jcjtZnar27jfWCXXhr9EqQGcFvyfnpC9cRjYLmC";
// Constant ATA address. The account can be created and closed repeatedly, but the
// address is derived from (owner, mint, program) so signatures stay indexed
// against it either way. Must stay in agreement with DEV_ATA_ADDR in scripts/scan.mjs.
const DEV_ATA = "9eFXRtXE5FoPFmUMPWkjf7kS6WrUihNGyVBXsUhHLbcS";
const BOOST = "BGVtkQcLUWtsm6FeZQrk12yXyDDYj9PhvmytYDKcDv5v";

const DECIMALS = 6;
const WSOL = "So11111111111111111111111111111111111111112";
const SOL_FEE_FLOOR = 0.0005;
const PUMP_FLOOR = 1; // ignore PUMP dust when tagging a buyback
const USDC_FLOOR = 0.01;
const WANT_BUYS = 12;

// 4321 is the port in .claude/launch.json, so the local preview can exercise the
// real Worker before anything is pushed. An origin that is not on this list still
// gets a response, just stamped with the canonical origin — so the browser blocks
// it. That is the intent: this proxy is for bullcember.net, not for anyone's page.
const ALLOWED_ORIGINS = [
  "https://bullcember.net",
  "https://www.bullcember.net",
  "http://localhost:4321",
  "http://127.0.0.1:4321",
];

// Per-route edge TTL. Buys move constantly; the engine and payout rounds move a few
// times a week, so they can sit longer and cost almost nothing. Total volume is a
// lifetime cumulative figure that the page only ever refreshes once a day, so an
// hour at the edge is generous — and it caps Birdeye at 24 calls a day for the
// entire internet, which is the whole point of putting it behind here.
const CACHE_V = 2; // bump when a route's output changes; see the cache key below
const TTL = { buys: 15, engine: 45, volume: 3600, ohlcv: 120, curve: 30 };
// Chart timeframes the page can ask for. Anything else is a 400, not a Birdeye call.
const OHLCV_TF = {
  "1H": 30 * 24 * 3600, // last 30 days of hourly candles
  "4H": null,           // from launch
  "1D": null,
};
const LAUNCH_TS = 1791061000; // a little before the 2026-10-03 launch

const cors = (origin) => ({
  "access-control-allow-origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type",
  "vary": "Origin",
});

const json = (body, origin, ttl) =>
  new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      // s-maxage drives the edge cache (shared across all visitors); max-age keeps
      // a single browser from re-asking inside the same window.
      "cache-control": `public, max-age=${Math.ceil(ttl / 2)}, s-maxage=${ttl}`,
      ...cors(origin),
    },
  });

// ---------------------------------------------------------------- upstream ---
async function rpc(env, method, params) {
  const r = await fetch(`https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_KEY}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!r.ok) throw new Error(`rpc ${method} ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

async function enhanced(env, address, limit = 40) {
  const r = await fetch(
    `https://api.helius.xyz/v0/addresses/${address}/transactions?api-key=${env.HELIUS_KEY}&limit=${limit}`
  );
  if (!r.ok) throw new Error(`enhanced ${r.status}`);
  const j = await r.json();
  if (!Array.isArray(j)) throw new Error("unexpected enhanced payload");
  return j;
}

// ------------------------------------------------------------------- buys ---
// A buy is the curve (or, after graduation, the pool) sending BULLCEMBER out to
// someone. Same rule as buysViaEnhancedApi() in scripts/update-herd.mjs, so the
// shape the browser gets here is interchangeable with data/buys.json.
// Both venues are read so the feed keeps working across graduation with no edit.
async function getBuys(env) {
  const venues = [CURVE, POOL];
  const pages = await Promise.all(venues.map((v) => enhanced(env, v, 40)));
  const buys = [];
  const seen = new Set();
  for (const tx of pages.flat()) {
    if (seen.has(tx.signature)) continue;
    const tt = (tx.tokenTransfers || []).find((x) => x.mint === MINT && venues.includes(x.fromUserAccount));
    if (!tt || !tt.tokenAmount) continue;
    seen.add(tx.signature);
    buys.push({ sig: tx.signature, buyer: tt.toUserAccount, tokens: tt.tokenAmount, ts: tx.timestamp });
  }
  buys.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return { updatedAt: new Date().toISOString(), buys: buys.slice(0, WANT_BUYS) };
}

// ------------------------------------------------------------------ curve ---
// Bonding-curve progress. The browser may not read chain itself (see the header),
// so it asks here. Layout: 8-byte discriminator, then u64 virtual_token,
// virtual_quote, real_token, real_quote, total_supply, then a `complete` bool.
const INIT_REAL_TOKEN = 793_100_000_000_000n; // real token reserve at launch (793.1M * 1e6)
async function getCurve(env) {
  const info = await rpc(env, "getAccountInfo", [CURVE, { encoding: "base64" }]);
  // The PDA is closed at graduation, so a missing account means it bonded.
  if (!info?.value) return { updatedAt: new Date().toISOString(), complete: true, pct: 100, quote: 0 };
  const b = Uint8Array.from(atob(info.value.data[0]), (c) => c.charCodeAt(0));
  const dv = new DataView(b.buffer);
  const realToken = dv.getBigUint64(24, true);
  const realQuote = dv.getBigUint64(32, true);
  const complete = b[48] === 1;
  const sold = INIT_REAL_TOKEN - realToken;
  const pct = complete ? 100 : Math.max(0, Math.min(100, Number((sold * 10000n) / INIT_REAL_TOKEN) / 100));
  return { updatedAt: new Date().toISOString(), complete, pct, quote: Number(realQuote) / 10 ** DECIMALS };
}

// ----------------------------------------------------------------- engine ---
const ownerMintBal = (list, owner, mint) => {
  const e = (list || []).find((b) => b.owner === owner && b.mint === mint);
  return e ? Number(e.uiTokenAmount.uiAmount || 0) : 0;
};
const ownerBal = (list, owner) => ownerMintBal(list, owner, MINT);

function solDelta(tx, who) {
  const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === "string" ? k : k.pubkey));
  const i = keys.indexOf(who);
  if (i < 0 || !tx.meta) return 0;
  return (tx.meta.postBalances[i] - tx.meta.preBalances[i]) / 1e9;
}

// What the dev paid in tokens, if anything. Net per mint across the transaction,
// because a SOL route passes PUMP through the wallet and nets to ~0. Same rule as
// spentTokens() in scripts/scan.mjs.
function spentTokens(pre, post) {
  const pumpD = ownerMintBal(post, DEV, PUMP) - ownerMintBal(pre, DEV, PUMP);
  const usdcD = ownerMintBal(post, DEV, USDC) - ownerMintBal(pre, DEV, USDC);
  const out = {};
  if (pumpD < -PUMP_FLOOR) out.pump = Math.round(-pumpD);
  if (usdcD < -USDC_FLOOR) out.usdc = +(-usdcD).toFixed(2);
  return Object.keys(out).length ? out : null;
}

// The boost vault funds buys from a wrapped-SOL account, so its native lamport
// balance barely moves and solDelta() reads ~0 — the spend only shows as a drop in
// its WSOL balance. Count both so either funding path is caught.
function boostSpend(tx, pre, post) {
  return -(ownerMintBal(post, BOOST, WSOL) - ownerMintBal(pre, BOOST, WSOL) + solDelta(tx, BOOST));
}

function burnAmount(tx) {
  let burned = 0;
  const walk = (instrs) =>
    (instrs || []).forEach((ix) => {
      const p = ix.parsed;
      if (p && (p.type === "burn" || p.type === "burnChecked") && p.info && p.info.mint === MINT) {
        burned += p.info.tokenAmount
          ? Number(p.info.tokenAmount.uiAmount)
          : Number(p.info.amount) / 10 ** DECIMALS;
      }
    });
  walk(tx.transaction.message.instructions);
  (tx.meta?.innerInstructions || []).forEach((ii) => walk(ii.instructions));
  return burned;
}

// Recent classified engine events at or after `since`. Classification is a port of
// scripts/scan.mjs — it has to agree with it exactly, because the browser merges
// what comes back on top of the totals that script already published.
//
// `since` is the newest event in data/stats.json. The boundary second is re-read,
// same as scan.mjs: two engine transactions can share it, and stopping on equality
// dropped the unsaved one until the next stats run. The page dedupes type+sig
// before adding, so returning the already-saved sibling does not double-count.
async function getEngine(env, since) {
  const sigs = new Map();
  for (const acct of [DEV_ATA, BOOST]) {
    // A failed page used to become []. The other account's events would still be
    // returned, and the browser would treat that partial list as the whole delta.
    let before;
    for (let page = 0; page < 4; page++) {
      const opts = { limit: 25, ...(before ? { before } : {}) };
      const batch = await rpc(env, "getSignaturesForAddress", [acct, opts]);
      if (!batch || !batch.length) break;
      let hitOld = false;
      for (const s of batch) {
        if (s.err || !s.blockTime) continue;
        // `<`, not `<=`. See the comment on getEngine. scan.mjs uses the same test.
        if (since && s.blockTime < since) { hitOld = true; break; }
        sigs.set(s.signature, true);
      }
      if (hitOld || batch.length < 25) break;
      before = batch[batch.length - 1].signature;
    }
  }

  const pending = [...sigs.keys()];
  // A browser-facing endpoint must never fan out unboundedly, even if `since`
  // arrives as 0. Past this cap, fail the request so the page keeps its baseline
  // instead of painting a silently shortened delta.
  if (pending.length > 40) throw new Error(`engine window truncated: ${pending.length} signatures`);

  const events = [];
  for (const sig of pending) {
    const tx = await rpc(env, "getTransaction", [
      sig,
      { maxSupportedTransactionVersion: 0, encoding: "jsonParsed" },
    ]);
    if (!tx) throw new Error(`getTransaction returned nothing for ${sig}`);
    if (tx.meta?.err) continue;

    const time = tx.blockTime;
    const pre = tx.meta?.preTokenBalances;
    const post = tx.meta?.postTokenBalances;
    const devDelta = ownerBal(post, DEV) - ownerBal(pre, DEV);
    const burned = burnAmount(tx);
    const solD = solDelta(tx, DEV);
    const tokenSpend = spentTokens(pre, post);
    const boostSol = boostSpend(tx, pre, post);

    if (burned > 0.0001) events.push({ type: "burn", time, bull: Math.round(burned), sig });

    // Token spends are tested first. A PUMP- or USDC-funded buy still moves ~0.0013
    // SOL of fees and rent, which would otherwise pass the SOL test as a fake SOL buy.
    const isBuy = devDelta > 0.0001;
    if (isBuy && tokenSpend) {
      events.push({ type: "buyback", time, bull: Math.round(devDelta), ...tokenSpend, sig });
    } else if (isBuy && solD < -SOL_FEE_FLOOR) {
      events.push({ type: "buyback", time, bull: Math.round(devDelta), sol: +(-solD).toFixed(4), sig });
    } else if (burned > 0.0001 && boostSol > SOL_FEE_FLOOR) {
      // A boost buy never lands in any balance — bought and burned atomically, so
      // the burned amount IS the amount bought back. This deliberately emits a
      // second event on a signature that already produced a burn above, which is
      // why the feed dedupes on type+sig rather than sig alone.
      events.push({ type: "buyback", time, bull: Math.round(burned), sol: +boostSol.toFixed(4), sig });
    }
  }

  events.sort((a, b) => (b.time || 0) - (a.time || 0));
  return { updatedAt: new Date().toISOString(), since, events };
}

// ------------------------------------------------------------------ router ---
// Lifetime traded volume, summed across the full daily OHLCV history.
//
// The only route here that does not touch Helius. It fronts Birdeye, whose key sat
// in index.html where anyone could lift it — the same mistake that took the site
// down on 2026-08-25 with the Helius key. Worse, the page summed the history by
// paging the endpoint several times back to back on every load, which is precisely
// the shape that trips a free-tier rate limit: a 429 left a dash on screen until
// the next UTC midnight.
//
// Behind here the key is a secret binding and the 1h TTL above means traffic cannot
// drive the call count at all.
async function birdeyeCandles(env, type, from) {
  const now = Math.floor(Date.now() / 1000);
  const items = [];
  // Birdeye returns at most 1000 candles per page. The page cap exists only so a
  // malformed response cannot spin forever.
  for (let page = 0; page < 8 && from < now; page++) {
    const r = await fetch(
      `https://public-api.birdeye.so/defi/ohlcv?address=${MINT}&type=${type}&time_from=${from}&time_to=${now}`,
      { headers: { "X-API-KEY": env.BIRDEYE_KEY, "x-chain": "solana" } },
    );
    // Must throw rather than fall through: the old client code treated a 429 as
    // "no items", which silently produced a zero and never retried.
    if (!r.ok) throw new Error(`birdeye ${r.status}`);
    const batch = (await r.json())?.data?.items || [];
    if (!batch.length) break;
    items.push(...batch);
    if (batch.length < 1000) break;
    from = Math.max(...batch.map((i) => i.unixTime)) + 1;
  }
  return items;
}

//
// Hourly, not daily. Each candle is valued at its close, and a daily close on a
// day that ran up and dumped prices the whole day's volume at the bottom: on
// launch day 1D candles summed to $4.8K while ~$19.8K had actually traded.
// Hourly candles came to $17.7K. 1000 candles a page x 8 pages covers ~11 months.
async function getVolume(env) {
  const items = await birdeyeCandles(env, "1H", LAUNCH_TS);
  let total = 0;
  for (const it of items) total += (Number(it.v) || 0) * (Number(it.c) || 0);
  // Lifetime volume can never be less than the last 24h. DexScreener reports
  // that in USD directly and needs no key, so it floors any Birdeye undercount.
  try {
    const r = await fetch(`https://api.dexscreener.com/token-pairs/v1/solana/${MINT}`);
    const pairs = r.ok ? await r.json() : [];
    const h24 = (Array.isArray(pairs) ? pairs : []).reduce((s, p) => s + (Number(p.volume?.h24) || 0), 0);
    total = Math.max(total, h24);
  } catch { /* the Birdeye figure stands on its own */ }
  if (!(total > 0)) throw new Error("birdeye returned no volume");
  return { updatedAt: new Date().toISOString(), totalUsd: total };
}

// Candles for the page chart. The browser used to call Birdeye with a key that
// shipped in index.html. Same secret as /volume, different timeframe.
async function getOhlcv(env, tf) {
  const window = OHLCV_TF[tf];
  const now = Math.floor(Date.now() / 1000);
  const from = window ? now - window : LAUNCH_TS;
  const items = await birdeyeCandles(env, tf, from);
  const candles = items
    .sort((a, b) => a.unixTime - b.unixTime)
    .filter((c, i, arr) => i === 0 || c.unixTime !== arr[i - 1].unixTime)
    .map(({ unixTime, o, h, l, c, v }) => ({
      time: unixTime,
      open: o,
      high: h,
      low: l,
      close: c,
      volume: (Number(v) || 0) * (Number(c) || 0),
    }));
  if (!candles.length) throw new Error("birdeye returned no candles");
  return { updatedAt: new Date().toISOString(), tf, candles };
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    if (request.method === "OPTIONS") return new Response(null, { headers: cors(origin) });
    if (request.method !== "GET") return new Response("method not allowed", { status: 405 });

    const url = new URL(request.url);
    const route = url.pathname.replace(/\/+$/, "").split("/").pop();
    if (!TTL[route]) return new Response("not found", { status: 404, headers: cors(origin) });
    // /volume and /ohlcv front Birdeye. Everything else fronts Helius. Gate per
    // route, so a missing Birdeye secret cannot take down buys, engine, or curve.
    const needs = route === "volume" || route === "ohlcv" ? "BIRDEYE_KEY" : "HELIUS_KEY";
    if (!env[needs]) {
      return new Response(`worker not configured: ${needs}`, { status: 503, headers: cors(origin) });
    }

    const tf = url.searchParams.get("tf") || "1H";
    if (route === "ohlcv" && !Object.prototype.hasOwnProperty.call(OHLCV_TF, tf)) {
      return new Response("bad timeframe", { status: 400, headers: cors(origin) });
    }

    // `since` is clamped, not trusted: it comes from the visitor's baseline file and
    // a bogus value would otherwise widen the upstream fan-out.
    const raw = Number(url.searchParams.get("since") || 0);
    const since = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;

    // Cache on a normalized key so one visitor's cache-buster query can't force a
    // miss for everyone else — that would defeat the whole point of the edge cache.
    // /ohlcv must keep the timeframe in the key, or 1H and 1D would share a body.
    // CACHE_V is in the key so a deploy that changes what a route computes does
    // not keep serving the previous version's body for up to a full TTL.
    const key = new Request(
      route === "ohlcv" ? `${url.origin}/ohlcv?tf=${tf}&v=${CACHE_V}` : `${url.origin}/${route}?since=${since}&v=${CACHE_V}`,
      { method: "GET" },
    );
    const cache = caches.default;
    const hit = await cache.match(key);
    if (hit) {
      const out = new Response(hit.body, hit);
      Object.entries(cors(origin)).forEach(([k, v]) => out.headers.set(k, v));
      out.headers.set("x-bull-cache", "HIT");
      return out;
    }

    try {
      const body =
        route === "buys" ? await getBuys(env)
        : route === "engine" ? await getEngine(env, since)
        : route === "volume" ? await getVolume(env)
        : route === "ohlcv" ? await getOhlcv(env, tf)
        : await getCurve(env);

      const res = json(body, origin, TTL[route]);
      // Store a copy without the per-origin CORS header, so the cached body is
      // origin-neutral and the next visitor gets their own header stamped on.
      const store = new Response(res.clone().body, { headers: Object.fromEntries(res.headers) });
      store.headers.delete("access-control-allow-origin");
      ctx.waitUntil(cache.put(key, store));
      res.headers.set("x-bull-cache", "MISS");
      return res;
    } catch (e) {
      // Never cache a failure: the browser already has a baseline on screen, so a
      // short error is strictly better than pinning a bad response for 45s.
      return new Response(JSON.stringify({ error: String(e.message || e) }), {
        status: 502,
        headers: { "content-type": "application/json", "cache-control": "no-store", ...cors(origin) },
      });
    }
  },
};
