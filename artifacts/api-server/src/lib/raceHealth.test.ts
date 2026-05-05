// ─── Race Health / Orchestration Tests (node:test) ───────────────────────────
// Run: pnpm --filter @workspace/api-server run test:race
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isTerminalCycleStatus,
  computeRaceHealth,
  initDiagnostics,
  computeRanks,
  buildMtmPriceMap,
  type BotHealthSnapshot,
  type BotRankInput,
  type CycleStatus,
} from "./raceHealth.js";

// ─── 1. isTerminalCycleStatus ─────────────────────────────────────────────────

describe("isTerminalCycleStatus", () => {
  it("COMPLETED, NO_ACTION, FAILED, TIMED_OUT are terminal", () => {
    assert.equal(isTerminalCycleStatus("COMPLETED"),  true);
    assert.equal(isTerminalCycleStatus("NO_ACTION"),  true);
    assert.equal(isTerminalCycleStatus("FAILED"),     true);
    assert.equal(isTerminalCycleStatus("TIMED_OUT"),  true);
  });

  it("NOT_STARTED, SCANNING, DECIDED, ORDER_SUBMITTED, ORDER_FILLED, ORDER_FAILED are NOT terminal", () => {
    for (const s of ["NOT_STARTED", "SCANNING", "DECIDED", "ORDER_SUBMITTED", "ORDER_FILLED", "ORDER_FAILED"]) {
      assert.equal(isTerminalCycleStatus(s), false, `${s} should not be terminal`);
    }
  });
});

// ─── 2. All 4 bots initialize correctly ───────────────────────────────────────

describe("All 4 bots have correct initial state", () => {
  const BOT_IDS = ["momentum", "dip_buyer", "conservative", "scalper"];

  function makeInitialBot(id: string): BotHealthSnapshot {
    return {
      id,
      cycleStatus: "NOT_STARTED",
      cyclesStarted: 0,
      cycleCount: 0,
      first_cycle_terminal: false,
      running: true,
    };
  }

  it("all 4 bots start as NOT_STARTED with cycleCount=0", () => {
    for (const id of BOT_IDS) {
      const bot = makeInitialBot(id);
      assert.equal(bot.cycleStatus,        "NOT_STARTED");
      assert.equal(bot.cyclesStarted,      0);
      assert.equal(bot.cycleCount,         0);
      assert.equal(bot.first_cycle_terminal, false);
    }
  });

  it("computeRaceHealth on initial state: not ready, 4 not started, 0 in progress", () => {
    const bots = BOT_IDS.map(makeInitialBot);
    const health = computeRaceHealth(bots);
    assert.equal(health.total_bots,              4);
    assert.equal(health.bots_not_started,        4);
    assert.equal(health.bots_in_progress,        0);
    assert.equal(health.bots_completed_first_cycle, 0);
    assert.equal(health.race_ready_for_comparison, false, "race not ready until all bots finish first cycle");
  });
});

// ─── 3. Timeout path ──────────────────────────────────────────────────────────

describe("Bot timeout path", () => {
  it("a bot stuck in SCANNING is correctly identified as in-progress", () => {
    const bot: BotHealthSnapshot = {
      id: "scalper", cycleStatus: "SCANNING",
      cyclesStarted: 1, cycleCount: 0, first_cycle_terminal: false, running: true,
    };
    const health = computeRaceHealth([bot]);
    assert.equal(health.bots_in_progress, 1);
    assert.equal(health.bots_not_started, 0);
    assert.equal(health.race_ready_for_comparison, false);
  });

  it("after timeout handler fires, bot moves to TIMED_OUT — race tracks it", () => {
    // Simulate what handleBotCycleTimeout does to the bot state
    const bot: BotHealthSnapshot = {
      id: "scalper", cycleStatus: "TIMED_OUT",
      cyclesStarted: 1, cycleCount: 1, first_cycle_terminal: true, running: true,
    };
    const health = computeRaceHealth([bot]);
    assert.equal(health.bots_timed_out, 1);
    assert.equal(health.bots_completed_first_cycle, 1);
    assert.equal(isTerminalCycleStatus(bot.cycleStatus), true, "TIMED_OUT must be terminal");
  });

  it("one TIMED_OUT + three COMPLETED = race ready for comparison", () => {
    const bots: BotHealthSnapshot[] = [
      { id: "momentum",    cycleStatus: "COMPLETED",  cyclesStarted: 1, cycleCount: 1, first_cycle_terminal: true,  running: true },
      { id: "dip_buyer",   cycleStatus: "COMPLETED",  cyclesStarted: 1, cycleCount: 1, first_cycle_terminal: true,  running: true },
      { id: "conservative",cycleStatus: "COMPLETED",  cyclesStarted: 1, cycleCount: 1, first_cycle_terminal: true,  running: true },
      { id: "scalper",     cycleStatus: "TIMED_OUT",  cyclesStarted: 1, cycleCount: 1, first_cycle_terminal: true,  running: true },
    ];
    const health = computeRaceHealth(bots);
    assert.equal(health.race_ready_for_comparison, true, "should be ready even with one timeout");
    assert.equal(health.bots_timed_out,            1);
    assert.equal(health.bots_completed_first_cycle, 4);
  });
});

// ─── 4. NO_ACTION path ────────────────────────────────────────────────────────

describe("NO_ACTION path (bot chose not to trade)", () => {
  it("bot in NO_ACTION is terminal and counted in completed_first_cycle", () => {
    const bot: BotHealthSnapshot = {
      id: "conservative", cycleStatus: "NO_ACTION",
      cyclesStarted: 1, cycleCount: 1, first_cycle_terminal: true, running: true,
    };
    assert.equal(isTerminalCycleStatus(bot.cycleStatus), true);
    const health = computeRaceHealth([bot]);
    assert.equal(health.bots_no_action, 1);
    assert.equal(health.bots_completed_first_cycle, 1);
  });

  it("all bots NO_ACTION = race ready for comparison (all reached a terminal state)", () => {
    const bots: BotHealthSnapshot[] = ["momentum","dip_buyer","conservative","scalper"].map((id) => ({
      id, cycleStatus: "NO_ACTION" as CycleStatus,
      cyclesStarted: 1, cycleCount: 1, first_cycle_terminal: true, running: true,
    }));
    const health = computeRaceHealth(bots);
    assert.equal(health.race_ready_for_comparison, true);
    assert.equal(health.bots_no_action, 4);
    assert.equal(health.bots_timed_out, 0);
    assert.equal(health.bots_failed,    0);
  });
});

// ─── 5. FAILED path ──────────────────────────────────────────────────────────

describe("FAILED path (unhandled error)", () => {
  it("FAILED is terminal and tracked separately", () => {
    const bot: BotHealthSnapshot = {
      id: "momentum", cycleStatus: "FAILED",
      cyclesStarted: 1, cycleCount: 1, first_cycle_terminal: true, running: true,
    };
    assert.equal(isTerminalCycleStatus("FAILED"), true);
    const health = computeRaceHealth([bot]);
    assert.equal(health.bots_failed, 1);
    assert.equal(health.bots_completed_first_cycle, 1);
  });
});

// ─── 6. Incomplete race — ranking should show "race in progress" ──────────────

describe("Incomplete race export state", () => {
  it("race not ready when 3 completed but 1 still SCANNING", () => {
    const bots: BotHealthSnapshot[] = [
      { id: "momentum",    cycleStatus: "COMPLETED", cyclesStarted: 1, cycleCount: 1, first_cycle_terminal: true,  running: true },
      { id: "dip_buyer",   cycleStatus: "COMPLETED", cyclesStarted: 1, cycleCount: 1, first_cycle_terminal: true,  running: true },
      { id: "conservative",cycleStatus: "COMPLETED", cyclesStarted: 1, cycleCount: 1, first_cycle_terminal: true,  running: true },
      { id: "scalper",     cycleStatus: "SCANNING",  cyclesStarted: 1, cycleCount: 0, first_cycle_terminal: false, running: true },
    ];
    const health = computeRaceHealth(bots);
    assert.equal(health.race_ready_for_comparison, false, "one bot still scanning — not ready");
    assert.equal(health.bots_completed_first_cycle, 3);
    assert.equal(health.bots_in_progress, 1);
  });

  it("race not ready when bots have not started at all", () => {
    const bots: BotHealthSnapshot[] = [
      { id: "momentum", cycleStatus: "NOT_STARTED", cyclesStarted: 0, cycleCount: 0, first_cycle_terminal: false, running: true },
      { id: "dip_buyer", cycleStatus: "SCANNING",   cyclesStarted: 1, cycleCount: 0, first_cycle_terminal: false, running: true },
    ];
    const health = computeRaceHealth(bots);
    assert.equal(health.race_ready_for_comparison, false);
    assert.equal(health.bots_not_started, 1);
    assert.equal(health.bots_in_progress, 1);
  });
});

// ─── 7. diagnostics structure ─────────────────────────────────────────────────

describe("initDiagnostics", () => {
  it("returns clean diagnostics with only started_at set", () => {
    const d = initDiagnostics();
    assert.ok(typeof d.started_at === "string" && d.started_at.length > 0, "started_at must be set");
    assert.equal(d.completed_at,        null);
    assert.equal(d.data_fetch_started,  null);
    assert.equal(d.data_fetch_completed,null);
    assert.equal(d.strategy_started,    null);
    assert.equal(d.strategy_completed,  null);
    assert.equal(d.init_error,          null);
    assert.equal(d.timeout_at,          null);
  });
});

// ─── 8. computeRanks — deterministic ranking ─────────────────────────────────

describe("computeRanks — race not ready", () => {
  it("returns IN PROGRESS for all bots when raceReady=false", () => {
    const bots: BotRankInput[] = [
      { id: "momentum",     total_equity: 260 },
      { id: "dip_buyer",   total_equity: 250 },
      { id: "conservative",total_equity: 245 },
      { id: "scalper",     total_equity: 255 },
    ];
    const r = computeRanks(bots, { snapshotId: "snap_test", raceReady: false });
    assert.equal(r.is_global_tie, false);
    assert.equal(r.snapshot_id, "snap_test");
    assert.equal(r.ranking_basis, "total_equity_marked_to_market");
    for (const rank of r.ranks) {
      assert.equal(rank.rank, null, `${rank.id} should have rank: null`);
      assert.equal(rank.rank_label, "IN PROGRESS");
      assert.equal(rank.is_tied, false);
    }
  });

  it("returns IN PROGRESS for empty bots list", () => {
    const r = computeRanks([], { snapshotId: "snap_empty", raceReady: true });
    assert.equal(r.ranks.length, 0);
    assert.equal(r.is_global_tie, false);
    assert.equal(r.snapshot_id, "snap_empty");
  });
});

describe("computeRanks — global tie (equal equity within epsilon)", () => {
  it("all 4 bots within $0.01 → global tie, all rank: null", () => {
    const bots: BotRankInput[] = [
      { id: "momentum",     total_equity: 250.004 },
      { id: "dip_buyer",   total_equity: 250.000 },
      { id: "conservative",total_equity: 249.999 },
      { id: "scalper",     total_equity: 250.005 },
    ];
    const r = computeRanks(bots, { snapshotId: "snap_tie", raceReady: true });
    assert.equal(r.is_global_tie, true, "should be global tie");
    assert.ok(r.tie_break_reason !== null, "should have tie_break_reason");
    for (const rank of r.ranks) {
      assert.equal(rank.rank, null, `${rank.id} should have rank: null in a global tie`);
      assert.equal(rank.rank_label, "TIE");
      assert.equal(rank.is_tied, true);
      assert.equal(rank.ranking_basis, "total_equity_marked_to_market");
    }
  });

  it("bots $0.05 apart are NOT a tie (clearly outside epsilon)", () => {
    // 250.05 - 250.00 = 0.05 > 0.01 epsilon, unambiguously not tied regardless of FP precision
    const bots: BotRankInput[] = [
      { id: "a", total_equity: 250.05 },
      { id: "b", total_equity: 250.00 },
    ];
    const r = computeRanks(bots, { snapshotId: "snap_edge", raceReady: true });
    assert.equal(r.is_global_tie, false, "$0.05 apart is clearly not a tie");
    const byId = new Map(r.ranks.map((x) => [x.id, x]));
    assert.equal(byId.get("a")!.rank, 1);
    assert.equal(byId.get("b")!.rank, 2);
  });

  it("custom epsilon: bots within $1 → tied", () => {
    const bots: BotRankInput[] = [
      { id: "a", total_equity: 250.50 },
      { id: "b", total_equity: 250.00 },
    ];
    const r = computeRanks(bots, { snapshotId: "snap_custom_eps", raceReady: true, epsilon: 1.0 });
    assert.equal(r.is_global_tie, true, "should be global tie with epsilon=1");
  });
});

describe("computeRanks — distinct equities → ordered ranks", () => {
  it("4 distinct equities → ranked #1-#4 deterministically", () => {
    const bots: BotRankInput[] = [
      { id: "a", total_equity: 280 },
      { id: "b", total_equity: 270 },
      { id: "c", total_equity: 260 },
      { id: "d", total_equity: 250 },
    ];
    const r = computeRanks(bots, { snapshotId: "snap_ordered", raceReady: true });
    assert.equal(r.is_global_tie, false);
    assert.equal(r.tie_break_reason, null);
    const byId = new Map(r.ranks.map((x) => [x.id, x]));
    assert.equal(byId.get("a")!.rank, 1);
    assert.equal(byId.get("a")!.rank_label, "#1");
    assert.equal(byId.get("b")!.rank, 2);
    assert.equal(byId.get("c")!.rank, 3);
    assert.equal(byId.get("d")!.rank, 4);
    for (const rank of r.ranks) assert.equal(rank.is_tied, false);
  });

  it("single bot → rank 1, not tied", () => {
    const bots: BotRankInput[] = [{ id: "solo", total_equity: 250 }];
    const r = computeRanks(bots, { snapshotId: "snap_solo", raceReady: true });
    assert.equal(r.is_global_tie, false);
    assert.equal(r.ranks[0]!.rank, 1);
    assert.equal(r.ranks[0]!.rank_label, "#1");
    assert.equal(r.ranks[0]!.is_tied, false);
  });

  it("snapshot_id and ranking_basis are always propagated", () => {
    const bots: BotRankInput[] = [{ id: "x", total_equity: 250 }];
    const r = computeRanks(bots, { snapshotId: "my_snap_id_42", raceReady: true });
    assert.equal(r.snapshot_id, "my_snap_id_42");
    assert.equal(r.ranking_basis, "total_equity_marked_to_market");
    assert.equal(r.ranks[0]!.ranking_basis, "total_equity_marked_to_market");
  });
});

describe("computeRanks — partial tie at top", () => {
  it("top 2 tied, bottom 2 distinctly ranked", () => {
    // a and b are within $0.01 of each other → TIE at slot 1
    // c and d are clearly separated below → slots 3 and 4
    const bots: BotRankInput[] = [
      { id: "a", total_equity: 275.003 },
      { id: "b", total_equity: 275.000 },
      { id: "c", total_equity: 260.000 },
      { id: "d", total_equity: 250.000 },
    ];
    const r = computeRanks(bots, { snapshotId: "snap_partial", raceReady: true });
    assert.equal(r.is_global_tie, false, "not a global tie");
    const byId = new Map(r.ranks.map((x) => [x.id, x]));
    assert.equal(byId.get("a")!.rank, null, "a is tied");
    assert.equal(byId.get("a")!.rank_label, "TIE");
    assert.equal(byId.get("b")!.rank, null, "b is tied with a");
    assert.equal(byId.get("b")!.rank_label, "TIE");
    // Slots 1 and 2 consumed by the tie group → c gets slot 3
    assert.equal(byId.get("c")!.rank, 3, "c is rank 3");
    assert.equal(byId.get("c")!.rank_label, "#3");
    assert.equal(byId.get("d")!.rank, 4, "d is rank 4");
    assert.equal(byId.get("d")!.is_tied, false);
  });
});

// ─── 9. buildMtmPriceMap — symbol normalization ───────────────────────────────

describe("buildMtmPriceMap — dual-form crypto keys", () => {
  it("adds both BTC/USD and BTC-USD keys for the same price", () => {
    const prices = { "BTC-USD": { price: 50000, change: 100, changePercent: 0.2, name: "Bitcoin" } };
    const map = buildMtmPriceMap(prices);
    assert.equal(map["BTC-USD"], 50000, "original key present");
    assert.equal(map["BTC/USD"], 50000, "slash form present");
  });

  it("handles slash-form input and also produces dash form", () => {
    const prices = { "ETH/USD": { price: 3000, change: 10, changePercent: 0.3, name: "Ethereum" } };
    const map = buildMtmPriceMap(prices);
    assert.equal(map["ETH/USD"], 3000, "original slash key");
    assert.equal(map["ETH-USD"], 3000, "dash form produced");
  });

  it("equity symbols (no slash/dash) are passed through unchanged", () => {
    const prices = { "AAPL": { price: 180, change: 1, changePercent: 0.5, name: "Apple" } };
    const map = buildMtmPriceMap(prices);
    assert.equal(map["AAPL"], 180);
  });

  it("mixed equity and crypto symbols are all present", () => {
    const prices = {
      "AAPL":    { price: 180,   change: 1,   changePercent: 0.5,  name: "Apple" },
      "BTC-USD": { price: 50000, change: 100, changePercent: 0.2,  name: "Bitcoin" },
      "ETH/USD": { price: 3000,  change: 10,  changePercent: 0.33, name: "Ethereum" },
    };
    const map = buildMtmPriceMap(prices);
    assert.equal(map["AAPL"],    180);
    assert.equal(map["BTC-USD"], 50000);
    assert.equal(map["BTC/USD"], 50000);
    assert.equal(map["ETH/USD"], 3000);
    assert.equal(map["ETH-USD"], 3000);
  });
});

// ─── 10. computeRanks — tie-breaker scenarios ────────────────────────────────

describe("computeRanks — one bot trades, others no-op (equity tied)", () => {
  it("trading bot wins over no-action bots even when equity is equal", () => {
    const bots: BotRankInput[] = [
      { id: "momentum",     total_equity: 250, did_trade: true,  capital_deployed: 125, deployment_pct: 50, session_eligible: true },
      { id: "dip_buyer",   total_equity: 250, did_trade: false, capital_deployed: 0,   deployment_pct: 0,  session_eligible: true },
      { id: "conservative",total_equity: 250, did_trade: false, capital_deployed: 0,   deployment_pct: 0,  session_eligible: true },
      { id: "scalper",     total_equity: 250, did_trade: false, capital_deployed: 0,   deployment_pct: 0,  session_eligible: true },
    ];
    const r = computeRanks(bots, { snapshotId: "snap_trade_wins", raceReady: true });
    assert.equal(r.is_global_tie, false, "trader vs no-action is not a global tie");
    assert.ok(r.tie_break_reason !== null, "tie-break was applied");
    const byId = new Map(r.ranks.map((x) => [x.id, x]));

    // momentum traded → must be rank #1
    assert.equal(byId.get("momentum")!.rank, 1, "trading bot is rank 1");
    assert.equal(byId.get("momentum")!.rank_label, "#1");
    assert.equal(byId.get("momentum")!.is_tied, false);
    assert.equal(byId.get("momentum")!.did_trade, true);
    assert.ok(byId.get("momentum")!.comparison_reason.includes("traded"), "comparison_reason mentions traded");

    // The 3 no-action bots are meaningfully equal → they form a TIE sub-group
    assert.equal(byId.get("dip_buyer")!.rank, null, "no-action bots are tied");
    assert.equal(byId.get("dip_buyer")!.rank_label, "TIE");
    assert.equal(byId.get("conservative")!.rank, null);
    assert.equal(byId.get("scalper")!.rank, null);
    assert.equal(byId.get("dip_buyer")!.did_trade, false);
    assert.ok(byId.get("dip_buyer")!.comparison_reason.includes("no action"), "comparison_reason mentions no action");
  });
});

describe("computeRanks — multiple bots trade with equal equity, different deployment", () => {
  it("higher deployment % wins among trading bots, session-ineligible loses among non-traders", () => {
    const bots: BotRankInput[] = [
      { id: "momentum",     total_equity: 250, did_trade: true,  capital_deployed: 125, deployment_pct: 50,  session_eligible: true },
      { id: "scalper",     total_equity: 250, did_trade: true,  capital_deployed: 50,  deployment_pct: 20,  session_eligible: true },
      { id: "dip_buyer",   total_equity: 250, did_trade: false, capital_deployed: 0,   deployment_pct: 0,   session_eligible: true },
      { id: "conservative",total_equity: 250, did_trade: false, capital_deployed: 0,   deployment_pct: 0,   session_eligible: false },
    ];
    const r = computeRanks(bots, { snapshotId: "snap_deploy", raceReady: true });
    assert.equal(r.is_global_tie, false);
    const byId = new Map(r.ranks.map((x) => [x.id, x]));

    // momentum: highest deployment (50%) → rank 1
    assert.equal(byId.get("momentum")!.rank, 1, "50% deployment wins");
    assert.equal(byId.get("momentum")!.deployment_pct, 50);

    // scalper: 20% deployment → rank 2
    assert.equal(byId.get("scalper")!.rank, 2, "20% deployment is rank 2");
    assert.equal(byId.get("scalper")!.deployment_pct, 20);

    // dip_buyer: no trade but session eligible → rank 3
    assert.equal(byId.get("dip_buyer")!.rank, 3, "session-eligible no-action bot is rank 3");
    assert.equal(byId.get("dip_buyer")!.session_eligible, true);
    assert.ok(byId.get("dip_buyer")!.comparison_reason.includes("session eligible"), "mentions session eligible");

    // conservative: no trade and session ineligible → rank 4
    assert.equal(byId.get("conservative")!.rank, 4, "session-ineligible bot is rank 4");
    assert.equal(byId.get("conservative")!.session_eligible, false);
    assert.ok(byId.get("conservative")!.comparison_reason.includes("unavailable"), "mentions unavailable");
  });

  it("two traders with identical deployment_pct are still meaningfully tied", () => {
    const bots: BotRankInput[] = [
      { id: "alpha", total_equity: 250, did_trade: true, capital_deployed: 50, deployment_pct: 20, session_eligible: true },
      { id: "beta",  total_equity: 250, did_trade: true, capital_deployed: 50, deployment_pct: 20, session_eligible: true },
    ];
    const r = computeRanks(bots, { snapshotId: "snap_dep_tie", raceReady: true });
    assert.equal(r.is_global_tie, true, "identical traders are a global tie");
    const byId = new Map(r.ranks.map((x) => [x.id, x]));
    assert.equal(byId.get("alpha")!.rank, null);
    assert.equal(byId.get("beta")!.rank, null);
    assert.equal(byId.get("alpha")!.rank_label, "TIE");
  });
});

describe("computeRanks — market-closed race, equity-only bot marked session-ineligible", () => {
  it("crypto-eligible bot ranks above session-ineligible equity-only bot when equity is tied", () => {
    const bots: BotRankInput[] = [
      { id: "momentum",     total_equity: 250, did_trade: false, capital_deployed: 0, deployment_pct: 0, session_eligible: true  },
      { id: "conservative", total_equity: 250, did_trade: false, capital_deployed: 0, deployment_pct: 0, session_eligible: false },
    ];
    const r = computeRanks(bots, { snapshotId: "snap_closed", raceReady: true });
    assert.equal(r.is_global_tie, false, "eligibility breaks the tie");
    const byId = new Map(r.ranks.map((x) => [x.id, x]));
    assert.equal(byId.get("momentum")!.rank, 1, "session-eligible bot wins");
    assert.equal(byId.get("conservative")!.rank, 2, "ineligible bot loses");
    assert.equal(byId.get("conservative")!.session_eligible, false);
    assert.ok(byId.get("conservative")!.comparison_reason.includes("unavailable"), "reason mentions unavailable");
    assert.ok(r.tie_break_reason !== null, "tie-break reason is set");
  });

  it("two session-ineligible bots with equal equity are globally tied", () => {
    const bots: BotRankInput[] = [
      { id: "conservative", total_equity: 250, did_trade: false, capital_deployed: 0, deployment_pct: 0, session_eligible: false },
      { id: "other",        total_equity: 250, did_trade: false, capital_deployed: 0, deployment_pct: 0, session_eligible: false },
    ];
    const r = computeRanks(bots, { snapshotId: "snap_both_ineligible", raceReady: true });
    assert.equal(r.is_global_tie, true, "two equally-ineligible bots are truly tied");
  });
});

describe("computeRanks — comparison_reason field", () => {
  it("trader comparison_reason includes deployment_pct and capital_deployed", () => {
    const bots: BotRankInput[] = [
      { id: "a", total_equity: 260, did_trade: true, capital_deployed: 87.5, deployment_pct: 35, session_eligible: true },
    ];
    const r = computeRanks(bots, { snapshotId: "snap_cr", raceReady: true });
    const reason = r.ranks[0]!.comparison_reason;
    assert.ok(reason.includes("traded"), "mentions traded");
    assert.ok(reason.includes("35.0%"), "mentions deployment pct");
    assert.ok(reason.includes("$87.50"), "mentions capital deployed");
  });

  it("session-ineligible reason mentions unavailable", () => {
    const bots: BotRankInput[] = [
      { id: "a", total_equity: 250, did_trade: false, capital_deployed: 0, deployment_pct: 0, session_eligible: false },
    ];
    const r = computeRanks(bots, { snapshotId: "snap_inelig", raceReady: true });
    assert.ok(r.ranks[0]!.comparison_reason.includes("unavailable"));
  });

  it("session-eligible no-trade reason says no trade signal", () => {
    const bots: BotRankInput[] = [
      { id: "a", total_equity: 250, did_trade: false, capital_deployed: 0, deployment_pct: 0, session_eligible: true },
    ];
    const r = computeRanks(bots, { snapshotId: "snap_notrade", raceReady: true });
    assert.ok(r.ranks[0]!.comparison_reason.includes("no trade signal"));
  });
});

// ─── 11. Source-of-truth regression scenarios ─────────────────────────────────
// These tests guard against bugs where summary.leader did not match the bot
// with the highest total_equity (e.g. using insertion order instead of rank).

describe("computeRanks — Scalper regression: highest equity = rank 1 regardless of position", () => {
  it("scalper at index 3 (RACE_CONFIGS insertion order) with highest equity wins rank 1", () => {
    // Mirrors the real RACE_CONFIGS insertion order: momentum, dip_buyer, conservative, scalper.
    // Scalper has the highest total_equity — it MUST be rank 1.
    const bots: BotRankInput[] = [
      { id: "momentum",     total_equity: 245.00 },
      { id: "dip_buyer",   total_equity: 248.50 },
      { id: "conservative",total_equity: 250.00 },
      { id: "scalper",     total_equity: 262.33 },   // highest — last in array
    ];
    const r = computeRanks(bots, { snapshotId: "snap_scalper_regression", raceReady: true });
    assert.equal(r.is_global_tie, false, "clear winner — not a tie");
    assert.equal(r.tie_break_reason, null, "equity alone decides — no tie-breaking");
    const byId = new Map(r.ranks.map((x) => [x.id, x]));

    assert.equal(byId.get("scalper")!.rank,       1, "scalper is rank 1");
    assert.equal(byId.get("scalper")!.rank_label, "#1");
    assert.equal(byId.get("scalper")!.is_tied,    false);

    assert.equal(byId.get("conservative")!.rank,  2);
    assert.equal(byId.get("dip_buyer")!.rank,      3);
    assert.equal(byId.get("momentum")!.rank,       4);
  });

  it("ranks array preserves original input order — caller must sort for display", () => {
    // computeRanks returns ranks in the SAME ORDER as the input bots array.
    // The caller (autopilot.ts) is responsible for sorting the display array by rank.
    const bots: BotRankInput[] = [
      { id: "momentum",     total_equity: 245.00 },
      { id: "scalper",     total_equity: 262.33 },  // highest
    ];
    const r = computeRanks(bots, { snapshotId: "snap_order", raceReady: true });
    // ranks[0] corresponds to bots[0] (momentum), ranks[1] to bots[1] (scalper)
    assert.equal(r.ranks[0]!.id,   "momentum", "ranks array preserves input order");
    assert.equal(r.ranks[0]!.rank, 2,          "momentum is rank 2 despite being index 0");
    assert.equal(r.ranks[1]!.id,   "scalper");
    assert.equal(r.ranks[1]!.rank, 1,          "scalper is rank 1 despite being index 1");
  });
});

describe("computeRanks — exact equity tie, all criteria equal", () => {
  it("4 bots with identical equity and identical tie-breakers → is_global_tie=true, all rank:null", () => {
    const bots: BotRankInput[] = [
      { id: "momentum",     total_equity: 250.000, did_trade: false, deployment_pct: 0, session_eligible: false },
      { id: "dip_buyer",   total_equity: 250.000, did_trade: false, deployment_pct: 0, session_eligible: false },
      { id: "conservative",total_equity: 250.000, did_trade: false, deployment_pct: 0, session_eligible: false },
      { id: "scalper",     total_equity: 250.000, did_trade: false, deployment_pct: 0, session_eligible: false },
    ];
    const r = computeRanks(bots, { snapshotId: "snap_exact_tie", raceReady: true });
    assert.equal(r.is_global_tie, true, "completely equal bots → global tie");
    assert.ok(r.tie_break_reason !== null, "tie_break_reason explains the tie");
    for (const rank of r.ranks) {
      assert.equal(rank.rank,       null,  `${rank.id} rank should be null`);
      assert.equal(rank.rank_label, "TIE", `${rank.id} label should be TIE`);
      assert.equal(rank.is_tied,    true);
    }
  });
});

describe("computeRanks — within-$0.01 epsilon tie, tie-breakers resolve it", () => {
  it("bots within $0.01 but one traded → trader wins, no global tie", () => {
    const bots: BotRankInput[] = [
      { id: "momentum", total_equity: 250.000, did_trade: true,  deployment_pct: 40, session_eligible: true },
      { id: "scalper",  total_equity: 250.005, did_trade: false, deployment_pct: 0,  session_eligible: true },
    ];
    const r = computeRanks(bots, { snapshotId: "snap_epsilon_resolve", raceReady: true, epsilon: 0.01 });
    assert.equal(r.is_global_tie, false, "tie-breaker separates them");
    assert.ok(r.tie_break_reason !== null, "tie-break was applied");
    const byId = new Map(r.ranks.map((x) => [x.id, x]));
    assert.equal(byId.get("momentum")!.rank, 1, "traded bot wins despite marginally lower equity");
    assert.equal(byId.get("scalper")!.rank,  2);
  });

  it("bots within $0.01, neither traded, both session-eligible → true tie (only id differs)", () => {
    const bots: BotRankInput[] = [
      { id: "alpha", total_equity: 250.000, did_trade: false, deployment_pct: 0, session_eligible: true },
      { id: "beta",  total_equity: 250.005, did_trade: false, deployment_pct: 0, session_eligible: true },
    ];
    const r = computeRanks(bots, { snapshotId: "snap_epsilon_true_tie", raceReady: true, epsilon: 0.01 });
    assert.equal(r.is_global_tie, true, "only id differs → global tie");
    const byId = new Map(r.ranks.map((x) => [x.id, x]));
    assert.equal(byId.get("alpha")!.rank, null);
    assert.equal(byId.get("beta")!.rank,  null);
  });
});

describe("computeRanks — bot with historical trade, current cycle NO_ACTION", () => {
  it("did_trade=true (any past cycle) beats did_trade=false at equal equity", () => {
    // A bot that traded in cycle 1 and held in cycle 2 still has did_trade=true
    // (tradesCount > 0). It must outrank a bot that has never traded.
    const bots: BotRankInput[] = [
      { id: "scalper",  total_equity: 250.00, did_trade: true,  deployment_pct: 25, session_eligible: true },
      { id: "momentum", total_equity: 250.00, did_trade: false, deployment_pct: 0,  session_eligible: true },
    ];
    const r = computeRanks(bots, { snapshotId: "snap_hist_trade", raceReady: true });
    assert.equal(r.is_global_tie, false, "historical trade breaks the tie");
    const byId = new Map(r.ranks.map((x) => [x.id, x]));
    assert.equal(byId.get("scalper")!.rank,  1, "previously-traded bot wins");
    assert.equal(byId.get("momentum")!.rank, 2);
    assert.equal(byId.get("scalper")!.did_trade,  true);
    assert.equal(byId.get("momentum")!.did_trade, false);
    assert.ok(
      byId.get("scalper")!.comparison_reason.includes("traded"),
      "winner reason mentions traded"
    );
    assert.ok(
      byId.get("momentum")!.comparison_reason.includes("no action"),
      "loser reason mentions no action"
    );
  });

  it("two bots that both historically traded but hold in current cycle → deployment_pct breaks tie", () => {
    const bots: BotRankInput[] = [
      { id: "scalper",  total_equity: 250.00, did_trade: true, deployment_pct: 60, session_eligible: true },
      { id: "momentum", total_equity: 250.00, did_trade: true, deployment_pct: 20, session_eligible: true },
    ];
    const r = computeRanks(bots, { snapshotId: "snap_hist_deploy", raceReady: true });
    assert.equal(r.is_global_tie, false);
    const byId = new Map(r.ranks.map((x) => [x.id, x]));
    assert.equal(byId.get("scalper")!.rank,  1, "higher deployment wins");
    assert.equal(byId.get("momentum")!.rank, 2);
  });
});

// ─── 12. Performance gateway — zero P&L defers comparison ────────────────────
// Scenario: First cycle complete; scalper deployed capital but no mark-to-market
// movement has occurred yet, so realized_pnl=0 and unrealized_pnl=0 for every bot.
// With requirePerformanceData=true the comparison MUST be deferred — no winner
// should be declared based solely on did_trade or deployment_pct.

describe("computeRanks — performance gateway: zero P&L defers comparison", () => {
  const firstCycleBots: BotRankInput[] = [
    { id: "momentum",     total_equity: 250.00, did_trade: false, session_eligible: true,  realized_pnl: 0, unrealized_pnl: 0 },
    { id: "dip_buyer",   total_equity: 250.00, did_trade: false, session_eligible: true,  realized_pnl: 0, unrealized_pnl: 0 },
    { id: "conservative",total_equity: 250.00, did_trade: false, session_eligible: false, realized_pnl: 0, unrealized_pnl: 0 },
    { id: "scalper",     total_equity: 250.00, did_trade: true,  session_eligible: true,  realized_pnl: 0, unrealized_pnl: 0, deployment_pct: 32.0, capital_deployed: 80.00 },
  ];

  it("comparison_deferred=true when no eligible bot has non-zero P&L", () => {
    const r = computeRanks(firstCycleBots, { snapshotId: "snap_zero_pnl", raceReady: true, requirePerformanceData: true, excludeIneligible: true });
    assert.equal(r.comparison_deferred, true);
    assert.ok(r.deferred_reason !== null, "deferred_reason should be set");
    assert.equal(r.is_global_tie, false, "not a global tie — no comparison was made");
  });

  it("all eligible bots receive rank_label AWAITING and rank=null", () => {
    const r = computeRanks(firstCycleBots, { snapshotId: "snap_zero_pnl", raceReady: true, requirePerformanceData: true, excludeIneligible: true });
    const byId = new Map(r.ranks.map((x) => [x.id, x]));
    for (const id of ["momentum", "dip_buyer", "scalper"]) {
      assert.equal(byId.get(id)!.rank_label, "AWAITING", `${id} should be AWAITING`);
      assert.equal(byId.get(id)!.rank, null);
      assert.equal(byId.get(id)!.comparison_deferred, true);
      assert.equal(byId.get(id)!.excluded_from_ranking, false);
    }
  });

  it("ineligible bot gets EXCLUDED (not AWAITING) during deferred comparison", () => {
    const r = computeRanks(firstCycleBots, { snapshotId: "snap_zero_pnl", raceReady: true, requirePerformanceData: true, excludeIneligible: true });
    const byId = new Map(r.ranks.map((x) => [x.id, x]));
    assert.equal(byId.get("conservative")!.rank_label,           "EXCLUDED");
    assert.equal(byId.get("conservative")!.excluded_from_ranking, true);
    assert.equal(byId.get("conservative")!.comparison_deferred,   false);
  });

  it("scalper does NOT win despite did_trade=true and deployment_pct=32 when P&L is zero", () => {
    const r = computeRanks(firstCycleBots, { snapshotId: "snap_zero_pnl", raceReady: true, requirePerformanceData: true, excludeIneligible: true });
    const byId = new Map(r.ranks.map((x) => [x.id, x]));
    assert.equal(byId.get("scalper")!.rank, null,  "scalper must NOT be declared rank 1");
    assert.notEqual(byId.get("scalper")!.rank_label, "#1");
  });

  it("sub-epsilon P&L (< $0.01) is still treated as zero — comparison still deferred", () => {
    const subEpsilonBots = firstCycleBots.map((b) =>
      b.id === "scalper" ? { ...b, unrealized_pnl: 0.005 } : b
    );
    const r = computeRanks(subEpsilonBots, { snapshotId: "snap_subeps", raceReady: true, requirePerformanceData: true, excludeIneligible: true });
    assert.equal(r.comparison_deferred, true, "sub-epsilon PnL ($0.005) must not unlock comparison");
  });

  it("gateway is bypassed when requirePerformanceData=false (backward compat)", () => {
    const r = computeRanks(firstCycleBots, { snapshotId: "snap_compat", raceReady: true });
    assert.equal(r.comparison_deferred, false, "gateway disabled → normal ranking");
    assert.ok(r.ranks.some((x) => x.rank !== null), "at least one bot should have a real rank");
  });
});

// ─── 13. Performance gateway — real MtM P&L unlocks comparison ───────────────
// Scenario: After mark-to-market, scalper has an unrealized gain from a crypto
// position that moved in its favour. comparison_deferred must be false and ranks
// must reflect actual equity order.

describe("computeRanks — performance gateway: real MtM P&L unlocks comparison", () => {
  const mtmBots: BotRankInput[] = [
    { id: "momentum",     total_equity: 250.00, did_trade: false, session_eligible: true,  realized_pnl: 0,    unrealized_pnl: 0    },
    { id: "dip_buyer",   total_equity: 250.00, did_trade: false, session_eligible: true,  realized_pnl: 0,    unrealized_pnl: 0    },
    { id: "conservative",total_equity: 250.00, did_trade: false, session_eligible: false, realized_pnl: 0,    unrealized_pnl: 0    },
    { id: "scalper",     total_equity: 252.47, did_trade: true,  session_eligible: true,  realized_pnl: 0,    unrealized_pnl: 2.47, deployment_pct: 40.0, capital_deployed: 100.00 },
  ];

  it("comparison_deferred=false when at least one eligible bot has non-zero unrealized P&L", () => {
    const r = computeRanks(mtmBots, { snapshotId: "snap_mtm", raceReady: true, requirePerformanceData: true, excludeIneligible: true });
    assert.equal(r.comparison_deferred, false);
    assert.equal(r.deferred_reason, null);
  });

  it("scalper (highest equity + unrealized PnL) is rank 1 among eligible bots", () => {
    const r = computeRanks(mtmBots, { snapshotId: "snap_mtm", raceReady: true, requirePerformanceData: true, excludeIneligible: true });
    const byId = new Map(r.ranks.map((x) => [x.id, x]));
    assert.equal(byId.get("scalper")!.rank,       1);
    assert.equal(byId.get("scalper")!.rank_label, "#1");
    assert.equal(byId.get("scalper")!.comparison_deferred,   false);
    assert.equal(byId.get("scalper")!.excluded_from_ranking, false);
  });

  it("conservative is EXCLUDED even though it holds equal cash equity as the tied pair", () => {
    const r = computeRanks(mtmBots, { snapshotId: "snap_mtm", raceReady: true, requirePerformanceData: true, excludeIneligible: true });
    const byId = new Map(r.ranks.map((x) => [x.id, x]));
    assert.equal(byId.get("conservative")!.rank_label,           "EXCLUDED");
    assert.equal(byId.get("conservative")!.excluded_from_ranking, true);
    assert.equal(byId.get("conservative")!.rank,                 null);
  });

  it("momentum and dip_buyer at equal cash equity are meaningfully tied (no did_trade difference)", () => {
    const r = computeRanks(mtmBots, { snapshotId: "snap_mtm", raceReady: true, requirePerformanceData: true, excludeIneligible: true });
    const byId = new Map(r.ranks.map((x) => [x.id, x]));
    assert.equal(byId.get("momentum")!.is_tied,    true);
    assert.equal(byId.get("dip_buyer")!.is_tied,   true);
    assert.equal(byId.get("momentum")!.rank_label,  "TIE");
    assert.equal(byId.get("dip_buyer")!.rank_label, "TIE");
    assert.equal(byId.get("momentum")!.rank,  null, "tied → rank null");
    assert.equal(byId.get("dip_buyer")!.rank, null, "tied → rank null");
  });

  it("is_global_tie=false — scalper clearly leads the eligible field", () => {
    const r = computeRanks(mtmBots, { snapshotId: "snap_mtm", raceReady: true, requirePerformanceData: true, excludeIneligible: true });
    assert.equal(r.is_global_tie, false);
  });

  it("P&L of exactly $0.01 (= epsilon) is still treated as noise — comparison stays deferred", () => {
    const exactEpsBots: BotRankInput[] = [
      { id: "scalper", total_equity: 250.01, did_trade: true, session_eligible: true, realized_pnl: 0, unrealized_pnl: 0.01 },
      { id: "momentum",total_equity: 250.00, did_trade: false,session_eligible: true, realized_pnl: 0, unrealized_pnl: 0    },
    ];
    const r = computeRanks(exactEpsBots, { snapshotId: "snap_exact_eps", raceReady: true, requirePerformanceData: true });
    assert.equal(r.comparison_deferred, true, "$0.01 is at the epsilon boundary — still within noise, deferred");
  });

  it("P&L just above epsilon ($0.011) unlocks comparison", () => {
    const aboveEpsBots: BotRankInput[] = [
      { id: "scalper", total_equity: 250.011, did_trade: true, session_eligible: true, realized_pnl: 0, unrealized_pnl: 0.011 },
      { id: "momentum",total_equity: 250.00,  did_trade: false,session_eligible: true, realized_pnl: 0, unrealized_pnl: 0     },
    ];
    const r = computeRanks(aboveEpsBots, { snapshotId: "snap_above_eps", raceReady: true, requirePerformanceData: true });
    assert.equal(r.comparison_deferred, false, "$0.011 > epsilon ($0.01) — comparison should proceed");
    assert.equal(r.ranks.find((x) => x.id === "scalper")!.rank, 1);
  });
});

// ─── 14. Session-ineligible exclusion with excludeIneligible=true ─────────────
// Scenario: Equity market closed; conservative (equity-only) is session-ineligible.
// Crypto-capable bots traded and have realized gains. Conservative should be EXCLUDED
// from the ranking; eligible bots are ranked 1–3 among themselves.

describe("computeRanks — session-ineligible exclusion (excludeIneligible=true)", () => {
  const mixedEligibility: BotRankInput[] = [
    { id: "scalper",     total_equity: 258.30, did_trade: true,  session_eligible: true,  realized_pnl: 8.30,  unrealized_pnl: 0, deployment_pct: 0, capital_deployed: 0 },
    { id: "momentum",    total_equity: 251.15, did_trade: true,  session_eligible: true,  realized_pnl: 1.15,  unrealized_pnl: 0, deployment_pct: 0, capital_deployed: 0 },
    { id: "dip_buyer",  total_equity: 249.40, did_trade: true,  session_eligible: true,  realized_pnl: -0.60, unrealized_pnl: 0, deployment_pct: 0, capital_deployed: 0 },
    { id: "conservative",total_equity: 250.00, did_trade: false, session_eligible: false, realized_pnl: 0,     unrealized_pnl: 0, deployment_pct: 0, capital_deployed: 0 },
  ];

  it("conservative receives EXCLUDED label and excluded_from_ranking=true", () => {
    const r = computeRanks(mixedEligibility, { snapshotId: "snap_excl", raceReady: true, requirePerformanceData: true, excludeIneligible: true });
    const byId = new Map(r.ranks.map((x) => [x.id, x]));
    assert.equal(byId.get("conservative")!.rank_label,           "EXCLUDED");
    assert.equal(byId.get("conservative")!.excluded_from_ranking, true);
    assert.equal(byId.get("conservative")!.rank,                 null);
    assert.equal(byId.get("conservative")!.comparison_deferred,  false);
  });

  it("scalper (rank 1) wins based purely on eligible-bot equity comparison", () => {
    const r = computeRanks(mixedEligibility, { snapshotId: "snap_excl", raceReady: true, requirePerformanceData: true, excludeIneligible: true });
    const byId = new Map(r.ranks.map((x) => [x.id, x]));
    assert.equal(byId.get("scalper")!.rank,       1);
    assert.equal(byId.get("scalper")!.rank_label, "#1");
  });

  it("eligible bots are ranked 1–3 consecutively without conservative disrupting the sequence", () => {
    const r = computeRanks(mixedEligibility, { snapshotId: "snap_excl", raceReady: true, requirePerformanceData: true, excludeIneligible: true });
    const byId = new Map(r.ranks.map((x) => [x.id, x]));
    assert.equal(byId.get("scalper")!.rank,   1, "scalper: highest equity among eligible");
    assert.equal(byId.get("momentum")!.rank,  2, "momentum: second among eligible");
    assert.equal(byId.get("dip_buyer")!.rank, 3, "dip_buyer: third among eligible");
  });

  it("is_global_tie=false and comparison_deferred=false — clear winner in eligible field", () => {
    const r = computeRanks(mixedEligibility, { snapshotId: "snap_excl", raceReady: true, requirePerformanceData: true, excludeIneligible: true });
    assert.equal(r.is_global_tie,       false);
    assert.equal(r.comparison_deferred, false);
  });

  it("conservative higher equity does NOT make it rank 1 when excludeIneligible=true", () => {
    // Even if conservative somehow had $260, it must still be EXCLUDED
    const highEquityConservative = mixedEligibility.map((b) =>
      b.id === "conservative" ? { ...b, total_equity: 260.00 } : b
    );
    const r = computeRanks(highEquityConservative, { snapshotId: "snap_excl_high", raceReady: true, requirePerformanceData: true, excludeIneligible: true });
    const byId = new Map(r.ranks.map((x) => [x.id, x]));
    assert.equal(byId.get("conservative")!.rank_label, "EXCLUDED", "still EXCLUDED regardless of equity");
    assert.equal(byId.get("scalper")!.rank, 1, "scalper still rank 1 among eligible bots");
  });

  it("without excludeIneligible, conservative has a real rank (backward compat)", () => {
    const r = computeRanks(mixedEligibility, { snapshotId: "snap_excl_compat", raceReady: true });
    const byId = new Map(r.ranks.map((x) => [x.id, x]));
    const conservRank = byId.get("conservative")!.rank;
    assert.ok(conservRank !== null, "without excludeIneligible, conservative has a real rank");
    assert.notEqual(byId.get("conservative")!.rank_label, "EXCLUDED");
  });
});

// ─── 15. Mixed-participation race scenario ────────────────────────────────────
// Two idle cash bots ($250, no trades, session eligible),
// one session-ineligible bot ($250, equity-only strategy, market closed),
// one active bot with a losing crypto position ($247.50, did_trade=true).
//
// Expected outcome (trace through computeRanks):
//   Equity groups:
//     Group A: momentum $250, dip_buyer $250, conservative $250   (within $0.01)
//     Group B: scalper $247.50                                     (> $0.01 below Group A)
//   Group A tie-break: momentum (eligible, idle) & dip_buyer (eligible, idle) beat
//                      conservative (ineligible); momentum & dip_buyer are meaningfully tied.
//   Results: momentum=null/TIE, dip_buyer=null/TIE, conservative=rank 3, scalper=rank 4.

describe("computeRanks — mixed-participation race", () => {
  const mixedBots: BotRankInput[] = [
    { id: "momentum",     total_equity: 250.00, did_trade: false, capital_deployed: 0,     deployment_pct: 0,    session_eligible: true  },
    { id: "dip_buyer",   total_equity: 250.00, did_trade: false, capital_deployed: 0,     deployment_pct: 0,    session_eligible: true  },
    { id: "conservative",total_equity: 250.00, did_trade: false, capital_deployed: 0,     deployment_pct: 0,    session_eligible: false },
    { id: "scalper",     total_equity: 247.50, did_trade: true,  capital_deployed: 82.25, deployment_pct: 32.9, session_eligible: true  },
  ];

  it("participation_category is correctly assigned for all four bots", () => {
    const r = computeRanks(mixedBots, { snapshotId: "snap_mixed", raceReady: true });
    const byId = new Map(r.ranks.map((x) => [x.id, x]));
    assert.equal(byId.get("momentum")!.participation_category,     "idle",       "momentum: eligible, no trades → idle");
    assert.equal(byId.get("dip_buyer")!.participation_category,    "idle",       "dip_buyer: eligible, no trades → idle");
    assert.equal(byId.get("conservative")!.participation_category, "ineligible", "conservative: not eligible → ineligible");
    assert.equal(byId.get("scalper")!.participation_category,      "active",     "scalper: did_trade=true → active");
  });

  it("scalper (lowest equity despite trading) is rank 4", () => {
    const r = computeRanks(mixedBots, { snapshotId: "snap_mixed", raceReady: true });
    const byId = new Map(r.ranks.map((x) => [x.id, x]));
    assert.equal(byId.get("scalper")!.rank, 4, "scalper lowest equity → rank 4");
    assert.equal(byId.get("scalper")!.is_tied, false, "scalper alone in its equity tier");
  });

  it("conservative (ineligible) ranks below the idle-but-eligible bots in the same equity tier", () => {
    const r = computeRanks(mixedBots, { snapshotId: "snap_mixed", raceReady: true });
    const byId = new Map(r.ranks.map((x) => [x.id, x]));
    const conservRank = byId.get("conservative")!.rank;
    assert.ok(conservRank !== null && conservRank >= 2,
      `conservative (ineligible) should have a real rank ≥ 2, got ${String(conservRank)}`);
    assert.equal(byId.get("conservative")!.is_tied, false, "conservative separated from eligible bots");
  });

  it("momentum and dip_buyer are meaningfully tied — both idle+eligible, no further tie-breaker", () => {
    const r = computeRanks(mixedBots, { snapshotId: "snap_mixed", raceReady: true });
    const byId = new Map(r.ranks.map((x) => [x.id, x]));
    assert.equal(byId.get("momentum")!.rank,       null, "momentum tied → rank null");
    assert.equal(byId.get("dip_buyer")!.rank,      null, "dip_buyer tied → rank null");
    assert.equal(byId.get("momentum")!.rank_label, "TIE");
    assert.equal(byId.get("dip_buyer")!.rank_label,"TIE");
    assert.equal(byId.get("momentum")!.is_tied,    true);
    assert.equal(byId.get("dip_buyer")!.is_tied,   true);
  });

  it("race is NOT a global tie — conservative (ineligible) separates from idle-eligible group", () => {
    const r = computeRanks(mixedBots, { snapshotId: "snap_mixed", raceReady: true });
    assert.equal(r.is_global_tie, false, "conservative ineligible separates from idle group");
    assert.ok(r.tie_break_reason !== null, "tie-break explanation present");
  });

  it("comparison_reason is semantically consistent with participation_category", () => {
    const r = computeRanks(mixedBots, { snapshotId: "snap_mixed", raceReady: true });
    const byId = new Map(r.ranks.map((x) => [x.id, x]));
    assert.ok(
      byId.get("scalper")!.comparison_reason.includes("traded"),
      `active bot reason should mention 'traded', got: "${byId.get("scalper")!.comparison_reason}"`
    );
    assert.ok(
      byId.get("conservative")!.comparison_reason.includes("unavailable"),
      `ineligible bot reason should mention 'unavailable', got: "${byId.get("conservative")!.comparison_reason}"`
    );
    assert.ok(
      byId.get("momentum")!.comparison_reason.includes("no action"),
      `idle bot reason should mention 'no action', got: "${byId.get("momentum")!.comparison_reason}"`
    );
  });

  it("participation_category is set even when raceReady=false (pre-race state)", () => {
    const r = computeRanks(mixedBots, { snapshotId: "snap_mixed_notready", raceReady: false });
    const byId = new Map(r.ranks.map((x) => [x.id, x]));
    // Categories should still be computed correctly regardless of race readiness
    assert.equal(byId.get("momentum")!.participation_category,     "idle");
    assert.equal(byId.get("conservative")!.participation_category, "ineligible");
    assert.equal(byId.get("scalper")!.participation_category,      "active");
  });
});
