// ─── Portfolio Engine Tests (node:test) ───────────────────────────────────────
// Run: node --import=tsx/esm src/lib/portfolioEngine.test.ts
// Or:  pnpm --filter @workspace/api-server run test:portfolio
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  initPortfolio,
  applyBuy,
  applySell,
  closePosition,
  closeAllPositions,
  markToMarket,
} from "./portfolioEngine.js";

const TOLERANCE = 0.01; // $0.01 for floating point comparisons
function near(actual: number, expected: number, msg?: string) {
  assert(
    Math.abs(actual - expected) <= TOLERANCE,
    `${msg ?? "value"}: expected ~${expected}, got ${actual}`
  );
}

// ─── Core regression test: the $125 BUY case from the spec ───────────────────
describe("$125 BUY regression (the bug that started it all)", () => {
  it("after buying $125 of BTC/USD from a $250 budget: cash≈125, open_position_value≈125, unrealized≈0, realized=0, total_pnl≈0, equity≈250", () => {
    const portfolio = initPortfolio(250);
    const fillPrice = 50_000; // BTC at $50,000

    applyBuy(portfolio, "BTC/USD", 125, fillPrice, /* cycle */ 1);

    near(portfolio.cash,                125, "cash");
    assert.equal(portfolio.open_positions.length, 1, "open_positions length");
    near(portfolio.open_position_value, 125, "open_position_value");
    near(portfolio.unrealized_pnl,        0, "unrealized_pnl");
    assert.equal(portfolio.realized_pnl,  0, "realized_pnl");
    near(portfolio.total_pnl,             0, "total_pnl — NOT -125");
    near(portfolio.total_equity,        250, "total_equity");
    near(portfolio.total_pnl_pct,         0, "total_pnl_pct");

    const pos = portfolio.open_positions[0]!;
    assert.equal(pos.symbol,          "BTC/USD");
    near(pos.qty,           125 / fillPrice, "qty");
    near(pos.cost_basis,    125,             "cost_basis");
    near(pos.market_value,  125,             "market_value");
    near(pos.unrealized_pnl, 0,             "pos unrealized_pnl");

    // execution_details captures before/after
    const detail = portfolio.execution_details[0]!;
    assert.equal(detail.action, "BUY");
    near(detail.portfolio_before.cash,               250, "before.cash");
    near(detail.portfolio_before.open_position_value,  0, "before.open_position_value");
    near(detail.portfolio_after.cash,                125, "after.cash");
    near(detail.portfolio_after.open_position_value, 125, "after.open_position_value");
  });
});

// ─── Mark-to-market: price increase → unrealized profit ──────────────────────
describe("mark-to-market after price rise", () => {
  it("equity rises when open position appreciates", () => {
    const portfolio = initPortfolio(250);
    applyBuy(portfolio, "BTC/USD", 125, 50_000, 1);

    markToMarket(portfolio, { "BTC/USD": 55_000 }); // +10%

    near(portfolio.cash,                125,        "cash unchanged");
    near(portfolio.open_position_value, 137.5,      "open_position_value +10%");
    near(portfolio.unrealized_pnl,       12.5,      "unrealized_pnl");
    assert.equal(portfolio.realized_pnl,   0,       "realized still 0");
    near(portfolio.total_equity,        262.5,      "total_equity up");
    near(portfolio.total_pnl,            12.5,      "total_pnl");
    near(portfolio.total_pnl_pct,         5,        "total_pnl_pct"); // 12.5/250*100=5%
  });
});

// ─── Sell closes position, realizes PnL ──────────────────────────────────────
describe("sell after price rise", () => {
  it("realized PnL is correct, cash increases, position removed", () => {
    const portfolio = initPortfolio(250);
    applyBuy(portfolio, "BTC/USD", 125, 50_000, 1);
    markToMarket(portfolio, { "BTC/USD": 55_000 });
    applySell(portfolio, "BTC/USD", 137.5, 55_000, 2); // sell all at new price

    near(portfolio.cash,                250 + 12.5, "cash = 262.5");
    assert.equal(portfolio.open_positions.length, 0, "no open positions");
    near(portfolio.open_position_value, 0,          "open_position_value 0");
    near(portfolio.realized_pnl,        12.5,       "realized_pnl");
    near(portfolio.unrealized_pnl,      0,          "unrealized_pnl 0");
    near(portfolio.total_equity,        262.5,      "total_equity");
    near(portfolio.total_pnl,           12.5,       "total_pnl");
  });
});

// ─── Close position via closePosition() ──────────────────────────────────────
describe("closePosition", () => {
  it("closes entire position at current price and realizes PnL", () => {
    const portfolio = initPortfolio(250);
    applyBuy(portfolio, "ETH/USD", 100, 3_000, 1);
    closePosition(portfolio, "ETH/USD", 3_150, 2); // +5%

    near(portfolio.cash,          255,  "cash = 100 * (3150/3000) + 150");
    assert.equal(portfolio.open_positions.length, 0);
    near(portfolio.realized_pnl,    5,  "realized: 105-100=5");
    near(portfolio.total_equity,  255,  "total_equity");
  });
});

// ─── closeAllPositions ────────────────────────────────────────────────────────
describe("closeAllPositions", () => {
  it("closes every open position and sums realized PnL", () => {
    const portfolio = initPortfolio(300);
    applyBuy(portfolio, "BTC/USD", 100, 50_000, 1);
    applyBuy(portfolio, "ETH/USD", 100, 3_000, 1);

    closeAllPositions(portfolio, { "BTC/USD": 51_000, "ETH/USD": 3_150 }, 2);

    assert.equal(portfolio.open_positions.length, 0, "all closed");
    near(portfolio.cash,          302 + 5, "cash = 300 + 2 + 5");
    near(portfolio.realized_pnl,       7,  "realized = 2+5");
    near(portfolio.total_equity,     307,  "equity up");
  });
});

// ─── Add-to-position (avg down / avg up) ─────────────────────────────────────
describe("add to existing position", () => {
  it("correctly updates avg_entry_price and cost_basis", () => {
    const portfolio = initPortfolio(500);
    applyBuy(portfolio, "BTC/USD", 100, 50_000, 1); // 0.002 BTC
    applyBuy(portfolio, "BTC/USD", 100, 60_000, 1); // 0.00167 BTC (avg up)

    assert.equal(portfolio.open_positions.length, 1, "still 1 position");
    const pos = portfolio.open_positions[0]!;
    near(pos.cost_basis, 200, "cost_basis");
    near(portfolio.cash, 300, "cash = 500-200");
    // avg_entry_price = 200 / (0.002 + 0.00167) ≈ 54545
    assert(pos.avg_entry_price > 50_000 && pos.avg_entry_price < 60_000, "avg between the two fills");
  });
});

// ─── Leaderboard: buyer not penalized ────────────────────────────────────────
describe("leaderboard ranking correctness", () => {
  it("bot with open position ranks ABOVE cash-only bot when position is at par", () => {
    const buyer = initPortfolio(250);
    const hodler = initPortfolio(250);

    applyBuy(buyer, "BTC/USD", 125, 50_000, 1);
    markToMarket(buyer, { "BTC/USD": 50_000 }); // price unchanged

    // Both should have total_equity ≈ 250
    near(buyer.total_equity,  250, "buyer equity");
    near(hodler.total_equity, 250, "hodler equity");

    // Now price rises 2% — buyer leads
    markToMarket(buyer, { "BTC/USD": 51_000 });
    assert(buyer.total_equity > hodler.total_equity, "buyer leads after price rise");
  });
});
