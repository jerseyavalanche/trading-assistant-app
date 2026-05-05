// ─── Risk Validator Tests (node:test) ─────────────────────────────────────────
// Run: pnpm --filter @workspace/api-server run test:risk
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeSymbol,
  detectMarketType,
  validatePreTrade,
  checkPostTradeInvariants,
  BOT_RISK_CONFIGS,
} from "./riskValidator.js";
import { initPortfolio, applyBuy } from "./portfolioEngine.js";

// ─── 1. Symbol normalization ──────────────────────────────────────────────────

describe("normalizeSymbol — single source of truth", () => {
  it("BTC-USD → BTC/USD", () => assert.equal(normalizeSymbol("BTC-USD"), "BTC/USD"));
  it("BTC/USD → BTC/USD (no-op)", () => assert.equal(normalizeSymbol("BTC/USD"), "BTC/USD"));
  it("btc-usd (lowercase) → BTC/USD", () => assert.equal(normalizeSymbol("btc-usd"), "BTC/USD"));
  it("BTC (bare) → BTC/USD", () => assert.equal(normalizeSymbol("BTC"), "BTC/USD"));
  it("ETH-USDT → ETH/USDT", () => assert.equal(normalizeSymbol("ETH-USDT"), "ETH/USDT"));
  it("AAPL (equity) → AAPL (unchanged)", () => assert.equal(normalizeSymbol("AAPL"), "AAPL"));
  it("MSFT (equity) → MSFT (unchanged)", () => assert.equal(normalizeSymbol("MSFT"), "MSFT"));
});

describe("detectMarketType", () => {
  it("BTC-USD → crypto", () => assert.equal(detectMarketType("BTC-USD"), "crypto"));
  it("BTC/USD → crypto", () => assert.equal(detectMarketType("BTC/USD"), "crypto"));
  it("ETH (bare) → crypto", () => assert.equal(detectMarketType("ETH"), "crypto"));
  it("AAPL → equity", () => assert.equal(detectMarketType("AAPL"), "equity"));
  it("NVDA → equity", () => assert.equal(detectMarketType("NVDA"), "equity"));
});

// ─── 2. Scalper BTC accumulation cap ─────────────────────────────────────────
// Config: max 30% per symbol = $75 on a $250 budget.
// After one $75 BTC buy, a second $75 BTC buy must be BLOCKED.

describe("Scalper: BTC accumulation cap across cycles", () => {
  const BUDGET = 250;
  const MAX_PER_SYMBOL = BUDGET * BOT_RISK_CONFIGS.scalper!.maxPositionPct; // $75

  it("first $75 BTC buy is ALLOWED", () => {
    const portfolio = initPortfolio(BUDGET);
    const result = validatePreTrade({
      botId: "scalper",
      side: "buy",
      rawSymbol: "BTC-USD",
      notional: 75,
      portfolio,
      marketIsOpen: true,
      raceSymbols: ["BTC-USD"],
    });
    assert.equal(result.allowed, true, `Expected allowed. Violations: ${JSON.stringify(result.violations)}`);
    assert.equal(result.computedExposure.existing_position_value, 0);
    assert.equal(result.computedExposure.max_allowed_per_symbol, MAX_PER_SYMBOL);
  });

  it("second $75 BTC buy is BLOCKED — symbol_exposure_cap violation", () => {
    const portfolio = initPortfolio(BUDGET);
    // Simulate first cycle: apply $75 BUY to portfolio
    applyBuy(portfolio, "BTC/USD", 75, 50_000, 1);
    // Now try to buy another $75 in cycle 2
    const result = validatePreTrade({
      botId: "scalper",
      side: "buy",
      rawSymbol: "BTC-USD",   // intentionally using dash form — should still match
      notional: 75,
      portfolio,
      marketIsOpen: true,
      raceSymbols: ["BTC-USD"],
    });
    assert.equal(result.allowed, false, "Second $75 BTC buy should be blocked");
    const hasExposureCap = result.violations.some((v) => v.rule === "symbol_exposure_cap");
    assert.equal(hasExposureCap, true, `Expected symbol_exposure_cap violation. Got: ${JSON.stringify(result.violations.map((v) => v.rule))}`);
    // Computed exposure shows the problem clearly
    assert(result.computedExposure.position_after_order > MAX_PER_SYMBOL,
      `position_after_order ${result.computedExposure.position_after_order} should exceed max ${MAX_PER_SYMBOL}`);
  });

  it("BUY of exactly the remaining allowed amount IS allowed", () => {
    const portfolio = initPortfolio(BUDGET);
    applyBuy(portfolio, "BTC/USD", 50, 50_000, 1); // $50 of $75 cap
    const result = validatePreTrade({
      botId: "scalper",
      side: "buy",
      rawSymbol: "BTC-USD",
      notional: 25,    // $50 + $25 = $75 exactly (within cap)
      portfolio,
      marketIsOpen: true,
      raceSymbols: ["BTC-USD"],
    });
    const hasExposureCap = result.violations.some((v) => v.rule === "symbol_exposure_cap");
    assert.equal(hasExposureCap, false, `Should not trigger exposure cap for $25 when $50 of $75 used`);
  });

  it("adding $1 over the cap is BLOCKED", () => {
    const portfolio = initPortfolio(BUDGET);
    applyBuy(portfolio, "BTC/USD", 75, 50_000, 1);  // already at the cap
    const result = validatePreTrade({
      botId: "scalper",
      side: "buy",
      rawSymbol: "BTC/USD",
      notional: 1,    // even $1 more should be blocked
      portfolio,
      marketIsOpen: true,
      raceSymbols: ["BTC-USD"],
    });
    assert.equal(result.allowed, false, "$1 over cap should be blocked");
    const hasExposureCap = result.violations.some((v) => v.rule === "symbol_exposure_cap");
    assert.equal(hasExposureCap, true);
  });
});

// ─── 3. Valid orders execute normally ─────────────────────────────────────────

describe("Valid orders pass validation", () => {
  it("Momentum: 25% of budget on AAPL is allowed", () => {
    const portfolio = initPortfolio(1000);
    const result = validatePreTrade({
      botId: "momentum",
      side: "buy",
      rawSymbol: "AAPL",
      notional: 250,    // 25% of $1000
      portfolio,
      marketIsOpen: true,
      raceSymbols: ["AAPL", "MSFT", "NVDA"],
    });
    assert.equal(result.allowed, true, `Should be allowed. Violations: ${JSON.stringify(result.violations)}`);
    assert.equal(result.violations.length, 0);
  });

  it("Conservative: AAPL during market hours is allowed", () => {
    const portfolio = initPortfolio(500);
    const result = validatePreTrade({
      botId: "conservative",
      side: "buy",
      rawSymbol: "AAPL",
      notional: 50,    // 10% of $500 — under the 15% cap ($75)
      portfolio,
      marketIsOpen: true,
      raceSymbols: ["AAPL", "MSFT"],
    });
    assert.equal(result.allowed, true, `Should be allowed. Violations: ${JSON.stringify(result.violations)}`);
  });

  it("SELL order always passes (no buy-side rules apply)", () => {
    const portfolio = initPortfolio(250);
    applyBuy(portfolio, "BTC/USD", 200, 50_000, 1);   // way over any buy cap — but SELL is OK
    const result = validatePreTrade({
      botId: "scalper",
      side: "sell",
      rawSymbol: "BTC/USD",
      notional: 200,
      portfolio,
      marketIsOpen: false,
      raceSymbols: ["BTC-USD"],
    });
    assert.equal(result.allowed, true, "SELL should always be allowed");
  });

  it("Dip Buyer: three positions under 20% cap each", () => {
    const portfolio = initPortfolio(500);
    applyBuy(portfolio, "AAPL", 50, 200, 1);
    applyBuy(portfolio, "NVDA", 50, 800, 1);
    // Third position (still under 3-position limit, 20% cap = $100)
    const result = validatePreTrade({
      botId: "dip_buyer",
      side: "buy",
      rawSymbol: "MSFT",
      notional: 80,    // under $100 cap
      portfolio,
      marketIsOpen: true,
      raceSymbols: ["AAPL", "NVDA", "MSFT"],
    });
    assert.equal(result.allowed, true, `Should be allowed. Violations: ${JSON.stringify(result.violations)}`);
  });
});

// ─── 4. Rejected orders carry explicit violation reasons ──────────────────────

describe("Rejected orders carry explicit violation reasons", () => {
  it("Conservative: BLOCKED for crypto (not in allowedSymbols)", () => {
    const portfolio = initPortfolio(500);
    const result = validatePreTrade({
      botId: "conservative",
      side: "buy",
      rawSymbol: "BTC-USD",
      notional: 50,
      portfolio,
      marketIsOpen: true,
      raceSymbols: ["AAPL", "BTC-USD"],
    });
    assert.equal(result.allowed, false);
    const symbolRule = result.violations.find((v) => v.rule === "symbol_not_allowed");
    assert.ok(symbolRule, `Expected symbol_not_allowed. Got: ${JSON.stringify(result.violations.map((v) => v.rule))}`);
    assert.ok(symbolRule.detail.includes("BTC/USD"), "Detail should mention the normalized symbol");
  });

  it("Conservative: BLOCKED for equity orders when market is closed", () => {
    const portfolio = initPortfolio(500);
    const result = validatePreTrade({
      botId: "conservative",
      side: "buy",
      rawSymbol: "AAPL",
      notional: 50,
      portfolio,
      marketIsOpen: false,    // market closed
      raceSymbols: ["AAPL"],
    });
    assert.equal(result.allowed, false);
    const sessionRule = result.violations.find((v) => v.rule === "market_closed");
    assert.ok(sessionRule, "Expected market_closed violation");
  });

  it("Any bot: BLOCKED when insufficient cash", () => {
    const portfolio = initPortfolio(100);
    // Drain cash
    applyBuy(portfolio, "AAPL", 95, 200, 1);
    const result = validatePreTrade({
      botId: "momentum",
      side: "buy",
      rawSymbol: "MSFT",
      notional: 50,    // only $5 cash remaining
      portfolio,
      marketIsOpen: true,
      raceSymbols: ["AAPL", "MSFT"],
    });
    assert.equal(result.allowed, false);
    const cashRule = result.violations.find((v) => v.rule === "insufficient_cash");
    assert.ok(cashRule, "Expected insufficient_cash violation");
    assert.ok(cashRule.detail.includes("$50.00"), "Detail should mention the requested notional");
  });

  it("Momentum: BLOCKED when max positions already open", () => {
    const portfolio = initPortfolio(1000);
    // Open 4 positions (the max for momentum)
    applyBuy(portfolio, "AAPL", 100, 200, 1);
    applyBuy(portfolio, "MSFT", 100, 400, 1);
    applyBuy(portfolio, "NVDA", 100, 800, 1);
    applyBuy(portfolio, "TSLA", 100, 300, 1);
    // Try a 5th
    const result = validatePreTrade({
      botId: "momentum",
      side: "buy",
      rawSymbol: "GOOGL",
      notional: 50,
      portfolio,
      marketIsOpen: true,
      raceSymbols: ["AAPL", "MSFT", "NVDA", "TSLA", "GOOGL"],
    });
    assert.equal(result.allowed, false);
    const posRule = result.violations.find((v) => v.rule === "max_positions_reached");
    assert.ok(posRule, `Expected max_positions_reached. Got: ${JSON.stringify(result.violations.map((v) => v.rule))}`);
    assert.ok(posRule.detail.includes("4"), "Detail should mention max count");
  });

  it("Symbol not in race universe is blocked", () => {
    const portfolio = initPortfolio(250);
    const result = validatePreTrade({
      botId: "scalper",
      side: "buy",
      rawSymbol: "GME",    // not in the race
      notional: 50,
      portfolio,
      marketIsOpen: true,
      raceSymbols: ["BTC-USD", "ETH-USD"],   // race only has crypto
    });
    assert.equal(result.allowed, false);
    const raceRule = result.violations.find((v) => v.rule === "symbol_not_in_race");
    assert.ok(raceRule, "Expected symbol_not_in_race violation");
  });
});

// ─── 5. Post-trade invariant checks ──────────────────────────────────────────

describe("Post-trade invariant checks", () => {
  it("clean portfolio passes all checks", () => {
    const portfolio = initPortfolio(250);
    applyBuy(portfolio, "BTC/USD", 100, 50_000, 1);
    const result = checkPostTradeInvariants(portfolio, "scalper");
    assert.equal(result.clean, true, `Expected clean. Violations: ${JSON.stringify(result.violations)}`);
  });

  it("negative cash triggers error", () => {
    const portfolio = initPortfolio(250);
    portfolio.cash = -5;   // force bad state
    const result = checkPostTradeInvariants(portfolio, "scalper");
    assert.equal(result.clean, false);
    const neg = result.violations.find((v) => v.check === "negative_cash");
    assert.ok(neg, "Expected negative_cash violation");
    assert.equal(neg.severity, "error");
  });

  it("equity drift triggers error when cash+positions ≠ total_equity", () => {
    const portfolio = initPortfolio(250);
    applyBuy(portfolio, "BTC/USD", 100, 50_000, 1);
    portfolio.total_equity = 99999;    // force drift
    const result = checkPostTradeInvariants(portfolio, "scalper");
    const drift = result.violations.find((v) => v.check === "equity_drift");
    assert.ok(drift, "Expected equity_drift violation");
    assert.equal(drift.severity, "error");
  });

  it("suspiciously high equity triggers warn", () => {
    const portfolio = initPortfolio(250);
    portfolio.total_equity = 99_000;   // >10× starting_budget
    portfolio.cash = 99_000;
    portfolio.open_position_value = 0;
    const result = checkPostTradeInvariants(portfolio, "scalper");
    const suspicious = result.violations.find((v) => v.check === "equity_suspiciously_high");
    assert.ok(suspicious, "Expected equity_suspiciously_high warn");
    assert.equal(suspicious.severity, "warn");
  });
});
