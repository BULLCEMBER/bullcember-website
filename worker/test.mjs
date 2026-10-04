// Exercises worker/src/index.js with a stubbed fetch + caches, so the routing,
// clamping, caching and chain-classification logic can be checked without a key.
import worker from "./src/index.js";

const MINT = "EUpN7RE7YLXmtF4FDuE4j7hqDhoogGqnbnKCcq3Upump";
// Pre-graduation the bonding curve is where buys come from. The future pool is
// read too, and returns nothing until it exists.
const POOL = "CrFq4zNsEAEZqdmJWy9aWarZDSb1FLx64RbfUW7mVbvJ";
const FUTURE_POOL = "598LgNU99ZQmPCNkfdF93eEmSkvtshgPPjnQ2ebatuWZ";
const PUMP = "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const DEV = "BXrU6jcjtZnar27jfWCXXhr9EqQGcFvyfnpC9cRjYLmC";
const DEV_ATA = "9eFXRtXE5FoPFmUMPWkjf7kS6WrUihNGyVBXsUhHLbcS";
const BOOST = "BGVtkQcLUWtsm6FeZQrk12yXyDDYj9PhvmytYDKcDv5v";
const WSOL = "So11111111111111111111111111111111111111112";

const T = 1791100000; // after launch, so BUYBACK_AFTER does not filter fixtures
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

// --- a buyback paid in PUMP, the way this launch actually buys back ------------
// Shape of 4RfCsuXZ2S… (2026-10-04): PUMP out, BULLCEMBER in, and ~0.0013 SOL of
// fees/rent that must NOT turn it into a "SOL buy".
const pumpTx = {
  blockTime: T + 250,
  transaction: { message: { accountKeys: [{ pubkey: DEV }, { pubkey: POOL }], instructions: [] } },
  meta: {
    err: null,
    preBalances: [1e9, 0], postBalances: [1e9 - 1346200, 0],
    innerInstructions: [],
    preTokenBalances:  [{ owner: DEV, mint: MINT, uiTokenAmount: { uiAmount: 0 } },
                        { owner: DEV, mint: PUMP, uiTokenAmount: { uiAmount: 12500 } }],
    postTokenBalances: [{ owner: DEV, mint: MINT, uiTokenAmount: { uiAmount: 5327189 } },
                        { owner: DEV, mint: PUMP, uiTokenAmount: { uiAmount: 132 } }],
  },
};

// --- a buyback paid in USDC, routed through PUMP (37Y8iyDR..., 2026-10-03) -------
// PUMP passes through the wallet and nets to ~0; USDC is what was actually spent.
const usdcTx = {
  blockTime: T + 260,
  transaction: { message: { accountKeys: [{ pubkey: DEV }, { pubkey: POOL }], instructions: [] } },
  meta: {
    err: null,
    preBalances: [1e9, 0], postBalances: [1e9 - 1410000, 0],
    innerInstructions: [],
    preTokenBalances:  [{ owner: DEV, mint: MINT, uiTokenAmount: { uiAmount: 0 } },
                        { owner: DEV, mint: PUMP, uiTokenAmount: { uiAmount: 100 } },
                        { owner: DEV, mint: USDC, uiTokenAmount: { uiAmount: 200 } }],
    postTokenBalances: [{ owner: DEV, mint: MINT, uiTokenAmount: { uiAmount: 12633970 } },
                        { owner: DEV, mint: PUMP, uiTokenAmount: { uiAmount: 100.0001 } },
                        { owner: DEV, mint: USDC, uiTokenAmount: { uiAmount: 45 } }],
  },
};

// --- a buyback that lands in the same second as `since` ------------------------
// scan.mjs re-reads that second. Stopping on blockTime <= since dropped it.
const sameSecTx = {
  blockTime: T,
  transaction: { message: { accountKeys: [{ pubkey: DEV }, { pubkey: POOL }], instructions: [] } },
  meta: {
    err: null,
    preBalances: [1e9, 0], postBalances: [1e9 - 2e7, 0], // dev spends 0.02 SOL
    innerInstructions: [],
    preTokenBalances:  [{ owner: DEV, mint: MINT, uiTokenAmount: { uiAmount: 0 } }],
    postTokenBalances: [{ owner: DEV, mint: MINT, uiTokenAmount: { uiAmount: 111 } }],
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
        ? [{ signature: "USDCSIG", blockTime: T + 260, err: null },
           { signature: "PUMPSIG", blockTime: T + 250, err: null },
           { signature: "DEVSIG", blockTime: T + 200, err: null },
           { signature: "SAMESEC", blockTime: T, err: null },         // equal to `since`
           { signature: "OLDSIG", blockTime: T - 5000, err: null },   // below `since`
           { signature: "FAILSIG", blockTime: T + 300, err: "boom" }] // failed tx
        : [{ signature: "BOOSTSIG", blockTime: T + 100, err: null }];
      return new Response(JSON.stringify({ jsonrpc: "2.0", result: sigs }));
    }
    if (method === "getAccountInfo") {
      // Real curve bytes read 2026-10-04: real_token 282964750147271, real_quote 619736737946.
      const b = new Uint8Array(151);
      const dv = new DataView(b.buffer);
      dv.setBigUint64(24, 282964750147271n, true);
      dv.setBigUint64(32, 619736737946n, true);
      const b64 = btoa(String.fromCharCode(...b));
      return new Response(JSON.stringify({ jsonrpc: "2.0", result: { value: { data: [b64, "base64"] } } }));
    }
    const sig = params[0];
    const tx = sig === "BOOSTSIG" ? boostTx : sig === "DEVSIG" ? devTx : sig === "SAMESEC" ? sameSecTx : sig === "PUMPSIG" ? pumpTx : sig === "USDCSIG" ? usdcTx : null;
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
  if (u.includes(`/addresses/${FUTURE_POOL}/`)) return new Response("[]");
  // --- birdeye OHLCV, for /volume. 1000*0.5 + 2000*0.25 = 1000 -----------------
  if (u.includes("birdeye")) {
    upstreamCalls++;
    return new Response(JSON.stringify({ data: { items: [
      { unixTime: T,       v: 1000, o: 0.4, h: 0.6, l: 0.3, c: 0.5  },
      { unixTime: T + 864, v: 2000, o: 0.2, h: 0.3, l: 0.1, c: 0.25 },
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

store.clear();
const ohlcvRes = await call("/ohlcv?tf=1D", { BIRDEYE_KEY: "b" });
ok("ohlcv works with BIRDEYE_KEY alone", ohlcvRes.status === 200);
const ohlcv = await ohlcvRes.json();
ok("ohlcv maps price and volume", ohlcv.candles.length === 2 && ohlcv.candles[0].open === 0.4 && ohlcv.candles[0].volume === 500, JSON.stringify(ohlcv.candles?.[0]));
ok("ohlcv cached per timeframe", (await call("/ohlcv?tf=1D", { BIRDEYE_KEY: "b" })).headers.get("x-bull-cache") === "HIT");
ok("ohlcv bad timeframe -> 400", (await call("/ohlcv?tf=1W", { BIRDEYE_KEY: "b" })).status === 400);
ok("ohlcv without BIRDEYE_KEY -> 503", (await call("/ohlcv", { HELIUS_KEY: "stub" })).status === 503);

// ---- buys --------------------------------------------------------------------
const buys = await (await call("/buys")).json();
ok("buys: only pool-outflows counted", buys.buys.length === 1, JSON.stringify(buys.buys.map(b => b.sig)));
ok("buys: buyer + amount parsed", buys.buys[0].buyer === "buyerA" && buys.buys[0].tokens === 6186992);

// ---- engine ------------------------------------------------------------------
store.clear();
const eng = await (await call(`/engine?since=${T}`)).json();
const byType = (t) => eng.events.filter((e) => e.type === t);
ok("engine: boost tx yields BOTH a burn and a buyback",
   byType("burn").length === 1 && byType("buyback").some(e => e.sig === "BOOSTSIG") && byType("buyback").some(e => e.sig === "DEVSIG"),
   JSON.stringify(eng.events.map(e => e.type + ":" + e.sig)));
ok("engine: boost burn amount from parsed instruction", byType("burn")[0].bull === 500000);
ok("engine: boost spend read off WSOL drop",
   byType("buyback").find(e => e.sig === "BOOSTSIG").sol === 0.25);
ok("engine: dev buyback = tokens in, SOL out",
   byType("buyback").find(e => e.sig === "DEVSIG").bull === 272065 &&
   byType("buyback").find(e => e.sig === "DEVSIG").sol === 0.1);
const pb = byType("buyback").find(e => e.sig === "PUMPSIG");
ok("engine: PUMP-funded buyback logged with its PUMP spend, not SOL",
   pb && pb.bull === 5327189 && pb.pump === 12368 && pb.sol === undefined, JSON.stringify(pb));
const ub = byType("buyback").find(e => e.sig === "USDCSIG");
ok("engine: USDC-funded buyback logged as USDC; PUMP passing through ignored",
   ub && ub.usdc === 155 && ub.pump === undefined && ub.sol === undefined, JSON.stringify(ub));
ok("engine: boundary second is re-read",
   byType("buyback").some(e => e.sig === "SAMESEC" && e.bull === 111 && e.time === T),
   JSON.stringify(eng.events.map(e => e.sig)));
ok("engine: failed + pre-`since` sigs skipped", !JSON.stringify(eng.events).includes("OLDSIG") && !JSON.stringify(eng.events).includes("FAILSIG"));
ok("engine: newest first", eng.events[0].time >= eng.events[eng.events.length - 1].time);

// ---- curve -------------------------------------------------------------------
store.clear();
const curve = await (await call("/curve")).json();
ok("curve: progress from real_token reserve", curve.pct === 64.32 && curve.complete === false, JSON.stringify(curve));
ok("curve: PUMP in the curve, 6dp", Math.abs(curve.quote - 619736.737946) < 1e-6);

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
