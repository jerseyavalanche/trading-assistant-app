# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.

## Artifacts

### Trading Assistant Mobile App (`artifacts/mobile`)

Expo React Native mobile app — a trading assistant that integrates with TradingView.

**Features:**
- **Markets tab**: Live market data (S&P 500, NASDAQ, Dow Jones, crypto, top movers) via Yahoo Finance API
- **Watchlist tab**: Personal symbol watchlist with live prices, add/remove symbols, pull-to-refresh
- **Chart tab**: Embedded TradingView advanced chart (WebView), symbol search, interval selector (1m–1W), quick-switch watchlist bar
- **Journal tab**: Trade journal with P&L tracking — log BUY/SELL trades, see win rate and total P&L

**Tech:**
- `@react-native-async-storage/async-storage` — local persistence for watchlist and journal
- `react-native-webview` — TradingView chart embedding
- Dark fintech theme (deep navy #0D1117, teal accent #00D4AA)
- Contexts: WatchlistContext (prices + symbols), JournalContext (trades), ChartContext (selected symbol/interval)

### API Server (`artifacts/api-server`)

Express 5 server serving as a market data proxy and AI backend for the mobile app.

**Routes:**
- `GET /api/healthz` — health check
- `GET /api/market/quotes?symbols=AAPL,MSFT` — Yahoo Finance quote proxy (with crumb auth)
- `GET /api/market/search?q=apple` — Yahoo Finance symbol search proxy
- `POST /api/ai/conversations` — create a new chat conversation
- `GET /api/ai/conversations/:id/messages` — fetch message history
- `POST /api/ai/conversations/:id/messages` — send a chat message (streaming SSE, gpt-5.4)
- `POST /api/ai/analyze-watchlist` — AI signal analysis for watchlist (streaming SSE)
- `POST /api/ai/review-journal` — AI journal coaching review (streaming SSE)

- `GET /api/alpaca/account` — Alpaca paper trading account info
- `GET /api/alpaca/positions` — open positions
- `GET /api/alpaca/orders` — recent orders (status/limit querystring)
- `POST /api/alpaca/orders` — place a paper trade order
- `DELETE /api/alpaca/orders/:id` — cancel an open order

**AI Integration:** Uses Replit AI Integrations OpenAI proxy (no API key required). Conversations and messages are persisted in PostgreSQL via Drizzle ORM.

**Alpaca Paper Trading:** The AI chat agent uses OpenAI function-calling tools (`get_account`, `get_positions`, `get_orders`, `place_order`, `cancel_order`) to read and execute paper trades on Alpaca. Credentials stored as secrets: `ALPACA_API_KEY`, `ALPACA_API_SECRET`. Base URL: `https://paper-api.alpaca.markets/v2`.
