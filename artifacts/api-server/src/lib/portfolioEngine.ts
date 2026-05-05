// ─── Virtual Portfolio Engine ─────────────────────────────────────────────────
// Isolated per-bot accounting. Race scoring uses this, not shared Alpaca balances.
// Pure functions — no side effects, fully testable.

export interface OpenPosition {
  symbol: string;
  qty: number;
  notional: number;
  avg_entry_price: number;
  cost_basis: number;
  opened_at: string;
  last_price: number;
  market_value: number;
  unrealized_pnl: number;
}

export interface PortfolioSnapshot {
  cash: number;
  open_position_value: number;
  realized_pnl: number;
  total_equity: number;
}

export interface ExecutionDetail {
  cycle: number;
  action: "BUY" | "SELL" | "CLOSE" | "CLOSE_ALL";
  symbol: string;
  side: string;
  qty: number | null;
  notional: number | null;
  fill_price: number | null;
  fees: number;
  timestamp: string;
  portfolio_before: PortfolioSnapshot;
  portfolio_after: PortfolioSnapshot;
}

export interface BotPortfolio {
  starting_budget: number;
  cash: number;
  open_positions: OpenPosition[];
  realized_pnl: number;
  unrealized_pnl: number;
  open_position_value: number;
  total_equity: number;
  total_pnl: number;
  total_pnl_pct: number;
  execution_details: ExecutionDetail[];
}

export function initPortfolio(startingBudget: number): BotPortfolio {
  return {
    starting_budget: startingBudget,
    cash: startingBudget,
    open_positions: [],
    realized_pnl: 0,
    unrealized_pnl: 0,
    open_position_value: 0,
    total_equity: startingBudget,
    total_pnl: 0,
    total_pnl_pct: 0,
    execution_details: [],
  };
}

function snapshotPortfolio(p: BotPortfolio): PortfolioSnapshot {
  return {
    cash: p.cash,
    open_position_value: p.open_position_value,
    realized_pnl: p.realized_pnl,
    total_equity: p.total_equity,
  };
}

// ── BUY ───────────────────────────────────────────────────────────────────────
// cash decreases, open position created/increased. realized_pnl unchanged.
export function applyBuy(
  portfolio: BotPortfolio,
  symbol: string,
  notional: number,
  fillPrice: number,
  cycle: number,
  fees = 0
): void {
  const before = snapshotPortfolio(portfolio);
  const actualCost = notional + fees;
  portfolio.cash = Math.max(0, portfolio.cash - actualCost);

  const qty = fillPrice > 0 ? notional / fillPrice : 0;
  const existing = portfolio.open_positions.find((p) => p.symbol === symbol);

  if (existing) {
    const totalCost = existing.cost_basis + notional;
    const totalQty  = existing.qty + qty;
    existing.qty             = totalQty;
    existing.notional       += notional;
    existing.cost_basis      = totalCost;
    existing.avg_entry_price = totalQty > 0 ? totalCost / totalQty : fillPrice;
    existing.last_price      = fillPrice;
    existing.market_value    = totalQty * fillPrice;
    existing.unrealized_pnl  = existing.market_value - existing.cost_basis;
  } else {
    portfolio.open_positions.push({
      symbol,
      qty,
      notional,
      avg_entry_price: fillPrice,
      cost_basis: notional,
      opened_at: new Date().toISOString(),
      last_price: fillPrice,
      market_value: qty * fillPrice,
      unrealized_pnl: 0,
    });
  }

  recomputeTotals(portfolio);
  portfolio.execution_details.push({
    cycle,
    action: "BUY",
    symbol,
    side: "buy",
    qty,
    notional,
    fill_price: fillPrice,
    fees,
    timestamp: new Date().toISOString(),
    portfolio_before: before,
    portfolio_after: snapshotPortfolio(portfolio),
  });
}

// ── SELL ──────────────────────────────────────────────────────────────────────
// cash increases, position reduced/closed, PnL realized on closed portion.
export function applySell(
  portfolio: BotPortfolio,
  symbol: string,
  notional: number,
  fillPrice: number,
  cycle: number,
  fees = 0
): void {
  const before = snapshotPortfolio(portfolio);
  const pos = portfolio.open_positions.find((p) => p.symbol === symbol);

  let proceeds = notional - fees;
  let realizedGain = 0;

  if (pos && pos.qty > 0 && fillPrice > 0) {
    const sellQty = notional / fillPrice;
    const fraction = Math.min(1, pos.qty > 0 ? sellQty / pos.qty : 1);
    const costOfSold = pos.cost_basis * fraction;
    realizedGain = proceeds - costOfSold;

    pos.qty       -= sellQty * fraction;
    pos.notional  -= pos.notional * fraction;
    pos.cost_basis -= costOfSold;
    pos.last_price  = fillPrice;
    pos.market_value = pos.qty * fillPrice;
    pos.unrealized_pnl = pos.market_value - pos.cost_basis;

    if (pos.qty <= 0.0001) {
      portfolio.open_positions = portfolio.open_positions.filter((p) => p.symbol !== symbol);
    }
  } else {
    realizedGain = proceeds;
  }

  portfolio.cash += proceeds;
  portfolio.realized_pnl += realizedGain;
  recomputeTotals(portfolio);

  portfolio.execution_details.push({
    cycle,
    action: "SELL",
    symbol,
    side: "sell",
    qty: fillPrice > 0 ? notional / fillPrice : null,
    notional,
    fill_price: fillPrice,
    fees,
    timestamp: new Date().toISOString(),
    portfolio_before: before,
    portfolio_after: snapshotPortfolio(portfolio),
  });
}

// ── CLOSE POSITION ────────────────────────────────────────────────────────────
// Close entire position at current price, realize full PnL.
export function closePosition(
  portfolio: BotPortfolio,
  symbol: string,
  currentPrice: number,
  cycle: number
): void {
  const before = snapshotPortfolio(portfolio);
  const pos = portfolio.open_positions.find((p) => p.symbol === symbol);
  if (!pos) return;

  const price = currentPrice > 0 ? currentPrice : pos.last_price;
  const proceeds = pos.qty * price;
  const realizedGain = proceeds - pos.cost_basis;

  portfolio.cash += proceeds;
  portfolio.realized_pnl += realizedGain;
  portfolio.open_positions = portfolio.open_positions.filter((p) => p.symbol !== symbol);
  recomputeTotals(portfolio);

  portfolio.execution_details.push({
    cycle,
    action: "CLOSE",
    symbol,
    side: "sell",
    qty: pos.qty,
    notional: proceeds,
    fill_price: price,
    fees: 0,
    timestamp: new Date().toISOString(),
    portfolio_before: before,
    portfolio_after: snapshotPortfolio(portfolio),
  });
}

// ── CLOSE ALL ─────────────────────────────────────────────────────────────────
export function closeAllPositions(
  portfolio: BotPortfolio,
  priceMap: Record<string, number>,
  cycle: number
): void {
  const symbols = portfolio.open_positions.map((p) => p.symbol);
  for (const sym of symbols) {
    const price = priceMap[sym] ?? 0;
    closePosition(portfolio, sym, price, cycle);
  }
}

// ── MARK-TO-MARKET ────────────────────────────────────────────────────────────
// Revalue all open positions at current prices. Call once per cycle.
export function markToMarket(
  portfolio: BotPortfolio,
  priceMap: Record<string, number>
): void {
  for (const pos of portfolio.open_positions) {
    const price = priceMap[pos.symbol] ?? pos.last_price;
    if (price > 0) {
      pos.last_price      = price;
      pos.market_value    = pos.qty * price;
      pos.unrealized_pnl  = pos.market_value - pos.cost_basis;
    }
  }
  recomputeTotals(portfolio);
}

// ── Internal recompute ────────────────────────────────────────────────────────
function recomputeTotals(portfolio: BotPortfolio): void {
  portfolio.open_position_value = portfolio.open_positions.reduce((s, p) => s + p.market_value, 0);
  portfolio.unrealized_pnl      = portfolio.open_positions.reduce((s, p) => s + p.unrealized_pnl, 0);
  portfolio.total_equity        = portfolio.cash + portfolio.open_position_value;
  portfolio.total_pnl           = portfolio.total_equity - portfolio.starting_budget;
  portfolio.total_pnl_pct       = portfolio.starting_budget > 0
    ? (portfolio.total_pnl / portfolio.starting_budget) * 100
    : 0;
}
