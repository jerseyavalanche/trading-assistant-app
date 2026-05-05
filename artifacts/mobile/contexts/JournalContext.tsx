import AsyncStorage from "@react-native-async-storage/async-storage";
import React, { createContext, useCallback, useContext, useEffect, useState } from "react";

export type TradeSide = "BUY" | "SELL";

export interface JournalEntry {
  id: string;
  symbol: string;
  side: TradeSide;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  notes: string;
  date: string;
  pnl: number;
  pnlPercent: number;
}

interface JournalContextType {
  entries: JournalEntry[];
  addEntry: (entry: Omit<JournalEntry, "id" | "pnl" | "pnlPercent">) => Promise<void>;
  deleteEntry: (id: string) => void;
  totalPnl: number;
  winRate: number;
  tradeCount: number;
}

const JournalContext = createContext<JournalContextType | null>(null);
const STORAGE_KEY = "@journal_entries";

export function JournalProvider({ children }: { children: React.ReactNode }) {
  const [entries, setEntries] = useState<JournalEntry[]>([]);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then((stored) => {
      if (stored) setEntries(JSON.parse(stored));
    });
  }, []);

  const addEntry = useCallback(
    async (entry: Omit<JournalEntry, "id" | "pnl" | "pnlPercent">) => {
      const priceDiff =
        entry.side === "BUY"
          ? entry.exitPrice - entry.entryPrice
          : entry.entryPrice - entry.exitPrice;
      const pnl = priceDiff * entry.quantity;
      const pnlPercent =
        entry.side === "BUY"
          ? ((entry.exitPrice - entry.entryPrice) / entry.entryPrice) * 100
          : ((entry.entryPrice - entry.exitPrice) / entry.entryPrice) * 100;

      const newEntry: JournalEntry = {
        ...entry,
        id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
        pnl,
        pnlPercent,
      };
      const next = [newEntry, ...entries];
      setEntries(next);
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    },
    [entries]
  );

  const deleteEntry = useCallback(
    (id: string) => {
      const next = entries.filter((e) => e.id !== id);
      setEntries(next);
      AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    },
    [entries]
  );

  const totalPnl = entries.reduce((sum, e) => sum + e.pnl, 0);
  const wins = entries.filter((e) => e.pnl > 0).length;
  const winRate = entries.length > 0 ? (wins / entries.length) * 100 : 0;

  return (
    <JournalContext.Provider
      value={{
        entries,
        addEntry,
        deleteEntry,
        totalPnl,
        winRate,
        tradeCount: entries.length,
      }}
    >
      {children}
    </JournalContext.Provider>
  );
}

export function useJournal() {
  const ctx = useContext(JournalContext);
  if (!ctx) throw new Error("useJournal must be used inside JournalProvider");
  return ctx;
}
