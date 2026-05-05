import AsyncStorage from "@react-native-async-storage/async-storage";
import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import { Platform } from "react-native";

export interface AlpacaAccount {
  id: string;
  status: string;
  currency: string;
  buying_power: string;
  cash: string;
  portfolio_value: string;
  equity: string;
  last_equity: string;
  long_market_value: string;
  short_market_value: string;
  unrealized_pl: string;
  unrealized_plpc: string;
  daytrade_count: number;
}

export interface AlpacaPosition {
  asset_id: string;
  symbol: string;
  qty: string;
  side: string;
  market_value: string;
  cost_basis: string;
  unrealized_pl: string;
  unrealized_plpc: string;
  current_price: string;
  avg_entry_price: string;
  change_today: string;
}

export interface AlpacaOrder {
  id: string;
  symbol: string;
  qty: string | null;
  notional: string | null;
  filled_qty: string;
  side: string;
  type: string;
  time_in_force: string;
  status: string;
  filled_avg_price: string | null;
  limit_price: string | null;
  submitted_at: string;
  filled_at: string | null;
}

interface PlaceOrderParams {
  symbol: string;
  qty?: number;
  notional?: number;
  side: "buy" | "sell";
  type: "market" | "limit" | "stop" | "stop_limit";
  time_in_force: "day" | "gtc" | "ioc" | "fok";
  limit_price?: number;
}

const BUDGET_KEY = "@alpaca_budget";
const DEFAULT_BUDGET = 1000;

interface AlpacaContextType {
  account: AlpacaAccount | null;
  positions: AlpacaPosition[];
  orders: AlpacaOrder[];
  loading: boolean;
  error: string | null;
  budget: number;
  setBudget: (amount: number) => Promise<void>;
  budgetDeployed: number;
  budgetRemaining: number;
  budgetPnl: number;
  fetchAccount: () => Promise<void>;
  fetchPositions: () => Promise<void>;
  fetchOrders: () => Promise<void>;
  placeOrder: (params: PlaceOrderParams) => Promise<AlpacaOrder>;
  cancelOrder: (id: string) => Promise<void>;
}

const AlpacaContext = createContext<AlpacaContextType | null>(null);

function getBaseUrl() {
  if (Platform.OS === "web") {
    const domain = process.env.EXPO_PUBLIC_DOMAIN ?? "";
    return domain ? `https://${domain}` : "";
  }
  return `https://${process.env.EXPO_PUBLIC_DOMAIN ?? ""}`;
}

export function AlpacaProvider({ children }: { children: React.ReactNode }) {
  const [account, setAccount] = useState<AlpacaAccount | null>(null);
  const [positions, setPositions] = useState<AlpacaPosition[]>([]);
  const [orders, setOrders] = useState<AlpacaOrder[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [budget, setBudgetState] = useState(DEFAULT_BUDGET);

  const base = getBaseUrl();

  useEffect(() => {
    AsyncStorage.getItem(BUDGET_KEY)
      .then((val) => {
        if (val) setBudgetState(parseFloat(val));
      })
      .catch(() => {});
  }, []);

  const setBudget = useCallback(async (amount: number) => {
    setBudgetState(amount);
    await AsyncStorage.setItem(BUDGET_KEY, String(amount));
  }, []);

  // Cost basis of all open positions = deployed capital
  const budgetDeployed = positions.reduce((sum, p) => sum + parseFloat(p.cost_basis), 0);
  // Current market value of positions - cost basis = unrealized P&L
  const budgetPnl = positions.reduce((sum, p) => sum + parseFloat(p.unrealized_pl), 0);
  const budgetRemaining = Math.max(0, budget - budgetDeployed);

  const fetchAccount = useCallback(async () => {
    try {
      const res = await fetch(`${base}/api/alpaca/account`);
      if (!res.ok) throw new Error(`${res.status}`);
      const data = (await res.json()) as AlpacaAccount;
      setAccount(data);
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, [base]);

  const fetchPositions = useCallback(async () => {
    try {
      const res = await fetch(`${base}/api/alpaca/positions`);
      if (!res.ok) throw new Error(`${res.status}`);
      const data = (await res.json()) as AlpacaPosition[];
      setPositions(data);
    } catch (err) {
      setError(String(err));
    }
  }, [base]);

  const fetchOrders = useCallback(async () => {
    try {
      const res = await fetch(`${base}/api/alpaca/orders?status=all&limit=20`);
      if (!res.ok) throw new Error(`${res.status}`);
      const data = (await res.json()) as AlpacaOrder[];
      setOrders(data);
    } catch (err) {
      setError(String(err));
    }
  }, [base]);

  const placeOrder = useCallback(
    async (params: PlaceOrderParams): Promise<AlpacaOrder> => {
      setLoading(true);
      try {
        const res = await fetch(`${base}/api/alpaca/orders`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(params),
        });
        if (!res.ok) {
          const err = (await res.json()) as { error: string };
          throw new Error(err.error ?? `${res.status}`);
        }
        const order = (await res.json()) as AlpacaOrder;
        await Promise.all([fetchPositions(), fetchOrders()]);
        return order;
      } finally {
        setLoading(false);
      }
    },
    [base, fetchPositions, fetchOrders]
  );

  const cancelOrder = useCallback(
    async (id: string) => {
      await fetch(`${base}/api/alpaca/orders/${id}`, { method: "DELETE" });
      await fetchOrders();
    },
    [base, fetchOrders]
  );

  return (
    <AlpacaContext.Provider
      value={{
        account,
        positions,
        orders,
        loading,
        error,
        budget,
        setBudget,
        budgetDeployed,
        budgetRemaining,
        budgetPnl,
        fetchAccount,
        fetchPositions,
        fetchOrders,
        placeOrder,
        cancelOrder,
      }}
    >
      {children}
    </AlpacaContext.Provider>
  );
}

export function useAlpaca() {
  const ctx = useContext(AlpacaContext);
  if (!ctx) throw new Error("useAlpaca must be used inside AlpacaProvider");
  return ctx;
}
