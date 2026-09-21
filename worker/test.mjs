// Exercises worker/src/index.js with a stubbed fetch + caches, so the routing,
// clamping, caching and chain-classification logic can be checked without a key.
import worker from "./src/index.js";

const MINT = "DTRmPLZPfQRRRVwyZFuSxUhvnj9RHgDqFjQXx6vUpump";
const POOL = "3LnLWicgYKDipE4nDUNS9BuLeXJZTB8jYqbGVcyhVHnr";
const DEV = "BXrU6jcjtZnar27jfWCXXhr9EqQGcFvyfnpC9cRjYLmC";
const DEV_ATA = "4dTEzL1XdsWuzwFwXyzsxNKBUCqH8Nsac9CRGSfpgVGw";
const BOOST = "BGVtkQcLUWtsm6FeZQrk12yXyDDYj9PhvmytYDKcDv5v";
const DIST = "7D2dJwtSH4dmM19MzJk1ms9kH5gmpbRbGaCXURmVdhQc";
const WSOL = "So11111111111111111111111111111111111111112";

const T = 1789900000;
let upstreamCalls = 0;

// --- a pump.fun boost tx: buys and burns atomically under one signature --------
const boostTx = {
  blockTime: T + 100,
  transaction: { message: {
    accountKeys: [{ pubkey: BOOST }, { pubkey: DEV }],
    instructions: [{ parsed: { type: "burn", info: { mint: MINT, amount: "500000000000" } } }],
  } },
  meta: {
    err: null,
    preBalances: [1e9, 1e9], postBalances: [1e9, 1e9], // native barely moves; spend is in WSOL
    innerInstructions: [],
    preTokenBalances:  [{ owner: BOOST, mint: WSOL, uiTokenAmount: { uiAmount: 1.0 } }],
    postTokenBalances: [{ owner: BOOST, mint: WSOL, uiTokenAmount: { uiAmount: 0.75 } }],
  },
};

// --- a plain dev buyback: BULLCEMBER in, SOL out ------------------------------
const devTx = {
  blockTime: T + 200,
  transaction: { message: { accountKeys: [{ pubkey: DEV }, { pubkey: POOL }], instructions: [] } },
  meta: {
    err: null,
    preBalances: [1e9, 0], postBalances: [1e9 - 1e8, 0], // dev spends 0.1 SOL
    innerInstructions: [],
    preTokenBalances:  [{ owner: DEV, mint: MINT, uiTokenAmount: { uiAmount: 0 } }],
    postTokenBalances: [{ owner: DEV, mint: MINT, uiTokenAmount: { uiAmount: 272065 } }],
  },
};

globalThis.fetch = async (url, opts) => {
  upstreamCalls++;
  const u = String(url);
  if (u.includes("helius-rpc.com")) {
    const { method, params } = JSON.parse(opts.body);
    if (method === "getSignaturesForAddress") {
      const acct = params[0];
      const sigs = acct === DEV_ATA
        ? [{ signature: "DEVSIG", blockTime: T + 200, err: null },
           { signature: "OLDSIG", blockTime: T - 5000, err: null },   // below `since`
           { signature: "FAILSIG", blockTime: T + 300, err: "boom" }] // failed tx
        : [{ signature: "BOOSTSIG", blockTime: T + 100, err: null }];
      return new Response(JSON.stringify({ jsonrpc: "2.0", result: sigs }));
    }
    const sig = params[0];
    const tx = sig === "BOOSTSIG" ? boostTx : sig === "DEVSIG" ? devTx : null;
    return new Response(JSON.stringify({ jsonrpc: "2.0", result: tx }));
  }
  if (u.includes(`/addresses/${POOL}/`)) {
    return new Response(JSON.stringify([
      { signature: "BUY1", timestamp: T + 10,
        tokenTransfers: [{ mint: MINT, fromUserAccount: POOL, toUserAccount: "buyerA", tokenAmount: 6186992 }] },
      { signature: "SELL1", timestamp: T + 5, // pool RECEIVING = a sell, must be skipped
        tokenTransfers: [{ mint: MINT, fromUserAccount: "sellerB", toUserAccount: POOL, tokenAmount: 999 }] },
    ]));
  }
  if (u.includes(`/addresses/${DIST}/`)) {
    return new Response(JSON.stringify([
      // newest first, as the enhanced API returns
      { signature: "FEE", timestamp: T + 60, nativeTransfers: [{ fromUserAccount: DIST, toUserAccount: "pumpfee", amount: 69300 }] },
      { signature: "FANOUT2", timestamp: T + 50, nativeTransfers: [
        { fromUserAccount: DIST, toUserAccount: "w3", amount: 30000000 },
        { fromUserAccount: DIST, toUserAccount: "w4", amount: 20000000 }] },
      { signature: "FANOUT1", timestamp: T + 45, nativeTransfers: [
        { fromUserAccount: DIST, toUserAccount: "w1", amount: 100000000 },
        { fromUserAccount: DIST, toUserAccount: "w2", amount: 50000000 }] },
      { signature: "WITHDRAW", timestamp: T + 40, nativeTransfers: [{ fromUserAccount: "vault", toUserAccount: DIST, amount: 200069300 }] },
      { signature: "ANCIENT", timestamp: T - 9000, nativeTransfers: [
        { fromUserAccount: DIST, toUserAccount: "w9", amount: 777 },
        { fromUserAccount: DIST, toUserAccount: "w8", amount: 777 }] },
    ]));
  }
  // --- birdeye OHLCV, for /volume. 1000*0.5 + 2000*0.25 = 1000 -----------------
  if (u.includes("birdeye")) {
    upstreamCalls++;
    return new Response(JSON.stringify({ data: { items: [
      { unixTime: T,       v: 1000, c: 0.5  },
      { unixTime: T + 864, v: 2000, c: 0.25 },
    ] } }));
  }
  throw new Error("unexpected upstream " + u);
};

// Minimal Cache API stub.
const store = new Map();
globalThis.caches = { default: {
  async match(req) { const v = store.get(req.url); return v ? v.clone() : undefined; },
  async put(req, res) { store.set(req.url, res.clone()); },
} };

const ctx = { waitUntil: (p) => p };
const ORIGIN = "https://bullcember.net";
const call = (path, env = { HELIUS_KEY: "stub" }) =>
  worker.fetch(new Request("https://live.example.com" + path, { headers: { Origin: ORIGIN } }), env, ctx);

const out = [];
const ok = (name, cond, extra = "") => out.push(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);

// ---- routing / guards --------------------------------------------------------
ok("unknown route -> 404", (await call("/nope")).status === 404);
ok("missing key -> 503", (await call("/buys", {})).status === 503);
const opt = await worker.fetch(new Request("https://live.example.com/buys", { method: "OPTIONS", headers: { Origin: ORIGIN } }), { HELIUS_KEY: "s" }, ctx);
ok("OPTIONS preflight allowed", opt.headers.get("access-control-allow-origin") === ORIGIN);
const post = await worker.fetch(new Request("https://live.example.com/buys", { method: "POST" }), { HELIUS_KEY: "s" }, ctx);
ok("POST rejected -> 405", post.status === 405);

// ---- /volume and the per-route key gate --------------------------------------
// The gate is per route on purpose: /volume fronts Birdeye, the other three front
// Helius, and one missing secret must not take out the others. Both directions are
// checked, because a single shared gate would still pass the first assertion.
const volNoKey = await call("/volume", { HELIUS_KEY: "stub" });
ok("volume without BIRDEYE_KEY -> 503", volNoKey.status === 503);
ok("503 names the missing secret", (await volNoKey.text()).includes("BIRDEYE_KEY"));
ok("buys with only BIRDEYE_KEY -> 503", (await call("/buys", { BIRDEYE_KEY: "b" })).status === 503);

const volRes = await call("/volume", { BIRDEYE_KEY: "b" });   // no HELIUS_KEY at all
ok("volume works with BIRDEYE_KEY alone", volRes.status === 200);
const vol = await volRes.json();
ok("volume sums v*c across candles", vol.totalUsd === 1000, JSON.stringify(vol.totalUsd));
ok("volume gets the 1h edge TTL", (volRes.headers.get("cache-control") || "").includes("s-maxage=3600"));

// ---- buys --------------------------------------------------------------------
const buys = await (await call("/buys")).json();
ok("buys: only pool-outflows counted", buys.buys.length === 1, JSON.stringify(buys.buys.map(b => b.sig)));
ok("buys: buyer + amount parsed", buys.buys[0].buyer === "buyerA" && buys.buys[0].tokens === 6186992);

// ---- engine ------------------------------------------------------------------
store.clear();
const eng = await (await call(`/engine?since=${T}`)).json();
const byType = (t) => eng.events.filter((e) => e.type === t);
ok("engine: boost tx yields BOTH a burn and a buyback",
   byType("burn").length === 1 && byType("buyback").length === 2,
   JSON.stringify(eng.events.map(e => e.type + ":" + e.sig)));
ok("engine: boost burn amount from parsed instruction", byType("burn")[0].bull === 500000);
ok("engine: boost spend read off WSOL drop",
   byType("buyback").find(e => e.sig === "BOOSTSIG").sol === 0.25);
ok("engine: dev buyback = tokens in, SOL out",
   byType("buyback").find(e => e.sig === "DEVSIG").bull === 272065 &&
   byType("buyback").find(e => e.sig === "DEVSIG").sol === 0.1);
ok("engine: failed + pre-`since` sigs skipped", !JSON.stringify(eng.events).includes("OLDSIG") && !JSON.stringify(eng.events).includes("FAILSIG"));
ok("engine: newest first", eng.events[0].time >= eng.events[eng.events.length - 1].time);

// ---- rewards -----------------------------------------------------------------
store.clear();
const rw = await (await call(`/rewards?since=${T}`)).json();
ok("rewards: fan-out batches inside ROUND_GAP bucket into one round", rw.rounds.length === 1, JSON.stringify(rw.rounds));
ok("rewards: round sums both batches", rw.rounds[0].sol === 0.2);
ok("rewards: wallets deduped across batches", rw.rounds[0].wallets === 4);
// 6dp is the published convention (update-rewards.mjs uses +(x/1e9).toFixed(6)),
// so the Worker's delta and the baseline it gets added to are on the same scale.
ok("rewards: lone-transfer tx booked as overhead, not a payout", rw.overheadSol === 0.000069);
ok("rewards: inbound counted as collected", rw.collectedSol === 0.200069);
ok("rewards: pre-`since` round excluded", !JSON.stringify(rw.rounds).includes("ANCIENT"));
ok("rewards: collected = paid + overhead (no dust here)",
   Math.abs(rw.collectedSol - (rw.rounds[0].sol + rw.overheadSol)) < 1e-9);

// Regression: the flat fee lands ~9s AFTER the round it pays for, so when `since`
// is that round's timestamp the fee sits just past the cutoff. Returning it would
// double-bill overhead against a baseline that already counted it.
store.clear();
// since = T+50, the bucket's MAX timestamp — which is what update-rewards.mjs
// publishes as lastRound (bucket.time = Math.max(bucket.time, tx.timestamp)).
const trailing = await (await call(`/rewards?since=${T + 50}`)).json();
ok("rewards: trailing fee of an already-counted round is NOT re-reported",
   trailing.overheadSol === 0, `got ${trailing.overheadSol}`);
// A fee far enough past `since` is a genuinely new round's fee and must still count.
store.clear();
const older = await (await call(`/rewards?since=${T - 600}`)).json();
ok("rewards: a fee beyond ROUND_GAP still counts as overhead", older.overheadSol === 0.000069);

// ---- cache -------------------------------------------------------------------
store.clear();
upstreamCalls = 0;
const a = await call("/buys");
const afterFirst = upstreamCalls;
const b = await call("/buys");
ok("cache: first call MISS, second HIT",
   a.headers.get("x-bull-cache") === "MISS" && b.headers.get("x-bull-cache") === "HIT");
ok("cache: HIT makes no upstream call", upstreamCalls === afterFirst, `calls=${upstreamCalls}`);
ok("cache: HIT still carries CORS", b.headers.get("access-control-allow-origin") === ORIGIN);
// A cache-buster in the query must NOT fragment the shared cache.
const c = await call("/buys?t=12345&since=abc");
ok("cache: junk query normalized to same key", c.headers.get("x-bull-cache") === "HIT" && upstreamCalls === afterFirst);
ok("cache: s-maxage set for the edge", /s-maxage=15/.test(b.headers.get("cache-control") || ""));

// ---- failures are not cached -------------------------------------------------
store.clear();
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("helius down"); };
const err = await call("/buys");
ok("upstream failure -> 502", err.status === 502);
ok("failure not cached", (err.headers.get("cache-control") || "").includes("no-store"));
globalThis.fetch = realFetch;

console.log(out.join("\n"));
console.log(`\n${out.filter(l => l.startsWith("PASS")).length}/${out.length} passed`);
process.exit(out.some((l) => l.startsWith("FAIL")) ? 1 : 0);
