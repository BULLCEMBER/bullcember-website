// Authoritative BULLCEMBER engine scanner — public RPC, no API key required.
// Classifies every BULLCEMBER movement on the dev (creator) token account.
//
//   buyback = dev received BULLCEMBER AND spent SOL (a real buy off the market)
//   burn    = burn / burnChecked instruction on the mint
//
// No supply is ever sent to anyone — the creator fees only buy back and burn.
// Total burned for the headline tile is itemized from the burn events we attribute.

const RPC = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const MINT = "DTRmPLZPfQRRRVwyZFuSxUhvnj9RHgDqFjQXx6vUpump";
const DEV = "BXrU6jcjtZnar27jfWCXXhr9EqQGcFvyfnpC9cRjYLmC"; // pump.fun creator / fee wallet
// pump.fun "boost" vault. On graduation it takes a slice of the migration SOL and spends
// it buying BULLCEMBER on PumpSwap, burning each buy inside the same transaction. The
// tokens never touch the dev wallet, so a DEV-only scan is blind to every bit of it —
// on 2026-08-08 that was 17.58 SOL and 39.09M BULLCEMBER the engine never saw.
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
// On 2026-08-01 the dev burned its remaining balance and closed the account in one
// transaction. getTokenAccountsByOwner then returned zero accounts, this function
// returned null, and the caller's `if (devAcct)` guard silently scanned nothing —
// so the scan reported "no new events" while a 1.7M burn sat unrecorded.
// Must stay in agreement with DEV_ATA_ADDR in index.html.
const DEV_ATA_ADDR = "4dTEzL1XdsWuzwFwXyzsxNKBUCqH8Nsac9CRGSfpgVGw";

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
      if (sinceTime && x.blockTime && x.blockTime <= sinceTime) break outer;
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
  (await allSigs(BOOST, sinceTime).catch(() => [])).forEach((s) => set.add(s));
  const sigs = [...set];

  const rows = [];
  for (const sig of sigs) {
    const tx = await rpc("getTransaction", [sig, { maxSupportedTransactionVersion: 0, encoding: "jsonParsed" }]).catch(() => null);
    if (tx && !tx.meta?.err) rows.push({ sig, tx });
    await sleep(120);
  }
  rows.sort((a, b) => (a.tx.blockTime || 0) - (b.tx.blockTime || 0)); // oldest -> newest

  const out = {
    buyback: { bull: 0, sol: 0, count: 0 },
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
    const boostSol = boostSpend(tx, pre, post);

    if (burned > 0.0001) {
      out.burn.bull += burned; out.burn.count += 1;
      out.feed.push({ type: "burn", time, bull: Math.round(burned), sig });
    }
    // buyback: BULLCEMBER came in AND SOL went out (a real purchase, not a plain transfer/allocation)
    if (devDelta > 0.0001 && solD < -SOL_FEE_FLOOR) {
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
  out.burn.bull = Math.round(out.burn.bull);
  return out;
}
