// ─── Race Health Utilities ────────────────────────────────────────────────────
// Pure functions — no side effects, fully testable without server context.
// Imported by autopilot.ts and the test suite.

// ─── Cycle status machine ─────────────────────────────────────────────────────

export type TerminalCycleStatus = "COMPLETED" | "NO_ACTION" | "FAILED" | "TIMED_OUT";

export type CycleStatus =
  | "NOT_STARTED"
  | "SCANNING"
  | "DECIDED"
  | "ORDER_SUBMITTED"
  | "ORDER_FILLED"
  | "ORDER_FAILED"
  | TerminalCycleStatus;

const TERMINAL: ReadonlySet<string> = new Set<TerminalCycleStatus>([
  "COMPLETED",
  "NO_ACTION",
  "FAILED",
  "TIMED_OUT",
]);

export function isTerminalCycleStatus(s: string): s is TerminalCycleStatus {
  return TERMINAL.has(s);
}

// ─── Diagnostics ─────────────────────────────────────────────────────────────

export interface BotCycleDiagnostics {
  started_at: string;
  completed_at: string | null;
  data_fetch_started: string | null;
  data_fetch_completed: string | null;
  strategy_started: string | null;
  strategy_completed: string | null;
  init_error: string | null;
  timeout_at: string | null;
}

export function initDiagnostics(): BotCycleDiagnostics {
  return {
    started_at: new Date().toISOString(),
    completed_at: null,
    data_fetch_started: null,
    data_fetch_completed: null,
    strategy_started: null,
    strategy_completed: null,
    init_error: null,
    timeout_at: null,
  };
}

// ─── Health computation ───────────────────────────────────────────────────────
// Takes a lightweight snapshot of each bot's status — no full BotPortfolio needed.

export interface BotHealthSnapshot {
  id: string;
  cycleStatus: CycleStatus;
  cyclesStarted: number;
  cycleCount: number;           // completed cycles (each ends in a terminal state)
  first_cycle_terminal: boolean;
  running: boolean;
}

export interface RaceHealth {
  total_bots: number;
  bots_not_started: number;
  bots_in_progress: number;
  bots_completed_first_cycle: number;  // any terminal state after first cycle
  bots_completed: number;              // COMPLETED (traded)
  bots_no_action: number;              // NO_ACTION (held / market closed)
  bots_failed: number;                 // FAILED (error)
  bots_timed_out: number;              // TIMED_OUT
  race_ready_for_comparison: boolean;  // all bots have reached a terminal first-cycle state
}

// ─── MtM price map — symbol normalization ─────────────────────────────────────
// Builds a lookup that matches both BTC/USD and BTC-USD so positions are always
// found regardless of which form the AI or Alpaca returned.

export function buildMtmPriceMap(
  prices: Record<string, { price: number; [key: string]: unknown }>
): Record<string, number> {
  const map: Record<string, number> = {};
  for (const [sym, q] of Object.entries(prices)) {
    map[sym] = q.price;
    if (sym.includes("/") || sym.includes("-")) {
      map[sym.replace("-", "/").toUpperCase()] = q.price;   // → BTC/USD
      map[sym.replace("/", "-").toUpperCase()] = q.price;   // → BTC-USD
    }
  }
  return map;
}

// ─── Deterministic ranking with tie-breakers ──────────────────────────────────
// Primary:    total_equity (marked-to-market, shared snapshot)
// Tie-break 1: did_trade — bots with filled orders rank above no-action bots
// Tie-break 2: deployment_pct — among traders, higher capital deployment wins
// Tie-break 3: session_eligible — among non-traders, bots with tradeable symbols
//              in the current session rank above those whose universe was unavailable
// Tie-break 4: bot id — alphabetical for deterministic stability
//
// rank: null / rank_label: "TIE" is assigned only when ALL meaningful criteria are
// truly equal (i.e. only the ID tie-breaker separates bots in a group).

export const RANK_EPSILON = 0.01; // $0.01 — within a cent is an equity tie

// ─── Participation category ───────────────────────────────────────────────────
// Classifies each bot by whether it acted, held idle, or was blocked from acting.
// active:     has at least one filled order (tradesCount > 0, any cycle)
// idle:       session-eligible but chose no action / found no signal this session
// ineligible: strategy universe unavailable this session (e.g. equity-only bot, market closed)
export type BotParticipationCategory = "active" | "idle" | "ineligible";

export interface BotRankInput {
  id: string;
  total_equity: number;
  // Tie-breaker fields (all optional; absent fields default to most-conservative value)
  did_trade?: boolean;          // true if at least one order was filled this session
  capital_deployed?: number;    // total open position value in $
  deployment_pct?: number;      // capital_deployed / starting_budget × 100
  session_eligible?: boolean;   // true if the bot had any tradeable symbols this session
  realized_pnl?: number;        // realized P&L — fed to the performance gateway to detect first meaningful price move
  unrealized_pnl?: number;      // mark-to-market unrealized P&L — same
}

// Derives participation category from rank inputs.
// Placed here (after BotRankInput) so it can be used in computeRanks below.
function getParticipationCategory(bot: BotRankInput): BotParticipationCategory {
  if (bot.did_trade ?? false) return "active";
  if (!(bot.session_eligible ?? true)) return "ineligible";
  return "idle";
}

export interface BotRankResult {
  id: string;
  rank: number | null;                                   // null only when truly tied on all meaningful criteria
  rank_label: string;                                    // "#1" | "TIE" | "IN PROGRESS"
  is_tied: boolean;
  ranking_basis: "total_equity_marked_to_market";
  tie_break_reason: string | null;                       // null if equity alone determined rank
  // Tie-breaker context echoed per-bot for transparency
  did_trade: boolean;
  capital_deployed: number;
  deployment_pct: number;
  session_eligible: boolean;
  comparison_reason: string;                             // human-readable explanation of standing
  participation_category: BotParticipationCategory;     // active | idle | ineligible
  comparison_deferred: boolean;                          // rank deferred — awaiting first meaningful P&L
  excluded_from_ranking: boolean;                        // session-ineligible bot excluded from winner determination
}

export interface RankingResult {
  ranks: BotRankResult[];
  is_global_tie: boolean;       // true only when ALL bots are meaningfully equal (only id differs)
  tie_break_reason: string | null;
  ranking_basis: "total_equity_marked_to_market";
  snapshot_id: string;
  comparison_deferred: boolean;    // true when performance gateway blocked comparison
  deferred_reason: string | null;  // human-readable reason for deferral
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

// Compare two equity-tied bots on meaningful criteria only.
// Returns negative if a is better, positive if b is better, 0 if meaningfully equal.
function meaningfulCmp(a: BotRankInput, b: BotRankInput): number {
  const aTraded = a.did_trade ?? false;
  const bTraded = b.did_trade ?? false;

  // Tie-break 1: traded > did not trade
  if (aTraded !== bTraded) return aTraded ? -1 : 1;

  // Tie-break 2 (both traded): higher deployment_pct wins
  if (aTraded && bTraded) {
    const diff = (b.deployment_pct ?? 0) - (a.deployment_pct ?? 0);
    if (Math.abs(diff) > 0.001) return diff > 0 ? 1 : -1;
  }

  // Tie-break 3 (both did NOT trade): session-eligible > ineligible
  if (!aTraded && !bTraded) {
    const aElig = a.session_eligible ?? true;
    const bElig = b.session_eligible ?? true;
    if (aElig !== bElig) return aElig ? -1 : 1;
  }

  return 0; // meaningfully equal — only bot id remains
}

function comparisonReasonStr(bot: BotRankInput): string {
  if (bot.did_trade ?? false) {
    return `traded — deployed ${(bot.deployment_pct ?? 0).toFixed(1)}% ($${(bot.capital_deployed ?? 0).toFixed(2)})`;
  }
  if (!(bot.session_eligible ?? true)) {
    return "no action — strategy universe unavailable in current session";
  }
  return "no action — session eligible, no trade signal";
}

// ─── computeRanks ─────────────────────────────────────────────────────────────

/**
 * Compute deterministic ranks for a set of bots.
 *
 * Default behaviour (backward-compatible with all existing tests):
 * - Race not ready → all "IN PROGRESS", rank: null
 * - Equity tiers formed by epsilon; tie-breakers applied within each tier.
 * - rank: null / "TIE" only when ALL meaningful criteria are equal.
 *
 * Opt-in fairness features:
 * - requirePerformanceData: true — defers comparison ("AWAITING") when no eligible
 *   bot has non-zero realized or unrealized P&L.  Prevents tie-breakers such as
 *   did_trade or deployment_pct from crowning a winner after the very first cycle
 *   before any meaningful price movement has occurred.
 * - excludeIneligible: true — session-ineligible bots are removed from winner
 *   determination ("EXCLUDED") and do not affect leader or is_global_tie.
 */
export function computeRanks(
  bots: BotRankInput[],
  opts: {
    snapshotId: string;
    raceReady: boolean;
    epsilon?: number;
    /** Enable the performance gateway: defer comparison when no eligible bot has non-zero P&L. */
    requirePerformanceData?: boolean;
    /** Exclude session-ineligible bots from winner determination; they receive rank_label "EXCLUDED". */
    excludeIneligible?: boolean;
  }
): RankingResult {
  const epsilon         = opts.epsilon ?? RANK_EPSILON;
  const ranking_basis   = "total_equity_marked_to_market" as const;
  const requirePerf     = opts.requirePerformanceData ?? false;
  const doExcludeInelig = opts.excludeIneligible ?? false;

  // ── 0. Race not ready → IN PROGRESS ───────────────────────────────────────
  if (!opts.raceReady || bots.length === 0) {
    return {
      ranks: bots.map((b) => ({
        id: b.id,
        rank: null,
        rank_label: "IN PROGRESS",
        is_tied: false,
        ranking_basis,
        tie_break_reason: null,
        did_trade: b.did_trade ?? false,
        capital_deployed: b.capital_deployed ?? 0,
        deployment_pct: b.deployment_pct ?? 0,
        session_eligible: b.session_eligible ?? true,
        comparison_reason: "race not yet ready for comparison",
        participation_category: getParticipationCategory(b),
        comparison_deferred: false,
        excluded_from_ranking: false,
      })),
      is_global_tie: false,
      tie_break_reason: null,
      ranking_basis,
      snapshot_id: opts.snapshotId,
      comparison_deferred: false,
      deferred_reason: null,
    };
  }

  // ── 1. Separate session-ineligible bots (when excludeIneligible=true) ──────
  const ineligibleIds = doExcludeInelig
    ? new Set(bots.filter((b) => b.session_eligible === false).map((b) => b.id))
    : new Set<string>();
  const botsToRank = doExcludeInelig
    ? bots.filter((b) => b.session_eligible !== false)
    : bots;

  // Helper: EXCLUDED result for an ineligible bot.
  const buildExcluded = (b: BotRankInput): BotRankResult => ({
    id: b.id,
    rank: null,
    rank_label: "EXCLUDED",
    is_tied: false,
    ranking_basis,
    tie_break_reason: null,
    did_trade: b.did_trade ?? false,
    capital_deployed: b.capital_deployed ?? 0,
    deployment_pct: b.deployment_pct ?? 0,
    session_eligible: false,
    comparison_reason: "excluded — strategy universe unavailable this session",
    participation_category: "ineligible",
    comparison_deferred: false,
    excluded_from_ranking: true,
  });

  // ── 2. Performance gateway (when requirePerformanceData=true) ──────────────
  // Checks eligible bots only — ineligible bots sitting in cash do not count.
  // If no eligible bot has |realized_pnl| > ε or |unrealized_pnl| > ε, defer.
  let comparisonDeferred = false;
  let deferredReason: string | null = null;

  if (requirePerf && botsToRank.length > 0) {
    const hasPerf = botsToRank.some(
      (b) =>
        Math.abs(b.realized_pnl ?? 0) > epsilon ||
        Math.abs(b.unrealized_pnl ?? 0) > epsilon
    );
    if (!hasPerf) {
      comparisonDeferred = true;
      deferredReason = "no P&L separation yet — awaiting first meaningful price movement";
    }
  }

  // ── 3. Deferred comparison state ───────────────────────────────────────────
  if (comparisonDeferred) {
    const rankById = new Map<string, BotRankResult>();
    for (const b of bots) {
      if (ineligibleIds.has(b.id)) {
        rankById.set(b.id, buildExcluded(b));
      } else {
        rankById.set(b.id, {
          id: b.id,
          rank: null,
          rank_label: "AWAITING",
          is_tied: false,
          ranking_basis,
          tie_break_reason: null,
          did_trade: b.did_trade ?? false,
          capital_deployed: b.capital_deployed ?? 0,
          deployment_pct: b.deployment_pct ?? 0,
          session_eligible: b.session_eligible ?? true,
          comparison_reason: "awaiting evaluation window — no P&L separation yet",
          participation_category: getParticipationCategory(b),
          comparison_deferred: true,
          excluded_from_ranking: false,
        });
      }
    }
    return {
      ranks: bots.map((b) => rankById.get(b.id)!),
      is_global_tie: false,
      tie_break_reason: null,
      ranking_basis,
      snapshot_id: opts.snapshotId,
      comparison_deferred: true,
      deferred_reason: deferredReason,
    };
  }

  // ── 4. Sort eligible bots descending by equity, group into equity tiers ────
  const sorted = [...botsToRank].sort((a, b) => b.total_equity - a.total_equity);

  type TieGroup = { bots: BotRankInput[]; slotRank: number };
  const groups: TieGroup[] = [];
  for (const bot of sorted) {
    const last = groups[groups.length - 1];
    if (last && Math.abs(bot.total_equity - last.bots[0]!.total_equity) < epsilon) {
      last.bots.push(bot);
    } else {
      groups.push({ bots: [bot], slotRank: 0 });
    }
  }

  // Assign base slot ranks (group i starts after cumulative size of all prior groups)
  let slot = 1;
  for (const g of groups) { g.slotRank = slot; slot += g.bots.length; }

  // ── 5. Within each equity tier apply tie-breakers ──────────────────────────
  const rankById = new Map<string, BotRankResult>();
  let anyMeaningfulTieBreak = false;
  let isGlobalTie = false;

  for (const g of groups) {
    if (g.bots.length === 1) {
      // Unique equity — straight rank, no tie-breaking needed
      const bot = g.bots[0]!;
      rankById.set(bot.id, {
        id: bot.id,
        rank: g.slotRank,
        rank_label: `#${g.slotRank}`,
        is_tied: false,
        ranking_basis,
        tie_break_reason: null,
        did_trade: bot.did_trade ?? false,
        capital_deployed: bot.capital_deployed ?? 0,
        deployment_pct: bot.deployment_pct ?? 0,
        session_eligible: bot.session_eligible ?? true,
        comparison_reason: comparisonReasonStr(bot),
        participation_category: getParticipationCategory(bot),
        comparison_deferred: false,
        excluded_from_ranking: false,
      });
      continue;
    }

    // Multiple bots in same equity tier — sort by meaningful criteria, then id
    const tieSorted = [...g.bots].sort((a, b) => {
      const mc = meaningfulCmp(a, b);
      return mc !== 0 ? mc : a.id.localeCompare(b.id);
    });

    // Sub-group: consecutive bots that are meaningfully equal form a sub-group
    type SubGroup = { bots: BotRankInput[]; subSlot: number };
    const subGroups: SubGroup[] = [];
    for (const bot of tieSorted) {
      const last = subGroups[subGroups.length - 1];
      const lastBot = last?.bots[last.bots.length - 1];
      if (last && lastBot && meaningfulCmp(lastBot, bot) === 0) {
        last.bots.push(bot);
      } else {
        subGroups.push({ bots: [bot], subSlot: 0 });
      }
    }

    // Assign sub-slots
    let subSlot = g.slotRank;
    for (const sg of subGroups) { sg.subSlot = subSlot; subSlot += sg.bots.length; }

    const hasMeaningfulTieBreak = subGroups.length > 1;
    if (hasMeaningfulTieBreak) anyMeaningfulTieBreak = true;

    for (const sg of subGroups) {
      const isMeaningfullyTied = sg.bots.length > 1;
      for (const bot of sg.bots) {
        const tieBreakReason = hasMeaningfulTieBreak
          ? `equity within $${epsilon.toFixed(2)} — ranked by tie-breakers`
          : `equity within $${epsilon.toFixed(2)} — all criteria equal (ordered by bot id)`;

        rankById.set(bot.id, {
          id: bot.id,
          rank: isMeaningfullyTied ? null : sg.subSlot,
          rank_label: isMeaningfullyTied ? "TIE" : `#${sg.subSlot}`,
          is_tied: isMeaningfullyTied,
          ranking_basis,
          tie_break_reason: tieBreakReason,
          did_trade: bot.did_trade ?? false,
          capital_deployed: bot.capital_deployed ?? 0,
          deployment_pct: bot.deployment_pct ?? 0,
          session_eligible: bot.session_eligible ?? true,
          comparison_reason: comparisonReasonStr(bot),
          participation_category: getParticipationCategory(bot),
          comparison_deferred: false,
          excluded_from_ranking: false,
        });
      }
    }

    // Global tie: single equity group, single meaningful sub-group, multiple bots
    // Evaluated among eligible bots only — excluded bots do not affect this flag.
    if (groups.length === 1 && subGroups.length === 1 && subGroups[0]!.bots.length > 1) {
      isGlobalTie = true;
    }
  }

  // Add EXCLUDED entries for ineligible bots (not part of the ranking loop)
  for (const b of bots.filter((b) => ineligibleIds.has(b.id))) {
    rankById.set(b.id, buildExcluded(b));
  }

  // ── 6. Build result ────────────────────────────────────────────────────────
  let globalTieBreakReason: string | null = null;
  if (isGlobalTie) {
    globalTieBreakReason = `All eligible bots equal on equity and all tie-breakers — ordered by bot id`;
  } else if (anyMeaningfulTieBreak) {
    globalTieBreakReason =
      "equity tied within epsilon — resolved by: 1) traded, 2) deployment %, 3) session eligibility, 4) bot id";
  }

  return {
    ranks: bots.map((b) => rankById.get(b.id)!),
    is_global_tie: isGlobalTie,
    tie_break_reason: globalTieBreakReason,
    ranking_basis,
    snapshot_id: opts.snapshotId,
    comparison_deferred: false,
    deferred_reason: null,
  };
}

// ─── computeRaceHealth ────────────────────────────────────────────────────────

export function computeRaceHealth(bots: BotHealthSnapshot[]): RaceHealth {
  const total = bots.length;
  const notStarted   = bots.filter((b) => b.cycleStatus === "NOT_STARTED").length;
  const inProgress   = bots.filter((b) => !isTerminalCycleStatus(b.cycleStatus) && b.cycleStatus !== "NOT_STARTED").length;
  const completedFst = bots.filter((b) => b.first_cycle_terminal).length;
  const completed    = bots.filter((b) => b.cycleStatus === "COMPLETED").length;
  const noAction     = bots.filter((b) => b.cycleStatus === "NO_ACTION").length;
  const failed       = bots.filter((b) => b.cycleStatus === "FAILED").length;
  const timedOut     = bots.filter((b) => b.cycleStatus === "TIMED_OUT").length;

  return {
    total_bots: total,
    bots_not_started: notStarted,
    bots_in_progress: inProgress,
    bots_completed_first_cycle: completedFst,
    bots_completed: completed,
    bots_no_action: noAction,
    bots_failed: failed,
    bots_timed_out: timedOut,
    race_ready_for_comparison: total > 0 && completedFst === total,
  };
}
