import { NextResponse } from "next/server";
import {
  GateFuturesAdapter,
  fetchGateBorrowInfo,
  fetchGateMarginPairs,
} from "@/lib/exchanges/gate";
import { BinanceAdapter } from "@/lib/exchanges/binance";
import { OkxAdapter } from "@/lib/exchanges/okx";
import { BybitAdapter } from "@/lib/exchanges/bybit";
import { BitgetAdapter } from "@/lib/exchanges/bitget";
import { BingXAdapter } from "@/lib/exchanges/bingx";
import { XtAdapter } from "@/lib/exchanges/xt";
import { MexcAdapter } from "@/lib/exchanges/mexc";
import { BitMartAdapter } from "@/lib/exchanges/bitmart";
import { KuCoinAdapter } from "@/lib/exchanges/kucoin";
import { ExchangeAdapter, toFundingAPR, FundingInfo } from "@/lib/exchanges/types";
import { ArbitrageRow, ScanResponse } from "@/types";
import { getTradingFeesPercent } from "@/lib/fees";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * When `SCAN_UPSTREAM_URL` is set (e.g. Railway app origin), this route returns a **read-only
 * copy** of `GET {origin}/api/scan` only — no POST body, no mutations on the remote host.
 * Opt-in flag `SCAN_UPSTREAM_ENABLED` is not required: URL alone enables the mirror (unless
 * `SCAN_UPSTREAM_DISABLED` is set).
 */
function scanUpstreamBase(): string | null {
  const raw = process.env.SCAN_UPSTREAM_URL?.trim();
  if (!raw) return null;
  return raw.replace(/\/+$/, "");
}

function normalizeHost(host: string): string {
  return host.split(":")[0]?.toLowerCase() ?? "";
}

/**
 * Avoid accidental infinite recursion / self-proxying:
 * if SCAN_UPSTREAM_URL points to the same host as the incoming /api/scan request,
 * skip upstream and compute locally.
 */
function upstreamWouldLoopToSelf(request: Request, upstreamBase: string): boolean {
  try {
    const upstream = new URL(upstreamBase);
    const incoming = new URL(request.url);

    const upstreamHost = normalizeHost(upstream.hostname);
    const selfHost = normalizeHost(
      request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() ||
        incoming.hostname
    );

    if (!upstreamHost || !selfHost) return false;
    return upstreamHost === selfHost;
  } catch {
    return false;
  }
}

async function tryRespondWithUpstreamScanCopy(
  request: Request
): Promise<NextResponse | null> {
  const upstreamDisabled =
    process.env.SCAN_UPSTREAM_DISABLED?.trim() === "1" ||
    process.env.SCAN_UPSTREAM_DISABLED?.trim()?.toLowerCase() === "true";
  if (upstreamDisabled) return null;

  const base = scanUpstreamBase();
  if (!base) return null;
  if (upstreamWouldLoopToSelf(request, base)) {
    console.warn(
      `[scan] SCAN_UPSTREAM_URL points to this same host (${base}); skipping upstream to avoid self-proxy loops`
    );
    return null;
  }

  const url = `${base}/api/scan`;
  const timeoutMs = Math.max(
    5_000,
    parseInt(process.env.SCAN_UPSTREAM_TIMEOUT_MS ?? "120000", 10) || 120_000
  );

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.text();
    console.log(`[scan] read-only copy: GET ${url} → HTTP ${res.status}, ${body.length} B`);

    const ct =
      res.headers.get("Content-Type")?.split(";")[0]?.trim() || "application/json";

    return new NextResponse(body, {
      status: res.status,
      headers: {
        "Content-Type": ct,
        "X-Scan-Data-Source": "upstream-readonly-copy",
        "X-Scan-Upstream-Base": base,
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[scan] upstream read-only copy failed: ${msg}`);
    const errFetchedAt = Date.now();
    return NextResponse.json(
      {
        rows: [],
        fetchedAt: errFetchedAt,
        errors: { "Scan.Upstream": msg },
      },
      {
        status: 502,
        headers: {
          "X-Scan-Data-Source": "upstream-error",
          "X-Scan-Upstream-Base": base,
        },
      }
    );
  }
}

// All exchange adapters
const adapters: ExchangeAdapter[] = [
  new BinanceAdapter(),
  new OkxAdapter(),
  new BybitAdapter(),
  new GateFuturesAdapter(),
  new BitgetAdapter(),
  new BingXAdapter(),
  new XtAdapter(),
  new MexcAdapter(),
  new BitMartAdapter(),
  new KuCoinAdapter(),
];

const SWR_TTL_MS = Math.max(
  5_000,
  parseInt(process.env.SCAN_SWR_TTL_MS ?? "45000", 10) || 45_000
);

let lastGoodResponse: ScanResponse | null = null;
let refreshInProgress: Promise<void> | null = null;

async function buildScanResponse(): Promise<ScanResponse> {
  const errors: Record<string, string> = {};
  const fetchedAt = Date.now();

  // Step 1: fetch Gate isolated-margin USDT bases (borrow side universe)
  let gatePairs: { base: string; id: string }[] = [];
  try {
    const pairs = await fetchGateMarginPairs();
    gatePairs = pairs.map((p) => ({ base: p.base, id: p.id }));
  } catch (err) {
    errors["Gate.MarginPairs"] = err instanceof Error ? err.message : String(err);
    return { rows: [], fetchedAt, errors };
  }

  const gateTokens = [...new Set(gatePairs.map((p) => p.base.toUpperCase()))];
  const tokenSet = new Set(gateTokens);

  // Step 2: fetch all exchange funding first. This lets us limit expensive Gate signed
  // borrowable calls only to tokens that actually have at least one funding venue.
  const adapterResults = await Promise.allSettled(
    adapters.map((adapter) =>
      adapter
        .fetchFunding(tokenSet)
        .then((map) => ({ name: adapter.name, map }))
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          return { name: adapter.name, map: new Map<string, FundingInfo>(), error: msg };
        })
    )
  );

  // Build exchange funding maps
  const exchangeFundingMaps = new Map<string, Map<string, FundingInfo>>();
  for (const result of adapterResults) {
    if (result.status === "fulfilled") {
      const { name, map, error } = result.value as {
        name: string;
        map: Map<string, FundingInfo>;
        error?: string;
      };
      if (error) errors[name] = error;
      exchangeFundingMaps.set(name, map);
    }
  }

  const relevantTokens = gateTokens.filter((token) =>
    [...exchangeFundingMaps.values()].some((fundingMap) => fundingMap.has(token))
  );

  // Step 3: fetch Gate borrow side only for tokens that can actually produce rows.
  const borrowMap = new Map<
    string,
    { borrowAPR: number; liquidityToken: number | null; liquidityUsdt: number | null; spotPrice: number }
  >();
  if (relevantTokens.length > 0) {
    try {
      const borrowInfo = await fetchGateBorrowInfo(relevantTokens);
      for (const [token, info] of borrowInfo.entries()) {
        borrowMap.set(token, {
          borrowAPR: info.borrowAPR,
          liquidityToken: info.liquidityToken,
          liquidityUsdt: info.liquidityUsdt,
          spotPrice: info.spotPrice,
        });
      }
    } catch (err) {
      errors["Gate.Borrow"] = err instanceof Error ? err.message : String(err);
    }
  }

  // Step 4: build arbitrage rows
  const rows: ArbitrageRow[] = [];

  for (const token of relevantTokens) {
    const borrow = borrowMap.get(token);
    const borrowAPR = borrow?.borrowAPR ?? 0;
    const spotPrice = borrow?.spotPrice ?? 0;
    const liquidityToken = borrow?.liquidityToken ?? null;
    const liquidityUsdt = borrow?.liquidityUsdt ?? null;

    for (const [exchangeName, fundingMap] of exchangeFundingMaps.entries()) {
      const funding = fundingMap.get(token);
      if (!funding) continue;

      const fundingAPR = toFundingAPR(funding.rawFundingRate, funding.intervalHours);

      const spread =
        spotPrice > 0 && funding.markPrice > 0
          ? ((funding.markPrice - spotPrice) / spotPrice) * 100
          : 0;

      const tradingFees = getTradingFeesPercent(exchangeName);
      const netAPR = fundingAPR - borrowAPR - tradingFees;

      rows.push({
        id: `${token}-${exchangeName}`,
        token,
        exchange: exchangeName,
        rawFunding: funding.rawFundingRate,
        intervalHours: funding.intervalHours,
        fundingAPR,
        borrowAPR,
        tradingFees,
        netAPR,
        spread,
        futuresPrice: funding.markPrice,
        spotPrice,
        borrowLiquidityToken: liquidityToken,
        borrowLiquidityUsdt: liquidityUsdt,
        nextFundingTime: funding.nextFundingTime,
        updatedAt: fetchedAt,
      });
    }
  }

  // Sort by netAPR descending by default
  rows.sort((a, b) => b.netAPR - a.netAPR);

  return { rows, fetchedAt, errors };
}

export async function GET(request: Request) {
  const upstream = await tryRespondWithUpstreamScanCopy(request);
  if (upstream) return upstream;

  const now = Date.now();
  const cached = lastGoodResponse;
  const ageMs = cached ? now - cached.fetchedAt : null;
  const isFresh = cached && ageMs != null && ageMs < SWR_TTL_MS;

  // Fresh cache: return immediately
  if (cached && isFresh) {
    return NextResponse.json(cached, {
      headers: {
        "X-Scan-Cache": "hit",
        "X-Scan-Cache-Age-Ms": String(ageMs),
      },
    });
  }

  // Stale cache: return immediately and refresh in background
  if (cached && !isFresh) {
    if (!refreshInProgress) {
      refreshInProgress = buildScanResponse()
        .then((data) => {
          lastGoodResponse = data;
        })
        .catch((e) => {
          const msg = e instanceof Error ? e.message : String(e);
          console.error(`[scan] background refresh failed: ${msg}`);
        })
        .finally(() => {
          refreshInProgress = null;
        });
    }
    return NextResponse.json(cached, {
      headers: {
        "X-Scan-Cache": "stale",
        "X-Scan-Cache-Age-Ms": String(ageMs ?? ""),
      },
    });
  }

  // Cold start: build synchronously
  const data = await buildScanResponse();
  lastGoodResponse = data;
  return NextResponse.json(data, { headers: { "X-Scan-Cache": "miss" } });
}
