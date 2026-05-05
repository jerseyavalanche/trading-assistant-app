import { openai } from "@workspace/integrations-openai-ai-server";
import { Router, type Response } from "express";
import { writeExport } from "./aiBrain.js";
import {
  type BotPortfolio,
  type OpenPosition,
  initPortfolio,
  applyBuy,
  applySell,
  closePosition,
  closeAllPositions,
  markToMarket,
} from "../lib/portfolioEngine.js";
import {
  normalizeSymbol,
  detectMarketType,
  validatePreTrade,
  checkPostTradeInvariants,
  type ValidationResult,
} from "../lib/riskValidator.js";
import {
  isTerminalCycleStatus,
  computeRaceHealth,
  computeRanks,
  buildMtmPriceMap,
  initDiagnostics,
  type CycleStatus,
  type BotCycleDiagnostics,
  type BotHealthSnapshot,
  type BotRankInput,
  type BotParticipationCategory,
  type RankingResult,
} from "../lib/raceHealth.js";

const router = Router();

// ─── State ────────────────────────────────────────────────────────────────────

export interface AutopilotLog {
  id: string;
  timestamp: string;
  type: "info" | "buy" | "sell" | "hold" | "close" | "error" | "market" | "ai";
  message: string;
  symbol?: string;
  amount?: number;
  pnl?: number;
}

interface AutopilotState {
  running: boolean;
  symbols: string[];
  budget: number;
  strategy: string;
  logs: AutopilotLog[];
  interval: ReturnType<typeof setInterval> | null;
  tradesCount: number;
  winCount: number;
  totalPnl: number;
  lastScan: string | null;
  nextScan: string | null;
}

const DEFAULT_STRATEGY = `Momentum Day Trading:
- Buy stocks showing strong upward momentum (>+0.8% today) with good volume
- Max position size: 25% of budget per stock, max 4 concurrent positions
- Stop loss: exit if a position drops -2.5% from entry
- Take profit: lock in gains when up +3%
- If market is choppy (most stocks flat or mixed signals), stay in cash
- Never exceed total budget`;

const state: AutopilotState = {
  running: false,
  symbols: [],
  budget: 1000,
  strategy: DEFAULT_STRATEGY,
  logs: [],
  interval: null,
  tradesCount: 0,
  winCount: 0,
  totalPnl: 0,
  lastScan: null,
  nextScan: null,
};

const sseClients = new Set<Response>();

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ALPACA_BASE = "https://paper-api.alpaca.markets/v2";

function alpacaHeaders() {
  return {
    "APCA-API-KEY-ID": process.env.ALPACA_API_KEY ?? "",
    "APCA-API-SECRET-KEY": process.env.ALPACA_API_SECRET ?? "",
    "Content-Type": "application/json",
  };
}

async function alpacaFetch(path: string, options: RequestInit = {}) {
  const res = await fetch(`${ALPACA_BASE}${path}`, {
    ...options,
    headers: { ...alpacaHeaders(), ...((options.headers as Record<string, string>) ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Alpaca ${res.status}: ${text}`);
  return JSON.parse(text) as unknown;
}

function addLog(entry: Omit<AutopilotLog, "id" | "timestamp">) {
  const log: AutopilotLog = {
    id: Date.now().toString() + Math.random().toString(36).slice(2, 6),
    timestamp: new Date().toISOString(),
    ...entry,
  };
  state.logs.unshift(log);
  if (state.logs.length > 150) state.logs = state.logs.slice(0, 150);
  broadcastSSE({ type: "log", log });
  return log;
}

function broadcastSSE(data: unknown) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
}

// ─── Yahoo Finance price fetch (v8 chart — 5m candles, 1d range) ──────────────
//
// The v7/quote endpoint returns 401 in this environment. The v8/chart endpoint
// works reliably and gives us regularMarketPrice + chartPreviousClose in meta,
// plus full 5-minute OHLCV candles so we can also derive volume.

const BASE_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
};

type PriceRecord = { price: number; change: number; changePercent: number; name: string; volume?: number; open?: number };

async function fetchOnePriceV8(symbol: string): Promise<PriceRecord | null> {
  try {
    const res = await fetch(
      `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=5m&range=1d`,
      { headers: BASE_HEADERS }
    );
    if (!res.ok) return null;
    const json = await res.json() as {
      chart?: {
        result?: Array<{
          meta?: {
            symbol: string;
            regularMarketPrice: number;
            chartPreviousClose: number;
            shortName?: string;
          };
          timestamp?: number[];
          indicators?: {
            quote?: Array<{
              open?: number[];
              close?: number[];
              volume?: number[];
            }>;
          };
        }>;
        error?: { code: string };
      };
    };
    if (json?.chart?.error) return null;
    const result = json?.chart?.result?.[0];
    if (!result) return null;
    const meta = result.meta;
    if (!meta) return null;

    const price = meta.regularMarketPrice;
    const prevClose = meta.chartPreviousClose;
    if (!price || !prevClose) return null;

    const change = price - prevClose;
    const changePercent = (change / prevClose) * 100;

    // Pull volume from the most recent non-null candle
    const quoteData = result.indicators?.quote?.[0] ?? {};
    const volumes = quoteData.volume ?? [];
    const opens = quoteData.open ?? [];
    const lastVol = [...volumes].reverse().find((v) => v != null && v > 0);
    const firstOpen = opens.find((o) => o != null);

    return {
      price,
      change,
      changePercent,
      name: meta.shortName ?? symbol,
      volume: lastVol ?? undefined,
      open: firstOpen ?? undefined,
    };
  } catch {
    return null;
  }
}

async function fetchPrices(symbols: string[]): Promise<Record<string, PriceRecord>> {
  if (!symbols.length) return {};
  const results = await Promise.allSettled(symbols.map((s) => fetchOnePriceV8(s)));
  const out: Record<string, PriceRecord> = {};
  for (let i = 0; i < symbols.length; i++) {
    const r = results[i];
    if (r.status === "fulfilled" && r.value) {
      out[symbols[i]] = r.value;
    }
  }
  return out;
}

// ─── Market snapshot ──────────────────────────────────────────────────────────
// Fetches clock + prices exactly once per coordinator tick. All bots share the
// same snapshot so mark-to-market comparisons are based on identical prices.
async function fetchMarketSnapshot(symbols: string[]): Promise<MarketSnapshot> {
  const id = `snap_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const clock = (await alpacaFetch("/clock")) as { is_open: boolean; next_open: string };
  const cryptoSymbols = symbols.filter(isCrypto);
  const equitySymbols = symbols.filter((s) => !isCrypto(s));
  const activeSymbols = clock.is_open ? symbols : cryptoSymbols;
  const prices = await fetchPrices(activeSymbols);
  const etNow = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
  const etDate = new Date(etNow);
  const minutesToClose = clock.is_open
    ? Math.max(0, (16 - etDate.getHours()) * 60 - etDate.getMinutes())
    : -1;
  return {
    id,
    fetched_at: new Date().toISOString(),
    is_open: clock.is_open,
    next_open: clock.next_open ?? null,
    prices,
    active_symbols: activeSymbols,
    crypto_symbols: cryptoSymbols,
    equity_symbols: equitySymbols,
    minutes_to_close: minutesToClose,
    is_eod: clock.is_open && minutesToClose <= 15,
  };
}

// ─── AI Tool executor ─────────────────────────────────────────────────────────

async function executeTool(
  name: string,
  args: Record<string, unknown>,
  prices: Record<string, { price: number; change: number; changePercent: number; name: string }>
): Promise<string> {
  try {
    if (name === "get_positions") {
      const data = await alpacaFetch("/positions");
      return JSON.stringify(data);
    }
    if (name === "get_account") {
      const data = await alpacaFetch("/account");
      return JSON.stringify(data);
    }
    if (name === "get_market_data") {
      return JSON.stringify(prices);
    }
    if (name === "place_order") {
      const body: Record<string, unknown> = {
        symbol: args.symbol,
        side: args.side,
        type: args.type ?? "market",
        time_in_force: args.time_in_force ?? "day",
      };
      if (args.notional) body.notional = String(args.notional);
      if (args.qty) body.qty = String(args.qty);
      if (args.limit_price) body.limit_price = String(args.limit_price);
      const data = await alpacaFetch("/orders", {
        method: "POST",
        body: JSON.stringify(body),
      });
      // log the trade
      const side = String(args.side);
      const sym = String(args.symbol);
      const amount = args.notional ? Number(args.notional) : undefined;
      addLog({
        type: side === "buy" ? "buy" : "sell",
        message: `${side.toUpperCase()} ${sym}${amount ? ` — $${amount.toFixed(2)}` : ""}`,
        symbol: sym,
        amount,
      });
      state.tradesCount++;
      return JSON.stringify(data);
    }
    if (name === "close_position") {
      const sym = String(args.symbol);
      const data = await alpacaFetch(`/positions/${sym}`, { method: "DELETE" });
      addLog({ type: "close", message: `Closed position: ${sym}`, symbol: sym });
      return JSON.stringify(data);
    }
    if (name === "close_all_positions") {
      const data = await alpacaFetch("/positions", { method: "DELETE" });
      addLog({ type: "close", message: "Closed ALL positions (EOD)" });
      return JSON.stringify(data);
    }
    if (name === "log_reasoning") {
      addLog({ type: "ai", message: String(args.reasoning ?? args.message ?? "") });
      return JSON.stringify({ ok: true });
    }
    return JSON.stringify({ error: `Unknown tool: ${name}` });
  } catch (err) {
    return JSON.stringify({ error: String(err) });
  }
}

// ─── Trading tools spec ───────────────────────────────────────────────────────

const TRADING_TOOLS: Parameters<typeof openai.chat.completions.create>[0]["tools"] = [
  {
    type: "function",
    function: {
      name: "get_market_data",
      description: "Get live price data for all watchlist symbols including price, % change today, and volume.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_positions",
      description: "Get all currently open positions.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_account",
      description: "Get account info: buying power, cash, equity.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "place_order",
      description: "Place a paper trade. Use notional (dollar amount) for precise budget control.",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string" },
          side: { type: "string", enum: ["buy", "sell"] },
          notional: { type: "number", description: "Dollar amount to buy/sell" },
          qty: { type: "number", description: "Number of shares (use notional instead when possible)" },
          type: { type: "string", enum: ["market", "limit"], default: "market" },
          time_in_force: { type: "string", enum: ["day", "gtc"], default: "day" },
          limit_price: { type: "number" },
        },
        required: ["symbol", "side"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "close_position",
      description: "Close an entire position in a specific symbol.",
      parameters: {
        type: "object",
        properties: { symbol: { type: "string" } },
        required: ["symbol"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "close_all_positions",
      description: "Close ALL open positions. Use this at end of day.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "log_reasoning",
      description: "Log your reasoning or analysis so the user can follow your thought process.",
      parameters: {
        type: "object",
        properties: { reasoning: { type: "string" } },
        required: ["reasoning"],
      },
    },
  },
];

// ─── Main trading loop ────────────────────────────────────────────────────────

async function runTradingLoop() {
  if (!state.running) return;

  state.lastScan = new Date().toISOString();
  addLog({ type: "info", message: "⏱ Starting scan..." });

  try {
    // 1. Check market hours
    const clock = (await alpacaFetch("/clock")) as {
      is_open: boolean;
      next_open: string;
      next_close: string;
    };

    if (!clock.is_open) {
      addLog({
        type: "market",
        message: `Market closed. Next open: ${new Date(clock.next_open).toLocaleTimeString("en-US", { timeZone: "America/New_York" })} ET`,
      });
      return;
    }

    // 2. Check if near EOD (3:45 PM ET)
    const etNow = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
    const etDate = new Date(etNow);
    const etHour = etDate.getHours();
    const etMin = etDate.getMinutes();
    const minutesToClose = (16 - etHour) * 60 - etMin; // minutes until 4 PM ET
    const isEOD = minutesToClose <= 15;

    // 3. Fetch live prices via v8 chart API (5m candles)
    const prices = await fetchPrices(state.symbols);
    const priceLines = Object.entries(prices).map(([sym, q]) => {
      const pctStr = `${q.changePercent >= 0 ? "+" : ""}${q.changePercent.toFixed(2)}%`;
      const volStr = q.volume ? ` vol ${(q.volume / 1000).toFixed(0)}k` : "";
      return `${sym}: $${q.price.toFixed(2)} (${pctStr} today${volStr})`;
    });
    const priceContext = priceLines.join("\n");

    if (priceLines.length === 0) {
      addLog({ type: "error", message: "⚠️ Market data fetch failed — no prices returned. Skipping AI cycle." });
      return;
    }
    addLog({ type: "market", message: `📊 Prices: ${priceLines.join(" | ")}` });

    // 4. Fetch current positions
    const positions = (await alpacaFetch("/positions")) as Array<{
      symbol: string;
      qty: string;
      market_value: string;
      cost_basis: string;
      unrealized_pl: string;
      unrealized_plpc: string;
    }>;

    const deployedCapital = positions.reduce((sum, p) => sum + parseFloat(p.cost_basis), 0);
    const budgetRemaining = Math.max(0, state.budget - deployedCapital);
    const unrealizedPnl = positions.reduce((sum, p) => sum + parseFloat(p.unrealized_pl), 0);

    const positionContext = positions.length > 0
      ? positions.map((p) =>
          `${p.symbol}: ${p.qty} shares @ $${(parseFloat(p.cost_basis) / parseFloat(p.qty)).toFixed(2)} cost, now $${(parseFloat(p.market_value) / parseFloat(p.qty)).toFixed(2)}, P&L: ${parseFloat(p.unrealized_pl) >= 0 ? "+" : ""}$${parseFloat(p.unrealized_pl).toFixed(2)} (${(parseFloat(p.unrealized_plpc) * 100).toFixed(2)}%)`
        ).join("\n")
      : "No open positions";

    const systemPrompt = `You are an autonomous day trader managing a $${state.budget} paper trading portfolio. You scan the market every 5 minutes and make real trading decisions based on your assigned strategy.

CURRENT STATUS:
- Time: ${new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York" })} ET
- Minutes until market close: ${minutesToClose}
- ${isEOD ? "⚠️ EOD MODE: Close ALL positions immediately — never hold overnight!" : "Market is OPEN — normal trading mode"}
- Budget: $${state.budget}
- Deployed capital: $${deployedCapital.toFixed(2)}
- Available to deploy: $${budgetRemaining.toFixed(2)}
- Unrealized P&L: ${unrealizedPnl >= 0 ? "+" : ""}$${unrealizedPnl.toFixed(2)}

OPEN POSITIONS:
${positionContext}

LIVE MARKET DATA (watchlist):
${priceContext || "No data available"}

YOUR TRADING STRATEGY (follow this precisely):
${isEOD ? "⚠️ EOD OVERRIDE: Ignore strategy — use close_all_positions immediately. No new buys." : state.strategy}

HARD RULES (always enforced regardless of strategy):
- Never exceed total budget of $${state.budget}
- Always close all positions by 3:45 PM ET (EOD)
- Use notional dollar amounts when placing orders for precise budget control
- Never hold a position overnight

Always call log_reasoning first to explain your analysis and decision. Be decisive — either trade or explicitly hold with a reason.`;

    // 5. Run AI agent
    const runMessages: Parameters<typeof openai.chat.completions.create>[0]["messages"] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: isEOD ? "It's near end of day. Close all positions now." : "Run your trading scan. Analyze the market data and positions, then execute any trades you deem appropriate." },
    ];

    let loopCount = 0;
    while (loopCount < 10) {
      loopCount++;
      const response = await openai.chat.completions.create({
        model: "gpt-5.4",
        max_completion_tokens: 2048,
        messages: runMessages,
        tools: TRADING_TOOLS,
        tool_choice: "auto",
        stream: false,
      });

      const choice = response.choices[0];
      if (!choice) break;

      const msg = choice.message;

      if (choice.finish_reason === "tool_calls" && msg.tool_calls?.length) {
        runMessages.push(msg as Parameters<typeof openai.chat.completions.create>[0]["messages"][number]);
        for (const tc of msg.tool_calls) {
          let args: Record<string, unknown> = {};
          try { args = JSON.parse(tc.function.arguments) as Record<string, unknown>; } catch { /* */ }
          const result = await executeTool(tc.function.name, args, prices);
          runMessages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: result,
          } as Parameters<typeof openai.chat.completions.create>[0]["messages"][number]);
        }
        continue;
      }

      // Final text summary
      if (msg.content) {
        addLog({ type: "info", message: msg.content });
      }
      break;
    }

    addLog({ type: "info", message: `✓ Scan complete — ${positions.length} positions, $${budgetRemaining.toFixed(2)} available` });
    broadcastSSE({ type: "stats", tradesCount: state.tradesCount, totalPnl: state.totalPnl });
  } catch (err) {
    addLog({ type: "error", message: `Error: ${String(err)}` });
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

router.post("/autopilot/start", async (req, res) => {
  const { symbols, budget, strategy } = req.body as { symbols: string[]; budget: number; strategy?: string };
  if (!symbols?.length) {
    res.status(400).json({ error: "symbols required" });
    return;
  }

  if (state.interval) clearInterval(state.interval);

  state.running = true;
  state.symbols = symbols;
  state.budget = budget ?? 1000;
  state.strategy = strategy?.trim() || DEFAULT_STRATEGY;
  state.tradesCount = 0;
  state.winCount = 0;
  state.totalPnl = 0;

  const INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
  const nextScan = new Date(Date.now() + INTERVAL_MS).toISOString();
  state.nextScan = nextScan;

  addLog({ type: "market", message: `🚀 Autopilot ON — watching ${symbols.join(", ")} · Budget $${state.budget}` });

  // Run immediately, then on interval
  void runTradingLoop();

  state.interval = setInterval(() => {
    state.nextScan = new Date(Date.now() + INTERVAL_MS).toISOString();
    broadcastSSE({ type: "next_scan", nextScan: state.nextScan });
    void runTradingLoop();
  }, INTERVAL_MS);

  broadcastSSE({ type: "status", running: true, symbols, budget: state.budget });
  res.json({ ok: true, symbols, budget: state.budget });
});

router.post("/autopilot/stop", (_req, res) => {
  if (state.interval) {
    clearInterval(state.interval);
    state.interval = null;
  }
  state.running = false;
  state.nextScan = null;
  addLog({ type: "market", message: "⛔ Autopilot stopped" });
  broadcastSSE({ type: "status", running: false });
  res.json({ ok: true });
});

router.get("/autopilot/status", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  sseClients.add(res);

  // Send current state immediately
  res.write(`data: ${JSON.stringify({
    type: "init",
    running: state.running,
    symbols: state.symbols,
    budget: state.budget,
    logs: state.logs.slice(0, 50),
    tradesCount: state.tradesCount,
    totalPnl: state.totalPnl,
    lastScan: state.lastScan,
    nextScan: state.nextScan,
  })}\n\n`);

  // Heartbeat
  const heartbeat = setInterval(() => {
    try {
      res.write(`data: ${JSON.stringify({ type: "ping" })}\n\n`);
    } catch {
      clearInterval(heartbeat);
    }
  }, 30000);

  req.on("close", () => {
    sseClients.delete(res);
    clearInterval(heartbeat);
  });
});

router.get("/autopilot/logs", (_req, res) => {
  res.json({
    running: state.running,
    symbols: state.symbols,
    budget: state.budget,
    logs: state.logs,
    tradesCount: state.tradesCount,
    totalPnl: state.totalPnl,
    lastScan: state.lastScan,
    nextScan: state.nextScan,
  });
});

// ─── Race Mode ────────────────────────────────────────────────────────────────

// CycleStatus is imported from raceHealth.ts (authoritative source)
// Non-terminal: NOT_STARTED | SCANNING | DECIDED | ORDER_SUBMITTED | ORDER_FILLED | ORDER_FAILED
// Terminal:     COMPLETED | NO_ACTION | FAILED | TIMED_OUT

interface ScanResult {
  action: "BUY" | "SELL" | "HOLD" | "NO_ACTION" | "MARKET_CLOSED" | "ERROR" | "TIMED_OUT" | "FAILED";
  symbols_considered: string[];
  reasoning_summary: string;
  order_attempted: boolean;
  order_status: "filled" | "rejected" | "pending" | "none";
  completed_at: string;
  timed_out?: boolean;
  error?: string;
}

// ─── Shared market snapshot ───────────────────────────────────────────────────
// Fetched once per coordinator tick, passed to all bots — guarantees all four
// see identical prices for fair mark-to-market comparison.
interface MarketSnapshot {
  id: string;                              // e.g. "snap_lrz3k_a7f9"
  fetched_at: string;                      // ISO timestamp of when data was fetched
  is_open: boolean;
  next_open: string | null;
  prices: Record<string, PriceRecord>;
  active_symbols: string[];               // tradeable this tick (crypto-only if closed)
  crypto_symbols: string[];
  equity_symbols: string[];
  minutes_to_close: number;              // -1 when market is closed
  is_eod: boolean;
}

interface RaceBotState {
  id: string;
  name: string;
  emoji: string;
  color: string;
  strategy: string;
  budget: number;
  running: boolean;
  logs: AutopilotLog[];
  interval: ReturnType<typeof setInterval> | null;
  tradesCount: number;
  // Legacy compat fields — kept for backward compat, derived from portfolio
  netSpent: number;
  netReceived: number;
  lastScan: string | null;
  nextScan: string | null;
  scan_result: ScanResult | null;
  cycleStatus: CycleStatus;
  cycleCount: number;
  cyclesStarted: number;
  portfolio: BotPortfolio;
  risk_rejections: RejectionEvent[];
  diagnostics: BotCycleDiagnostics | null;   // diagnostics for the current/last cycle
  first_cycle_terminal: boolean;              // true once the first cycle reaches any terminal state
  current_snapshot_id: string | null;         // snapshot shared with this bot's current cycle
}

// suppress unused-import warning — OpenPosition used in export schema
type _OpenPositionRef = OpenPosition;

interface RejectionEvent {
  cycle: number;
  timestamp: string;
  symbol: string;
  side: string;
  notional: number;
  violations: ValidationResult["violations"];
  computedExposure: ValidationResult["computedExposure"];
}

const RACE_CONFIGS: Array<{ id: string; name: string; emoji: string; color: string; strategy: string }> = [
  {
    id: "momentum",
    name: "Momentum Rider",
    emoji: "🚀",
    color: "#00D4AA",
    strategy: `Momentum Day Trading:
- Buy stocks up >+0.8% today with rising volume (top 2-3 movers only)
- Max position: 25% of your personal budget per stock
- Max 4 concurrent positions
- Stop loss: -2.5% | Take profit: +3%
- Stay cash if market is flat or mixed
- Never chase stocks already up >3% today`,
  },
  {
    id: "dip_buyer",
    name: "Dip Buyer",
    emoji: "📉",
    color: "#A78BFA",
    strategy: `Mean Reversion (Dip Buying):
- Buy stocks down >-1.5% today — bet on the bounce
- Max position: 20% of your personal budget per stock
- Max 3 concurrent positions
- Stop loss: -3.5% (give it room) | Take profit: +1.5%
- Avoid stocks in freefall (down >-5%)
- Prefer dips on stocks that were positive yesterday`,
  },
  {
    id: "conservative",
    name: "Conservative",
    emoji: "🛡️",
    color: "#60A5FA",
    strategy: `Conservative Low-Risk Trading:
- Only trade large-cap household names (AAPL, MSFT, GOOGL, AMZN, NVDA, TSLA)
- Only enter when stock is flat to slightly up (-0.3% to +1%)
- Max position: 15% of your personal budget per stock
- Max 3 concurrent positions
- Stop loss: -1.5% | Take profit: +1.8%
- When uncertain, stay in cash — capital preservation first`,
  },
  {
    id: "scalper",
    name: "Scalper",
    emoji: "⚡",
    color: "#FF8C42",
    strategy: `Aggressive Scalping:
- Trade frequently for small quick gains (1-2%)
- Buy stocks showing any upward momentum >+0.3%
- Max position: 30% of your personal budget (go bigger, move faster)
- Max 3 positions — rotate frequently
- Stop loss: -1% (cut instantly) | Take profit: +1.5%
- If a position hasn't moved after 2 scans, close and redeploy`,
  },
];

const RACE_INTERVAL_MS           = 5 * 60 * 1000;  // 5 min between coordinator ticks
const BOT_STAGGER_MS             = 12_000;          // stagger between bots in subsequent ticks
const RACE_BOT_CYCLE_TIMEOUT_MS  = 25_000;          // 25 s per-bot cycle hard timeout

// Bots whose strategy is equity-only (no crypto) — session-ineligible when market is closed.
// Used by botSessionEligible() to compute the session_eligible tie-breaker field.
const EQUITY_ONLY_BOT_IDS = new Set(["conservative"]);

// Whether a bot had any tradeable symbols in the given market snapshot.
// Equity-only bots can only act when the equity market is open; all others are
// eligible whenever at least one active symbol is available (e.g. crypto after-hours).
function botSessionEligible(botId: string, snapshot: MarketSnapshot): boolean {
  if (EQUITY_ONLY_BOT_IDS.has(botId)) return snapshot.is_open;
  return snapshot.active_symbols.length > 0;
}

// Single source of truth for the human-readable leader string.
// MUST be called after the bots array has been sorted by rank (rank-1 bot is first).
// Used by both the per-cycle auto-export and the getRaceSnapshot API response.
function buildRaceLeaderText(
  sortedBots: Array<{ rank: number | null; name: string; comparison_reason: string; excluded_from_ranking: boolean }>,
  rankResult: Pick<RankingResult, "is_global_tie" | "tie_break_reason" | "comparison_deferred" | "deferred_reason">,
  raceReady: boolean,
): string | null {
  if (!raceReady) return "RACE IN PROGRESS";
  if (rankResult.comparison_deferred) {
    return rankResult.deferred_reason ?? "Awaiting evaluation window — no P&L separation yet";
  }
  if (rankResult.is_global_tie) return "TIE — all criteria equal";
  const winner = sortedBots.find((b) => b.rank === 1 && !b.excluded_from_ranking);
  if (!winner) return null;
  // tie_break_reason is non-null whenever equity was tied and a tie-breaker resolved it
  return rankResult.tie_break_reason !== null
    ? `Equity tied — ${winner.name} leads (${winner.comparison_reason})`
    : winner.name;
}

let raceActive = false;
let raceSymbols: string[] = [];
let latestRaceSnapshot: MarketSnapshot | null = null;  // updated on every coordinator tick
let raceBudgetPerBot = 250;
let raceTick: ReturnType<typeof setInterval> | null = null;
const raceBots = new Map<string, RaceBotState>();
const raceSseClients = new Set<Response>();

// ─── Symbol utilities — delegating to riskValidator (single source of truth) ──
// normalizeSymbol and detectMarketType are imported from riskValidator.ts.
// These local wrappers keep all existing call sites working unchanged.
function normalizeCryptoSymbol(symbol: string): string {
  return normalizeSymbol(symbol);
}
function isCrypto(symbol: string): boolean {
  return detectMarketType(symbol) === "crypto";
}

function initRaceBots(totalBudget: number) {
  raceBudgetPerBot = Math.floor(totalBudget / 4);
  for (const cfg of RACE_CONFIGS) {
    raceBots.set(cfg.id, {
      ...cfg,
      budget: raceBudgetPerBot,
      running: false,
      logs: [],
      interval: null,
      tradesCount: 0,
      netSpent: 0,
      netReceived: 0,
      lastScan: null,
      nextScan: null,
      scan_result: null,
      cycleStatus: "NOT_STARTED",
      cycleCount: 0,
      cyclesStarted: 0,
      portfolio: initPortfolio(raceBudgetPerBot),
      risk_rejections: [],
      diagnostics: null,
      first_cycle_terminal: false,
      current_snapshot_id: null,
    });
  }
}

function serializeBot(bot: RaceBotState) {
  const p = bot.portfolio;
  return {
    id: bot.id,
    name: bot.name,
    emoji: bot.emoji,
    color: bot.color,
    running: bot.running,
    tradesCount: bot.tradesCount,
    // ── Virtual portfolio (source of truth) ──────────────────────────────────
    starting_budget: p.starting_budget,
    cash: p.cash,
    open_position_value: p.open_position_value,
    open_positions: p.open_positions,
    realized_pnl: p.realized_pnl,
    unrealized_pnl: p.unrealized_pnl,
    total_equity: p.total_equity,
    total_pnl: p.total_pnl,
    total_pnl_pct: p.total_pnl_pct,
    // ── Legacy compat ────────────────────────────────────────────────────────
    netSpent: bot.netSpent,
    netReceived: bot.netReceived,
    estimatedPnl: p.total_pnl,          // now correct — was netReceived-netSpent
    lastScan: bot.lastScan,
    nextScan: bot.nextScan,
    lastLog: bot.logs[0] ?? null,
    scan_result: bot.scan_result,
    cycleStatus: bot.cycleStatus,
    cycleCount: bot.cycleCount,
    cyclesStarted: bot.cyclesStarted,
    latest_logs: bot.logs.slice(0, 6).map((l) => ({
      type: l.type,
      message: l.message,
      symbol: l.symbol ?? null,
      timestamp: l.timestamp,
    })),
    // ── Cycle diagnostics ────────────────────────────────────────────────────
    first_cycle_terminal: bot.first_cycle_terminal,
    diagnostics: bot.diagnostics,
    current_snapshot_id: bot.current_snapshot_id,
    // ── Risk diagnostics ─────────────────────────────────────────────────────
    risk_rejections_count: bot.risk_rejections.length,
    recent_rejections: bot.risk_rejections.slice(-3).map((r) => ({
      cycle: r.cycle,
      timestamp: r.timestamp,
      symbol: r.symbol,
      side: r.side,
      notional: r.notional,
      primary_violation: r.violations[0]?.rule ?? "unknown",
      detail: r.violations[0]?.detail ?? "",
    })),
  };
}

function addRaceLog(botId: string, entry: Omit<AutopilotLog, "id" | "timestamp">) {
  const bot = raceBots.get(botId);
  if (!bot) return;
  const log: AutopilotLog = {
    id: Date.now().toString() + Math.random().toString(36).slice(2, 6),
    timestamp: new Date().toISOString(),
    ...entry,
  };
  bot.logs.unshift(log);
  if (bot.logs.length > 80) bot.logs = bot.logs.slice(0, 80);
  broadcastRaceSSE({ type: "log", botId, log, bot: serializeBot(bot) });
}

function broadcastRaceSSE(data: unknown) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of raceSseClients) {
    try { client.write(payload); }
    catch { raceSseClients.delete(client); }
  }
}

async function executeRaceTool(
  botId: string,
  name: string,
  args: Record<string, unknown>,
  prices: Record<string, { price: number; change: number; changePercent: number; name: string }>,
  marketIsOpen: boolean
): Promise<string> {
  const bot = raceBots.get(botId);
  if (!bot) return JSON.stringify({ error: "Bot not found" });
  try {
    // ── get_positions: return virtual portfolio positions, not shared Alpaca ──
    if (name === "get_positions") {
      return JSON.stringify(bot.portfolio.open_positions.map((p) => ({
        symbol: p.symbol,
        qty: p.qty.toFixed(6),
        avg_entry_price: p.avg_entry_price.toFixed(4),
        market_value: p.market_value.toFixed(2),
        cost_basis: p.cost_basis.toFixed(2),
        unrealized_pl: p.unrealized_pnl.toFixed(2),
        unrealized_plpc: p.cost_basis > 0 ? (p.unrealized_pnl / p.cost_basis).toFixed(4) : "0",
        note: "virtual portfolio — isolated per bot",
      })));
    }

    // ── get_account: return virtual portfolio cash/equity, not shared Alpaca ─
    if (name === "get_account") {
      const p = bot.portfolio;
      return JSON.stringify({
        cash: p.cash.toFixed(2),
        buying_power: p.cash.toFixed(2),
        equity: p.total_equity.toFixed(2),
        portfolio_value: p.total_equity.toFixed(2),
        realized_pnl: p.realized_pnl.toFixed(2),
        unrealized_pnl: p.unrealized_pnl.toFixed(2),
        total_pnl: p.total_pnl.toFixed(2),
        total_pnl_pct: p.total_pnl_pct.toFixed(2),
        note: "virtual portfolio — isolated per bot",
      });
    }

    if (name === "get_market_data") return JSON.stringify(prices);

    if (name === "place_order") {
      const notional = args.notional ? Number(args.notional) : undefined;
      const side = String(args.side) as "buy" | "sell";
      const rawSym = String(args.symbol);
      const sym = normalizeSymbol(rawSym);
      const crypto = isCrypto(rawSym);

      // ── Pre-trade risk validation (runs before ANY order hits Alpaca) ─────────
      if (notional && notional > 0) {
        const validation = validatePreTrade({
          botId,
          side,
          rawSymbol: rawSym,
          notional,
          portfolio: bot.portfolio,
          marketIsOpen,
          raceSymbols,
        });

        if (!validation.allowed) {
          // ── Structured rejection: log, store, broadcast, return ──────────────
          const primaryViolation = validation.violations[0];
          const rejectionMsg = `🚫 ORDER BLOCKED [${primaryViolation?.rule ?? "risk"}]: ${primaryViolation?.detail ?? "validation failed"}`;

          // Store for export diagnostics
          const rejectionEvent: RejectionEvent = {
            cycle: bot.cyclesStarted,
            timestamp: new Date().toISOString(),
            symbol: sym,
            side,
            notional,
            violations: validation.violations,
            computedExposure: validation.computedExposure,
          };
          bot.risk_rejections.push(rejectionEvent);
          if (bot.risk_rejections.length > 50) bot.risk_rejections = bot.risk_rejections.slice(-50);

          addRaceLog(botId, { type: "error", message: rejectionMsg, symbol: sym });
          // Log all block violations for full transparency
          for (const v of validation.violations.filter((x) => x.severity === "block").slice(1)) {
            addRaceLog(botId, { type: "error", message: `  ↳ [${v.rule}] ${v.detail}`, symbol: sym });
          }

          bot.cycleStatus = "ORDER_FAILED";
          broadcastRaceSSE({
            type: "order_rejected",
            botId, symbol: sym, side, notional,
            reason: "risk_validation",
            violations: validation.violations,
            computedExposure: validation.computedExposure,
            bot: serializeBot(bot),
          });

          return JSON.stringify({
            error: rejectionMsg,
            violations: validation.violations,
            computedExposure: validation.computedExposure,
          });
        }

        // Warn-only violations (allowed but flagged)
        for (const v of validation.violations.filter((x) => x.severity === "warn")) {
          addRaceLog(botId, { type: "info", message: `⚠️ [${v.rule}] ${v.detail}`, symbol: sym });
        }
      }

      // ── Validation passed — build and submit order ────────────────────────────
      const orderType = crypto ? "market" : String(args.type ?? "market");
      const tif = crypto ? "gtc" : String(args.time_in_force ?? "day");
      const body: Record<string, unknown> = {
        symbol: sym, side, type: orderType, time_in_force: tif,
        client_order_id: `race_${botId}_${Date.now()}`,
      };
      if (notional) body.notional = String(notional);
      else if (args.qty) body.qty = String(args.qty);
      if (orderType === "limit" && args.limit_price) body.limit_price = String(args.limit_price);

      bot.cycleStatus = "ORDER_SUBMITTED";
      broadcastRaceSSE({ type: "order_submitted", botId, symbol: sym, side, notional, orderType, tif, bot: serializeBot(bot) });
      addRaceLog(botId, { type: "info", message: `📤 ${side.toUpperCase()} ${sym}${notional ? ` $${notional.toFixed(2)}` : ""}${crypto ? " (crypto/gtc)" : ""}` });

      try {
        const data = await alpacaFetch("/orders", { method: "POST", body: JSON.stringify(body) });
        // ── Update virtual portfolio ──────────────────────────────────────────
        const fillPrice = prices[rawSym]?.price ?? prices[sym]?.price ?? 0;
        if (side === "buy" && notional) {
          applyBuy(bot.portfolio, sym, notional, fillPrice, bot.cyclesStarted);
          bot.netSpent += notional;
        } else if (side === "sell" && notional) {
          applySell(bot.portfolio, sym, notional, fillPrice, bot.cyclesStarted);
          bot.netReceived += notional;
        }
        bot.tradesCount++;
        bot.cycleStatus = "ORDER_FILLED";

        // ── Post-trade invariant check ────────────────────────────────────────
        const invariants = checkPostTradeInvariants(bot.portfolio, botId);
        if (!invariants.clean) {
          for (const inv of invariants.violations) {
            addRaceLog(botId, { type: "error", message: `⚠️ INVARIANT [${inv.check}] ${inv.detail}` });
          }
        }

        const pnlStr = bot.portfolio.total_pnl >= 0 ? `+$${bot.portfolio.total_pnl.toFixed(2)}` : `-$${Math.abs(bot.portfolio.total_pnl).toFixed(2)}`;
        addRaceLog(botId, {
          type: side === "buy" ? "buy" : "sell",
          message: `${side.toUpperCase()} ${sym}${notional ? ` — $${notional.toFixed(2)}` : ""} | equity ${pnlStr} | cash $${bot.portfolio.cash.toFixed(2)}`,
          symbol: sym, amount: notional,
        });
        broadcastRaceSSE({ type: "order_filled", botId, symbol: sym, side, notional, portfolio: bot.portfolio, bot: serializeBot(bot) });
        return JSON.stringify(data);
      } catch (orderErr) {
        bot.cycleStatus = "ORDER_FAILED";
        const errMsg = String(orderErr).slice(0, 200);
        addRaceLog(botId, { type: "error", message: `❌ Order rejected by broker: ${sym} — ${errMsg}` });
        broadcastRaceSSE({ type: "order_rejected", botId, symbol: sym, side, error: errMsg, reason: "broker_error", bot: serializeBot(bot) });
        return JSON.stringify({ error: errMsg });
      }
    }

    if (name === "close_position") {
      const rawSym = String(args.symbol);
      const crypto = isCrypto(rawSym);
      const sym = crypto ? normalizeCryptoSymbol(rawSym) : rawSym;
      const fillPrice = prices[rawSym]?.price ?? prices[sym]?.price ?? 0;
      const pos = bot.portfolio.open_positions.find((p) => p.symbol === sym);
      if (!pos) return JSON.stringify({ error: `No virtual position in ${sym}` });

      try {
        const data = await alpacaFetch(`/positions/${sym}`, { method: "DELETE" });
        closePosition(bot.portfolio, sym, fillPrice, bot.cyclesStarted);
        bot.tradesCount++;
        const gain = bot.portfolio.realized_pnl;
        addRaceLog(botId, { type: "close", message: `Closed ${sym} | realized P&L $${gain.toFixed(2)}`, symbol: sym });
        broadcastRaceSSE({ type: "order_filled", botId, symbol: sym, side: "sell", portfolio: bot.portfolio, bot: serializeBot(bot) });
        return JSON.stringify(data);
      } catch (closeErr) {
        // Still close in virtual portfolio if broker fails (position may not exist in shared account)
        closePosition(bot.portfolio, sym, fillPrice, bot.cyclesStarted);
        addRaceLog(botId, { type: "close", message: `Closed ${sym} (virtual only — broker: ${String(closeErr).slice(0, 80)})`, symbol: sym });
        return JSON.stringify({ ok: true, note: "virtual close only" });
      }
    }

    if (name === "close_all_positions") {
      const priceMap: Record<string, number> = {};
      for (const pos of bot.portfolio.open_positions) {
        const rawSym = pos.symbol.replace("/", "-");
        priceMap[pos.symbol] = prices[rawSym]?.price ?? prices[pos.symbol]?.price ?? pos.last_price;
      }
      try {
        const data = await alpacaFetch("/positions", { method: "DELETE" });
        closeAllPositions(bot.portfolio, priceMap, bot.cyclesStarted);
        addRaceLog(botId, { type: "close", message: `Closed all positions | realized P&L $${bot.portfolio.realized_pnl.toFixed(2)}` });
        broadcastRaceSSE({ type: "order_filled", botId, side: "sell", portfolio: bot.portfolio, bot: serializeBot(bot) });
        return JSON.stringify(data);
      } catch {
        closeAllPositions(bot.portfolio, priceMap, bot.cyclesStarted);
        addRaceLog(botId, { type: "close", message: "Closed all (virtual only)" });
        return JSON.stringify({ ok: true, note: "virtual close only" });
      }
    }

    if (name === "log_reasoning") {
      addRaceLog(botId, { type: "ai", message: String(args.reasoning ?? "") });
      return JSON.stringify({ ok: true });
    }
    return JSON.stringify({ error: `Unknown tool: ${name}` });
  } catch (err) {
    return JSON.stringify({ error: String(err) });
  }
}

async function runRaceBotCycle(botId: string, snapshot: MarketSnapshot) {
  const bot = raceBots.get(botId);
  if (!bot?.running) return;

  const cycleStart = new Date().toISOString();
  bot.lastScan = cycleStart;
  bot.cyclesStarted++;
  bot.cycleStatus = "SCANNING";
  bot.current_snapshot_id = snapshot.id;
  bot.diagnostics = initDiagnostics();   // started_at captured here
  addRaceLog(botId, { type: "info", message: `⏱ Cycle #${bot.cyclesStarted} scanning...` });
  broadcastRaceSSE({ type: "cycle_start", botId, cycleNum: bot.cyclesStarted, bot: serializeBot(bot) });

  // ── Idempotent finalizer: no-op if already in a terminal state ───────────
  // This guards against the timeout handler and the normal path racing each other.
  const finalizeCycle = (
    result: ScanResult,
    terminalStatus: "COMPLETED" | "NO_ACTION" | "FAILED" = "COMPLETED"
  ) => {
    if (isTerminalCycleStatus(bot.cycleStatus)) return; // timeout already fired — do nothing
    bot.cycleCount++;
    bot.scan_result = result;
    bot.cycleStatus = terminalStatus;
    if (!bot.first_cycle_terminal) bot.first_cycle_terminal = true;
    if (bot.diagnostics) bot.diagnostics.completed_at = new Date().toISOString();
    broadcastRaceSSE({ type: "cycle_completed", botId, cycleNum: bot.cycleCount, result, bot: serializeBot(bot) });
  };

  try {
    // ── Use shared market snapshot (fetched once by coordinator, identical for all bots) ─
    const {
      is_open, next_open, prices,
      active_symbols: activeScanSymbols,
      crypto_symbols: cryptoSymbols,
      equity_symbols: equitySymbols,
      minutes_to_close: minutesToClose,
      is_eod: isEOD,
    } = snapshot;
    if (bot.diagnostics) {
      bot.diagnostics.data_fetch_started  = snapshot.fetched_at;
      bot.diagnostics.data_fetch_completed = snapshot.fetched_at;
    }

    if (activeScanSymbols.length === 0) {
      const nextOpenStr = next_open
        ? new Date(next_open).toLocaleTimeString("en-US", { timeZone: "America/New_York" })
        : "unknown";
      addRaceLog(botId, { type: "market", message: `Market closed — next open ~${nextOpenStr} ET. No 24/7 symbols.` });
      finalizeCycle({
        action: "NO_ACTION",
        symbols_considered: [],
        reasoning_summary: `Equity market closed, no crypto symbols in watchlist. Waiting for open ~${nextOpenStr} ET.`,
        order_attempted: false,
        order_status: "none",
        completed_at: new Date().toISOString(),
      }, "NO_ACTION");
      broadcastRaceSSE({ type: "bot_update", bot: serializeBot(bot) });
      return;
    }

    if (!is_open && cryptoSymbols.length > 0) {
      const skipped = equitySymbols.length > 0 ? ` (skipping equities: ${equitySymbols.join(", ")})` : "";
      addRaceLog(botId, { type: "market", message: `🌙 Market closed — crypto only: ${cryptoSymbols.join(", ")}${skipped}` });
    }

    const priceLines = Object.entries(prices).map(([sym, q]) => {
      const pctStr = `${q.changePercent >= 0 ? "+" : ""}${q.changePercent.toFixed(2)}%`;
      const volStr = q.volume ? ` vol ${(q.volume / 1000).toFixed(0)}k` : "";
      const tag = isCrypto(sym) ? " 🔄24h" : "";
      return `${sym}: $${q.price.toFixed(2)} (${pctStr}${volStr}${tag})`;
    });

    if (priceLines.length === 0) {
      addRaceLog(botId, { type: "error", message: "⚠️ No price data — skipping AI cycle" });
      finalizeCycle({
        action: "FAILED",
        symbols_considered: activeScanSymbols,
        reasoning_summary: "Price fetch returned no data for any active symbol.",
        order_attempted: false,
        order_status: "none",
        completed_at: new Date().toISOString(),
        error: "Price fetch returned no data",
      }, "FAILED");
      broadcastRaceSSE({ type: "bot_update", bot: serializeBot(bot) });
      return;
    }

    addRaceLog(botId, { type: "market", message: `📊 ${priceLines.join(" | ")}` });
    const priceContext = priceLines.join("\n");

    // ── AI agent ──────────────────────────────────────────────────────────────
    bot.cycleStatus = "DECIDED";
    if (bot.diagnostics) bot.diagnostics.strategy_started = new Date().toISOString();

    const cryptoNote = !is_open
      ? `\n⚠️ Equity market CLOSED. Only crypto tradeable: ${cryptoSymbols.join(", ")}. Crypto orders MUST use time_in_force=gtc and market type.`
      : isEOD ? "\n⚠️ EOD MODE: Close all positions NOW — market closes in <15 min!" : "";

    // ── Virtual portfolio context for the AI ──────────────────────────────────
    const vp = bot.portfolio;
    const vpPositionContext = vp.open_positions.length > 0
      ? vp.open_positions.map((p) =>
          `${p.symbol}: qty=${p.qty.toFixed(6)}, cost_basis=$${p.cost_basis.toFixed(2)}, market_value=$${p.market_value.toFixed(2)}, unrealized=${p.unrealized_pnl >= 0 ? "+" : ""}$${p.unrealized_pnl.toFixed(2)}`
        ).join("\n")
      : "No open positions";

    const systemPrompt = `You are Bot ${bot.emoji} "${bot.name}" — one of 4 AI traders competing simultaneously.
You have a personal budget of $${bot.budget}. You are trying to beat the other 3 bots.${cryptoNote}

YOUR VIRTUAL PORTFOLIO (cycle #${bot.cyclesStarted}):
- Cash available: $${vp.cash.toFixed(2)} / $${vp.starting_budget}
- Open position value: $${vp.open_position_value.toFixed(2)}
- Total equity: $${vp.total_equity.toFixed(2)} (${vp.total_pnl >= 0 ? "+" : ""}${vp.total_pnl_pct.toFixed(2)}%)
- Realized P&L: ${vp.realized_pnl >= 0 ? "+" : ""}$${vp.realized_pnl.toFixed(2)}
- Unrealized P&L: ${vp.unrealized_pnl >= 0 ? "+" : ""}$${vp.unrealized_pnl.toFixed(2)}
${is_open ? `- Minutes until market close: ${minutesToClose}` : "- Equity market: CLOSED (crypto tradeable 24/7)"}
- Market open: ${is_open}

YOUR OPEN POSITIONS (virtual — isolated to you):
${vpPositionContext}

LIVE PRICES (active symbols only):
${priceContext}

YOUR STRATEGY:
${isEOD ? "⚠️ EOD: Use close_all_positions immediately." : bot.strategy}

HARD RULES: Never spend more than your available cash ($${vp.cash.toFixed(2)}). Use log_reasoning first. Be decisive.
If you choose NOT to trade this cycle, call log_reasoning with your rationale — do NOT call place_order with zero notional.
For crypto orders: always use time_in_force="gtc", type="market", and notional (dollar amount).`;

    const msgs: Parameters<typeof openai.chat.completions.create>[0]["messages"] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: isEOD ? "Close all positions — market closing." : "Run your scan and execute your strategy." },
    ];

    const tradesBefore = bot.tradesCount;
    let loops = 0;
    let reasoningSummary = "";

    while (loops++ < 8) {
      const resp = await openai.chat.completions.create({
        model: "gpt-5.4", max_completion_tokens: 1024,
        messages: msgs, tools: TRADING_TOOLS, tool_choice: "auto", stream: false,
      });
      const choice = resp.choices[0];
      if (!choice) break;
      if (choice.finish_reason === "tool_calls" && choice.message.tool_calls?.length) {
        msgs.push(choice.message as Parameters<typeof openai.chat.completions.create>[0]["messages"][number]);
        for (const tc of choice.message.tool_calls) {
          let args: Record<string, unknown> = {};
          try { args = JSON.parse(tc.function.arguments) as Record<string, unknown>; } catch { /* */ }
          if (tc.function.name === "log_reasoning") {
            const parsed = args as { reasoning?: string };
            if (parsed.reasoning) reasoningSummary = parsed.reasoning.slice(0, 200);
          }
          const result = await executeRaceTool(botId, tc.function.name, args, snapshot.prices, snapshot.is_open);
          msgs.push({ role: "tool", tool_call_id: tc.id, content: result } as Parameters<typeof openai.chat.completions.create>[0]["messages"][number]);
        }
        continue;
      }
      if (choice.message.content) {
        const content = choice.message.content.slice(0, 200);
        addRaceLog(botId, { type: "info", message: content });
        if (!reasoningSummary) reasoningSummary = content;
      }
      break;
    }

    if (bot.diagnostics) bot.diagnostics.strategy_completed = new Date().toISOString();

    // ── Structured scan_result ────────────────────────────────────────────────
    const finalCycleStatus: string = bot.cycleStatus;
    const newTrades = bot.tradesCount - tradesBefore;
    const recentTradeLogs = bot.logs.slice(0, 5).filter((l) => l.type === "buy" || l.type === "sell" || l.type === "close");

    // Bots that chose not to trade → NO_ACTION; bots that traded → COMPLETED
    const action: ScanResult["action"] = isEOD
      ? "SELL"
      : newTrades > 0
        ? (recentTradeLogs[0]?.type === "buy" ? "BUY" : "SELL")
        : "NO_ACTION";

    const terminalStatus: "COMPLETED" | "NO_ACTION" =
      newTrades > 0 || finalCycleStatus === "ORDER_FAILED" ? "COMPLETED" : "NO_ACTION";

    const orderStatus: ScanResult["order_status"] =
      finalCycleStatus === "ORDER_FILLED" ? "filled"
      : finalCycleStatus === "ORDER_FAILED" ? "rejected"
      : newTrades > 0 ? "pending"
      : "none";

    // ── Mark-to-market: revalue all open positions using shared snapshot prices ─
    // buildMtmPriceMap adds both BTC/USD and BTC-USD keys so symbol form never misses
    markToMarket(bot.portfolio, buildMtmPriceMap(snapshot.prices));

    finalizeCycle({
      action,
      symbols_considered: activeScanSymbols,
      reasoning_summary: reasoningSummary || (newTrades > 0 ? `Executed ${newTrades} trade(s)` : "No trade signal — held cash"),
      order_attempted: newTrades > 0 || finalCycleStatus === "ORDER_FAILED",
      order_status: orderStatus,
      completed_at: new Date().toISOString(),
    }, terminalStatus);

    broadcastRaceSSE({ type: "bot_update", bot: serializeBot(bot) });

    // ── Auto-export after every completed bot cycle ───────────────────────────
    try {
      const health = computeRaceHealth(
        Array.from(raceBots.values()).map<BotHealthSnapshot>((b) => ({
          id: b.id,
          cycleStatus: b.cycleStatus,
          cyclesStarted: b.cyclesStarted,
          cycleCount: b.cycleCount,
          first_cycle_terminal: b.first_cycle_terminal,
          running: b.running,
        }))
      );

      const botsSnapshot = Array.from(raceBots.values()).map((b) => ({
        id: b.id,
        name: b.name,
        emoji: b.emoji,
        status: b.running ? "LIVE" : "STOPPED",
        starting_budget: b.portfolio.starting_budget,
        cash: b.portfolio.cash,
        open_positions: b.portfolio.open_positions,
        open_position_value: b.portfolio.open_position_value,
        realized_pnl: b.portfolio.realized_pnl,
        unrealized_pnl: b.portfolio.unrealized_pnl,
        total_equity: b.portfolio.total_equity,
        total_pnl: b.portfolio.total_pnl,
        total_pnl_pct: b.portfolio.total_pnl_pct,
        execution_details: b.portfolio.execution_details.slice(-5),
        risk_rejections_count: b.risk_rejections.length,
        recent_rejections: b.risk_rejections.slice(-3).map((r) => ({
          cycle: r.cycle, timestamp: r.timestamp, symbol: r.symbol,
          side: r.side, notional: r.notional, violations: r.violations,
          computedExposure: r.computedExposure,
        })),
        net_pnl: b.portfolio.total_pnl,
        trades: b.tradesCount,
        cycles_completed: b.cycleCount,
        cycles_started: b.cyclesStarted,
        cycle_status: b.cycleStatus,
        first_cycle_terminal: b.first_cycle_terminal,
        diagnostics: b.diagnostics,
        last_scan: b.lastScan,
        scan_result: b.scan_result,
        latest_logs: b.logs.slice(0, 6).map((l) => ({ type: l.type, message: l.message, timestamp: l.timestamp })),
        strategy: b.id,
        // ── Tie-breaker fields ──────────────────────────────────────────────
        did_trade:        b.tradesCount > 0,
        capital_deployed: b.portfolio.open_position_value,
        deployment_pct:   b.portfolio.starting_budget > 0
          ? (b.portfolio.open_position_value / b.portfolio.starting_budget) * 100
          : 0,
        session_eligible: botSessionEligible(b.id, snapshot),
      }));

      const rankResult = computeRanks(
        botsSnapshot.map((b): BotRankInput => ({
          id: b.id,
          total_equity: b.total_equity,
          did_trade: b.did_trade,
          capital_deployed: b.capital_deployed,
          deployment_pct: b.deployment_pct,
          session_eligible: b.session_eligible,
          realized_pnl: b.realized_pnl,
          unrealized_pnl: b.unrealized_pnl,
        })),
        {
          snapshotId: snapshot.id,
          raceReady: health.race_ready_for_comparison,
          requirePerformanceData: true,
          excludeIneligible: true,
        }
      );
      const rankById = new Map(rankResult.ranks.map((r) => [r.id, r]));
      const ranked = botsSnapshot.map((b) => ({
        ...b,
        rank:                   rankById.get(b.id)?.rank ?? null,
        rank_label:             rankById.get(b.id)?.rank_label ?? "IN PROGRESS",
        is_tied:                rankById.get(b.id)?.is_tied ?? false,
        tie_break_reason:       rankById.get(b.id)?.tie_break_reason ?? null,
        comparison_reason:      rankById.get(b.id)?.comparison_reason ?? "",
        participation_category: rankById.get(b.id)?.participation_category ?? ("idle" as BotParticipationCategory),
        comparison_deferred:    rankById.get(b.id)?.comparison_deferred ?? false,
        excluded_from_ranking:  rankById.get(b.id)?.excluded_from_ranking ?? false,
      }));
      // Sort rank-1 first — export bots array is always in rank order,
      // not RACE_CONFIGS insertion order (which would make momentum always [0]).
      ranked.sort((a, b) => {
        const ra = a.rank ?? Infinity;
        const rb = b.rank ?? Infinity;
        if (ra !== rb) return ra - rb;
        return a.id.localeCompare(b.id);
      });
      const leaderText = buildRaceLeaderText(ranked, rankResult, health.race_ready_for_comparison);

      const feed = Array.from(raceBots.values())
        .flatMap((b) => b.logs.slice(0, 10).map((l) => ({ botId: b.id, botName: b.name, ...l })))
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
        .slice(0, 40);

      const errors = Array.from(raceBots.values())
        .flatMap((b) => b.logs.filter((l) => l.type === "error").slice(0, 3).map((l) => ({ botId: b.id, ...l })));

      writeExport({
        screen: "TradeBot",
        mode: "4-Bot Race",
        symbols: raceSymbols,
        snapshot_id: snapshot.id,
        market_open: snapshot.is_open,
        active_scan_symbols: snapshot.active_symbols,
        budget_per_bot: raceBudgetPerBot,
        race_health: health,
        bots: ranked,
        live_feed: feed,
        errors,
        summary: {
          is_tie: rankResult.is_global_tie,
          comparison_deferred: rankResult.comparison_deferred,
          deferred_reason: rankResult.deferred_reason,
          race_ready_for_comparison: health.race_ready_for_comparison,
          race_incomplete: !health.race_ready_for_comparison,
          ranking_basis: rankResult.ranking_basis,
          tie_break_reason: rankResult.tie_break_reason,
          leader: leaderText,
          total_trades: ranked.reduce((s, b) => s + b.trades, 0),
          total_pnl: ranked.reduce((s, b) => s + b.total_pnl, 0),
          total_equity: ranked.reduce((s, b) => s + b.total_equity, 0),
          bots_with_no_scan: health.bots_not_started,
          bots_current_cycle_no_action: health.bots_no_action,
          bots_ever_traded: Array.from(raceBots.values()).filter((b) => b.tradesCount > 0).length,
          bots_active_participants: ranked.filter((b) => b.participation_category === "active").length,
          bots_idle_no_signal:      ranked.filter((b) => b.participation_category === "idle").length,
          bots_session_ineligible:  ranked.filter((b) => b.participation_category === "ineligible").length,
          bots_awaiting:            ranked.filter((b) => b.rank_label === "AWAITING").length,
          bots_excluded:            ranked.filter((b) => b.excluded_from_ranking).length,
        },
      });
    } catch {
      // Never let export failure break the trading loop
    }
  } catch (err) {
    if (bot.diagnostics) {
      bot.diagnostics.init_error = String(err).slice(0, 200);
      bot.diagnostics.completed_at = new Date().toISOString();
    }
    finalizeCycle({
      action: "FAILED",
      symbols_considered: raceSymbols,
      reasoning_summary: String(err).slice(0, 200),
      order_attempted: false,
      order_status: "none",
      completed_at: new Date().toISOString(),
      error: String(err).slice(0, 200),
    }, "FAILED");
    addRaceLog(botId, { type: "error", message: `Error: ${String(err)}` });
    broadcastRaceSSE({ type: "bot_update", bot: serializeBot(bot) });
  }
}

// ─── Per-bot timeout handler ──────────────────────────────────────────────────
// Converts a stuck SCANNING/DECIDED/ORDER_SUBMITTED bot to TIMED_OUT.
// finalizeCycle inside runRaceBotCycle is idempotent — whichever fires first wins.

function handleBotCycleTimeout(botId: string): void {
  const bot = raceBots.get(botId);
  if (!bot) return;
  if (isTerminalCycleStatus(bot.cycleStatus)) return; // cycle finished before timeout — nothing to do

  const stuckIn = bot.cycleStatus;
  const msg = `⏱ Cycle timed out after ${RACE_BOT_CYCLE_TIMEOUT_MS / 1000}s — was in ${stuckIn}`;
  addRaceLog(botId, { type: "error", message: msg });
  bot.cycleCount++;
  bot.scan_result = {
    action: "TIMED_OUT",
    symbols_considered: raceSymbols,
    reasoning_summary: `Bot cycle timed out after ${RACE_BOT_CYCLE_TIMEOUT_MS / 1000}s. Last known status: ${stuckIn}.`,
    order_attempted: false,
    order_status: "none",
    completed_at: new Date().toISOString(),
    timed_out: true,
    error: msg,
  };
  bot.cycleStatus = "TIMED_OUT";
  if (!bot.first_cycle_terminal) bot.first_cycle_terminal = true;
  if (bot.diagnostics) {
    bot.diagnostics.timeout_at = new Date().toISOString();
    bot.diagnostics.completed_at = new Date().toISOString();
  }
  broadcastRaceSSE({ type: "cycle_timeout", botId, stuckIn, bot: serializeBot(bot) });
}

async function runRaceBotCycleWithTimeout(botId: string, snapshot: MarketSnapshot): Promise<void> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<void>((resolve) => {
    timeoutId = setTimeout(() => {
      handleBotCycleTimeout(botId);
      resolve();
    }, RACE_BOT_CYCLE_TIMEOUT_MS);
  });
  try {
    await Promise.race([runRaceBotCycle(botId, snapshot), timeoutPromise]);
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
  }
}

// ─── Race coordinator ─────────────────────────────────────────────────────────
// First cycle: all bots launch CONCURRENTLY — no stagger.
// Subsequent ticks: light stagger (BOT_STAGGER_MS) to avoid API hammering.
// Each call is wrapped in runRaceBotCycleWithTimeout for the 25 s per-bot budget.

async function startRaceCoordinator(): Promise<void> {
  if (raceTick) clearInterval(raceTick);

  // Fetch one shared snapshot for the first cycle — all 4 bots see identical prices
  let initialSnapshot: MarketSnapshot | null = null;
  try {
    initialSnapshot = await fetchMarketSnapshot(raceSymbols);
    latestRaceSnapshot = initialSnapshot;
    broadcastRaceSSE({
      type: "snapshot",
      snapshotId: initialSnapshot.id,
      fetched_at: initialSnapshot.fetched_at,
      is_open: initialSnapshot.is_open,
    });
  } catch (err) {
    for (const cfg of RACE_CONFIGS) {
      addRaceLog(cfg.id, { type: "error", message: `Snapshot fetch failed: ${String(err).slice(0, 100)}` });
    }
  }

  // Concurrent first-cycle launch — all 4 bots start at the same moment with the same snapshot
  for (const cfg of RACE_CONFIGS) {
    const bot = raceBots.get(cfg.id);
    if (!bot?.running) continue;
    addRaceLog(cfg.id, { type: "market", message: `${cfg.emoji} ${cfg.name} live — $${bot.budget} budget` });
    bot.nextScan = new Date(Date.now() + RACE_INTERVAL_MS).toISOString();
    broadcastRaceSSE({ type: "bot_update", bot: serializeBot(bot) });
    if (initialSnapshot) void runRaceBotCycleWithTimeout(cfg.id, initialSnapshot);
  }

  // Subsequent ticks: fetch a fresh shared snapshot, then stagger bots
  raceTick = setInterval(() => {
    void (async () => {
      let snapshot: MarketSnapshot | null = null;
      try {
        snapshot = await fetchMarketSnapshot(raceSymbols);
        latestRaceSnapshot = snapshot;
        broadcastRaceSSE({
          type: "snapshot",
          snapshotId: snapshot.id,
          fetched_at: snapshot.fetched_at,
          is_open: snapshot.is_open,
        });
      } catch {
        return; // skip this tick — all bots skip together rather than seeing stale/different prices
      }
      RACE_CONFIGS.forEach((cfg, i) => {
        setTimeout(() => {
          const bot = raceBots.get(cfg.id);
          if (!bot?.running) return;
          bot.nextScan = new Date(Date.now() + RACE_INTERVAL_MS).toISOString();
          broadcastRaceSSE({ type: "bot_update", bot: serializeBot(bot) });
          void runRaceBotCycleWithTimeout(cfg.id, snapshot!);
        }, i * BOT_STAGGER_MS);
      });
    })();
  }, RACE_INTERVAL_MS);
}

router.post("/autopilot/race/start", async (req, res) => {
  const { symbols, budget } = req.body as { symbols: string[]; budget: number };
  if (!symbols?.length) { res.status(400).json({ error: "symbols required" }); return; }

  // Clear any existing race state
  if (raceTick) { clearInterval(raceTick); raceTick = null; }
  for (const bot of raceBots.values()) { if (bot.interval) { clearInterval(bot.interval); bot.interval = null; } }

  raceSymbols = symbols;
  raceActive = true;
  initRaceBots(budget ?? 1000);

  // Mark all bots as running before launching coordinator
  for (const cfg of RACE_CONFIGS) {
    const bot = raceBots.get(cfg.id)!;
    bot.running = true;
    bot.nextScan = new Date(Date.now() + BOT_STAGGER_MS * RACE_CONFIGS.indexOf(cfg) + RACE_INTERVAL_MS).toISOString();
  }

  void startRaceCoordinator();
  broadcastRaceSSE({ type: "race_start", symbols, budgetPerBot: raceBudgetPerBot });
  res.json({ ok: true, budgetPerBot: raceBudgetPerBot, stagger_ms: BOT_STAGGER_MS, interval_ms: RACE_INTERVAL_MS });
});

router.post("/autopilot/race/stop", (_req, res) => {
  raceActive = false;
  // Clear the shared coordinator tick
  if (raceTick) { clearInterval(raceTick); raceTick = null; }
  // Also clear any residual per-bot intervals (legacy safety)
  for (const [id, bot] of raceBots.entries()) {
    if (bot.interval) { clearInterval(bot.interval); bot.interval = null; }
    bot.running = false;
    addRaceLog(id, { type: "market", message: `${bot.emoji} Stopped` });
  }
  broadcastRaceSSE({ type: "race_stop" });
  res.json({ ok: true });
});

router.get("/autopilot/race/status", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  raceSseClients.add(res);

  const allLogs = Array.from(raceBots.entries())
    .flatMap(([id, b]) => b.logs.slice(0, 15).map((l) => ({ ...l, botId: id })))
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, 60);

  res.write(`data: ${JSON.stringify({
    type: "init",
    active: raceActive,
    symbols: raceSymbols,
    budgetPerBot: raceBudgetPerBot,
    bots: Array.from(raceBots.values()).map(serializeBot),
    logs: allLogs,
  })}\n\n`);

  const hb = setInterval(() => { try { res.write(`data: ${JSON.stringify({ type: "ping" })}\n\n`); } catch { clearInterval(hb); } }, 30000);
  req.on("close", () => { raceSseClients.delete(res); clearInterval(hb); });
});

router.get("/autopilot/race/stats", (_req, res) => {
  res.json({ active: raceActive, symbols: raceSymbols, budgetPerBot: raceBudgetPerBot, bots: Array.from(raceBots.values()).map(serializeBot) });
});

router.get("/autopilot/race/snapshot", (_req, res) => {
  res.json(getRaceSnapshot());
});

// ─── Snapshot export (used by aiBrain export-snapshot endpoint) ───────────────

export function getAutopilotSnapshot() {
  return {
    mode: "solo",
    running: state.running,
    symbols: state.symbols,
    budget: state.budget,
    strategy: state.strategy,
    tradesCount: state.tradesCount,
    totalPnl: state.totalPnl,
    lastScan: state.lastScan,
    logs: state.logs.slice(0, 30),
  };
}

export function getRaceSnapshot() {
  // ── Health metrics (pure computation from bot states) ─────────────────────
  const health = computeRaceHealth(
    Array.from(raceBots.values()).map<BotHealthSnapshot>((b) => ({
      id: b.id,
      cycleStatus: b.cycleStatus,
      cyclesStarted: b.cyclesStarted,
      cycleCount: b.cycleCount,
      first_cycle_terminal: b.first_cycle_terminal,
      running: b.running,
    }))
  );

  const botsData = Array.from(raceBots.values()).map((b) => ({
    id: b.id,
    name: b.name,
    emoji: b.emoji,
    color: b.color,
    status: b.running ? "LIVE" : "STOPPED",
    budget: b.budget,
    // ── Virtual portfolio (authoritative) ─────────────────────────────────
    starting_budget: b.portfolio.starting_budget,
    cash: b.portfolio.cash,
    open_positions: b.portfolio.open_positions,
    open_position_value: b.portfolio.open_position_value,
    realized_pnl: b.portfolio.realized_pnl,
    unrealized_pnl: b.portfolio.unrealized_pnl,
    total_equity: b.portfolio.total_equity,
    total_pnl: b.portfolio.total_pnl,
    total_pnl_pct: b.portfolio.total_pnl_pct,
    execution_details: b.portfolio.execution_details.slice(-10),
    // ── Cycle diagnostics ─────────────────────────────────────────────────
    first_cycle_terminal: b.first_cycle_terminal,
    diagnostics: b.diagnostics,
    // ── Legacy compat ─────────────────────────────────────────────────────
    net_pnl: b.portfolio.total_pnl,
    net_spent: b.netSpent,
    net_received: b.netReceived,
    trades: b.tradesCount,
    cycles_completed: b.cycleCount,
    cycles_started: b.cyclesStarted,
    cycle_status: b.cycleStatus,
    lastScan: b.lastScan,
    scan_result: b.scan_result,
    latest_logs: b.logs.slice(0, 8).map((l) => ({
      type: l.type,
      message: l.message,
      symbol: l.symbol ?? null,
      timestamp: l.timestamp,
    })),
    // ── Tie-breaker fields ────────────────────────────────────────────────
    did_trade:        b.tradesCount > 0,
    capital_deployed: b.portfolio.open_position_value,
    deployment_pct:   b.portfolio.starting_budget > 0
      ? (b.portfolio.open_position_value / b.portfolio.starting_budget) * 100
      : 0,
    session_eligible: latestRaceSnapshot
      ? botSessionEligible(b.id, latestRaceSnapshot)
      : true,
    // ── Rank fields — pre-declared with null defaults so TypeScript knows the
    //    types before computeRanks populates them via a typed for-loop below. ──
    rank:                   null as number | null,
    rank_label:             "IN PROGRESS" as string,
    is_tied:                false,
    tie_break_reason:       null as string | null,
    comparison_reason:      "" as string,
    participation_category: "idle" as BotParticipationCategory,
    comparison_deferred:    false,
    excluded_from_ranking:  false,
  }));

  // ── Deterministic epsilon-based ranking ───────────────────────────────────
  const latestSnapshotId = Array.from(raceBots.values())
    .map((b) => b.current_snapshot_id).find((id) => id !== null) ?? "none";
  const rankResult = computeRanks(
    botsData.map((b): BotRankInput => ({
      id: b.id,
      total_equity: b.total_equity,
      did_trade: b.did_trade,
      capital_deployed: b.capital_deployed,
      deployment_pct: b.deployment_pct,
      session_eligible: b.session_eligible,
      realized_pnl: b.realized_pnl,
      unrealized_pnl: b.unrealized_pnl,
    })),
    {
      snapshotId: latestSnapshotId,
      raceReady: health.race_ready_for_comparison,
      requirePerformanceData: true,
      excludeIneligible: true,
    }
  );
  // Populate typed rank fields (rank was pre-declared as number|null in the map above)
  const rankById = new Map(rankResult.ranks.map((r) => [r.id, r]));
  for (const b of botsData) {
    const r = rankById.get(b.id);
    if (r) {
      b.rank                   = r.rank;
      b.rank_label             = r.rank_label;
      b.is_tied                = r.is_tied;
      b.tie_break_reason       = r.tie_break_reason;
      b.comparison_reason      = r.comparison_reason;
      b.participation_category = r.participation_category;
      b.comparison_deferred    = r.comparison_deferred;
      b.excluded_from_ranking  = r.excluded_from_ranking;
    }
  }
  // Sort rank-1 first; tied/null ranks go after real ranks, ordered by id for stability.
  // This guarantees botsData[0] is always the current leader and the summary.leader
  // is derived from the same source as the bots array — single source of truth.
  botsData.sort((a, b) => {
    const ra = a.rank ?? Infinity;
    const rb = b.rank ?? Infinity;
    if (ra !== rb) return ra - rb;
    return a.id.localeCompare(b.id);
  });
  const leaderText = buildRaceLeaderText(botsData, rankResult, health.race_ready_for_comparison);

  const recentFeed = Array.from(raceBots.values())
    .flatMap((b) => b.logs.slice(0, 12).map((l) => ({ botId: b.id, botName: b.name, ...l })))
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, 50);

  const errors = Array.from(raceBots.values())
    .flatMap((b) => b.logs.filter((l) => l.type === "error").slice(0, 3).map((l) => ({ botId: b.id, ...l })));

  // Bots still in progress (not yet at a terminal first-cycle state)
  const inProgressWarnings = Array.from(raceBots.values())
    .filter((b) => b.running && !b.first_cycle_terminal)
    .map((b) => ({
      type: "warning",
      botId: b.id,
      message: `${b.emoji} ${b.name} has not completed its first cycle yet (status: ${b.cycleStatus})`,
    }));

  return {
    mode: "4-Bot Race",
    active: raceActive,
    symbols: raceSymbols,
    budget_per_bot: raceBudgetPerBot,
    total_budget: raceBudgetPerBot * 4,
    race_health: health,
    bots: botsData,
    live_feed: recentFeed,
    errors: [...errors, ...inProgressWarnings],
    summary: {
      is_tie: rankResult.is_global_tie,
      comparison_deferred: rankResult.comparison_deferred,
      deferred_reason: rankResult.deferred_reason,
      race_ready_for_comparison: health.race_ready_for_comparison,
      race_incomplete: !health.race_ready_for_comparison,
      ranking_basis: rankResult.ranking_basis,
      tie_break_reason: rankResult.tie_break_reason,
      snapshot_id: latestSnapshotId,
      leader: leaderText,
      total_trades: botsData.reduce((s, b) => s + b.trades, 0),
      total_pnl: botsData.reduce((s, b) => s + b.net_pnl, 0),
      bots_completed_first_cycle: health.bots_completed_first_cycle,
      bots_failed: health.bots_failed,
      bots_timed_out: health.bots_timed_out,
      bots_with_no_scan: health.bots_not_started,
      bots_current_cycle_no_action: health.bots_no_action,
      bots_ever_traded: Array.from(raceBots.values()).filter((b) => b.tradesCount > 0).length,
      bots_active_participants: botsData.filter((b) => b.participation_category === "active").length,
      bots_idle_no_signal:      botsData.filter((b) => b.participation_category === "idle").length,
      bots_session_ineligible:  botsData.filter((b) => b.participation_category === "ineligible").length,
      bots_awaiting:            botsData.filter((b) => b.rank_label === "AWAITING").length,
      bots_excluded:            botsData.filter((b) => b.excluded_from_ranking).length,
    },
  };
}

export default router;
