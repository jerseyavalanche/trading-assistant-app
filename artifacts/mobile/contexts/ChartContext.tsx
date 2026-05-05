import React, { createContext, useContext, useState } from "react";

interface ChartContextType {
  symbol: string;
  setSymbol: (s: string) => void;
  interval: string;
  setInterval: (i: string) => void;
}

const ChartContext = createContext<ChartContextType | null>(null);

export function ChartProvider({ children }: { children: React.ReactNode }) {
  const [symbol, setSymbol] = useState("AAPL");
  const [interval, setInterval] = useState("D");

  return (
    <ChartContext.Provider value={{ symbol, setSymbol, interval, setInterval }}>
      {children}
    </ChartContext.Provider>
  );
}

export function useChart() {
  const ctx = useContext(ChartContext);
  if (!ctx) throw new Error("useChart must be used inside ChartProvider");
  return ctx;
}
