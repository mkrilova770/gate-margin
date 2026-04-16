# Funding Arbitrage Scanner (Gate short)

Next.js app: **short / borrow** — **Gate isolated margin (USDT pairs)**; **long** — **USDT perpetual** on Binance, OKX, Bybit, Gate, Bitget, BingX, XT, MEXC, BitMart, KuCoin.

## Quick start

```bash
npm install
npm run dev
# http://localhost:3000
```

## Strategy

| Side | Market | Data |
|------|--------|------|
| **Short** | Gate isolated margin (base vs USDT) | Borrow APR from public `GET /api/v4/earn/uni/rate` (`est_rate`). Liquidity: optional signed `GET /api/v4/margin/uni/borrowable`, else public cap from `margin/currency_pairs.max_quote_amount`. |
| **Long** | USDT perp | Funding from each exchange adapter |

**Net APR** = Funding APR − Borrow APR − Trading fees (see `lib/fees.ts`).

## Formulas

### Funding APR (% per year)

```
Funding APR = rawFundingRate × (8760 / intervalHours) × 100
```

(same as `raw × 3 × 365 × 100` when interval is 8h)

### Borrow APR (Gate)

Annual % from `est_rate` on `GET /api/v4/earn/uni/rate` (already an annual decimal in the API).

### Borrow liquidity (display)

1. **With `GATE_API_KEY` / `GATE_API_SECRET`**: max borrowable base amount from `GET /api/v4/margin/uni/borrowable` (account / uni-margin context), converted to USDT with Gate spot last.
2. **Without keys**: fallback to platform cap `max_quote_amount` (USDT) from `GET /api/v4/margin/currency_pairs`, converted to base with spot.

Tune concurrency: `GATE_BORROWABLE_CONCURRENCY` (default `12`), timeout: `GATE_BORROWABLE_TIMEOUT_MS` (default `15000`).

## Architecture

1. `GET /api/scan` — universe from Gate `margin/currency_pairs` (USDT, enabled); borrow + spot; funding from all adapters in parallel (`Promise.allSettled`). In-memory SWR cache (`SCAN_SWR_TTL_MS`, default 45s): stale responses return immediately while a background refresh runs.
2. Frontend: React Query, table + charts.

## Deploy (Railway)

1. Push repo (no `.env.local` / secrets in git).
2. Railway → Deploy from GitHub; **`Dockerfile`** + **`railway.toml`** are used.
3. Variables: see table below. `PORT` is set by Railway.

### Environment variables

| Variable | Purpose | Required |
|----------|---------|----------|
| `GATE_API_KEY` / `GATE_API_SECRET` | Signed `margin/uni/borrowable` for liquidity column | No (fallback cap without) |
| `GATE_BORROWABLE_CONCURRENCY` | Parallel signed borrowable calls (1–40) | No |
| `GATE_BORROWABLE_TIMEOUT_MS` | Per-request timeout (ms) | No |
| `GATE_PAIR_FETCH_THRESHOLD` | If unique bases ≤ this, use small per-pair Gate spot/margin requests (default 140) | No |
| `GATE_PUBLIC_PAIR_CONCURRENCY` | Parallelism for those per-pair public calls (default 16) | No |
| `BITGET_API_KEY` / `BITGET_API_SECRET` / `BITGET_PASSPHRASE` | Bitget adapter borrow extras | No |
| `NEXT_PUBLIC_SCAN_TIMEOUT_MS` | Client fetch timeout for `/api/scan` | No |
| `SCAN_SWR_TTL_MS` | Server cache TTL before background refresh (ms) | No |
| `SCAN_UPSTREAM_URL` | If set, **this** service returns a read-only copy of `GET {origin}/api/scan` | No |
| `SCAN_UPSTREAM_TIMEOUT_MS` | Upstream fetch timeout | No |
| `SCAN_UPSTREAM_DISABLED` | `1` / `true` — force local scan even if `SCAN_UPSTREAM_URL` is set | No |

> **Security:** do not commit secrets. Use Railway Variables or local `.env.local` (gitignored).

## Docker image

Standard Node image from the repo `Dockerfile` (no Playwright in this project).

## Requirements

- Node 20+ (see `package.json` / Next 16)
- Outbound HTTPS to exchange APIs

See **`.env.example`** for local copy-paste.
