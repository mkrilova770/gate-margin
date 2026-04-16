"use client";

import { useQuery } from "@tanstack/react-query";
import { ScanResponse } from "@/types";
import { useHistory } from "./useHistory";
import { useEffect } from "react";

const REFETCH_INTERVAL_MS = 30_000; // 30 seconds
/** Browser fetch has no default timeout; local full scan + Bitget margin-loans can exceed 2 min. */
const SCAN_FETCH_TIMEOUT_MS = 360_000;

async function fetchScan(): Promise<ScanResponse> {
  try {
    const res = await fetch("/api/scan", {
      signal: AbortSignal.timeout(SCAN_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Scan API error: ${res.status}`);
    return res.json();
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    if (name === "AbortError" || name === "TimeoutError") {
      throw new Error(
        `Scan timed out after ${SCAN_FETCH_TIMEOUT_MS / 1000}s — try upstream mirror (SCAN_UPSTREAM_URL) or Retry`
      );
    }
    throw e;
  }
}

export function useArbitrageData() {
  const { recordRows, getHistory } = useHistory();

  const query = useQuery<ScanResponse>({
    queryKey: ["arbitrage-scan"],
    queryFn: fetchScan,
    refetchInterval: REFETCH_INTERVAL_MS,
    refetchIntervalInBackground: true,
    staleTime: REFETCH_INTERVAL_MS,
    refetchOnWindowFocus: false,
    retry: 3,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 10000),
  });

  // Accumulate history on every successful fetch
  useEffect(() => {
    if (query.data?.rows) {
      recordRows(query.data.rows);
    }
  }, [query.data, recordRows]);

  return {
    rows: query.data?.rows ?? [],
    fetchedAt: query.data?.fetchedAt ?? 0,
    errors: query.data?.errors ?? {},
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isError: query.isError,
    error: query.error,
    getHistory,
    refetch: query.refetch,
  };
}
