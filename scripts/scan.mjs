// Authoritative BULLCEMBER engine scanner — public RPC, no API key required.
// Classifies every BULLCEMBER movement on the dev (creator) token account.
//
//   buyback = dev received BULLCEMBER AND spent PUMP, USDC or SOL (a real buy off the market)
//   burn    = burn / burnChecked instruction on the mint
//
// No supply is ever sent to anyone — the creator fees only buy back and burn.
// Total burned for the headline tile is itemized from the burn events we attribute.

const RPC = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const MINT = "EUpN7RE7YLXmtF4FDuE4j7hqDhoogGqnbnKCcq3Upump";
// This launch is quoted in PUMP: creator fees are paid in PUMP and the dev buys
// back with PUMP, so a buyback shows as PUMP out rather than lamports out.
const PUMP = "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn";
const PUMP_FLOOR = 1; // ignore PUMP dust when tagging buybacks
// The dev has also bought back straight out of USDC (37Y8iyDR..., 155 USDC).
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDC_FLOOR = 0.01;
const DEV = "BXrU6jcjtZnar27jfWCXXhr9EqQGcFvyfnpC9cRjYLmC"; // pump.fun creator / fee wallet
// pump.fun "boost" vault. On graduation it takes a slice of the migration SOL and spends
// it buying BULLCEMBER on PumpSwap, burning each buy inside the same transaction. The
// tokens never touch the dev wallet, so a DEV-only scan is blind to every bit of it.
// The vault is shared across coins: most of its signatures are other coins' failed txs
// (allSigs drops those) and burnAmount() filters whatever survives down to our mint.
const BOOST = "BGVtkQcLUWtsm6FeZQrk12yXyDDYj9PhvmytYDKcDv5v";
const DECIMALS = 6;
const SOL_FEE_FLOOR = 0.0005; // ignore dust/fee-only SOL moves when tagging buybacks

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(method, params, tries = 8) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      if (r.status === 429) { await sleep(700 * (i + 1)); continue; }
      const j = await r.json();
      if (j.error) throw new Error(j.error.message);
      return j.result;
    } catch (e) { if (i === tries - 1) throw e; await sleep(500 * (i + 1)); }
  }
}

// An associated token account address is derived from (owner, mint, token program),
// so it is CONSTANT. The account at that address can be created and closed
// repeatedly, but the address never changes and signatures stay indexed against it.
//
// If the dev burns its whole balance and closes the account, getTokenAccountsByOwner
// returns zero accounts, and a scan keyed on it would silently report "no new events"
// while the burn sits unrecorded.
// Must stay in agreement with DEV_ATA in worker/src/index.js.
const DEV_ATA_ADDR = "9eFXRtXE5FoPFmUMPWkjf7kS6WrUihNGyVBXsUhHLbcS";

async function tokenAccount(owner) {
  // {mint} filter resolves the account whether it's legacy SPL or Token-2022.
  try {
    const r = await rpc("getTokenAccountsByOwner", [owner, { mint: MINT }, { encoding: "jsonParsed" }]);
    return r.value[0]?.pubkey || DEV_ATA_ADDR;
  } catch (e) {
    return DEV_ATA_ADDR;
  }
}
// Collect signatures newer than `sinceTime` (unix seconds). 0 = full history.
async function allSigs(acct, sinceTime = 0) {
  let before, out = [];
  outer: while (true) {
    const s = await rpc("getSignaturesForAddress", [acct, { limit: 1000, ...(before ? { before } : {}) }]);
    if (!s.length) break;
    for (const x of s) {
      // `<`, not `<=`. The caller cursors on the newest saved timestamp, and two
      // engine transactions can share that second. Stopping on equality dropped
      // the unsaved sibling forever. Re-reading the boundary second is safe:
      // update-stats dedupes on type+signature.
      if (sinceTime && x.blockTime && x.blockTime < sinceTime) break outer;
      if (!x.err) out.push(x.signature);
    }
    before = s[s.length - 1].signature;
    if (s.length < 1000) break;
  }
  return out;
}

const WSOL = "So11111111111111111111111111111111111111112";
const ownerMintBal = (list, owner, mint) => {
  const e = (list || []).find((b) => b.owner === owner && b.mint === mint);
  return e ? Number(e.uiTokenAmount.uiAmount || 0) : 0;
};
const ownerBal = (list, owner) => ownerMintBal(list, owner, MINT);

// What the boost vault actually paid. It funds its buys from a wrapped-SOL account, so
// its native lamport balance barely moves and solDelta() reads ~0 — the spend only shows
// up as a drop in its WSOL token balance. Count both so either funding path is caught.
function boostSpend(tx, pre, post) {
  const wsol = ownerMintBal(post, BOOST, WSOL) - ownerMintBal(pre, BOOST, WSOL);
  return -(wsol + solDelta(tx, BOOST));
}
// What the dev paid in tokens, if anything. Net per mint across the transaction,
// because a SOL route passes PUMP through the wallet and nets to ~0.
// Must match spentTokens() in worker/src/index.js.
function spentTokens(pre, post) {
  const pumpD = ownerMintBal(post, DEV, PUMP) - ownerMintBal(pre, DEV, PUMP);
  const usdcD = ownerMintBal(post, DEV, USDC) - ownerMintBal(pre, DEV, USDC);
  const out = {};
  if (pumpD < -PUMP_FLOOR) out.pump = Math.round(-pumpD);
  if (usdcD < -USDC_FLOOR) out.usdc = Number((-usdcD).toFixed(2));
  return Object.keys(out).length ? out : null;
}
function burnAmount(tx) {
  let burned = 0;
  const scan = (instrs) => (instrs || []).forEach((ix) => {
    const p = ix.parsed;
    if (p && (p.type === "burn" || p.type === "burnChecked") && p.info && p.info.mint === MINT) {
      burned += p.info.tokenAmount ? Number(p.info.tokenAmount.uiAmount) : Number(p.info.amount) / 10 ** DECIMALS;
    }
  });
  scan(tx.transaction.message.instructions);
  (tx.meta?.innerInstructions || []).forEach((ii) => scan(ii.instructions));
  return burned;
}
function solDelta(tx, who) {
  const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === "string" ? k : k.pubkey));
  const i = keys.indexOf(who);
  if (i < 0 || !tx.meta) return 0;
  return (tx.meta.postBalances[i] - tx.meta.preBalances[i]) / 1e9;
}

// Scan from scratch (sinceTime=0) or only txns newer than sinceTime (unix secs).
// Returns { buyback, burn, feed, newestSig, newestTime } — events deduped by sig upstream.
export async function scan(sinceTime = 0) {
  const devAcct = await tokenAccount(DEV);
  const set = new Set();
  if (devAcct) (await allSigs(devAcct, sinceTime)).forEach((s) => set.add(s));
  // A failed boost lookup used to become an empty list. The dev scan would still
  // succeed, its newer timestamp would advance the cursor, and every boost burn
  // in the gap was gone for good.
  (await allSigs(BOOST, sinceTime)).forEach((s) => set.add(s));
  const sigs = [...set];

  const rows = [];
  for (const sig of sigs) {
    // rpc() already retries. Swallowing the last failure used to let a later,
    // successfully fetched transaction advance the cursor past the hole.
    const tx = await rpc("getTransaction", [sig, { maxSupportedTransactionVersion: 0, encoding: "jsonParsed" }]);
    if (!tx) throw new Error(`getTransaction returned nothing for ${sig}`);
    if (!tx.meta?.err) rows.push({ sig, tx });
    await sleep(120);
  }
  rows.sort((a, b) => (a.tx.blockTime || 0) - (b.tx.blockTime || 0)); // oldest -> newest

  const out = {
    buyback: { bull: 0, sol: 0, pump: 0, usdc: 0, count: 0 },
    burn: { bull: 0, count: 0 },
    feed: [],
    newestSig: null,
    newestTime: 0,
  };

  for (const { sig, tx } of rows) {
    const time = tx.blockTime;
    const pre = tx.meta?.preTokenBalances, post = tx.meta?.postTokenBalances;
    const devDelta = ownerBal(post, DEV) - ownerBal(pre, DEV);
    const burned = burnAmount(tx);
    const solD = solDelta(tx, DEV);
    const tokenSpend = spentTokens(pre, post);
    const boostSol = boostSpend(tx, pre, post);

    if (burned > 0.0001) {
      out.burn.bull += burned; out.burn.count += 1;
      out.feed.push({ type: "burn", time, bull: Math.round(burned), sig });
    }
    // buyback: BULLCEMBER came in AND PUMP, USDC or SOL went out (a real purchase, not a
    // plain transfer). Token spends are tested first: a PUMP- or USDC-funded buy still
    // moves ~0.0013 SOL of fees and rent, which would otherwise log a fake SOL spend.
    const isBuy = devDelta > 0.0001;
    if (isBuy && tokenSpend) {
      out.buyback.bull += devDelta; out.buyback.count += 1;
      out.buyback.pump += tokenSpend.pump || 0; out.buyback.usdc += tokenSpend.usdc || 0;
      out.feed.push({ type: "buyback", time, bull: Math.round(devDelta), ...tokenSpend, sig });
    } else if (isBuy && solD < -SOL_FEE_FLOOR) {
      out.buyback.bull += devDelta; out.buyback.count += 1; out.buyback.sol += -solD;
      out.feed.push({ type: "buyback", time, bull: Math.round(devDelta), sol: Number((-solD).toFixed(4)), sig });
    } else if (burned > 0.0001 && boostSol > SOL_FEE_FLOOR) {
      // A boost buy never lands in a balance — it is bought and burned atomically, so the
      // token delta is zero everywhere and the burned amount IS the amount bought back.
      // This emits a second event on a signature that also produced a burn above, which is
      // why the feed has to be deduped on type+sig rather than sig alone.
      out.buyback.bull += burned; out.buyback.count += 1; out.buyback.sol += boostSol;
      out.feed.push({ type: "buyback", time, bull: Math.round(burned), sol: Number(boostSol.toFixed(4)), sig });
    }
    if (time > out.newestTime) { out.newestTime = time; out.newestSig = sig; }
  }
  out.feed.sort((a, b) => (b.time || 0) - (a.time || 0));
  out.buyback.bull = Math.round(out.buyback.bull);
  out.buyback.sol = Number(out.buyback.sol.toFixed(4));
  out.buyback.pump = Math.round(out.buyback.pump);
  out.buyback.usdc = Number(out.buyback.usdc.toFixed(2));
  out.burn.bull = Math.round(out.burn.bull);
  return out;
}
