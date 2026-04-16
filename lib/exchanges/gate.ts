import {
  ExchangeAdapter,
  FundingInfo,
  normalizeBaseToken,
  fetchWithTimeout,
} from "./types";
import { GateMarginPair, GateBorrowInfo } from "@/types";
import { gateFetchSigned, getGateCredentialsFromEnv } from "@/lib/gateAuth";

// ─── Margin pairs ───────────────────────────────────────────────────────────

interface GateMarginPairRaw {
  id: string; // "BTC_USDT"
  base: string;
  quote: string;
  leverage: number;
  min_base_amount: string;
  min_quote_amount: string;
  max_quote_amount: string;
  status: number; // 1 = trading enabled
}

export async function fetchGateMarginPairs(): Promise<GateMarginPair[]> {
  const res = await fetchWithTimeout(
    "https://api.gateio.ws/api/v4/margin/currency_pairs"
  );
  if (!res.ok) throw new Error(`Gate margin pairs HTTP ${res.status}`);
  const data: GateMarginPairRaw[] = await res.json();

  return data
    .filter((p) => p.quote === "USDT" && p.status === 1)
    .map((p) => ({ id: p.id, base: p.base, quote: p.quote }));
}

// ─── Borrow rates & liquidity ────────────────────────────────────────────────

interface GateSpotTicker {
  currency_pair: string;
  last: string;
  lowest_ask: string;
  highest_bid: string;
}

interface GateEarnUniRate {
  currency: string; // e.g. "BTC"
  est_rate: string; // annual decimal, e.g. "0.034953"
}

/** `GET /api/v4/margin/uni/borrowable` — signed, account-aware max borrow in base currency */
interface GateMaxUniBorrowable {
  currency?: string;
  currency_pair?: string;
  borrowable?: string;
}

function gateBorrowableConcurrency(): number {
  const raw = process.env.GATE_BORROWABLE_CONCURRENCY?.trim();
  const n = raw ? parseInt(raw, 10) : 18;
  if (!Number.isFinite(n)) return 18;
  return Math.max(1, Math.min(40, n));
}

/** When unique base count is at most this, fetch spot + margin per pair (small JSON) instead of full lists. */
function gatePairFetchThreshold(): number {
  const raw = process.env.GATE_PAIR_FETCH_THRESHOLD?.trim();
  const n = raw ? parseInt(raw, 10) : 140;
  if (!Number.isFinite(n)) return 140;
  return Math.max(30, Math.min(400, n));
}

function gatePublicPairConcurrency(): number {
  const raw = process.env.GATE_PUBLIC_PAIR_CONCURRENCY?.trim();
  const n = raw ? parseInt(raw, 10) : 16;
  if (!Number.isFinite(n)) return 16;
  return Math.max(4, Math.min(32, n));
}

function gateBorrowableTimeoutMs(): number {
  const raw = process.env.GATE_BORROWABLE_TIMEOUT_MS?.trim();
  const n = raw ? parseInt(raw, 10) : 15_000;
  if (!Number.isFinite(n)) return 15_000;
  return Math.max(3_000, Math.min(60_000, n));
}

/**
 * Run async work over `items` with at most `concurrency` in-flight tasks (pool of workers).
 */
async function runPool<T>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  if (items.length === 0) return;
  const limit = Math.max(1, Math.min(concurrency, items.length));
  let next = 0;

  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i]!);
    }
  };

  await Promise.all(Array.from({ length: limit }, () => worker()));
}

async function fetchGateSpotAndMarginMapsForBases(
  bases: readonly string[]
): Promise<{ spotMap: Map<string, number>; maxQuoteUsdtByBase: Map<string, number> }> {
  const spotMap = new Map<string, number>();
  const maxQuoteUsdtByBase = new Map<string, number>();
  const conc = gatePublicPairConcurrency();

  await Promise.all([
    runPool(bases, conc, async (base) => {
      const pair = `${base}_USDT`;
      try {
        const res = await fetchWithTimeout(
          `https://api.gateio.ws/api/v4/spot/tickers?currency_pair=${encodeURIComponent(pair)}`,
          {},
          12_000
        );
        if (!res.ok) return;
        const arr: GateSpotTicker[] = await res.json();
        const item = Array.isArray(arr) ? arr[0] : null;
        if (!item?.last) return;
        const px = parseFloat(item.last);
        if (Number.isFinite(px) && px > 0) spotMap.set(base, px);
      } catch {
        /* ignore */
      }
    }),
    runPool(bases, conc, async (base) => {
      const pair = `${base}_USDT`;
      try {
        const res = await fetchWithTimeout(
          `https://api.gateio.ws/api/v4/margin/currency_pairs/${encodeURIComponent(pair)}`,
          {},
          12_000
        );
        if (!res.ok) return;
        const p = (await res.json()) as GateMarginPairRaw;
        if (p.quote !== "USDT" || p.status !== 1) return;
        const maxQuote = parseFloat(p.max_quote_amount || "0");
        if (!Number.isFinite(maxQuote) || maxQuote <= 0) return;
        const prev = maxQuoteUsdtByBase.get(base);
        if (prev == null || maxQuote > prev) maxQuoteUsdtByBase.set(base, maxQuote);
      } catch {
        /* ignore */
      }
    }),
  ]);

  return { spotMap, maxQuoteUsdtByBase };
}

async function fetchGateSpotAndMarginMapsBulk(): Promise<{
  spotMap: Map<string, number>;
  maxQuoteUsdtByBase: Map<string, number>;
}> {
  const spotMap = new Map<string, number>();
  const maxQuoteUsdtByBase = new Map<string, number>();

  const [marginPairsRes, spotRes] = await Promise.allSettled([
    fetchWithTimeout("https://api.gateio.ws/api/v4/margin/currency_pairs", {}, 20_000).then(
      (r) => (r.ok ? (r.json() as Promise<GateMarginPairRaw[]>) : ([] as GateMarginPairRaw[]))
    ),
    fetchWithTimeout("https://api.gateio.ws/api/v4/spot/tickers", {}, 20_000).then(
      (r) => (r.ok ? (r.json() as Promise<GateSpotTicker[]>) : ([] as GateSpotTicker[]))
    ),
  ]);

  if (spotRes.status === "fulfilled") {
    for (const item of spotRes.value) {
      if (item.currency_pair.endsWith("_USDT")) {
        const base = item.currency_pair.replace("_USDT", "").toUpperCase();
        spotMap.set(base, parseFloat(item.last || "0"));
      }
    }
  }

  if (marginPairsRes.status === "fulfilled") {
    for (const p of marginPairsRes.value) {
      if (p.quote !== "USDT" || p.status !== 1) continue;
      const base = (p.base || "").toUpperCase();
      if (!base) continue;
      const maxQuote = parseFloat(p.max_quote_amount || "0");
      if (!Number.isFinite(maxQuote) || maxQuote <= 0) continue;
      const prev = maxQuoteUsdtByBase.get(base);
      if (prev == null || maxQuote > prev) maxQuoteUsdtByBase.set(base, maxQuote);
    }
  }

  return { spotMap, maxQuoteUsdtByBase };
}

/**
 * Fetch Gate isolated-margin borrow info per token.
 *
 * Public (always):
 * - Borrow APR: GET /api/v4/earn/uni/rate (`est_rate` annual decimal → %)
 * - Spot + margin cap: either per-pair `spot/tickers?currency_pair=` and
 *   `margin/currency_pairs/{PAIR}` when base count ≤ `GATE_PAIR_FETCH_THRESHOLD`, or full list
 *   endpoints (large JSON) above that threshold.
 * - Fallback liquidity: `max_quote_amount` from margin pair (platform cap)
 *
 * Optional signed (`GATE_API_KEY` + `GATE_API_SECRET`):
 * - GET /api/v4/margin/uni/borrowable?currency=BASE&currency_pair=BASE_USDT → `borrowable` (base units)
 *   Per-token, concurrency-limited (`GATE_BORROWABLE_CONCURRENCY`). On error / missing value → fallback cap.
 */
export async function fetchGateBorrowInfo(
  tokens: string[]
): Promise<Map<string, GateBorrowInfo>> {
  const uniqueBases = [...new Set(tokens.map((t) => t.toUpperCase()))].sort();
  if (uniqueBases.length === 0) {
    return new Map();
  }

  const threshold = gatePairFetchThreshold();

  const [ratesRes, mapsRes] = await Promise.allSettled([
    fetchWithTimeout("https://api.gateio.ws/api/v4/earn/uni/rate", {}, 15_000).then(
      (r) => (r.ok ? (r.json() as Promise<GateEarnUniRate[]>) : ([] as GateEarnUniRate[]))
    ),
    uniqueBases.length <= threshold && uniqueBases.length > 0
      ? fetchGateSpotAndMarginMapsForBases(uniqueBases)
      : fetchGateSpotAndMarginMapsBulk(),
  ]);

  const spotMap = new Map<string, number>();
  const maxQuoteUsdtByBase = new Map<string, number>();
  if (mapsRes.status === "fulfilled") {
    for (const [k, v] of mapsRes.value.spotMap) spotMap.set(k, v);
    for (const [k, v] of mapsRes.value.maxQuoteUsdtByBase) maxQuoteUsdtByBase.set(k, v);
  }

  const aprMap = new Map<string, number>();
  if (ratesRes.status === "fulfilled") {
    for (const item of ratesRes.value) {
      const upper = (item.currency || "").toUpperCase();
      if (!upper) continue;
      const est = parseFloat(item.est_rate || "0");
      if (!Number.isFinite(est) || est <= 0) continue;
      aprMap.set(upper, est * 100);
    }
  }

  const creds = getGateCredentialsFromEnv();
  /** `null` = error / missing; `0` = valid zero borrowable */
  const signedBorrowableByBase = new Map<string, number | null>();

  if (creds && uniqueBases.length > 0) {
    const path = "/api/v4/margin/uni/borrowable";
    const conc = gateBorrowableConcurrency();
    const timeoutMs = gateBorrowableTimeoutMs();

    await runPool(uniqueBases, conc, async (base) => {
      try {
        const res = await gateFetchSigned(creds, path, {
          query: [
            ["currency", base],
            ["currency_pair", `${base}_USDT`],
          ],
          timeoutMs,
        });
        if (!res.ok) {
          signedBorrowableByBase.set(base, null);
          return;
        }
        const data = (await res.json()) as GateMaxUniBorrowable;
        const raw = data.borrowable;
        if (raw == null || raw === "") {
          signedBorrowableByBase.set(base, null);
          return;
        }
        const b = parseFloat(String(raw));
        if (!Number.isFinite(b) || b < 0) {
          signedBorrowableByBase.set(base, null);
          return;
        }
        signedBorrowableByBase.set(base, b);
      } catch {
        signedBorrowableByBase.set(base, null);
      }
    });
  }

  const result = new Map<string, GateBorrowInfo>();
  for (const token of tokens) {
    const upper = token.toUpperCase();
    const spotPrice = spotMap.get(upper) ?? 0;

    const capUsdt = maxQuoteUsdtByBase.get(upper) ?? null;
    const capToken =
      capUsdt != null && spotPrice > 0 ? capUsdt / spotPrice : null;

    let liquidityToken: number | null = capToken;
    let liquidityUsdt: number | null = capUsdt;

    if (creds) {
      const signed = signedBorrowableByBase.get(upper);
      if (signed != null) {
        liquidityToken = signed;
        liquidityUsdt = spotPrice > 0 ? signed * spotPrice : signed === 0 ? 0 : null;
      }
      // signed === null → keep margin-pair cap fallback
    }

    result.set(upper, {
      currency: upper,
      borrowAPR: aprMap.get(upper) ?? 0,
      liquidityToken: liquidityToken ?? null,
      liquidityUsdt,
      spotPrice,
    });
  }
  return result;
}

// ─── Gate futures funding (as one of the 10 exchanges) ──────────────────────

interface GateContract {
  name: string; // "BTC_USDT"
  mark_price: string;
  funding_rate: string; // current funding rate decimal
  funding_next_apply: number; // unix seconds
  funding_interval: number; // seconds (e.g. 28800 = 8h)
}

export class GateFuturesAdapter implements ExchangeAdapter {
  name = "Gate";

  async fetchFunding(
    filterTokens?: Set<string>
  ): Promise<Map<string, FundingInfo>> {
    const res = await fetchWithTimeout(
      "https://fx-api.gateio.ws/api/v4/futures/usdt/contracts"
    );
    if (!res.ok) throw new Error(`Gate futures HTTP ${res.status}`);
    const data: GateContract[] = await res.json();

    const result = new Map<string, FundingInfo>();
    for (const item of data) {
      if (!item.name.endsWith("_USDT")) continue;
      const base = item.name.replace("_USDT", "").toUpperCase();
      if (filterTokens && !filterTokens.has(base)) continue;

      const intervalHours = (item.funding_interval || 28800) / 3600;

      result.set(base, {
        exchange: this.name,
        baseToken: base,
        originalSymbol: item.name,
        rawFundingRate: parseFloat(item.funding_rate || "0"),
        markPrice: parseFloat(item.mark_price || "0"),
        nextFundingTime: (item.funding_next_apply || 0) * 1000,
        intervalHours,
      });
    }
    return result;
  }
}

// Suppress unused import warning — normalizeBaseToken is re-exported from types
void normalizeBaseToken;
