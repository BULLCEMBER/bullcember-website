// Builds data/stats.json (+ data/events.json) for the live BULLCEMBER Engine.
// Public-RPC only, no API key. Incremental: only new txns are scanned each run.
// Tracks buybacks + burns only — no supply is ever sent to anyone.

import { writeFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { scan } from "./scan.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dirname, "..", "data");
const STATS = join(DATA, "stats.json");
const EVENTS = join(DATA, "events.json");

const MINT = "DTRmPLZPfQRRRVwyZFuSxUhvnj9RHgDqFjQXx6vUpump";
const INITIAL_SUPPLY = 1_000_000_000;
const RPC = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
// Count dev-wallet burns from launch (pump.fun, Jun 21 2026 UTC). Excludes any
// older/unrelated burns — the mint didn't exist before this, so this is all-time.
const BURN_SINCE = 1782070621; // pump.fun created_timestamp for this mint

async function readJson(p, fallback) {
  try { return JSON.parse(await readFile(p, "utf8")); } catch { return fallback; }
}
async function getSupply() {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTokenSupply", params: [MINT] }) });
  const j = await r.json();
  return j.result?.value?.uiAmount ?? null;
}
async function getPrice() {
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${MINT}`);
    const j = await r.json();
    return Number(j.pairs?.[0]?.priceUsd) || 0;
  } catch { return 0; }
}

async function main() {
  const prevEvents = await readJson(EVENTS, []);
  const sinceTime = prevEvents.reduce((m, e) => Math.max(m, e.time || 0), 0);

  // Only scan transactions newer than what we already have.
  const fresh = await scan(sinceTime).catch((e) => { console.error("scan failed:", e.message); return null; });

  // Merge, dedupe by signature, keep newest first.
  const bySig = new Map();
  for (const e of prevEvents) bySig.set(e.sig, e);
  if (fresh) for (const e of fresh.feed) bySig.set(e.sig, e);
  const events = [...bySig.values()].sort((a, b) => (b.time || 0) - (a.time || 0));

  // Totals derived from the full event log (never double-counted).
  const sum = (t, f) => events.filter((e) => e.type === t).reduce((s, e) => s + (e[f] || 0), 0);
  const count = (t) => events.filter((e) => e.type === t).length;

  const [supply, price] = await Promise.all([getSupply().catch(() => null), getPrice()]);
  const prevStats = await readJson(STATS, {});
  const curSupply = supply ?? prevStats.supply ?? null;

  // Burned = dev-wallet burns since the campaign cutoff.
  const devBurns = events.filter((e) => e.type === "burn" && (e.time || 0) >= BURN_SINCE);
  const burnedTotal = devBurns.reduce((s, e) => s + (e.bull || 0), 0);

  const buybackBull = sum("buyback", "bull");

  // Feed always includes every burn, plus the newest buybacks.
  const burnsE = events.filter((e) => e.type === "burn");
  const buyE = events.filter((e) => e.type === "buyback").slice(0, 60);
  const feed = [...burnsE, ...buyE].sort((a, b) => (b.time || 0) - (a.time || 0));

  const stats = {
    updatedAt: process.env.BUILD_TIME || new Date().toISOString(),
    price,
    supply: curSupply,
    burnedSince: BURN_SINCE,
    burned: {
      amount: Math.round(burnedTotal),
      pct: Number(((burnedTotal / INITIAL_SUPPLY) * 100).toFixed(3)),
      usd: Number((burnedTotal * price).toFixed(2)),
      count: devBurns.length,
    },
    buyback: {
      bull: Math.round(buybackBull),
      sol: Number(sum("buyback", "sol").toFixed(4)),
      usd: Number((buybackBull * price).toFixed(2)),
      count: count("buyback"),
    },
    feed,
  };

  await writeFile(EVENTS, JSON.stringify(events) + "\n");
  await writeFile(STATS, JSON.stringify(stats, null, 2) + "\n");
  console.log(`events:${events.length} buyback:${stats.buyback.bull}(${stats.buyback.count}) ` +
    `burned:${stats.burned.amount}(${stats.burned.count})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
