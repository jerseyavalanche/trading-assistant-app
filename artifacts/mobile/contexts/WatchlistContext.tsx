import AsyncStorage from "@react-native-async-storage/async-storage";
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { Platform } from "react-native";

export interface QuoteData {
  symbol: string;
  shortName: string;
  longName: string;
  regularMarketPrice: number;
  regularMarketChange: number;
  regularMarketChangePercent: number;
  currency: string;
}

interface WatchlistContextType {
  symbols: string[];
  prices: Record<string, QuoteData>;
  loading: boolean;
  addSymbol: (symbol: string) => Promise<void>;
  removeSymbol: (symbol: string) => void;
  refreshPrices: () => Promise<void>;
  searchSymbols: (query: string) => Promise<QuoteData[]>;
}

const WatchlistContext = createContext<WatchlistContextType | null>(null);

const STORAGE_KEY = "@watchlist_symbols";
const DEFAULT_SYMBOLS = ["^GSPC", "^IXIC", "^DJI", "AAPL", "MSFT", "GOOGL", "TSLA", "BTC-USD", "ETH-USD"];

const YAHOO_DIRECT = "https://query1.finance.yahoo.com";
const YAHOO_HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; TradingAssistant/1.0)" };

async function fetchQuotesDirect(symbols: string[]): Promise<QuoteData[]> {
  if (symbols.length === 0) return [];
  try {
    const url = `${YAHOO_DIRECT}/v7/finance/quote?symbols=${symbols.join(",")}&fields=regularMarketPrice,regularMarketChangePercent,regularMarketChange,longName,shortName,currency`;
    const res = await fetch(url, { headers: YAHOO_HEADERS });
    const json = await res.json();
    return json?.quoteResponse?.result ?? [];
  } catch {
    return [];
  }
}

async function fetchQuotesProxy(symbols: string[]): Promise<QuoteData[]> {
  if (symbols.length === 0) return [];
  try {
    const domain = process.env.EXPO_PUBLIC_DOMAIN ?? "";
    const base = domain ? `https://${domain}` : "";
    const res = await fetch(`${base}/api/market/quotes?symbols=${symbols.join(",")}`);
    const json = await res.json();
    return json?.quoteResponse?.result ?? [];
  } catch {
    return [];
  }
}

async function fetchQuotes(symbols: string[]): Promise<QuoteData[]> {
  if (Platform.OS === "web") return fetchQuotesProxy(symbols);
  return fetchQuotesDirect(symbols);
}

async function searchDirect(query: string): Promise<QuoteData[]> {
  try {
    const res = await fetch(
      `${YAHOO_DIRECT}/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=8&newsCount=0`,
      { headers: YAHOO_HEADERS }
    );
    const json = await res.json();
    const hits = (json?.quotes ?? []) as Array<{ symbol: string }>;
    const syms = hits.map((h) => h.symbol);
    if (syms.length === 0) return [];
    return await fetchQuotesDirect(syms);
  } catch {
    return [];
  }
}

async function searchProxy(query: string): Promise<QuoteData[]> {
  try {
    const domain = process.env.EXPO_PUBLIC_DOMAIN ?? "";
    const base = domain ? `https://${domain}` : "";
    const res = await fetch(`${base}/api/market/search?q=${encodeURIComponent(query)}`);
    const json = await res.json();
    return json?.quoteResponse?.result ?? [];
  } catch {
    return [];
  }
}

export function WatchlistProvider({ children }: { children: React.ReactNode }) {
  const [symbols, setSymbols] = useState<string[]>(DEFAULT_SYMBOLS);
  const [prices, setPrices] = useState<Record<string, QuoteData>>({});
  const [loading, setLoading] = useState(false);
  const refreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then((stored) => {
      if (stored) {
        const parsed = JSON.parse(stored) as string[];
        if (parsed.length > 0) setSymbols(parsed);
      }
    });
  }, []);

  const refreshPrices = useCallback(async () => {
    setLoading(true);
    try {
      const results = await fetchQuotes(symbols);
      const map: Record<string, QuoteData> = {};
      for (const r of results) map[r.symbol] = r;
      setPrices(map);
    } finally {
      setLoading(false);
    }
  }, [symbols]);

  useEffect(() => {
    refreshPrices();
    refreshTimerRef.current = setInterval(refreshPrices, 30000);
    return () => {
      if (refreshTimerRef.current) clearInterval(refreshTimerRef.current);
    };
  }, [refreshPrices]);

  const addSymbol = useCallback(
    async (symbol: string) => {
      const upper = symbol.toUpperCase();
      if (symbols.includes(upper)) return;
      const next = [...symbols, upper];
      setSymbols(next);
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    },
    [symbols]
  );

  const removeSymbol = useCallback(
    (symbol: string) => {
      const next = symbols.filter((s) => s !== symbol);
      setSymbols(next);
      AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    },
    [symbols]
  );

  const searchSymbols = useCallback(async (query: string): Promise<QuoteData[]> => {
    if (!query.trim()) return [];
    if (Platform.OS === "web") return searchProxy(query);
    return searchDirect(query);
  }, []);

  return (
    <WatchlistContext.Provider
      value={{ symbols, prices, loading, addSymbol, removeSymbol, refreshPrices, searchSymbols }}
    >
      {children}
    </WatchlistContext.Provider>
  );
}

export function useWatchlist() {
  const ctx = useContext(WatchlistContext);
  if (!ctx) throw new Error("useWatchlist must be used inside WatchlistProvider");
  return ctx;
}
