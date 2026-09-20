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

const MINT = "DTRmPLZPfQRRRVwyZFuSxUhvnj9RHgDqFjQXx6vUpump";
const POOL = "3LnLWicgYKDipE4nDUNS9BuLeXJZTB8jYqbGVcyhVHnr";
const DEV = "BXrU6jcjtZnar27jfWCXXhr9EqQGcFvyfnpC9cRjYLmC";
// Constant ATA address. The account gets created and closed repeatedly (the dev
// burned out and closed it on 2026-08-01), but the address is derived from
// (owner, mint, program) so signatures stay indexed against it either way.
// Must stay in agreement with DEV_ATA_ADDR in index.html and scripts/scan.mjs.
const DEV_ATA = "4dTEzL1XdsWuzwFwXyzsxNKBUCqH8Nsac9CRGSfpgVGw";
const BOOST = "BGVtkQcLUWtsm6FeZQrk12yXyDDYj9PhvmytYDKcDv5v";
const DISTRIBUTOR = "7D2dJwtSH4dmM19MzJk1ms9kH5gmpbRbGaCXURmVdhQc";

const DECIMALS = 6;
const WSOL = "So11111111111111111111111111111111111111112";
const SOL_FEE_FLOOR = 0.0005;
const ROUND_GAP = 600;
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
// times a week, so they can sit longer and cost almost nothing.
const TTL = { buys: 15, engine: 45, rewards: 45 };

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
// A buy is the pool sending BULLCEMBER out to someone. Same rule as
// buysViaEnhancedApi() in scripts/update-herd.mjs, so the shape the browser gets
// here is interchangeable with data/buys.json.
async function getBuys(env) {
  const txns = await enhanced(env, POOL, 40);
  const buys = [];
  for (const tx of txns) {
    const tt = (tx.tokenTransfers || []).find((x) => x.mint === MINT && x.fromUserAccount === POOL);
    if (!tt || !tt.tokenAmount) continue;
    buys.push({ sig: tx.signature, buyer: tt.toUserAccount, tokens: tt.tokenAmount, ts: tx.timestamp });
    if (buys.length >= WANT_BUYS) break;
  }
  return { updatedAt: new Date().toISOString(), buys };
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

// Recent classified engine events newer than `since`. Classification is a port of
// scripts/scan.mjs — it has to agree with it exactly, because the browser merges
// what comes back on top of the totals that script already published.
//
// In steady state `since` is the newest event in data/stats.json, so this loop
// fetches zero or one transaction. The signature pages are the only fixed cost.
async function getEngine(env, since) {
  const sigs = new Map();
  for (const acct of [DEV_ATA, BOOST]) {
    const page = await rpc(env, "getSignaturesForAddress", [acct, { limit: 25 }]).catch(() => []);
    for (const s of page || []) {
      if (s.err || !s.blockTime || s.blockTime <= since) continue;
      sigs.set(s.signature, true);
    }
  }

  const events = [];
  // Hard cap: a browser-facing endpoint must never fan out unboundedly, even if
  // `since` arrives as 0 from a client with no baseline.
  for (const sig of [...sigs.keys()].slice(0, 12)) {
    const tx = await rpc(env, "getTransaction", [
      sig,
      { maxSupportedTransactionVersion: 0, encoding: "jsonParsed" },
    ]).catch(() => null);
    if (!tx || tx.meta?.err) continue;

    const time = tx.blockTime;
    const pre = tx.meta?.preTokenBalances;
    const post = tx.meta?.postTokenBalances;
    const devDelta = ownerBal(post, DEV) - ownerBal(pre, DEV);
    const burned = burnAmount(tx);
    const solD = solDelta(tx, DEV);
    const boostSol = boostSpend(tx, pre, post);

    if (burned > 0.0001) events.push({ type: "burn", time, bull: Math.round(burned), sig });

    if (devDelta > 0.0001 && solD < -SOL_FEE_FLOOR) {
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

// ---------------------------------------------------------------- rewards ---
// Payout rounds newer than `since`, bucketed the same way scripts/update-rewards.mjs
// buckets them. Returns only the delta; the browser adds it to the cumulative totals
// in data/rewards.json rather than trying to recompute all-time state here.
async function getRewards(env, since) {
  const txns = await enhanced(env, DISTRIBUTOR, 60);

  const rounds = [];
  let collected = 0;
  let overhead = 0;

  // Oldest first so rounds bucket in chronological order.
  for (const tx of txns.slice().reverse()) {
    if (!tx.timestamp || tx.timestamp <= since) continue;
    const native = tx.nativeTransfers || [];
    const outs = native.filter((n) => n.fromUserAccount === DISTRIBUTOR);

    for (const n of native.filter((n) => n.toUserAccount === DISTRIBUTOR)) collected += n.amount;
    if (outs.length === 0) continue;

    // pump.fun's flat per-round fee ships alone in its own transaction; holder
    // payouts always arrive as a fan-out batch. Splitting on batch size keeps the
    // headline "paid to holders" figure honest without hardcoding an address.
    if (outs.length === 1) {
      // ...but that fee lands a few seconds AFTER the round it pays for, while
      // `since` is the round's own timestamp. So the trailing fee of the round the
      // caller already has sits just past the cutoff and would be handed back as a
      // delta the baseline has already counted — double-billing the overhead and
      // under-reporting pending by the same amount.
      //
      // Transactions are walked oldest-first, so a fee arriving before any new round
      // has been bucketed must belong to the round at `since`. Once a new round IS
      // open, the fee pays for THAT round and has to count — which is why this tests
      // rounds.length rather than the timestamp alone.
      if (rounds.length === 0 && since && tx.timestamp - since <= ROUND_GAP) continue;
      overhead += outs[0].amount;
      continue;
    }

    const last = rounds[rounds.length - 1];
    const bucket =
      last && tx.timestamp - last.time <= ROUND_GAP
        ? last
        : (rounds.push({ time: tx.timestamp, lamports: 0, payees: [], sig: tx.signature }),
           rounds[rounds.length - 1]);

    const seen = new Set(bucket.payees);
    for (const n of outs) { bucket.lamports += n.amount; seen.add(n.toUserAccount); }
    bucket.time = Math.max(bucket.time, tx.timestamp);
    bucket.payees = [...seen];
  }

  return {
    updatedAt: new Date().toISOString(),
    since,
    rounds: rounds
      .map((r) => ({ time: r.time, sol: +(r.lamports / 1e9).toFixed(6), wallets: r.payees.length, sig: r.sig }))
      .sort((a, b) => b.time - a.time),
    collectedSol: +(collected / 1e9).toFixed(6),
    overheadSol: +(overhead / 1e9).toFixed(6),
  };
}

// ------------------------------------------------------------------ router ---
export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    if (request.method === "OPTIONS") return new Response(null, { headers: cors(origin) });
    if (request.method !== "GET") return new Response("method not allowed", { status: 405 });

    const url = new URL(request.url);
    const route = url.pathname.replace(/\/+$/, "").split("/").pop();
    if (!TTL[route]) return new Response("not found", { status: 404, headers: cors(origin) });
    if (!env.HELIUS_KEY) return new Response("worker not configured", { status: 503, headers: cors(origin) });

    // `since` is clamped, not trusted: it comes from the visitor's baseline file and
    // a bogus value would otherwise widen the upstream fan-out.
    const raw = Number(url.searchParams.get("since") || 0);
    const since = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;

    // Cache on a normalized key so one visitor's cache-buster query can't force a
    // miss for everyone else — that would defeat the whole point of the edge cache.
    const key = new Request(`${url.origin}/${route}?since=${since}`, { method: "GET" });
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
        : await getRewards(env, since);

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
