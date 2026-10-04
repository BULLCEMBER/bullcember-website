// Exercises worker/src/index.js with a stubbed fetch + caches, so the routing,
// clamping and caching logic can be checked without a key.
import worker from "./src/index.js";

const MINT = "EUpN7RE7YLXmtF4FDuE4j7hqDhoogGqnbnKCcq3Upump";
// Pre-graduation the bonding curve is where buys come from. The future pool is
// read too, and returns nothing until it exists.
const POOL = "CrFq4zNsEAEZqdmJWy9aWarZDSb1FLx64RbfUW7mVbvJ";
const FUTURE_POOL = "598LgNU99ZQmPCNkfdF93eEmSkvtshgPPjnQ2ebatuWZ";

const T = 1791100000;
let upstreamCalls = 0;

globalThis.fetch = async (url, opts) => {
  upstreamCalls++;
  const u = String(url);
  if (u.includes("helius-rpc.com")) {
    const { method, params } = JSON.parse(opts.body);
    if (method === "getAccountInfo") {
      // Real curve bytes read 2026-10-04: real_token 282964750147271, real_quote 619736737946.
      const b = new Uint8Array(151);
      const dv = new DataView(b.buffer);
      dv.setBigUint64(24, 282964750147271n, true);
      dv.setBigUint64(32, 619736737946n, true);
      const b64 = btoa(String.fromCharCode(...b));
      return new Response(JSON.stringify({ jsonrpc: "2.0", result: { value: { data: [b64, "base64"] } } }));
    }
    throw new Error("unexpected rpc " + method);
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
ok("engine route removed -> 404", (await call("/engine")).status === 404);
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
