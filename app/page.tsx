"use client";

import { useEffect, useMemo, useState } from "react";
import { Providers } from "@/components/Providers";
import { ArbitrageTable } from "@/components/ArbitrageTable";
import { TokenModal } from "@/components/TokenModal";
import { StatusBar } from "@/components/StatusBar";
import { useArbitrageData } from "@/hooks/useArbitrageData";
import { ArbitrageRow } from "@/types";

const FUTURES_EXCHANGES_DEFAULT = [
  "Binance",
  "OKX",
  "Bybit",
  "Gate",
  "Bitget",
  "BingX",
  "XT",
  "MEXC",
  "BitMart",
  "KuCoin",
] as const;

const EXCHANGE_TOGGLES_LS_KEY = "fa.enabledFuturesExchanges.v1";

function Dashboard() {
  const {
    rows,
    fetchedAt,
    errors,
    isLoading,
    isFetching,
    isError,
    getHistory,
    refetch,
  } = useArbitrageData();

  const [search, setSearch] = useState("");
  const [selectedRow, setSelectedRow] = useState<ArbitrageRow | null>(null);
  const [showExchangeToggles, setShowExchangeToggles] = useState(false);
  const [enabledExchanges, setEnabledExchanges] = useState<Set<string>>(
    () => new Set(FUTURES_EXCHANGES_DEFAULT)
  );

  useEffect(() => {
    try {
      const raw = localStorage.getItem(EXCHANGE_TOGGLES_LS_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        const next = new Set<string>();
        for (const v of parsed) if (typeof v === "string") next.add(v);
        if (next.size > 0) setEnabledExchanges(next);
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(EXCHANGE_TOGGLES_LS_KEY, JSON.stringify([...enabledExchanges]));
    } catch {
      // ignore
    }
  }, [enabledExchanges]);

  const availableExchanges = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) set.add(r.exchange);
    for (const name of FUTURES_EXCHANGES_DEFAULT) set.add(name);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [rows]);

  const filteredRows = useMemo(() => {
    return rows.filter((r) => {
      if (!enabledExchanges.has(r.exchange)) return false;
      return true;
    });
  }, [rows, enabledExchanges]);

  return (
    <div className="min-h-screen bg-[#0a0e17]">
      {/* Header */}
      <header className="border-b border-gray-800 bg-gray-900/50 backdrop-blur-sm sticky top-0 z-30">
        <div className="max-w-screen-2xl mx-auto px-4 py-3 flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center text-white font-bold text-sm">
              FA
            </div>
            <div>
              <h1 className="text-white font-semibold leading-tight">
                Funding Arbitrage Scanner
              </h1>
              <p className="text-gray-500 text-xs leading-tight">
                Gate isolated margin short · Long → Futures
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3 flex-1 max-w-md">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search token or exchange..."
              className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 transition-colors"
            />
            <div className="relative">
              <button
                onClick={() => setShowExchangeToggles((v) => !v)}
                className="bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-300 transition-colors whitespace-nowrap"
                title="Enable/disable futures exchanges"
                type="button"
              >
                Exchanges
              </button>
              {showExchangeToggles && (
                <div className="absolute right-0 mt-2 w-64 rounded-lg border border-gray-700 bg-gray-900 shadow-xl p-3 z-50">
                  <div className="flex items-center justify-between mb-2">
                    <div className="text-xs text-gray-400">Futures exchanges</div>
                    <button
                      className="text-xs text-gray-400 hover:text-white"
                      onClick={() => setEnabledExchanges(new Set(availableExchanges))}
                      type="button"
                    >
                      All
                    </button>
                  </div>
                  <div className="max-h-64 overflow-auto pr-1 space-y-1">
                    {availableExchanges.map((name) => {
                      const checked = enabledExchanges.has(name);
                      return (
                        <label key={name} className="flex items-center gap-2 text-sm text-gray-200">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => {
                              setEnabledExchanges((prev) => {
                                const next = new Set(prev);
                                if (next.has(name)) next.delete(name);
                                else next.add(name);
                                if (next.size === 0) return prev;
                                return next;
                              });
                            }}
                          />
                          <span>{name}</span>
                        </label>
                      );
                    })}
                  </div>
                  <div className="mt-3 flex items-center justify-between">
                    <button
                      className="text-xs text-gray-400 hover:text-white"
                      onClick={() => setEnabledExchanges(new Set(FUTURES_EXCHANGES_DEFAULT))}
                      type="button"
                    >
                      Reset
                    </button>
                    <button
                      className="text-xs text-gray-400 hover:text-white"
                      onClick={() => setShowExchangeToggles(false)}
                      type="button"
                    >
                      Close
                    </button>
                  </div>
                </div>
              )}
            </div>
            <button
              onClick={() => refetch()}
              disabled={isFetching}
              className="bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-300 disabled:opacity-50 transition-colors whitespace-nowrap"
            >
              {isFetching ? "..." : "↺ Refresh"}
            </button>
          </div>
        </div>
      </header>

      {/* Status bar */}
      <div className="max-w-screen-2xl mx-auto px-4 py-2">
        <StatusBar
          fetchedAt={fetchedAt}
          isFetching={isFetching}
          isError={isError}
          rowCount={rows.length}
          errors={errors}
        />
      </div>

      {/* Legend */}
      <div className="max-w-screen-2xl mx-auto px-4 pb-2">
        <div className="flex flex-wrap gap-4 text-xs text-gray-500">
          <span>
            <span className="text-white">Long →</span> Futures exchange (always)
          </span>
          <span>
            <span className="text-white">Short →</span> Gate isolated margin (always)
          </span>
          <span className="text-gray-700">·</span>
          <span>
            <span className="text-blue-400">Funding APR</span> = Raw Rate ×
            (8760 / interval_h) × 100
          </span>
          <span className="text-gray-700">·</span>
          <span>
            <span className="text-green-400">Net APR</span> = Funding APR − Borrow APR − Trading fees
          </span>
          <span className="text-gray-700">·</span>
          <span>
            <span className="text-purple-400">Spread</span> = (Futures − Spot)
            / Spot × 100 (not in APR)
          </span>
        </div>
      </div>

      {/* Main table */}
      <main className="max-w-screen-2xl mx-auto px-4 pb-8">
        <div className="bg-gray-900/50 border border-gray-800 rounded-xl overflow-hidden">
          {isError ? (
            <div className="flex flex-col items-center justify-center h-48 gap-2">
              <div className="text-red-400 text-sm">Failed to load data</div>
              <button
                onClick={() => refetch()}
                className="text-blue-400 text-sm hover:underline"
              >
                Retry
              </button>
            </div>
          ) : (
            <div className="relative">
              {(isLoading || isFetching) && filteredRows.length === 0 ? (
                <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-[#0a0e17]/80 backdrop-blur-[2px] pointer-events-none">
                  <div className="w-7 h-7 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                  <div className="text-gray-400 text-xs px-4 text-center">
                    Загрузка первого скана (биржи + Gate)… страница уже открыта, данные появятся в
                    таблице.
                  </div>
                </div>
              ) : null}
              <ArbitrageTable
                rows={filteredRows}
                search={search}
                onRowClick={setSelectedRow}
              />
            </div>
          )}
        </div>
      </main>

      {/* Token Modal */}
      {selectedRow && (
        <TokenModal
          row={selectedRow}
          history={getHistory(selectedRow.id)}
          onClose={() => setSelectedRow(null)}
        />
      )}
    </div>
  );
}

export default function Home() {
  return (
    <Providers>
      <Dashboard />
    </Providers>
  );
}
