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

const ownerBal = (list, owner) => {
  const e = (list || []).find((b) => b.owner === owner && b.mint === MINT);
  return e ? Number(e.uiTokenAmount.uiAmount || 0) : 0;
};
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
function solDeltaDev(tx) {
  const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === "string" ? k : k.pubkey));
  const i = keys.indexOf(DEV);
  if (i < 0 || !tx.meta) return 0;
  return (tx.meta.postBalances[i] - tx.meta.preBalances[i]) / 1e9;
}

// Scan from scratch (sinceTime=0) or only txns newer than sinceTime (unix secs).
// Returns { buyback, burn, feed, newestSig, newestTime } — events deduped by sig upstream.
export async function scan(sinceTime = 0) {
  const devAcct = await tokenAccount(DEV);
  const set = new Set();
  if (devAcct) (await allSigs(devAcct, sinceTime)).forEach((s) => set.add(s));
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
    const solD = solDeltaDev(tx);

    if (burned > 0.0001) {
      out.burn.bull += burned; out.burn.count += 1;
      out.feed.push({ type: "burn", time, bull: Math.round(burned), sig });
    }
    // buyback: BULLCEMBER came in AND SOL went out (a real purchase, not a plain transfer/allocation)
    if (devDelta > 0.0001 && solD < -SOL_FEE_FLOOR) {
      out.buyback.bull += devDelta; out.buyback.count += 1; out.buyback.sol += -solD;
      out.feed.push({ type: "buyback", time, bull: Math.round(devDelta), sol: Number((-solD).toFixed(4)), sig });
    }
    if (time > out.newestTime) { out.newestTime = time; out.newestSig = sig; }
  }
  out.feed.sort((a, b) => (b.time || 0) - (a.time || 0));
  out.buyback.bull = Math.round(out.buyback.bull);
  out.buyback.sol = Number(out.buyback.sol.toFixed(4));
  out.burn.bull = Math.round(out.burn.bull);
  return out;
}
