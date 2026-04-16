import {
  ExchangeAdapter,
  FundingInfo,
  normalizeBaseToken,
  fetchWithTimeout,
} from "./types";
import { GateMarginPair, GateBorrowInfo } from "@/types";

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

/**
 * Fetch Gate isolated-margin borrow info per token.
 *
 * Public data source (fast, no auth):
 * - Borrow APR: GET /api/v4/earn/uni/rate (est_rate annual decimal)
 * - Liquidity (USDT cap): GET /api/v4/margin/currency_pairs (`max_quote_amount` for USDT pairs)
 * - Spot price: GET /api/v4/spot/tickers (for optional token amount display)
 */
export async function fetchGateBorrowInfo(
  tokens: string[]
): Promise<Map<string, GateBorrowInfo>> {
  const [ratesRes, marginPairsRes, spotRes] = await Promise.allSettled([
    fetchWithTimeout("https://api.gateio.ws/api/v4/earn/uni/rate", {}, 15_000).then(
      (r) => (r.ok ? (r.json() as Promise<GateEarnUniRate[]>) : ([] as GateEarnUniRate[]))
    ),
    fetchWithTimeout("https://api.gateio.ws/api/v4/margin/currency_pairs", {}, 15_000).then(
      (r) => (r.ok ? (r.json() as Promise<GateMarginPairRaw[]>) : ([] as GateMarginPairRaw[]))
    ),
    fetchWithTimeout("https://api.gateio.ws/api/v4/spot/tickers", {}, 15_000).then(
      (r) => (r.ok ? (r.json() as Promise<GateSpotTicker[]>) : ([] as GateSpotTicker[]))
    ),
  ]);

  const spotMap = new Map<string, number>();
  if (spotRes.status === "fulfilled") {
    for (const item of spotRes.value) {
      if (item.currency_pair.endsWith("_USDT")) {
        const base = item.currency_pair.replace("_USDT", "").toUpperCase();
        spotMap.set(base, parseFloat(item.last || "0"));
      }
    }
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

  /** Per-base max quote (USDT) from isolated margin pairs (platform cap, not live pool). */
  const maxQuoteUsdtByBase = new Map<string, number>();
  if (marginPairsRes.status === "fulfilled") {
    for (const p of marginPairsRes.value) {
      if (p.quote !== "USDT" || p.status !== 1) continue;
      const base = (p.base || "").toUpperCase();
      if (!base) continue;
      const maxQuote = parseFloat(p.max_quote_amount || "0");
      if (!Number.isFinite(maxQuote) || maxQuote <= 0) continue;
      // If duplicates exist, keep the max cap we see.
      const prev = maxQuoteUsdtByBase.get(base);
      if (prev == null || maxQuote > prev) maxQuoteUsdtByBase.set(base, maxQuote);
    }
  }

  const result = new Map<string, GateBorrowInfo>();
  for (const token of tokens) {
    const upper = token.toUpperCase();
    const spotPrice = spotMap.get(upper) ?? 0;
    const liquidityUsdt = maxQuoteUsdtByBase.get(upper) ?? null;
    const liquidityToken =
      liquidityUsdt != null && spotPrice > 0 ? liquidityUsdt / spotPrice : null;

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
