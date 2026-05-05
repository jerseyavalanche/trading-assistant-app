# Trading Assistant — Full Project Export

Generated: 2026-05-05

---

## Project Overview

A mobile trading assistant built with Expo (React Native) and an Express 5 API server, running as a pnpm monorepo. The app provides live market data, a personal watchlist, a trade journal, AI-powered analysis, and an autonomous "TradeBot" tab featuring a 4-Bot Race Mode where four distinct AI trading strategies compete head-to-head using isolated virtual portfolios.

---

## Monorepo Structure

```
workspace/
├── artifacts/
│   ├── api-server/          — Express 5 API + AI backend + race engine
│   └── mobile/              — Expo React Native app
├── lib/
│   └── db/                  — Drizzle ORM + PostgreSQL schema
├── scripts/                 — Shared utility scripts
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── replit.md
```

---

## Stack

| Layer | Technology |
|---|---|
| Package manager | pnpm workspaces |
| Node.js | v24 |
| TypeScript | 5.9 |
| Mobile framework | Expo (React Native) |
| API framework | Express 5 |
| Database | PostgreSQL + Drizzle ORM |
| Validation | Zod (v4) + drizzle-zod |
| AI model | gpt-5.4 via Replit OpenAI proxy |
| API codegen | Orval (from OpenAPI spec) |
| Build | esbuild (CJS bundle) |

---

## Mobile App — `artifacts/mobile`

### Tabs

| Tab | File | Description |
|---|---|---|
| Markets | `app/(tabs)/index.tsx` | Live S&P 500, NASDAQ, Dow Jones, crypto prices and top movers via Yahoo Finance |
| Watchlist | `app/(tabs)/watchlist.tsx` | Personal symbol list with live prices, add/remove, pull-to-refresh |
| Chart | `app/(tabs)/chart.tsx` | Embedded TradingView advanced chart (WebView), symbol search, interval selector (1m–1W), quick-switch bar |
| Journal | `app/(tabs)/journal.tsx` | Trade journal with P&L tracking — log BUY/SELL trades, win rate, total P&L |
| TradeBot | `app/(tabs)/ai.tsx` | AI chat assistant + 4-Bot Race Mode |

### Other Screens

| Screen | File |
|---|---|
| Add symbol | `app/add-symbol.tsx` |
| New journal entry | `app/new-entry.tsx` |

### Contexts

| Context | Purpose |
|---|---|
| `WatchlistContext` | Symbol list + live prices |
| `JournalContext` | Trade log entries |
| `ChartContext` | Selected symbol and interval |

### Theme

- Background: deep navy `#0D1117`
- Accent: teal `#00D4AA`
- Storage: `@react-native-async-storage/async-storage` for watchlist and journal persistence
- Charts: `react-native-webview` embedding TradingView

---

## API Server — `artifacts/api-server`

### Source Files

| File | Lines | Role |
|---|---|---|
| `src/index.ts` | — | Server entry point |
| `src/app.ts` | — | Express app setup |
| `src/lib/logger.ts` | — | Pino logger singleton |
| `src/lib/portfolioEngine.ts` | 262 | Isolated virtual portfolio accounting (buy/sell/mark-to-market) |
| `src/lib/portfolioEngine.test.ts` | — | 7 portfolio tests |
| `src/lib/riskValidator.ts` | 321 | Symbol normalization, market-type detection, per-bot risk rules |
| `src/lib/riskValidator.test.ts` | — | 29 risk/validation tests |
| `src/lib/raceHealth.ts` | 361 | Pure race health + ranking logic (no side effects) |
| `src/lib/raceHealth.test.ts` | 626 | 41 race/ranking tests |
| `src/routes/health.ts` | — | `GET /api/healthz` |
| `src/routes/market.ts` | — | Yahoo Finance proxy routes |
| `src/routes/ai.ts` | — | AI conversations + analysis routes |
| `src/routes/alpaca.ts` | — | Alpaca paper trading routes |
| `src/routes/aiBrain.ts` | — | AI brain export/feedback loop |
| `src/routes/autopilot.ts` | 1838 | Solo autopilot + 4-Bot Race engine |

### All API Routes

#### Market
| Method | Path | Description |
|---|---|---|
| GET | `/api/market/quotes?symbols=AAPL,BTC-USD` | Yahoo Finance quote proxy (with crumb auth) |
| GET | `/api/market/search?q=apple` | Yahoo Finance symbol search proxy |

#### AI Conversations
| Method | Path | Description |
|---|---|---|
| POST | `/api/ai/conversations` | Create a new chat conversation |
| GET | `/api/ai/conversations/:id/messages` | Fetch message history |
| POST | `/api/ai/conversations/:id/messages` | Send a chat message (streaming SSE) |
| POST | `/api/ai/analyze-watchlist` | AI signal analysis for watchlist (streaming SSE) |
| POST | `/api/ai/review-journal` | AI journal coaching review (streaming SSE) |

#### Alpaca Paper Trading
| Method | Path | Description |
|---|---|---|
| GET | `/api/alpaca/account` | Account info |
| GET | `/api/alpaca/positions` | Open positions |
| GET | `/api/alpaca/orders` | Recent orders |
| POST | `/api/alpaca/orders` | Place a paper trade order |
| DELETE | `/api/alpaca/orders/:id` | Cancel an open order |

#### Solo Autopilot
| Method | Path | Description |
|---|---|---|
| POST | `/api/autopilot/start` | Start the solo AI trading bot |
| POST | `/api/autopilot/stop` | Stop the solo bot |
| GET | `/api/autopilot/status` | SSE stream of bot status |
| GET | `/api/autopilot/logs` | Recent log entries |

#### 4-Bot Race Mode
| Method | Path | Description |
|---|---|---|
| POST | `/api/autopilot/race/start` | Start the race (symbols, totalBudget) |
| POST | `/api/autopilot/race/stop` | Stop all race bots |
| GET | `/api/autopilot/race/status` | SSE stream of live race events |
| GET | `/api/autopilot/race/stats` | Current bot state snapshot |

### Environment Secrets

| Secret | Used for |
|---|---|
| `ALPACA_API_KEY` | Alpaca paper trading authentication |
| `ALPACA_API_SECRET` | Alpaca paper trading authentication |
| `SESSION_SECRET` | Express session signing |

---

## 4-Bot Race Mode — Architecture

### Race Configuration

```
Race interval:        5 minutes between coordinator ticks
Bot stagger:          12 seconds between bots within a tick
Bot cycle timeout:    25 seconds hard cap per bot cycle
Budget per bot:       totalBudget / 4 (default $250 each, $1000 total)
```

### The Four Bots

| ID | Name | Emoji | Color | Strategy |
|---|---|---|---|---|
| `momentum` | Momentum Rider | 🚀 | `#00D4AA` | Buy stocks up >+0.8% with rising volume; max 25% per stock, 4 positions; stop -2.5%, take +3% |
| `dip_buyer` | Dip Buyer | 📉 | `#A78BFA` | Mean reversion; buy dips >-1.5%; max 20% per stock, 3 positions; stop -3.5%, take +1.5% |
| `conservative` | Conservative | 🛡️ | `#60A5FA` | Large-cap only (AAPL/MSFT/GOOGL/AMZN/NVDA/TSLA); flat-to-slightly-up entries; max 15%, 3 positions; stop -1.5%, take +1.8% |
| `scalper` | Scalper | ⚡ | `#FF8C42` | Aggressive high-frequency; any upward momentum >+0.3%; max 30%, 3 positions; stop -1%, take +1.5% |

**Insertion order in `RACE_CONFIGS`**: momentum → dip_buyer → conservative → scalper

**Session eligibility**: `conservative` is equity-only — when the equity market is closed it is marked `session_eligible: false`, which is used as a tie-breaker disadvantage.

### Race Engine Flow

```
POST /race/start
  → fetchMarketSnapshot()
  → initPortfolio($250) × 4 bots
  → setInterval (coordinator tick, 5 min)
      → snapshot = fetchMarketSnapshot(raceSymbols)
      → latestRaceSnapshot = snapshot          ← global for getRaceSnapshot()
      → for each bot (staggered 12s):
          runRaceBotCycle(botId, snapshot)
              → markToMarket(positions, priceMap)
              → validateOrder() via riskValidator
              → gpt-5.4 AI agent (function-calling loop, max 10 turns)
                  tools: log_reasoning, buy_stock, sell_stock,
                         close_position, close_all_positions, no_action
              → writeExport() → aiBrain feedback loop
```

### Virtual Portfolio Engine (`portfolioEngine.ts`)

Pure functions, no side effects. Each bot gets an isolated `BotPortfolio`:

```typescript
interface BotPortfolio {
  starting_budget: number;
  cash: number;
  open_positions: OpenPosition[];
  realized_pnl: number;
  unrealized_pnl: number;
  open_position_value: number;
  total_equity: number;           // cash + open_position_value (marked-to-market)
  total_pnl: number;
  total_pnl_pct: number;
  execution_details: ExecutionDetail[];
}
```

Mark-to-market uses a shared `MarketSnapshot` so all four bots are scored on identical prices — no price-timing advantage.

### Cycle Status Machine (`raceHealth.ts`)

```
NOT_STARTED
    ↓
SCANNING → (AI thinking)
    ↓
DECIDED
    ↓
ORDER_SUBMITTED
    ↓
ORDER_FILLED ──┐
ORDER_FAILED ──┤→ COMPLETED (terminal)
    ↓           │
               └→ NO_ACTION (terminal — held / market closed)
SCANNING timeout → TIMED_OUT (terminal)
Unhandled error → FAILED (terminal)
```

`race_ready_for_comparison = true` once all 4 bots have reached a terminal first-cycle state.

---

## Ranking System (`raceHealth.ts` — `computeRanks`)

### Primary Metric

`total_equity_marked_to_market` = `cash + open_position_value` using a shared price snapshot

### Tie-Breaker Pipeline (applied within $0.01 equity groups)

| Priority | Criterion | Winner |
|---|---|---|
| 1 | `did_trade` | Bot with filled orders beats no-action bots |
| 2 | `deployment_pct` | Higher capital deployed wins among traders |
| 3 | `session_eligible` | Eligible bots beat strategy-universe-unavailable bots |
| 4 | `bot_id` (alphabetical) | Only falls here for a true `rank: null` / `"TIE"` |

`RANK_EPSILON = $0.01` — bots within one cent of each other enter the tie-breaker pipeline.

### Key Constants and Types

```typescript
export const RANK_EPSILON = 0.01;

interface BotRankInput {
  id: string;
  total_equity: number;
  did_trade?: boolean;
  capital_deployed?: number;
  deployment_pct?: number;
  session_eligible?: boolean;
}

interface BotRankResult {
  id: string;
  rank: number | null;          // null = TIE (no meaningful distinction)
  rank_label: string;           // "#1", "#2", "TIE", "IN PROGRESS"
  is_tied: boolean;
  tie_break_reason: string | null;
  comparison_reason: string;    // human-readable explanation
  did_trade: boolean;
  capital_deployed: number;
  deployment_pct: number;
  session_eligible: boolean;
}

interface RankingResult {
  ranks: BotRankResult[];       // same order as input bots array
  ranking_basis: "total_equity_marked_to_market";
  is_global_tie: boolean;
  tie_break_reason: string | null;
  snapshot_id: string;
}
```

### `buildRaceLeaderText()` — Single Source of Truth

Called after bots are sorted by rank. Used by both the per-cycle auto-export (`writeExport`) and the `getRaceSnapshot` API response:

```
raceReady=false           → "RACE IN PROGRESS"
is_global_tie=true        → "TIE — all criteria equal (ordered by bot id)"
tie_break_reason≠null     → "Equity tied — [Name] leads ([comparison_reason])"
clear equity winner       → "[Name]"
```

### Summary Fields

| Field | Meaning |
|---|---|
| `leader` | Always reflects rank-1 bot by `total_equity_marked_to_market` |
| `is_tie` | True only when all 4 bots are equal on all meaningful criteria |
| `ranking_basis` | Always `"total_equity_marked_to_market"` |
| `tie_break_reason` | Non-null when equity was tied and a tie-breaker resolved it |
| `bots_current_cycle_no_action` | Bots in `NO_ACTION` status for the **latest cycle only** |
| `bots_ever_traded` | Bots with ≥1 filled order across **any cycle** (not just the latest) |

---

## Risk Validator (`riskValidator.ts`)

### Per-Bot Rules (mirroring `RACE_CONFIGS` strategy text)

| Bot | Allowed Symbols | Max Position % | Max Positions | Equity-Only |
|---|---|---|---|---|
| `momentum` | All symbols | 25% | 4 | No |
| `dip_buyer` | All symbols | 20% | 3 | No |
| `conservative` | AAPL, MSFT, GOOGL, AMZN, NVDA, TSLA | 15% | 3 | Yes |
| `scalper` | All symbols | 30% | 3 | No |

### Symbol Normalization Rules

```
BTC-USD  → BTC/USD
BTC/USD  → BTC/USD  (no-op)
btc-usd  → BTC/USD  (case-insensitive)
BTC      → BTC/USD  (bare ticker)
ETH-USDT → ETH/USDT
AAPL     → AAPL     (equity unchanged)
```

### Post-Trade Invariant Checks

- Negative cash → error
- `cash + open_position_value ≠ total_equity` within $0.01 → error
- `total_equity > starting_budget × 10` → warning (suspicious)

---

## Test Suite

**Total: 77 passing, 0 failing**

| File | Tests | Suites | Covers |
|---|---|---|---|
| `portfolioEngine.test.ts` | 7 | 7 | BUY/SELL accounting, mark-to-market, realized/unrealized PnL, position averaging |
| `riskValidator.test.ts` | 29 | 6 | Symbol normalization, market-type detection, Scalper cap regression, valid orders, rejections, invariant checks |
| `raceHealth.test.ts` | 41 | 20 | Cycle state machine, health computation, timeout/failure paths, epsilon ties, tie-breakers, `buildMtmPriceMap`, Scalper regression, insertion-order regression, exact tie, within-epsilon tie, historical-trade ranking |

### Key Regression Tests

| Test | What it guards |
|---|---|
| "Scalper at index 3 with highest equity wins rank 1" | `summary.leader` never uses `raceBots[0]` (insertion order = momentum) |
| "ranks array preserves original input order" | `computeRanks` contract: caller must sort for display |
| "bots within $0.01 but one traded → trader wins" | Tie-breaker pipeline correctness |
| "did_trade=true (any past cycle) beats did_trade=false" | Multi-cycle hold/no-action semantics |
| "Scalper: BTC accumulation cap across cycles" | `symbol_exposure_cap` blocks over-concentration |

---

## Git History (last 20 commits)

```
a4ed09e  Fix AI Brain race ranking and summary inconsistencies
3f47c9d  Improve race ranking to provide deterministic tie-breakers and detailed summaries
896f754  Make trading race results fairer and more consistent
e185242  Update AI Brain screen name to TradeBot in exported data
98ab8a1  Update trading assistant with improved race and bot performance tracking
cdc82ef  Add race health metrics and update bot execution details
8a06d6a  Improve AI Brain 4-Bot Race orchestration and bot reliability
bff990b  Implement pre-trade risk validation and post-trade invariant checks
5202c16  Improve trading bot by implementing isolated virtual portfolios for accurate scoring
6cf57ce  Update export data to include broader market symbols and updated performance metrics
42eaafd  Improve trading bot stability and data accuracy for crypto
be73bd8  Update trading assistant to analyze and report on bot race performance
5c3d7b1  Add automated feedback loop for AI Brain trading app
a2d8d49  Enhance trading bot race with market session handling and improved data logging
592c9fb  Improve export functionality and prompt handling in the AI assistant
33a85de  Remove human approval step and enable automatic feedback application
fd4269e  Implement automated feedback loop for AI trading bots
dbd00fe  Add working market data fetching for trading bots
cc690f8  Add a competitive trading mode with four distinct AI traders
d53c3df  Add ability for users to define and use custom trading strategies
```

---

## Key Design Decisions

### Why isolated virtual portfolios?
Each bot gets its own `BotPortfolio` (`cash`, `open_positions`, `realized_pnl`) initialized at race start. Scores are computed from these portfolios — not from a shared Alpaca balance — so all four bots are always compared on equal footing regardless of when their orders execute.

### Why `computeRanks` returns results in input order?
The function is a pure, side-effect-free ranking utility. It assigns ranks but preserves the caller's ordering so the caller controls the display array. `autopilot.ts` sorts the output by rank after calling it — documented as an explicit contract in the tests.

### Why `buildRaceLeaderText` lives in `autopilot.ts`?
It needs bot `name` and `comparison_reason` which are runtime display data, not part of the pure `raceHealth.ts` types. Keeping it in `autopilot.ts` avoids coupling the pure library to presentation strings.

### Why pre-declare rank fields in `botsData`?
The old code used `Object.assign(b, {rank: ...})` to mutate an object whose TypeScript type didn't include `rank`. This worked at runtime (esbuild strips types) but was invisible to TypeScript and fragile. Pre-declaring `rank: null as number | null` in the `.map()` call gives TypeScript the correct type for the entire downstream pipeline.

### Why `bots_current_cycle_no_action` instead of `bots_no_action`?
In a multi-cycle race, a bot that filled an order in cycle 1 but held in cycle 2 would show `cycleStatus = "NO_ACTION"` — making it look inactive even though it traded. The renamed field makes the per-cycle scope explicit. `bots_ever_traded` provides the complementary all-time signal.
