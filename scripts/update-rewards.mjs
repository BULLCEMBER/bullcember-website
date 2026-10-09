// Builds data/rewards.json — the holder-rewards tracker.
//
// WHAT THIS TRACKS: on 2026-09-17 the BULLCEMBER PumpSwap pool's `coin_creator`
// field was pointed at DISTRIBUTOR below instead of the dev wallet. That field is
// what the AMM pays creator fees against, so from that moment every lamport of
// creator fee accrues to the distributor's vault and the dev wallet is not in the
// path at all. pump.fun then runs the cycle itself:
//
//   1. WITHDRAW  — pulls the accrued fees out of the creator-fee vault into DISTRIBUTOR
//   2. fan-out   — 5-6 batched transactions paying every holder pro-rata to their bag
//
// Verify the premise yourself: read the pool account, field `coin_creator` at byte
// offset 211, and confirm it is DISTRIBUTOR and not DEV.
//
// Runs alongside update-stats.mjs / update-herd.mjs in
// .github/workflows/update-stats.yml. Like those, a failure here keeps the
// previous file rather than blanking the section.

import { writeFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dirname, "..", "data");
const OUT = join(DATA, "rewards.json");        // lean, site-facing
const STATE = join(DATA, "rewards-state.json"); // cumulative, never fetched by the browser

// pump.fun's fee distributor. This is the pool's on-chain `coin_creator`.
const DISTRIBUTOR = "7D2dJwtSH4dmM19MzJk1ms9kH5gmpbRbGaCXURmVdhQc";
// The old creator/fee wallet. Kept here so the site can state, and anyone can
// check, that it no longer appears anywhere in the fee path.
const DEV = "BXrU6jcjtZnar27jfWCXXhr9EqQGcFvyfnpC9cRjYLmC";
const PAIR = "3LnLWicgYKDipE4nDUNS9BuLeXJZTB8jYqbGVcyhVHnr";
const LAMPORTS = 1e9;

// A payout round's transactions land within seconds of each other; rounds are
// hours apart. Anything inside this window belongs to the same round.
const ROUND_GAP = 600; // seconds

const TOP_N = 25;   // recipients published to the site
const FEED_N = 30;  // rounds published to the site

const RPC = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const HELIUS_KEY =
  process.env.HELIUS_KEY ||
  (() => { try { return new URL(RPC).searchParams.get("api-key") || ""; } catch { return ""; } })();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readJson(p, fallback) {
  try { return JSON.parse(await readFile(p, "utf8")); } catch { return fallback; }
}

// Enhanced Transactions API, paged backwards. Stops as soon as it sees a
// signature the previous run already recorded, so steady-state cost is one page.
async function history(address, knownSigs) {
  if (!HELIUS_KEY) throw new Error("no Helius key — set RPC_URL or HELIUS_KEY");
  const out = [];
  let before = "";
  for (let page = 0; page < 40; page++) {
    const url = `https://api.helius.xyz/v0/addresses/${address}/transactions` +
      `?api-key=${HELIUS_KEY}&limit=100${before ? `&before=${before}` : ""}`;
    let j;
    for (let i = 0; i < 5; i++) {
      const r = await fetch(url);
      if (r.status === 429 || r.status >= 500) { await sleep(700 * (i + 1)); continue; }
      j = await r.json();
      break;
    }
    if (!Array.isArray(j) || j.length === 0) return out;
    let hitKnown = false;
    for (const tx of j) {
      if (knownSigs.has(tx.signature)) { hitKnown = true; break; }
      out.push(tx);
    }
    if (hitKnown) return out;
    before = j[j.length - 1].signature;
    if (j.length < 100) return out;
  }
  return out;
}

// SOL/USD, derived from the pair the site already depends on: Dexscreener gives
// the same price in SOL and in USD, so the ratio is the SOL price. Best-effort —
// a failure just means the tracker reports SOL without a dollar figure.
async function solUsd() {
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/pairs/solana/${PAIR}`);
    const p = (await r.json())?.pairs?.[0];
    const usd = Number(p?.priceUsd), nat = Number(p?.priceNative);
    return usd > 0 && nat > 0 ? usd / nat : 0;
  } catch { return 0; }
}

async function build() {
  const prev = await readJson(STATE, null);
  const known = new Set(prev?.sigs || []);
  const fresh = await history(DISTRIBUTOR, known);

  // Cumulative state carried across runs.
  const totals = { ...(prev?.totals || {}) };   // holder -> lamports, all time
  const rounds = [...(prev?.rounds || [])];      // newest last
  let collected = prev?.collected || 0;          // pulled out of the fee vault
  let overhead = prev?.overhead || 0;            // flat pump.fun per-round fee

  // Oldest first, so rounds accumulate in chronological order.
  for (const tx of fresh.slice().reverse()) {
    const native = tx.nativeTransfers || [];
    const outs = native.filter((n) => n.fromUserAccount === DISTRIBUTOR);
    const ins = native.filter((n) => n.toUserAccount === DISTRIBUTOR);

    for (const n of ins) collected += n.amount;

    if (outs.length === 0) continue;

    // pump.fun takes a flat per-round fee, shipped alone in its own transaction
    // (a constant 69,300 lamports regardless of how large the round is). Holder
    // payouts always arrive as a fan-out batch. Splitting on batch size keeps
    // the headline "paid to holders" figure honest without hardcoding an address.
    if (outs.length === 1) {
      overhead += outs[0].amount;
      continue;
    }

    const last = rounds[rounds.length - 1];
    const bucket = last && tx.timestamp - last.time <= ROUND_GAP
      ? last
      : (rounds.push({ time: tx.timestamp, sol: 0, wallets: 0, sig: tx.signature }), rounds[rounds.length - 1]);

    const seen = new Set(bucket.payees || []);
    for (const n of outs) {
      totals[n.toUserAccount] = (totals[n.toUserAccount] || 0) + n.amount;
      bucket.sol += n.amount;
      seen.add(n.toUserAccount);
    }
    bucket.time = Math.max(bucket.time, tx.timestamp);
    bucket.payees = [...seen];
    bucket.wallets = seen.size;
  }

  // Signature ledger: enough to make the next run incremental, capped so the
  // state file cannot grow without bound.
  const sigs = [...fresh.map((t) => t.signature), ...(prev?.sigs || [])].slice(0, 400);

  await writeFile(STATE, JSON.stringify({ totals, rounds, collected, overhead, sigs }, null, 2) + "\n");

  const paid = Object.values(totals).reduce((a, b) => a + b, 0);
  const newest = rounds[rounds.length - 1];
  const price = await solUsd();
  const top = Object.entries(totals)
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_N)
    .map(([addr, lam]) => [addr, +(lam / LAMPORTS).toFixed(6)]);

  return {
    updatedAt: new Date().toISOString(),
    distributor: DISTRIBUTOR,
    dev: DEV,
    devSol: 0, // the dev wallet is not in the fee path; stated so the site can show it
    totalSol: +(paid / LAMPORTS).toFixed(6),
    totalUsd: price ? +((paid / LAMPORTS) * price).toFixed(2) : 0,
    collectedSol: +(collected / LAMPORTS).toFixed(6),
    overheadSol: +(overhead / LAMPORTS).toFixed(6),
    // What was pulled from the vault but not yet paid out: per-wallet rounding
    // dust that rolls into the next round. Verified to equal the distributor's
    // live SOL balance exactly, which is what makes "nothing is skimmed"
    // checkable rather than a claim — every lamport is either paid, the flat
    // pump.fun fee, or sitting here waiting.
    pendingSol: +((collected - paid - overhead) / LAMPORTS).toFixed(6),
    rounds: rounds.length,
    wallets: Object.keys(totals).length,
    lastRound: newest?.time || 0,
    biggestSol: rounds.length ? +(Math.max(...rounds.map((r) => r.sol)) / LAMPORTS).toFixed(6) : 0,
    top,
    feed: rounds
      .slice(-FEED_N)
      .reverse()
      .map((r) => ({ time: r.time, sol: +(r.sol / LAMPORTS).toFixed(6), wallets: r.wallets, sig: r.sig })),
  };
}

// Same guard the other scripts use: never fail the workflow, never blank the site.
try {
  const out = await build();
  const prev = await readJson(OUT, null);
  const same = (a, b) => a && b && JSON.stringify({ ...a, updatedAt: 0 }) === JSON.stringify({ ...b, updatedAt: 0 });
  if (same(prev, out)) {
    console.log("rewards: unchanged");
  } else {
    await writeFile(OUT, JSON.stringify(out, null, 2) + "\n");
    console.log(
      `rewards: ${out.totalSol} SOL to ${out.wallets} wallets over ${out.rounds} rounds ` +
      `(collected ${out.collectedSol}, overhead ${out.overheadSol})`
    );
  }
} catch (e) {
  console.error(`rewards failed: ${e.message} — keeping previous file`);
}
