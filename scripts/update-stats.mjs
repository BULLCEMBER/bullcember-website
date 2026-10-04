// Builds data/stats.json: the mint's chain supply and the DexScreener price.
// Public-RPC only, no API key. Keeps the previous values when a read fails.

import { writeFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATS = join(__dirname, "..", "data", "stats.json");

const MINT = "EUpN7RE7YLXmtF4FDuE4j7hqDhoogGqnbnKCcq3Upump";
const RPC = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";

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
    return Number(j.pairs?.[0]?.priceUsd) || null;
  } catch { return null; }
}

async function main() {
  const prev = await readJson(STATS, {});
  const [supply, price] = await Promise.all([getSupply().catch(() => null), getPrice()]);
  const stats = {
    updatedAt: process.env.BUILD_TIME || new Date().toISOString(),
    price: price ?? prev.price ?? 0,
    supply: supply ?? prev.supply ?? null,
  };
  await writeFile(STATS, JSON.stringify(stats, null, 2) + "\n");
  console.log(`supply:${stats.supply} price:${stats.price}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
