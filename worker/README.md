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

`since` is the newest timestamp the caller already has from its baseline JSON, so in
steady state these return an empty delta and cost almost nothing. It is clamped
server-side — a bogus value cannot widen the upstream fan-out.

`/engine` classification is a direct port of `scripts/scan.mjs`. **If you change the
rules in one, change them in the other**, or the live delta will disagree with the
published totals it gets added to.

## Deploy

```bash
cd worker
npx wrangler login
npx wrangler secret put HELIUS_KEY   # paste the Helius key, not the full RPC URL
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
curl -sI "https://<your-worker-url>/buys" | grep -i "x-bull-cache\|cache-control"
```

A second call within the TTL should report `x-bull-cache: HIT`.
