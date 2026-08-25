// Builds data/herd.json (holder census + leaderboard) and data/buys.json
// (recent buys off the PumpSwap pool) for the BULLCEMBER site.
//
// WHY THIS EXISTS: both datasets used to be fetched by every visitor's browser
// using a Helius key hardcoded in index.html. Credit burn therefore scaled with
// traffic, the key was there for anyone to lift, and on 2026-08-25 the quota hit
// "max usage reached" — every widget without a cached fallback sat on its
// loading string forever. Now the chain is read once per cron run with a secret
// key and the browser only ever reads static JSON.
//
// Runs alongside update-stats.mjs in .github/workflows/update-stats.yml.

import { writeFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dirname, "..", "data");
const HERD = join(DATA, "herd.json");
const BUYS = join(DATA, "buys.json");

const MINT = "DTRmPLZPfQRRRVwyZFuSxUhvnj9RHgDqFjQXx6vUpump";
const POOL = "3LnLWicgYKDipE4nDUNS9BuLeXJZTB8jYqbGVcyhVHnr";
const BONDING_CURVE = "DExz6gLccnrgCQRphPhCqT3TUZPEY33RerUhoAwvvbhg";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const DECIMALS = 1e6;

const RPC = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
// The Enhanced Transactions API is a separate host from the RPC, but the same
// key works. Prefer an explicit secret; otherwise lift it off RPC_URL.
const HELIUS_KEY =
  process.env.HELIUS_KEY ||
  (() => { try { return new URL(RPC).searchParams.get("api-key") || ""; } catch { return ""; } })();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(method, params, tries = 6) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      if (r.status === 429 || r.status >= 500) throw new Error("RPC " + r.status);
      const j = await r.json();
      if (j.error) throw new Error(j.error.message);
      return j.result;
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) await sleep(600 * (i + 1));
    }
  }
  throw lastErr;
}

async function readJson(p, fallback) {
  try { return JSON.parse(await readFile(p, "utf8")); } catch { return fallback; }
}

// ---------------------------------------------------------------- holders ---
// getTokenAccounts is the cheap path and the PUBLIC RPC implements it — it just
// names the argument `mintAddress` where Helius documents `mint`. The old
// client-side code only ever sent `mint`, which is why this looked like it
// needed a paid key. Try both spellings before falling back.
async function holdersViaTokenAccounts() {
  for (const field of ["mintAddress", "mint"]) {
    try {
      const balances = new Map();
      let cursor;
      do {
        const params = { [field]: MINT, limit: 1000 };
        if (cursor) params.cursor = cursor;
        const res = await rpc("getTokenAccounts", params, 3);
        const accounts = res?.token_accounts || [];
        for (const a of accounts) {
          // Emptied-but-not-closed token accounts still come back here. Someone
          // who sold their whole bag is not a bull, and counting them made the
          // herd total flicker between runs depending on which path resolved it.
          const raw = Number(a.amount || 0);
          if (!a.owner || !raw) continue;
          balances.set(a.owner, (balances.get(a.owner) || 0) + raw);
        }
        cursor = accounts.length === 1000 ? res?.cursor : undefined;
      } while (cursor);
      if (balances.size) return balances;
    } catch (e) {
      console.error(`getTokenAccounts({${field}}) failed: ${e.message}`);
    }
  }
  throw new Error("getTokenAccounts unavailable in either spelling");
}

async function holdersViaProgramAccounts() {
  const res = await rpc("getProgramAccounts", [
    TOKEN_2022,
    { encoding: "jsonParsed", filters: [{ memcmp: { offset: 0, bytes: MINT } }] },
  ]);
  const balances = new Map();
  for (const a of res || []) {
    const info = a.account?.data?.parsed?.info;
    if (!info?.owner) continue;
    const raw = Number(info.tokenAmount?.amount || 0);
    if (!raw) continue;
    balances.set(info.owner, (balances.get(info.owner) || 0) + raw);
  }
  return balances;
}

async function buildHerd() {
  let balances;
  try {
    balances = await holdersViaTokenAccounts();
  } catch (e) {
    console.error(e.message + " — trying getProgramAccounts");
    balances = await holdersViaProgramAccounts();
  }

  // Neither the curve's unsold reserve nor the pool's LP side is a holder. The
  // pool holds a large share of supply, so leaving it in would put it at #1 on
  // the leaderboard and add a phantom bull to the count.
  balances.delete(BONDING_CURVE);
  balances.delete(POOL);
  if (!balances.size) throw new Error("no holders resolved");

  const holders = [...balances.entries()].sort((a, b) => b[1] - a[1]);
  const tiers = { calf: 0, bull: 0, stampede: 0, alpha: 0 };
  for (const [, raw] of holders) {
    const tok = raw / DECIMALS;
    if (tok >= 50e6) tiers.alpha++;
    else if (tok >= 10e6) tiers.stampede++;
    else if (tok >= 1e6) tiers.bull++;
    else tiers.calf++;
  }

  return {
    updatedAt: new Date().toISOString(),
    total: holders.length,
    tiers,
    // Full census, not just the top 10 — the "What's your rank?" widget has to
    // be able to find any wallet. ~135 holders is a few KB.
    holders,
  };
}

// ------------------------------------------------------------------ buys ---
const WANT_BUYS = 12;

// Fast path: one call, but Helius-only and it costs credits.
async function buysViaEnhancedApi() {
  if (!HELIUS_KEY) throw new Error("no Helius key");
  const r = await fetch(
    `https://api.helius.xyz/v0/addresses/${POOL}/transactions?api-key=${HELIUS_KEY}&limit=40`
  );
  if (!r.ok) throw new Error("enhanced tx API " + r.status);
  const txns = await r.json();
  if (!Array.isArray(txns)) throw new Error("unexpected payload");

  const buys = [];
  for (const tx of txns) {
    // A buy is the pool sending BULLCEMBER out to someone.
    const tt = (tx.tokenTransfers || []).find((x) => x.mint === MINT && x.fromUserAccount === POOL);
    if (!tt || !tt.tokenAmount) continue;
    buys.push({ sig: tx.signature, buyer: tt.toUserAccount, tokens: tt.tokenAmount, ts: tx.timestamp });
    if (buys.length >= WANT_BUYS) break;
  }
  return buys;
}

// Provider-independent path: read the pool's signatures and diff the token
// balances ourselves. More calls, but they are plain RPC and free, and a cron
// run every 15 minutes can afford them where a browser could not.
async function buysViaRpc() {
  const sigs = await rpc("getSignaturesForAddress", [POOL, { limit: 40 }]);
  const buys = [];
  for (const s of sigs || []) {
    if (s.err || buys.length >= WANT_BUYS) continue;
    let tx;
    try {
      tx = await rpc("getTransaction", [s.signature, { maxSupportedTransactionVersion: 0, encoding: "jsonParsed" }], 3);
    } catch { continue; }
    if (!tx?.meta || tx.meta.err) continue;

    // Net every owner's BULLCEMBER movement across the transaction.
    const delta = new Map();
    const walk = (rows, sign) => {
      for (const b of rows || []) {
        if (b.mint !== MINT || !b.owner) continue;
        const amt = Number(b.uiTokenAmount?.amount || 0);
        delta.set(b.owner, (delta.get(b.owner) || 0) + sign * amt);
      }
    };
    walk(tx.meta.preTokenBalances, -1);
    walk(tx.meta.postTokenBalances, +1);

    // The pool must have LOST tokens (someone bought off it), and the buyer is
    // whoever gained the most. Pool gaining means it was a sell.
    if ((delta.get(POOL) || 0) >= 0) continue;
    let buyer = null, gained = 0;
    for (const [owner, d] of delta) {
      if (owner === POOL || d <= 0) continue;
      if (d > gained) { gained = d; buyer = owner; }
    }
    if (!buyer || !gained) continue;
    buys.push({ sig: s.signature, buyer, tokens: gained / DECIMALS, ts: s.blockTime });
  }
  return buys;
}

async function buildBuys() {
  let buys = [];
  try {
    buys = await buysViaEnhancedApi();
  } catch (e) {
    console.error(`enhanced tx API unavailable (${e.message}) — reading the pool over plain RPC`);
    buys = await buysViaRpc();
  }
  if (!buys.length) throw new Error("no buys parsed");
  return { updatedAt: new Date().toISOString(), buys };
}

// ------------------------------------------------------------------ main ---
// A failure here must never fail the workflow or blank the site: the previous
// file stays on disk and the page keeps showing last-known data.
async function step(name, path, build) {
  try {
    const out = await build();
    const prev = await readJson(path, null);
    // Only rewrite when the substance changed. Every run produces a new
    // updatedAt, so writing unconditionally would make the workflow commit on
    // every single cron tick even when the chain hasn't moved.
    const same = (a, b) => a && b && JSON.stringify({ ...a, updatedAt: 0 }) === JSON.stringify({ ...b, updatedAt: 0 });
    if (same(prev, out)) {
      console.log(`${name}: unchanged`);
      return prev;
    }
    await writeFile(path, JSON.stringify(out, null, 2) + "\n");
    return out;
  } catch (e) {
    const prev = await readJson(path, null);
    console.error(`${name} failed: ${e.message}${prev ? " — keeping previous file" : " — no previous file to keep"}`);
    return null;
  }
}

const herd = await step("herd", HERD, buildHerd);
const buys = await step("buys", BUYS, buildBuys);

console.log(
  `herd:${herd ? herd.total + " holders (" + Object.entries(herd.tiers).map(([k, v]) => k + "=" + v).join(" ") + ")" : "unchanged"} ` +
  `buys:${buys ? buys.buys.length : "unchanged"}`
);
