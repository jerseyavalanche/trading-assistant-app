// ─── Pre-Trade Risk Validator ──────────────────────────────────────────────────
// Single source of truth for:
//   • Symbol normalization  (BTC-USD / BTC/USD / BTC → canonical form)
//   • Market-type detection (crypto vs equity)
//   • Per-bot strategy rule enforcement before any order reaches Alpaca
//   • Post-trade portfolio invariant checks
//
// All rules are derived directly from the strategy text in RACE_CONFIGS.

import type { BotPortfolio } from "./portfolioEngine.js";

// ─── Symbol utilities ─────────────────────────────────────────────────────────

const CRYPTO_BARE = ["BTC","ETH","SOL","DOGE","ADA","XRP","AVAX","MATIC","DOT","LINK"] as const;
type CryptoBare = typeof CRYPTO_BARE[number];

export type MarketType = "crypto" | "equity";

/** One canonical normalizer — used by both autopilot and risk validator.
 *  BTC-USD → BTC/USD | ETH → ETH/USD | BTC/USD stays | AAPL stays */
export function normalizeSymbol(symbol: string): string {
  const upper = symbol.toUpperCase().trim();
  // Already slash-separated crypto
  if (upper.includes("/")) return upper;
  // Dash-separated crypto
  if (upper.endsWith("-USD"))  return upper.replace(/-USD$/,  "/USD");
  if (upper.endsWith("-USDT")) return upper.replace(/-USDT$/, "/USDT");
  // Bare crypto ticker
  if ((CRYPTO_BARE as readonly string[]).includes(upper)) return `${upper}/USD`;
  // Equity — return as-is (AAPL, MSFT, etc.)
  return upper;
}

/** Returns the market type for any symbol string (before or after normalization). */
export function detectMarketType(symbol: string): MarketType {
  const upper = symbol.toUpperCase().trim();
  if (upper.includes("/")) return "crypto";
  if (upper.endsWith("-USD") || upper.endsWith("-USDT")) return "crypto";
  if ((CRYPTO_BARE as readonly string[]).includes(upper)) return "crypto";
  return "equity";
}

// ─── Per-bot risk config ──────────────────────────────────────────────────────
// Mirrors strategy text in RACE_CONFIGS exactly — single source of truth.

export interface BotRiskConfig {
  botId: string;
  /** Symbols allowed. "all" = any symbol in the current race universe. */
  allowedSymbols: string[] | "all";
  /** If true, equity orders are blocked when market is closed (crypto is exempt). */
  requiresMarketOpen: boolean;
  /** Maximum notional per symbol as fraction of starting_budget (e.g. 0.25 = 25%). */
  maxPositionPct: number;
  /** Hard cap on max concurrent open positions. */
  maxConcurrentPositions: number;
  /** Max total open exposure as fraction of starting_budget. */
  maxTotalExposurePct: number;
}

export const BOT_RISK_CONFIGS: Record<string, BotRiskConfig> = {
  momentum: {
    botId: "momentum",
    allowedSymbols: "all",
    requiresMarketOpen: false,
    maxPositionPct: 0.25,        // "Max position: 25% of your personal budget per stock"
    maxConcurrentPositions: 4,   // "Max 4 concurrent positions"
    maxTotalExposurePct: 1.0,    // 4 × 25% = 100%
  },
  dip_buyer: {
    botId: "dip_buyer",
    allowedSymbols: "all",
    requiresMarketOpen: false,
    maxPositionPct: 0.20,        // "Max position: 20% of your personal budget per stock"
    maxConcurrentPositions: 3,   // "Max 3 concurrent positions"
    maxTotalExposurePct: 0.60,   // 3 × 20%
  },
  conservative: {
    botId: "conservative",
    allowedSymbols: ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "TSLA"],
    requiresMarketOpen: true,    // "Only trade large-cap household names" → equity only
    maxPositionPct: 0.15,        // "Max position: 15% of your personal budget per stock"
    maxConcurrentPositions: 3,   // "Max 3 concurrent positions"
    maxTotalExposurePct: 0.45,   // 3 × 15%
  },
  scalper: {
    botId: "scalper",
    allowedSymbols: "all",
    requiresMarketOpen: false,
    maxPositionPct: 0.30,        // "Max position: 30% of your personal budget"
    maxConcurrentPositions: 3,   // "Max 3 positions"
    maxTotalExposurePct: 0.90,   // 3 × 30%
  },
};

// ─── Validation types ─────────────────────────────────────────────────────────

export interface Violation {
  rule: string;
  detail: string;
  severity: "block" | "warn";
}

export interface ComputedExposure {
  existing_position_value: number;   // current market_value of this symbol in portfolio
  position_after_order: number;      // existing + notional (what it would become)
  max_allowed_per_symbol: number;    // maxPositionPct * starting_budget
  open_positions_count: number;      // current number of open positions
  total_exposure_current: number;    // current open_position_value
  total_exposure_after: number;      // total_exposure_current + notional
  total_exposure_pct_after: number;  // as % of starting_budget
  max_total_exposure: number;        // maxTotalExposurePct * starting_budget
}

export interface ValidationResult {
  allowed: boolean;
  violations: Violation[];
  computedExposure: ComputedExposure;
}

// ─── Pre-trade validator ──────────────────────────────────────────────────────

export interface PreTradeOpts {
  botId: string;
  side: "buy" | "sell" | string;
  rawSymbol: string;          // as the AI passed it — may be BTC-USD or BTC/USD
  notional: number;
  portfolio: BotPortfolio;
  marketIsOpen: boolean;
  raceSymbols: string[];      // the symbols this race was started with
}

export function validatePreTrade(opts: PreTradeOpts): ValidationResult {
  const { botId, side, rawSymbol, notional, portfolio, marketIsOpen, raceSymbols } = opts;
  const sym = normalizeSymbol(rawSymbol);
  const mktType = detectMarketType(sym);

  const config = BOT_RISK_CONFIGS[botId];
  const violations: Violation[] = [];

  // ── Compute exposure numbers upfront ────────────────────────────────────────
  const existingPos = portfolio.open_positions.find(
    (p) => normalizeSymbol(p.symbol) === sym
  );
  const existingValue = existingPos?.market_value ?? 0;
  const positionAfter = existingValue + notional;
  const maxPerSymbol  = config ? config.maxPositionPct * portfolio.starting_budget : Infinity;
  const maxTotal      = config ? config.maxTotalExposurePct * portfolio.starting_budget : Infinity;
  const totalAfter    = portfolio.open_position_value + (side === "buy" ? notional : 0);
  const totalAfterPct = portfolio.starting_budget > 0 ? (totalAfter / portfolio.starting_budget) * 100 : 0;

  const exposure: ComputedExposure = {
    existing_position_value: existingValue,
    position_after_order:    positionAfter,
    max_allowed_per_symbol:  maxPerSymbol,
    open_positions_count:    portfolio.open_positions.length,
    total_exposure_current:  portfolio.open_position_value,
    total_exposure_after:    totalAfter,
    total_exposure_pct_after: totalAfterPct,
    max_total_exposure:      maxTotal,
  };

  // ── SELL: only basic checks ──────────────────────────────────────────────────
  if (side !== "buy") {
    return { allowed: violations.length === 0, violations, computedExposure: exposure };
  }

  // ── BUY checks (all BLOCK severity unless noted) ─────────────────────────────

  // 1. Config exists?
  if (!config) {
    violations.push({
      rule: "unknown_bot",
      detail: `No risk config found for botId="${botId}" — order blocked as safety measure.`,
      severity: "block",
    });
    return { allowed: false, violations, computedExposure: exposure };
  }

  // 2. Symbol universe
  if (config.allowedSymbols !== "all") {
    const normalizedAllowed = config.allowedSymbols.map(normalizeSymbol);
    if (!normalizedAllowed.includes(sym)) {
      violations.push({
        rule: "symbol_not_allowed",
        detail: `${botId} strategy only allows [${config.allowedSymbols.join(", ")}]. "${sym}" is not in the list.`,
        severity: "block",
      });
    }
  }

  // 3. Race universe — symbol must be in the symbols this race was started with
  if (raceSymbols.length > 0) {
    const normalizedRace = raceSymbols.map(normalizeSymbol);
    if (!normalizedRace.includes(sym)) {
      violations.push({
        rule: "symbol_not_in_race",
        detail: `"${sym}" is not in the race universe [${raceSymbols.join(", ")}].`,
        severity: "block",
      });
    }
  }

  // 4. Market session restriction
  if (config.requiresMarketOpen && mktType === "equity" && !marketIsOpen) {
    violations.push({
      rule: "market_closed",
      detail: `${botId} can only trade equities during market hours. Market is currently closed.`,
      severity: "block",
    });
  }

  // 5. Available cash
  if (notional > portfolio.cash + 0.01) {
    violations.push({
      rule: "insufficient_cash",
      detail: `Need $${notional.toFixed(2)} but only $${portfolio.cash.toFixed(2)} available.`,
      severity: "block",
    });
  }

  // 6. Max order notional (single order vs per-symbol cap)
  if (notional > maxPerSymbol + 0.01) {
    violations.push({
      rule: "order_exceeds_max_position",
      detail: `Order $${notional.toFixed(2)} exceeds max ${(config.maxPositionPct * 100).toFixed(0)}% per-symbol cap of $${maxPerSymbol.toFixed(2)} (budget $${portfolio.starting_budget}).`,
      severity: "block",
    });
  }

  // 7. Per-symbol aggregate exposure cap (catches accumulation across cycles)
  if (positionAfter > maxPerSymbol + 0.01) {
    violations.push({
      rule: "symbol_exposure_cap",
      detail: `After this order, ${sym} exposure would be $${positionAfter.toFixed(2)} (existing $${existingValue.toFixed(2)} + new $${notional.toFixed(2)}), exceeding the ${(config.maxPositionPct * 100).toFixed(0)}% cap of $${maxPerSymbol.toFixed(2)}.`,
      severity: "block",
    });
  }

  // 8. Max concurrent positions (only blocks if this is a NEW symbol)
  const isNewSymbol = !existingPos;
  if (isNewSymbol && portfolio.open_positions.length >= config.maxConcurrentPositions) {
    violations.push({
      rule: "max_positions_reached",
      detail: `Already at max ${config.maxConcurrentPositions} concurrent positions. Close one before opening ${sym}.`,
      severity: "block",
    });
  }

  // 9. Total exposure cap
  if (totalAfter > maxTotal + 0.01) {
    violations.push({
      rule: "total_exposure_cap",
      detail: `Total exposure after order would be $${totalAfter.toFixed(2)} (${totalAfterPct.toFixed(1)}%), exceeding ${(config.maxTotalExposurePct * 100).toFixed(0)}% cap of $${maxTotal.toFixed(2)}.`,
      severity: "block",
    });
  }

  const hasBlock = violations.some((v) => v.severity === "block");
  return { allowed: !hasBlock, violations, computedExposure: exposure };
}

// ─── Post-trade invariant checks ──────────────────────────────────────────────

export interface InvariantViolation {
  check: string;
  detail: string;
  severity: "error" | "warn";
}

export interface InvariantResult {
  clean: boolean;
  violations: InvariantViolation[];
}

export function checkPostTradeInvariants(portfolio: BotPortfolio, botId: string): InvariantResult {
  const violations: InvariantViolation[] = [];
  const { cash, open_position_value, total_equity, starting_budget } = portfolio;

  if (cash < -0.01) {
    violations.push({
      check: "negative_cash",
      detail: `[${botId}] cash is $${cash.toFixed(4)} — should never go negative.`,
      severity: "error",
    });
  }

  if (open_position_value < -0.01) {
    violations.push({
      check: "negative_position_value",
      detail: `[${botId}] open_position_value is $${open_position_value.toFixed(4)} — impossible.`,
      severity: "error",
    });
  }

  if (total_equity < 0) {
    violations.push({
      check: "negative_equity",
      detail: `[${botId}] total_equity $${total_equity.toFixed(2)} < 0 — severe accounting error.`,
      severity: "error",
    });
  }

  if (starting_budget > 0 && total_equity > starting_budget * 10) {
    violations.push({
      check: "equity_suspiciously_high",
      detail: `[${botId}] total_equity $${total_equity.toFixed(2)} is >10× starting_budget $${starting_budget} — possible double-credit.`,
      severity: "warn",
    });
  }

  const recomputedEquity = cash + open_position_value;
  if (Math.abs(recomputedEquity - total_equity) > 0.10) {
    violations.push({
      check: "equity_drift",
      detail: `[${botId}] total_equity $${total_equity.toFixed(4)} ≠ cash+positions $${recomputedEquity.toFixed(4)} — drift of $${Math.abs(recomputedEquity - total_equity).toFixed(4)}.`,
      severity: "error",
    });
  }

  return { clean: violations.length === 0, violations };
}
