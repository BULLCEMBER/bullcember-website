# bullcember-live — the live-data proxy

Holds the Helius key so the browser never sees it, and caches every response at the
edge so credit burn is bounded by time rather than by traffic.

## Why it exists

Before this, every number on the site came from `data/*.json`, refreshed by
`.github/workflows/update-stats.yml`. The cron asks for every 15 minutes; GitHub
delivers about **7%** of those runs, median gap **~3.5 hours**. So "live buys" were
routinely 90+ minutes stale and payout rounds could sit unrecorded for days.

The naive fix is to let the browser call Helius directly. That is exactly what was
in `index.html` until **2026-08-25**, when the hardcoded key hit
`max usage reached` and every live widget hung on its loading string. Credit burn
scaled with traffic, and the key was there for anyone to lift.

This Worker keeps the live reads but removes both failure modes:

- the key is a Cloudflare **secret**, never shipped to a client
- responses are cached in `caches.default`, so a thousand concurrent visitors
  collapse into roughly **3 upstream calls a minute** per route

## Endpoints

| route | returns | edge TTL |
|---|---|---|
| `GET /buys` | 12 most recent buys off the PumpSwap pool | 15s |
| `GET /engine?since=<unix>` | classified buyback/burn events newer than `since` | 45s |
| `GET /rewards?since=<unix>` | payout rounds newer than `since`, plus collected/overhead | 45s |
| `GET /volume` | `{ totalUsd }` — lifetime traded volume, summed from daily OHLCV | 1h |

`since` is the newest timestamp the caller already has from its baseline JSON, so in
steady state these return an empty delta and cost almost nothing. It is clamped
server-side — a bogus value cannot widen the upstream fan-out.

`/engine` classification is a direct port of `scripts/scan.mjs`. **If you change the
rules in one, change them in the other**, or the live delta will disagree with the
published totals it gets added to.

`/volume` is the odd one out: it fronts **Birdeye**, not Helius, and needs its own
`BIRDEYE_KEY` secret. The key gate is per route, so a missing Birdeye secret takes
out `/volume` alone (503) and leaves the other three working. It ignores `since`.

Why it exists: the page used to sum that history in the browser, paging Birdeye
several times per load with the key hardcoded in `index.html`. That is the same
exposure that killed the site on 2026-08-25, and the burst of calls tripped the
free tier, which left a dash on the Total Volume tile. At a 1h TTL the whole
internet costs Birdeye **24 calls a day**.

## Deploy

```bash
cd worker
npx wrangler login
npx wrangler secret put HELIUS_KEY    # paste the Helius key, not the full RPC URL
npx wrangler secret put BIRDEYE_KEY   # only /volume needs this
npx wrangler deploy
```

Then point the site at it — in `index.html`, set:

```js
const LIVE_API = 'https://bullcember-live.<your-subdomain>.workers.dev';
```

Leave `LIVE_API` empty and the site behaves exactly as it did before: baseline JSON
only, no live top-up, no errors. That is the intended fallback, not a degraded mode.

## Free-tier cost

Cloudflare Workers free tier is 100k requests/day. With the TTLs above, upstream
Helius calls are capped at roughly `(4 + 1.3 + 1.3) × 60 × 24 ≈ 9.5k/day` no matter
how much traffic the site gets — the edge absorbs the rest.

## Tests

```bash
cd worker && node test.mjs
```

No key and no network: `fetch` and the Cache API are stubbed. Covers routing and
guards, the buy/burn/buyback classification rules, round bucketing, and the cache
behaviour that keeps credit burn flat under load.

The classification cases are the ones worth keeping honest — they encode the same
rules as `scripts/scan.mjs`, including the pump.fun boost transaction that must emit
**both** a burn and a buyback under a single signature.

## Checking it works

```bash
curl -s "https://<your-worker-url>/buys" | head -c 300
curl -s "https://<your-worker-url>/volume"          # {"updatedAt":...,"totalUsd":179081.xx}
curl -sI "https://<your-worker-url>/buys" | grep -i "x-bull-cache\|cache-control"
```

Until `BIRDEYE_KEY` is set, `/volume` answers `503 worker not configured: BIRDEYE_KEY`
and the page silently falls back to calling Birdeye directly — so nothing breaks, it
just keeps using the in-page key. Once the secret is set and this route answers 200,
the `BIRDEYE_KEY` constant in `index.html` is dead and should be deleted.

A second call within the TTL should report `x-bull-cache: HIT`.
