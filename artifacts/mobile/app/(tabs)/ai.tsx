import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import Animated, { FadeInDown, FadeInRight } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import AsyncStorage from "@react-native-async-storage/async-storage";

import { useAI, type ChatMessage } from "@/contexts/AIContext";
import { useAlpaca, type AlpacaOrder, type AlpacaPosition } from "@/contexts/AlpacaContext";
import { useJournal } from "@/contexts/JournalContext";
import { useWatchlist } from "@/contexts/WatchlistContext";
import { useColors } from "@/hooks/useColors";

type Tab = "chat" | "signals" | "coach" | "portfolio" | "autopilot" | "loop";

// ─── Strategy presets ─────────────────────────────────────────────────────────

interface StrategyPreset {
  id: string;
  name: string;
  emoji: string;
  tagline: string;
  color: string;
  rules: string;
}

const STRATEGY_PRESETS: StrategyPreset[] = [
  {
    id: "momentum",
    name: "Momentum Rider",
    emoji: "🚀",
    tagline: "Ride strong upward moves",
    color: "#00D4AA",
    rules: `Momentum Day Trading Strategy:
- Scan for stocks up >+0.8% today with rising volume
- Buy the top 2-3 strongest movers from the watchlist
- Max position size: 25% of budget per stock
- Max 4 concurrent positions
- Stop loss: -2.5% from entry price
- Take profit: +3% gain (lock it in)
- If most stocks are flat or mixed, stay in cash and wait
- Avoid buying into stocks already up >3% (chasing)`,
  },
  {
    id: "mean_reversion",
    name: "Dip Buyer",
    emoji: "📉",
    tagline: "Buy dips, sell the bounce",
    color: "#A78BFA",
    rules: `Mean Reversion Strategy:
- Look for stocks down >-1.5% today that are fundamentally strong
- These dips are likely to bounce — buy them
- Max position size: 20% of budget per stock
- Max 3 concurrent positions
- Stop loss: -3.5% (give it room to bounce)
- Take profit: +1.5% (quick bounce, take it)
- Avoid stocks in freefall (down >-5%) — those may keep falling
- Prefer stocks that were up yesterday and dipped today`,
  },
  {
    id: "conservative",
    name: "Conservative",
    emoji: "🛡️",
    tagline: "Low risk, steady approach",
    color: "#60A5FA",
    rules: `Conservative Trading Strategy:
- Only trade highly liquid large-cap stocks (AAPL, MSFT, GOOGL, AMZN, NVDA, TSLA)
- Only enter when the stock is between -0.3% and +1% for the day (stable conditions)
- Tiny position sizes: max 15% of budget per stock
- Max 3 concurrent positions
- Very tight stop loss: -1.5%
- Take profit: +1.8%
- When uncertain, stay in cash — capital preservation is priority
- Never trade in the first 30 minutes of market open (volatile)`,
  },
  {
    id: "scalper",
    name: "Aggressive Scalper",
    emoji: "⚡",
    tagline: "Fast trades, small gains",
    color: "#FF8C42",
    rules: `Aggressive Scalping Strategy:
- Make frequent small trades to capture quick 1-2% moves
- Buy any stock showing upward momentum >+0.3% in the last scan
- Max position size: 30% of budget (go bigger, move faster)
- Max 3 concurrent positions — rotate frequently
- Stop loss: -1% (cut fast, no exceptions)
- Take profit: +1.5% (small wins add up)
- If a position isn't moving after 2 scans, close it and find a better one
- Prioritize high-volume stocks — liquidity is essential for fast exits`,
  },
  {
    id: "custom",
    name: "Custom Strategy",
    emoji: "✏️",
    tagline: "Write your own rules",
    color: "#9B9EA3",
    rules: "",
  },
];

const QUICK_PROMPTS = [
  "What's in my portfolio right now?",
  "Buy 1 share of AAPL for me",
  "What are my open positions?",
  "How much of my budget is left?",
  "Sell all my TSLA shares",
];

function buildSystemPrompt(budget: number, budgetDeployed: number, budgetRemaining: number) {
  return `You are a knowledgeable trading assistant integrated into a paper trading app powered by Alpaca. You help users with:
- Market analysis and commentary
- Technical analysis concepts
- Trading psychology and risk management
- Explaining financial instruments and indicators
- General trading education
- Executing paper trades on Alpaca (buying/selling stocks with fake money for practice)

You have access to tools to check account info, view positions, view orders, place orders, and cancel orders on the user's Alpaca paper trading account.

BUDGET CONSTRAINT (very important):
- The user is practicing with a simulated budget of $${budget.toFixed(2)}
- Already deployed: $${budgetDeployed.toFixed(2)}
- Remaining budget: $${budgetRemaining.toFixed(2)}
- NEVER place orders that would cause total deployed capital to exceed $${budget.toFixed(2)}
- If a requested trade would exceed the budget, warn the user and suggest a smaller quantity
- Always mention the remaining budget after placing a trade

TRADING RULES:
- Paper trading uses simulated money — no real funds at risk
- For market orders, use time_in_force: "day"
- When the user asks to buy/sell something, use place_order tool to execute it
- After placing an order, summarize what was done and how much budget remains

Be concise, direct, and helpful. Use markdown formatting for clarity.`;
}

function MessageBubble({ msg }: { msg: ChatMessage }) {
  const colors = useColors();
  const isUser = msg.role === "user";

  return (
    <Animated.View
      entering={FadeInDown.delay(50).springify()}
      style={[styles.bubbleWrap, isUser ? styles.bubbleRight : styles.bubbleLeft]}
    >
      {!isUser && (
        <View style={[styles.aiAvatar, { backgroundColor: colors.primary }]}>
          <Feather name="cpu" size={12} color={colors.primaryForeground} />
        </View>
      )}
      <View
        style={[
          styles.bubble,
          isUser
            ? [styles.userBubble, { backgroundColor: colors.primary }]
            : [styles.aiBubble, { backgroundColor: colors.card, borderColor: colors.border }],
        ]}
      >
        <Text
          style={[
            styles.bubbleText,
            { color: isUser ? colors.primaryForeground : colors.foreground },
          ]}
        >
          {msg.content || "▊"}
        </Text>
      </View>
    </Animated.View>
  );
}

function ToolCallIndicator({ toolName }: { toolName: string }) {
  const colors = useColors();
  const labels: Record<string, string> = {
    get_account: "Checking account...",
    get_positions: "Loading positions...",
    get_orders: "Fetching orders...",
    place_order: "Placing order...",
    cancel_order: "Cancelling order...",
  };
  return (
    <View style={[styles.toolCall, { backgroundColor: colors.secondary, borderColor: colors.border }]}>
      <ActivityIndicator size="small" color={colors.primary} />
      <Text style={[styles.toolCallText, { color: colors.mutedForeground }]}>
        {labels[toolName] ?? `Running ${toolName}...`}
      </Text>
    </View>
  );
}

function ChatTab() {
  const colors = useColors();
  const { messages, streaming, sendMessage, clearConversation } = useAI();
  const { budget, budgetDeployed, budgetRemaining } = useAlpaca();
  const [input, setInput] = useState("");
  const [activeToolCall, setActiveToolCall] = useState<string | null>(null);
  const flatRef = useRef<FlatList>(null);
  const insets = useSafeAreaInsets();

  const handleSend = async () => {
    const text = input.trim();
    if (!text || streaming) return;
    setInput("");
    Haptics.selectionAsync();
    await sendMessage(text, buildSystemPrompt(budget, budgetDeployed, budgetRemaining), (toolName) => {
      setActiveToolCall(toolName);
      setTimeout(() => setActiveToolCall(null), 3000);
    });
    flatRef.current?.scrollToEnd({ animated: true });
  };

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      keyboardVerticalOffset={Platform.OS === "web" ? 0 : 90}
    >
      {messages.length === 0 ? (
        <ScrollView
          contentContainerStyle={styles.emptyChat}
          showsVerticalScrollIndicator={false}
        >
          <View style={[styles.aiIcon, { backgroundColor: colors.secondary }]}>
            <Feather name="cpu" size={32} color={colors.primary} />
          </View>
          <Text style={[styles.emptyTitle, { color: colors.foreground }]}>
            AI Trading Agent
          </Text>
          <Text style={[styles.emptySubtitle, { color: colors.mutedForeground }]}>
            Ask questions or give commands — the agent can execute paper trades on your behalf
          </Text>

          <View style={styles.quickPrompts}>
            {QUICK_PROMPTS.map((prompt, i) => (
              <Animated.View key={i} entering={FadeInRight.delay(i * 60).springify()}>
                <TouchableOpacity
                  onPress={() => {
                    setInput(prompt);
                    Haptics.selectionAsync();
                  }}
                  style={[styles.promptChip, { backgroundColor: colors.secondary, borderColor: colors.border }]}
                >
                  <Text style={[styles.promptText, { color: colors.foreground }]}>{prompt}</Text>
                </TouchableOpacity>
              </Animated.View>
            ))}
          </View>
        </ScrollView>
      ) : (
        <FlatList
          ref={flatRef}
          data={messages}
          keyExtractor={(m) => m.id}
          renderItem={({ item }) => <MessageBubble msg={item} />}
          contentContainerStyle={[styles.chatList, { paddingBottom: Platform.OS === "web" ? 84 + 34 : 16 }]}
          onContentSizeChange={() => flatRef.current?.scrollToEnd({ animated: true })}
          showsVerticalScrollIndicator={false}
          ListFooterComponent={activeToolCall ? <ToolCallIndicator toolName={activeToolCall} /> : null}
        />
      )}

      <View style={[styles.inputBar, { backgroundColor: colors.background, borderTopColor: colors.border, paddingBottom: Platform.OS === "web" ? 20 : insets.bottom + 8 }]}>
        {messages.length > 0 && (
          <TouchableOpacity onPress={clearConversation} hitSlop={8} style={styles.clearBtn}>
            <Feather name="refresh-ccw" size={16} color={colors.mutedForeground} />
          </TouchableOpacity>
        )}
        <View style={[styles.inputWrap, { backgroundColor: colors.secondary, borderColor: colors.border }]}>
          <TextInput
            style={[styles.input, { color: colors.foreground }]}
            value={input}
            onChangeText={setInput}
            placeholder="Ask or command the AI agent..."
            placeholderTextColor={colors.mutedForeground}
            multiline
            maxLength={1000}
            returnKeyType="send"
            onSubmitEditing={handleSend}
          />
          <Pressable
            onPress={handleSend}
            disabled={!input.trim() || streaming}
            style={[
              styles.sendBtn,
              { backgroundColor: input.trim() && !streaming ? colors.primary : colors.secondary },
            ]}
          >
            {streaming ? (
              <ActivityIndicator size="small" color={colors.primary} />
            ) : (
              <Feather
                name="send"
                size={16}
                color={input.trim() ? colors.primaryForeground : colors.mutedForeground}
              />
            )}
          </Pressable>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

function SignalsTab() {
  const colors = useColors();
  const { symbols, prices } = useWatchlist();
  const { analyzeWatchlist } = useAI();
  const [analysis, setAnalysis] = useState("");
  const [loading, setLoading] = useState(false);

  const handleAnalyze = async () => {
    if (loading || symbols.length === 0) return;
    setAnalysis("");
    setLoading(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      const priceMap = Object.fromEntries(
        symbols.map((s) => {
          const q = prices[s];
          return [s, {
            price: q?.regularMarketPrice ?? 0,
            change: q?.regularMarketChange ?? 0,
            changePercent: q?.regularMarketChangePercent ?? 0,
            name: q?.shortName ?? s,
          }];
        })
      );
      await analyzeWatchlist(symbols, priceMap, (chunk) => {
        setAnalysis((prev) => prev + chunk);
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <ScrollView
      contentContainerStyle={[styles.tabContent, { paddingBottom: Platform.OS === "web" ? 84 + 34 : 100 }]}
      showsVerticalScrollIndicator={false}
    >
      <View style={[styles.signalsHeader, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <View style={styles.signalsHeaderLeft}>
          <Text style={[styles.signalsTitle, { color: colors.foreground }]}>Watchlist Signals</Text>
          <Text style={[styles.signalsSubtitle, { color: colors.mutedForeground }]}>
            AI analysis of {symbols.length} symbols
          </Text>
        </View>
        <TouchableOpacity
          onPress={handleAnalyze}
          disabled={loading || symbols.length === 0}
          style={[styles.analyzeBtn, { backgroundColor: loading ? colors.secondary : colors.primary }]}
        >
          {loading ? (
            <ActivityIndicator size="small" color={colors.primary} />
          ) : (
            <Text style={[styles.analyzeBtnText, { color: colors.primaryForeground }]}>Analyze</Text>
          )}
        </TouchableOpacity>
      </View>

      {!analysis && !loading && (
        <View style={styles.signalsEmpty}>
          <View style={[styles.aiIcon, { backgroundColor: colors.secondary }]}>
            <Feather name="zap" size={28} color={colors.primary} />
          </View>
          <Text style={[styles.emptyTitle, { color: colors.foreground }]}>Get Smart Signals</Text>
          <Text style={[styles.emptySubtitle, { color: colors.mutedForeground }]}>
            Tap Analyze to get AI-powered trading signals for every symbol in your watchlist
          </Text>
        </View>
      )}

      {(analysis || loading) && (
        <Animated.View
          entering={FadeInDown.springify()}
          style={[styles.analysisCard, { backgroundColor: colors.card, borderColor: colors.border }]}
        >
          <Text style={[styles.analysisText, { color: colors.foreground }]}>
            {analysis || ""}
            {loading && <Text style={{ color: colors.primary }}>▊</Text>}
          </Text>
        </Animated.View>
      )}
    </ScrollView>
  );
}

function CoachTab() {
  const colors = useColors();
  const { entries } = useJournal();
  const { reviewJournal } = useAI();
  const [review, setReview] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const handleReview = async () => {
    if (loading || entries.length === 0) return;
    setReview("");
    setLoading(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      await reviewJournal(entries, (chunk) => {
        setReview((prev) => prev + chunk);
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <ScrollView
      contentContainerStyle={[styles.tabContent, { paddingBottom: Platform.OS === "web" ? 84 + 34 : 100 }]}
      showsVerticalScrollIndicator={false}
    >
      <View style={[styles.signalsHeader, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <View style={styles.signalsHeaderLeft}>
          <Text style={[styles.signalsTitle, { color: colors.foreground }]}>Journal Coach</Text>
          <Text style={[styles.signalsSubtitle, { color: colors.mutedForeground }]}>
            {entries.length} trades logged
          </Text>
        </View>
        <TouchableOpacity
          onPress={handleReview}
          disabled={loading || entries.length === 0}
          style={[styles.analyzeBtn, { backgroundColor: loading || entries.length === 0 ? colors.secondary : colors.primary }]}
        >
          {loading ? (
            <ActivityIndicator size="small" color={colors.primary} />
          ) : (
            <Text style={[styles.analyzeBtnText, { color: entries.length === 0 ? colors.mutedForeground : colors.primaryForeground }]}>
              Review
            </Text>
          )}
        </TouchableOpacity>
      </View>

      {entries.length === 0 && (
        <View style={styles.signalsEmpty}>
          <View style={[styles.aiIcon, { backgroundColor: colors.secondary }]}>
            <Feather name="book-open" size={28} color={colors.primary} />
          </View>
          <Text style={[styles.emptyTitle, { color: colors.foreground }]}>No Trades Yet</Text>
          <Text style={[styles.emptySubtitle, { color: colors.mutedForeground }]}>
            Log trades in your Journal first, then come back for AI coaching
          </Text>
          <TouchableOpacity
            onPress={() => router.push("/(tabs)/journal")}
            style={[styles.analyzeBtn, { backgroundColor: colors.primary, marginTop: 16 }]}
          >
            <Text style={[styles.analyzeBtnText, { color: colors.primaryForeground }]}>Go to Journal</Text>
          </TouchableOpacity>
        </View>
      )}

      {!review && !loading && entries.length > 0 && (
        <View style={styles.signalsEmpty}>
          <View style={[styles.aiIcon, { backgroundColor: colors.secondary }]}>
            <Feather name="trending-up" size={28} color={colors.primary} />
          </View>
          <Text style={[styles.emptyTitle, { color: colors.foreground }]}>Ready to Coach</Text>
          <Text style={[styles.emptySubtitle, { color: colors.mutedForeground }]}>
            Tap Review to get personalized feedback on your trading patterns
          </Text>
        </View>
      )}

      {(review || loading) && (
        <Animated.View
          entering={FadeInDown.springify()}
          style={[styles.analysisCard, { backgroundColor: colors.card, borderColor: colors.border }]}
        >
          <Text style={[styles.analysisText, { color: colors.foreground }]}>
            {review || ""}
            {loading && <Text style={{ color: colors.primary }}>▊</Text>}
          </Text>
        </Animated.View>
      )}
    </ScrollView>
  );
}

function PositionRow({ position, onTrade }: { position: AlpacaPosition; onTrade: (symbol: string, side: "buy" | "sell") => void }) {
  const colors = useColors();
  const pl = parseFloat(position.unrealized_pl);
  const plPct = parseFloat(position.unrealized_plpc) * 100;
  const isPositive = pl >= 0;

  return (
    <View style={[styles.positionRow, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <View style={[styles.positionAvatar, { backgroundColor: colors.secondary }]}>
        <Text style={[styles.positionAvatarText, { color: colors.primary }]}>
          {position.symbol.slice(0, 2)}
        </Text>
      </View>
      <View style={styles.positionInfo}>
        <Text style={[styles.positionSymbol, { color: colors.foreground }]}>{position.symbol}</Text>
        <Text style={[styles.positionMeta, { color: colors.mutedForeground }]}>
          {position.qty} shares · avg ${parseFloat(position.avg_entry_price).toFixed(2)}
        </Text>
      </View>
      <View style={styles.positionRight}>
        <Text style={[styles.positionValue, { color: colors.foreground }]}>
          ${parseFloat(position.market_value).toFixed(2)}
        </Text>
        <Text style={[styles.positionPl, { color: isPositive ? "#00D4AA" : "#FF4757" }]}>
          {isPositive ? "+" : ""}${pl.toFixed(2)} ({isPositive ? "+" : ""}{plPct.toFixed(2)}%)
        </Text>
      </View>
      <View style={styles.positionActions}>
        <TouchableOpacity
          onPress={() => onTrade(position.symbol, "buy")}
          style={[styles.tradeBtn, { backgroundColor: "#00D4AA22" }]}
        >
          <Text style={[styles.tradeBtnText, { color: "#00D4AA" }]}>B</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => onTrade(position.symbol, "sell")}
          style={[styles.tradeBtn, { backgroundColor: "#FF475722" }]}
        >
          <Text style={[styles.tradeBtnText, { color: "#FF4757" }]}>S</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

function OrderRow({ order, onCancel }: { order: AlpacaOrder; onCancel: (id: string) => void }) {
  const colors = useColors();
  const isBuy = order.side === "buy";
  const statusColor =
    order.status === "filled" ? "#00D4AA" :
    order.status === "canceled" ? colors.mutedForeground :
    order.status === "partially_filled" ? "#FFB347" :
    colors.foreground;

  return (
    <View style={[styles.orderRow, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <View style={[styles.orderSideBadge, { backgroundColor: isBuy ? "#00D4AA22" : "#FF475722" }]}>
        <Text style={[styles.orderSideText, { color: isBuy ? "#00D4AA" : "#FF4757" }]}>
          {order.side.toUpperCase()}
        </Text>
      </View>
      <View style={styles.orderInfo}>
        <Text style={[styles.orderSymbol, { color: colors.foreground }]}>
          {order.symbol} · {order.type}
        </Text>
        <Text style={[styles.orderMeta, { color: colors.mutedForeground }]}>
          {order.qty ? `${order.qty} shares` : order.notional ? `$${order.notional}` : ""}
          {order.filled_avg_price ? ` @ $${parseFloat(order.filled_avg_price).toFixed(2)}` : ""}
        </Text>
      </View>
      <View style={styles.orderRight}>
        <Text style={[styles.orderStatus, { color: statusColor }]}>
          {order.status}
        </Text>
        {order.status === "new" || order.status === "accepted" || order.status === "pending_new" ? (
          <TouchableOpacity onPress={() => onCancel(order.id)} hitSlop={8}>
            <Feather name="x" size={14} color={colors.mutedForeground} />
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  );
}

function TradeModal({
  visible,
  symbol,
  side,
  onClose,
  onSubmit,
}: {
  visible: boolean;
  symbol: string;
  side: "buy" | "sell";
  onClose: () => void;
  onSubmit: (qty: number, type: "market" | "limit", limitPrice?: number) => void;
}) {
  const colors = useColors();
  const [qty, setQty] = useState("1");
  const [orderType, setOrderType] = useState<"market" | "limit">("market");
  const [limitPrice, setLimitPrice] = useState("");
  const isBuy = side === "buy";

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        <View style={[styles.modalCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={styles.modalHeader}>
            <Text style={[styles.modalTitle, { color: colors.foreground }]}>
              {isBuy ? "Buy" : "Sell"} {symbol}
            </Text>
            <TouchableOpacity onPress={onClose}>
              <Feather name="x" size={20} color={colors.mutedForeground} />
            </TouchableOpacity>
          </View>

          <View style={styles.modalField}>
            <Text style={[styles.modalLabel, { color: colors.mutedForeground }]}>Shares</Text>
            <TextInput
              style={[styles.modalInput, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.secondary }]}
              value={qty}
              onChangeText={setQty}
              keyboardType="decimal-pad"
              placeholder="1"
              placeholderTextColor={colors.mutedForeground}
            />
          </View>

          <View style={styles.modalField}>
            <Text style={[styles.modalLabel, { color: colors.mutedForeground }]}>Order Type</Text>
            <View style={styles.orderTypeRow}>
              {(["market", "limit"] as const).map((t) => (
                <TouchableOpacity
                  key={t}
                  onPress={() => setOrderType(t)}
                  style={[
                    styles.orderTypeBtn,
                    { borderColor: colors.border, backgroundColor: orderType === t ? colors.primary : colors.secondary },
                  ]}
                >
                  <Text style={[styles.orderTypeBtnText, { color: orderType === t ? colors.primaryForeground : colors.mutedForeground }]}>
                    {t.charAt(0).toUpperCase() + t.slice(1)}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          {orderType === "limit" && (
            <View style={styles.modalField}>
              <Text style={[styles.modalLabel, { color: colors.mutedForeground }]}>Limit Price</Text>
              <TextInput
                style={[styles.modalInput, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.secondary }]}
                value={limitPrice}
                onChangeText={setLimitPrice}
                keyboardType="decimal-pad"
                placeholder="0.00"
                placeholderTextColor={colors.mutedForeground}
              />
            </View>
          )}

          <View style={[styles.paperBadge, { backgroundColor: colors.secondary }]}>
            <Feather name="shield" size={12} color={colors.mutedForeground} />
            <Text style={[styles.paperBadgeText, { color: colors.mutedForeground }]}>
              Paper trading — no real money
            </Text>
          </View>

          <TouchableOpacity
            onPress={() => {
              const q = parseFloat(qty);
              if (!q || q <= 0) return;
              onSubmit(q, orderType, orderType === "limit" ? parseFloat(limitPrice) : undefined);
            }}
            style={[styles.submitBtn, { backgroundColor: isBuy ? "#00D4AA" : "#FF4757" }]}
          >
            <Text style={styles.submitBtnText}>
              {isBuy ? "Place Buy Order" : "Place Sell Order"}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

function PortfolioTab() {
  const colors = useColors();
  const {
    account, positions, orders, error,
    budget, setBudget, budgetDeployed, budgetRemaining, budgetPnl,
    fetchAccount, fetchPositions, fetchOrders, placeOrder, cancelOrder,
  } = useAlpaca();
  const [refreshing, setRefreshing] = useState(false);
  const [tradeModal, setTradeModal] = useState<{ symbol: string; side: "buy" | "sell" } | null>(null);
  const [view, setView] = useState<"positions" | "orders">("positions");
  const [editingBudget, setEditingBudget] = useState(false);
  const [budgetInput, setBudgetInput] = useState(String(budget));

  useEffect(() => {
    void fetchAccount();
    void fetchPositions();
    void fetchOrders();
  }, []);

  const handleRefresh = async () => {
    setRefreshing(true);
    await Promise.all([fetchAccount(), fetchPositions(), fetchOrders()]);
    setRefreshing(false);
  };

  const handleTrade = (symbol: string, side: "buy" | "sell") => {
    setTradeModal({ symbol, side });
  };

  const handleSubmitOrder = async (qty: number, type: "market" | "limit", limitPrice?: number) => {
    if (!tradeModal) return;
    setTradeModal(null);
    try {
      const order = await placeOrder({
        symbol: tradeModal.symbol,
        qty,
        side: tradeModal.side,
        type,
        time_in_force: "day",
        limit_price: limitPrice,
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert(
        "Order Placed",
        `${tradeModal.side.toUpperCase()} ${qty} ${tradeModal.symbol} — ${type} order submitted (ID: ${order.id.slice(0, 8)}...)`,
        [{ text: "OK" }]
      );
    } catch (err) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert("Order Failed", String(err));
    }
  };

  const handleCancel = async (id: string) => {
    Alert.alert("Cancel Order", "Are you sure you want to cancel this order?", [
      { text: "No", style: "cancel" },
      {
        text: "Cancel Order",
        style: "destructive",
        onPress: async () => {
          await cancelOrder(id);
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        },
      },
    ]);
  };

  const handleSaveBudget = async () => {
    const val = parseFloat(budgetInput);
    if (!val || val <= 0) return;
    await setBudget(val);
    setEditingBudget(false);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  const deployedPct = budget > 0 ? Math.min(100, (budgetDeployed / budget) * 100) : 0;
  const isPnlUp = budgetPnl >= 0;
  const currentValue = budgetDeployed + budgetPnl;

  return (
    <ScrollView
      contentContainerStyle={[styles.tabContent, { paddingBottom: Platform.OS === "web" ? 84 + 34 : 100 }]}
      showsVerticalScrollIndicator={false}
    >
      {error && (
        <View style={[styles.errorBanner, { backgroundColor: "#FF475722", borderColor: "#FF4757" }]}>
          <Feather name="alert-circle" size={14} color="#FF4757" />
          <Text style={[styles.errorText, { color: "#FF4757" }]}>{error}</Text>
        </View>
      )}

      {/* Budget Card */}
      <Animated.View entering={FadeInDown.springify()} style={[styles.accountCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <View style={styles.accountHeader}>
          <View style={{ flex: 1 }}>
            <Text style={[styles.accountLabel, { color: colors.mutedForeground }]}>Practice Budget</Text>
            {editingBudget ? (
              <View style={styles.budgetEditRow}>
                <Text style={[styles.budgetDollar, { color: colors.foreground }]}>$</Text>
                <TextInput
                  style={[styles.budgetInput, { color: colors.foreground, borderColor: colors.primary }]}
                  value={budgetInput}
                  onChangeText={setBudgetInput}
                  keyboardType="decimal-pad"
                  autoFocus
                  selectTextOnFocus
                />
                <TouchableOpacity onPress={handleSaveBudget} style={[styles.budgetSaveBtn, { backgroundColor: colors.primary }]}>
                  <Text style={[styles.budgetSaveBtnText, { color: colors.primaryForeground }]}>Save</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => setEditingBudget(false)} hitSlop={8}>
                  <Feather name="x" size={16} color={colors.mutedForeground} />
                </TouchableOpacity>
              </View>
            ) : (
              <View style={styles.budgetValueRow}>
                <Text style={[styles.accountValue, { color: colors.foreground }]}>
                  ${budget.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                </Text>
                <TouchableOpacity onPress={() => { setEditingBudget(true); setBudgetInput(String(budget)); }} hitSlop={8}>
                  <Feather name="edit-2" size={14} color={colors.mutedForeground} />
                </TouchableOpacity>
              </View>
            )}
            {!editingBudget && positions.length > 0 && (
              <Text style={[styles.accountPl, { color: isPnlUp ? "#00D4AA" : "#FF4757" }]}>
                {isPnlUp ? "+" : ""}${budgetPnl.toFixed(2)} unrealized P&L
              </Text>
            )}
          </View>
          <TouchableOpacity
            onPress={handleRefresh}
            disabled={refreshing}
            style={[styles.refreshBtn, { backgroundColor: colors.secondary }]}
          >
            <Feather name="refresh-cw" size={16} color={refreshing ? colors.mutedForeground : colors.primary} />
          </TouchableOpacity>
        </View>

        {/* Budget progress bar */}
        <View style={styles.budgetBarSection}>
          <View style={[styles.budgetBarTrack, { backgroundColor: colors.secondary }]}>
            <View
              style={[
                styles.budgetBarFill,
                {
                  width: `${deployedPct}%` as `${number}%`,
                  backgroundColor: deployedPct > 90 ? "#FF4757" : deployedPct > 70 ? "#FFB347" : "#00D4AA",
                },
              ]}
            />
          </View>
          <View style={styles.budgetBarLabels}>
            <Text style={[styles.budgetBarLabel, { color: colors.mutedForeground }]}>
              Deployed: ${budgetDeployed.toFixed(2)}
              {positions.length > 0 ? ` → $${currentValue.toFixed(2)}` : ""}
            </Text>
            <Text style={[styles.budgetBarLabel, { color: budgetRemaining > 0 ? colors.primary : "#FF4757" }]}>
              ${budgetRemaining.toFixed(2)} left
            </Text>
          </View>
        </View>

        <View style={styles.accountStats}>
          <View style={styles.accountStat}>
            <Text style={[styles.accountStatLabel, { color: colors.mutedForeground }]}>Deployed</Text>
            <Text style={[styles.accountStatValue, { color: colors.foreground }]}>
              {deployedPct.toFixed(0)}%
            </Text>
          </View>
          <View style={[styles.accountStatDivider, { backgroundColor: colors.border }]} />
          <View style={styles.accountStat}>
            <Text style={[styles.accountStatLabel, { color: colors.mutedForeground }]}>Positions</Text>
            <Text style={[styles.accountStatValue, { color: colors.foreground }]}>{positions.length}</Text>
          </View>
          <View style={[styles.accountStatDivider, { backgroundColor: colors.border }]} />
          <View style={styles.accountStat}>
            <Text style={[styles.accountStatLabel, { color: colors.mutedForeground }]}>Total P&L</Text>
            <Text style={[styles.accountStatValue, { color: isPnlUp ? "#00D4AA" : "#FF4757" }]}>
              {isPnlUp ? "+" : ""}${budgetPnl.toFixed(2)}
            </Text>
          </View>
        </View>

        <View style={[styles.paperTag, { backgroundColor: colors.secondary }]}>
          <Feather name="shield" size={11} color={colors.mutedForeground} />
          <Text style={[styles.paperTagText, { color: colors.mutedForeground }]}>Paper Trading — No real money</Text>
        </View>
      </Animated.View>

      {!account && !error && (
        <View style={styles.loadingBox}>
          <ActivityIndicator color={colors.primary} />
          <Text style={[styles.loadingText, { color: colors.mutedForeground }]}>Loading account...</Text>
        </View>
      )}

      <View style={[styles.viewToggle, { backgroundColor: colors.secondary }]}>
        {(["positions", "orders"] as const).map((v) => (
          <TouchableOpacity
            key={v}
            onPress={() => setView(v)}
            style={[styles.viewToggleBtn, view === v && { backgroundColor: colors.primary }]}
          >
            <Text style={[styles.viewToggleBtnText, { color: view === v ? colors.primaryForeground : colors.mutedForeground }]}>
              {v.charAt(0).toUpperCase() + v.slice(1)}
              {v === "positions" && positions.length > 0 ? ` (${positions.length})` : ""}
              {v === "orders" && orders.length > 0 ? ` (${orders.length})` : ""}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {view === "positions" && (
        <>
          {positions.length === 0 ? (
            <View style={styles.signalsEmpty}>
              <View style={[styles.aiIcon, { backgroundColor: colors.secondary }]}>
                <Feather name="briefcase" size={28} color={colors.primary} />
              </View>
              <Text style={[styles.emptyTitle, { color: colors.foreground }]}>No Open Positions</Text>
              <Text style={[styles.emptySubtitle, { color: colors.mutedForeground }]}>
                Use the Chat tab to ask the AI to buy stocks, or tap the buttons below to place a trade
              </Text>
              <TouchableOpacity
                onPress={() => handleTrade("AAPL", "buy")}
                style={[styles.analyzeBtn, { backgroundColor: colors.primary, marginTop: 8 }]}
              >
                <Text style={[styles.analyzeBtnText, { color: colors.primaryForeground }]}>Buy AAPL (demo)</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={styles.listSection}>
              <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>OPEN POSITIONS</Text>
              {positions.map((pos) => (
                <PositionRow key={pos.asset_id} position={pos} onTrade={handleTrade} />
              ))}
            </View>
          )}
        </>
      )}

      {view === "orders" && (
        <>
          {orders.length === 0 ? (
            <View style={styles.signalsEmpty}>
              <View style={[styles.aiIcon, { backgroundColor: colors.secondary }]}>
                <Feather name="list" size={28} color={colors.primary} />
              </View>
              <Text style={[styles.emptyTitle, { color: colors.foreground }]}>No Orders Yet</Text>
              <Text style={[styles.emptySubtitle, { color: colors.mutedForeground }]}>
                Orders you place will appear here
              </Text>
            </View>
          ) : (
            <View style={styles.listSection}>
              <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>RECENT ORDERS</Text>
              {orders.map((order) => (
                <OrderRow key={order.id} order={order} onCancel={handleCancel} />
              ))}
            </View>
          )}
        </>
      )}

      {tradeModal && (
        <TradeModal
          visible={true}
          symbol={tradeModal.symbol}
          side={tradeModal.side}
          onClose={() => setTradeModal(null)}
          onSubmit={handleSubmitOrder}
        />
      )}
    </ScrollView>
  );
}

// ─── Autopilot Tab ─────────────────────────────────────────────────────────

interface AutopilotLog {
  id: string;
  timestamp: string;
  type: "info" | "buy" | "sell" | "hold" | "close" | "error" | "market" | "ai";
  message: string;
  symbol?: string;
  amount?: number;
}

const LOG_COLORS: Record<AutopilotLog["type"], string> = {
  buy: "#00D4AA",
  sell: "#FF4757",
  close: "#FFB347",
  error: "#FF4757",
  market: "#9B9EA3",
  info: "#9B9EA3",
  hold: "#9B9EA3",
  ai: "#A78BFA",
};

const LOG_ICONS: Record<AutopilotLog["type"], string> = {
  buy: "trending-up",
  sell: "trending-down",
  close: "x-circle",
  error: "alert-circle",
  market: "clock",
  info: "activity",
  hold: "pause-circle",
  ai: "cpu",
};

function AutopilotLogRow({ log }: { log: AutopilotLog }) {
  const colors = useColors();
  const color = LOG_COLORS[log.type] ?? colors.mutedForeground;
  const icon = LOG_ICONS[log.type] ?? "activity";
  const time = new Date(log.timestamp).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  return (
    <Animated.View entering={FadeInDown.duration(200)} style={[styles.logRow, { borderLeftColor: color }]}>
      <Feather name={icon as "activity"} size={13} color={color} style={{ marginTop: 1 }} />
      <View style={styles.logContent}>
        <Text style={[styles.logMessage, { color: colors.foreground }]}>{log.message}</Text>
        <Text style={[styles.logTime, { color: colors.mutedForeground }]}>{time}</Text>
      </View>
    </Animated.View>
  );
}

function CountdownTimer({ nextScan }: { nextScan: string | null }) {
  const colors = useColors();
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    if (!nextScan) { setSeconds(0); return; }
    const tick = () => {
      const diff = Math.max(0, Math.round((new Date(nextScan).getTime() - Date.now()) / 1000));
      setSeconds(diff);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [nextScan]);

  if (!nextScan || seconds <= 0) return null;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return (
    <Text style={[styles.countdown, { color: colors.mutedForeground }]}>
      Next scan in {m}:{String(s).padStart(2, "0")}
    </Text>
  );
}

// ─── Race Mode UI ──────────────────────────────────────────────────────────────

interface RaceBotInfo {
  id: string;
  name: string;
  emoji: string;
  color: string;
  running: boolean;
  tradesCount: number;
  netSpent: number;
  netReceived: number;
  estimatedPnl: number;
  lastLog: AutopilotLog | null;
  nextScan: string | null;
}

type RaceLog = AutopilotLog & { botId: string };

// ─── Snapshot types — from /api/autopilot/race/snapshot ──────────────────────
type BotParticipationCategory = "active" | "idle" | "ineligible";

type RaceSnapshotBot = {
  id: string;
  name: string;
  emoji: string;
  color: string;
  status: string;
  total_equity: number;
  cash: number;
  open_position_value: number;
  rank: number | null;
  rank_label: string;
  is_tied: boolean;
  participation_category: BotParticipationCategory;
  comparison_reason: string;
  cycle_status: string;
  did_trade: boolean;
  deployment_pct: number;
  trades: number;
  net_pnl: number;
  realized_pnl: number;
  unrealized_pnl: number;
  comparison_deferred: boolean;
  excluded_from_ranking: boolean;
};

type RaceSnapshot = {
  active: boolean;
  bots: RaceSnapshotBot[];
  summary: {
    is_tie: boolean;
    leader: string | null;
    race_ready_for_comparison: boolean;
    comparison_deferred: boolean;
    deferred_reason: string | null;
    total_trades: number;
    bots_active_participants: number;
    bots_idle_no_signal: number;
    bots_session_ineligible: number;
    bots_ever_traded: number;
    bots_completed_first_cycle: number;
    bots_awaiting: number;
    bots_excluded: number;
  };
};

const PARTICIPATION_META: Record<BotParticipationCategory, { label: string; color: string }> = {
  active:     { label: "Active Participant", color: "#00D4AA" },
  idle:       { label: "Idle — No Signal",   color: "#FFB347" },
  ineligible: { label: "Session Ineligible", color: "#9B9EA3" },
};

function RaceBotCard({ bot }: { bot: RaceSnapshotBot }) {
  const colors = useColors();
  const pnl = bot.net_pnl;
  const pnlColor = pnl > 0 ? "#00D4AA" : pnl < 0 ? "#FF4757" : colors.mutedForeground;
  const catMeta = PARTICIPATION_META[bot.participation_category] ?? PARTICIPATION_META.idle;
  const MEDAL: Record<string, string> = { "#1": "🥇", "#2": "🥈", "#3": "🥉" };
  const medal = bot.is_tied ? "🤝" : (MEDAL[bot.rank_label] ?? "");
  const isActive = bot.participation_category === "active";

  return (
    <View style={[styles.raceBotCard, { backgroundColor: colors.card, borderColor: isActive ? `${bot.color}66` : colors.border }]}>
      <View style={styles.raceBotHeader}>
        <Text style={styles.raceBotEmoji}>{bot.emoji}</Text>
        <View style={styles.raceBotHeaderRight}>
          <View style={styles.raceBotStatusRow}>
            <View style={[styles.raceBotDot, { backgroundColor: catMeta.color }]} />
            <Text style={[styles.raceBotStatus, { color: catMeta.color }]}>{bot.rank_label}</Text>
            {medal ? <Text style={styles.raceMedal}>{medal}</Text> : null}
          </View>
          <Text style={[styles.raceBotName, { color: colors.foreground }]}>{bot.name}</Text>
        </View>
      </View>

      <View style={[styles.raceCategoryBadge, { backgroundColor: `${catMeta.color}18`, borderColor: `${catMeta.color}44` }]}>
        <Text style={[styles.raceCategoryBadgeText, { color: catMeta.color }]}>{catMeta.label}</Text>
      </View>

      <View style={styles.raceBotStats}>
        <View style={styles.raceBotStat}>
          <Text style={[styles.raceBotStatValue, { color: colors.foreground }]}>${bot.total_equity.toFixed(2)}</Text>
          <Text style={[styles.raceBotStatLabel, { color: colors.mutedForeground }]}>Equity</Text>
        </View>
        <View style={[styles.raceBotStatDivider, { backgroundColor: colors.border }]} />
        <View style={styles.raceBotStat}>
          <Text style={[styles.raceBotStatValue, { color: pnlColor }]}>{pnl >= 0 ? "+" : ""}${Math.abs(pnl).toFixed(2)}</Text>
          <Text style={[styles.raceBotStatLabel, { color: colors.mutedForeground }]}>P&L</Text>
        </View>
        <View style={[styles.raceBotStatDivider, { backgroundColor: colors.border }]} />
        <View style={styles.raceBotStat}>
          <Text style={[styles.raceBotStatValue, { color: colors.foreground }]}>{bot.trades}</Text>
          <Text style={[styles.raceBotStatLabel, { color: colors.mutedForeground }]}>Trades</Text>
        </View>
      </View>

      {bot.comparison_reason ? (
        <Text style={[styles.raceBotLastLog, { color: colors.mutedForeground }]} numberOfLines={2}>
          {bot.comparison_reason}
        </Text>
      ) : null}
    </View>
  );
}

function RaceModeUI({
  marketOpen,
  getBaseUrl,
}: {
  marketOpen: boolean | null;
  getBaseUrl: () => string;
}) {
  const colors = useColors();
  const { symbols } = useWatchlist();
  const { budget } = useAlpaca();

  const [raceActive, setRaceActive] = useState(false);
  const [raceLoading, setRaceLoading] = useState(false);
  const [budgetPerBot, setBudgetPerBot] = useState(250);
  const [bots, setBots] = useState<RaceBotInfo[]>([]);
  const [raceLogs, setRaceLogs] = useState<RaceLog[]>([]);
  const [raceSnapshot, setRaceSnapshot] = useState<RaceSnapshot | null>(null);
  const raceEsRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const base = getBaseUrl();
    const controller = new AbortController();

    const connect = async () => {
      try {
        const res = await fetch(`${base}/api/autopilot/race/status`, { signal: controller.signal });
        if (!res.ok || !res.body) return;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            try {
              const msg = JSON.parse(line.slice(6)) as {
                type: string;
                active?: boolean;
                bots?: RaceBotInfo[];
                logs?: RaceLog[];
                budgetPerBot?: number;
                botId?: string;
                log?: AutopilotLog;
                bot?: RaceBotInfo;
              };
              if (msg.type === "init") {
                setRaceActive(msg.active ?? false);
                setBots(msg.bots ?? []);
                setRaceLogs(msg.logs ?? []);
                setBudgetPerBot(msg.budgetPerBot ?? 250);
              } else if (msg.type === "log" && msg.botId && msg.log) {
                const enriched: RaceLog = { ...msg.log, botId: msg.botId };
                setRaceLogs((prev) => [enriched, ...prev].slice(0, 80));
                if (msg.bot) {
                  setBots((prev) => prev.map((b) => b.id === msg.bot!.id ? msg.bot! : b));
                }
              } else if (msg.type === "bot_update" && msg.bot) {
                setBots((prev) => prev.map((b) => b.id === msg.bot!.id ? msg.bot! : b));
              } else if (msg.type === "race_start") {
                setRaceActive(true);
                setBudgetPerBot(msg.budgetPerBot ?? 250);
              } else if (msg.type === "race_stop") {
                setRaceActive(false);
              }
            } catch { /* ignore */ }
          }
        }
      } catch { /* aborted */ }
    };

    void connect();
    raceEsRef.current = () => controller.abort();
    return () => { raceEsRef.current?.(); };
  }, []);

  // Poll /race/snapshot every 15 s for ranked, participation-categorized bot data.
  // Separate from the SSE stream (which handles real-time logs and running state).
  useEffect(() => {
    const base = getBaseUrl();
    const fetchSnapshot = async () => {
      try {
        const res = await fetch(`${base}/api/autopilot/race/snapshot`);
        if (res.ok) {
          const data = await res.json() as RaceSnapshot;
          setRaceSnapshot(data);
        }
      } catch { /* ignore */ }
    };
    void fetchSnapshot();
    const id = setInterval(fetchSnapshot, 15_000);
    return () => clearInterval(id);
  }, []);

  // Snapshot bots are server-sorted by rank — use directly for the grid.
  const displayBots = raceSnapshot?.bots ?? [];

  const handleRaceToggle = async () => {
    if (symbols.length === 0) {
      Alert.alert("No Symbols", "Add stocks to your Watchlist first.");
      return;
    }
    setRaceLoading(true);
    try {
      const base = getBaseUrl();
      if (raceActive) {
        await fetch(`${base}/api/autopilot/race/stop`, { method: "POST" });
        setRaceActive(false);
      } else {
        await fetch(`${base}/api/autopilot/race/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ symbols, budget }),
        });
        setRaceActive(true);
        setBudgetPerBot(Math.floor(budget / 4));
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch {
      Alert.alert("Error", "Could not toggle race mode.");
    } finally {
      setRaceLoading(false);
    }
  };

  const botColorMap: Record<string, string> = {
    momentum: "#00D4AA",
    dip_buyer: "#A78BFA",
    conservative: "#60A5FA",
    scalper: "#FF8C42",
  };

  return (
    <ScrollView
      contentContainerStyle={[styles.tabContent, { paddingBottom: Platform.OS === "web" ? 84 + 34 : 20 }]}
      showsVerticalScrollIndicator={false}
    >
      {/* Race header card */}
      <Animated.View entering={FadeInDown.springify()} style={[styles.raceHeaderCard, { backgroundColor: colors.card, borderColor: raceActive ? "#A78BFA44" : colors.border }]}>
        <View style={styles.raceHeaderTop}>
          <View>
            <Text style={[styles.raceTitle, { color: colors.foreground }]}>Trader Race</Text>
            <Text style={[styles.raceSubtitle, { color: colors.mutedForeground }]}>
              4 AIs · ${budgetPerBot || Math.floor(budget / 4)}/bot · {symbols.length} symbols
            </Text>
          </View>
          <TouchableOpacity
            onPress={handleRaceToggle}
            disabled={raceLoading}
            style={[styles.raceToggleBtn, { backgroundColor: raceActive ? "#FF475720" : "#A78BFA20", borderColor: raceActive ? "#FF4757" : "#A78BFA" }]}
          >
            {raceLoading ? (
              <ActivityIndicator size="small" color={raceActive ? "#FF4757" : "#A78BFA"} />
            ) : (
              <>
                <Feather name={raceActive ? "square" : "flag"} size={18} color={raceActive ? "#FF4757" : "#A78BFA"} />
                <Text style={[styles.raceToggleBtnText, { color: raceActive ? "#FF4757" : "#A78BFA" }]}>
                  {raceActive ? "Stop" : "Race!"}
                </Text>
              </>
            )}
          </TouchableOpacity>
        </View>

        <View style={[styles.raceStatusRow, { borderTopColor: colors.border }]}>
          <View style={styles.raceStatusItem}>
            <View style={[styles.raceStatusDot, { backgroundColor: marketOpen ? "#00D4AA" : "#FF4757" }]} />
            <Text style={[styles.raceStatusText, { color: marketOpen ? "#00D4AA" : "#FF4757" }]}>
              {marketOpen ? "Market Open" : "Market Closed"}
            </Text>
          </View>
          <View style={[styles.raceStatusDivider, { backgroundColor: colors.border }]} />
          <View style={styles.raceStatusItem}>
            <Feather name="cpu" size={11} color={raceActive ? "#A78BFA" : colors.mutedForeground} />
            <Text style={[styles.raceStatusText, { color: raceActive ? "#A78BFA" : colors.mutedForeground }]}>
              {raceActive ? `${bots.filter((b) => b.running).length}/4 active` : "Standing by"}
            </Text>
          </View>
          <View style={[styles.raceStatusDivider, { backgroundColor: colors.border }]} />
          <View style={styles.raceStatusItem}>
            <Feather name="trending-up" size={11} color={colors.mutedForeground} />
            <Text style={[styles.raceStatusText, { color: colors.mutedForeground }]}>
              {bots.reduce((s, b) => s + b.tradesCount, 0)} total trades
            </Text>
          </View>
        </View>
      </Animated.View>

      {/* Standings summary — visible once all bots have completed their first cycle */}
      {raceSnapshot?.summary?.race_ready_for_comparison && (
        <Animated.View entering={FadeInDown.springify()} style={[styles.raceStandingsCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>STANDINGS</Text>
          <Text style={[styles.raceLeaderText, { color: colors.foreground }]}>
            {raceSnapshot.summary.comparison_deferred
              ? "⏳ Awaiting evaluation window"
              : raceSnapshot.summary.is_tie
                ? "🤝 All bots tied"
                : raceSnapshot.summary.leader
                  ? `👑 ${raceSnapshot.summary.leader}`
                  : "Race in progress"}
          </Text>
          {raceSnapshot.summary.comparison_deferred && raceSnapshot.summary.deferred_reason ? (
            <Text style={[styles.raceBotLastLog, { color: colors.mutedForeground }]}>
              {raceSnapshot.summary.deferred_reason}
            </Text>
          ) : null}
          <View style={styles.raceCategoryRow}>
            {(raceSnapshot.summary.comparison_deferred
              ? [
                  { label: "Awaiting", count: raceSnapshot.summary.bots_awaiting, color: "#60BFFF" },
                  { label: "Excluded", count: raceSnapshot.summary.bots_excluded, color: "#9B9EA3" },
                ]
              : [
                  { label: "Active",   count: raceSnapshot.summary.bots_active_participants, color: "#00D4AA" },
                  { label: "Idle",     count: raceSnapshot.summary.bots_idle_no_signal,      color: "#FFB347" },
                  { label: "Excluded", count: raceSnapshot.summary.bots_excluded,            color: "#9B9EA3" },
                ]
            ).map((item) => (
              <View key={item.label} style={styles.raceCategoryPill}>
                <View style={[styles.raceCategoryDot, { backgroundColor: item.color }]} />
                <Text style={[styles.raceCategoryPillText, { color: colors.mutedForeground }]}>
                  {item.count} {item.label}
                </Text>
              </View>
            ))}
          </View>
        </Animated.View>
      )}

      {/* 2×2 bot grid — bots sorted by rank, labeled by participation category */}
      {displayBots.length > 0 ? (
        <View style={styles.raceBotGrid}>
          {displayBots.map((bot) => (
            <RaceBotCard key={bot.id} bot={bot} />
          ))}
        </View>
      ) : !raceActive && (
        <View style={[styles.strategyCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.strategyTitle, { color: colors.foreground }]}>How the race works</Text>
          {[
            { emoji: "🚀", label: "Momentum Rider", desc: "Chases the day's biggest movers" },
            { emoji: "📉", label: "Dip Buyer", desc: "Buys dips, bets on the bounce" },
            { emoji: "🛡️", label: "Conservative", desc: "Slow and steady, capital first" },
            { emoji: "⚡", label: "Scalper", desc: "Fast trades, quick small gains" },
          ].map((item, i) => (
            <View key={i} style={styles.raceExplainRow}>
              <Text style={styles.raceExplainEmoji}>{item.emoji}</Text>
              <View>
                <Text style={[styles.raceExplainName, { color: colors.foreground }]}>{item.label}</Text>
                <Text style={[styles.raceExplainDesc, { color: colors.mutedForeground }]}>{item.desc}</Text>
              </View>
            </View>
          ))}
          <Text style={[styles.raceExplainNote, { color: colors.mutedForeground }]}>
            Each bot gets ${Math.floor(budget / 4)} and runs independently. They stagger their scans every 90 seconds to avoid conflicts.
          </Text>
          {symbols.length === 0 && (
            <View style={[styles.warningBox, { backgroundColor: "#FFB34722", borderColor: "#FFB347" }]}>
              <Feather name="alert-triangle" size={13} color="#FFB347" />
              <Text style={[styles.warningText, { color: "#FFB347" }]}>Add stocks to your Watchlist first</Text>
            </View>
          )}
        </View>
      )}

      {/* Unified activity feed */}
      {raceLogs.length > 0 && (
        <View style={styles.listSection}>
          <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>LIVE FEED</Text>
          <View style={[styles.logContainer, { backgroundColor: colors.card, borderColor: colors.border }]}>
            {raceLogs.slice(0, 50).map((log) => {
              const color = LOG_COLORS[log.type] ?? "#9B9EA3";
              const botColor = botColorMap[log.botId] ?? "#9B9EA3";
              const icon = LOG_ICONS[log.type] ?? "activity";
              const time = new Date(log.timestamp).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
              const botEmoji = bots.find((b) => b.id === log.botId)?.emoji ?? "🤖";
              return (
                <Animated.View entering={FadeInDown.duration(200)} key={log.id} style={[styles.raceLogRow, { borderLeftColor: botColor }]}>
                  <Text style={styles.raceLogBotEmoji}>{botEmoji}</Text>
                  <Feather name={icon as "activity"} size={12} color={color} style={{ marginTop: 1 }} />
                  <View style={styles.logContent}>
                    <Text style={[styles.logMessage, { color: "#E6EDF3" }]}>{log.message}</Text>
                    <Text style={[styles.logTime, { color: "#9B9EA3" }]}>{time}</Text>
                  </View>
                </Animated.View>
              );
            })}
          </View>
        </View>
      )}
    </ScrollView>
  );
}

function AutopilotTab() {
  const colors = useColors();
  const { symbols } = useWatchlist();
  const { budget } = useAlpaca();
  const [autopilotMode, setAutopilotMode] = useState<"solo" | "race">("solo");

  const [running, setRunning] = useState(false);
  const [logs, setLogs] = useState<AutopilotLog[]>([]);
  const [tradesCount, setTradesCount] = useState(0);
  const [nextScan, setNextScan] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [marketOpen, setMarketOpen] = useState<boolean | null>(null);
  const [selectedStrategyId, setSelectedStrategyId] = useState("momentum");
  const [customRules, setCustomRules] = useState("");
  const [showStrategyBuilder, setShowStrategyBuilder] = useState(false);
  const esRef = useRef<(() => void) | null>(null);

  // Persist strategy selection
  useEffect(() => {
    AsyncStorage.getItem("autopilot_strategy_id").then((v) => { if (v) setSelectedStrategyId(v); }).catch(() => {});
    AsyncStorage.getItem("autopilot_custom_rules").then((v) => { if (v) setCustomRules(v); }).catch(() => {});
  }, []);

  const selectStrategy = (id: string) => {
    setSelectedStrategyId(id);
    AsyncStorage.setItem("autopilot_strategy_id", id).catch(() => {});
  };

  const saveCustomRules = (text: string) => {
    setCustomRules(text);
    AsyncStorage.setItem("autopilot_custom_rules", text).catch(() => {});
  };

  const getActiveStrategy = (): string => {
    const preset = STRATEGY_PRESETS.find((s) => s.id === selectedStrategyId);
    if (!preset) return "";
    if (preset.id === "custom") return customRules;
    return preset.rules;
  };

  function getBaseUrl() {
    if (Platform.OS === "web") {
      const domain = process.env.EXPO_PUBLIC_DOMAIN ?? "";
      return domain ? `https://${domain}` : "";
    }
    return `https://${process.env.EXPO_PUBLIC_DOMAIN ?? ""}`;
  }

  // Poll for market clock
  useEffect(() => {
    const checkClock = async () => {
      try {
        const res = await fetch(`${getBaseUrl()}/api/alpaca/clock`);
        if (res.ok) {
          const data = await res.json() as { is_open: boolean };
          setMarketOpen(data.is_open);
        }
      } catch { /* ignore */ }
    };
    void checkClock();
    const id = setInterval(checkClock, 60000);
    return () => clearInterval(id);
  }, []);

  // SSE connection
  const connectSSE = () => {
    const base = getBaseUrl();
    const url = `${base}/api/autopilot/status`;
    const controller = new AbortController();

    const connect = async () => {
      try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok || !res.body) return;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            try {
              const msg = JSON.parse(line.slice(6)) as {
                type: string;
                log?: AutopilotLog;
                logs?: AutopilotLog[];
                running?: boolean;
                tradesCount?: number;
                totalPnl?: number;
                nextScan?: string;
              };
              if (msg.type === "init") {
                setRunning(msg.running ?? false);
                setLogs(msg.logs ?? []);
                setTradesCount(msg.tradesCount ?? 0);
                setNextScan(msg.nextScan ?? null);
              } else if (msg.type === "log" && msg.log) {
                setLogs((prev) => [msg.log!, ...prev].slice(0, 100));
              } else if (msg.type === "status") {
                setRunning(msg.running ?? false);
                if (!msg.running) setNextScan(null);
              } else if (msg.type === "stats") {
                setTradesCount(msg.tradesCount ?? 0);
              } else if (msg.type === "next_scan") {
                setNextScan(msg.nextScan ?? null);
              }
            } catch { /* ignore */ }
          }
        }
      } catch { /* aborted or error */ }
    };

    void connect();
    esRef.current = () => controller.abort();
  };

  useEffect(() => {
    connectSSE();
    return () => { esRef.current?.(); };
  }, []);

  const handleToggle = async () => {
    if (symbols.length === 0) {
      Alert.alert("No Symbols", "Add stocks to your Watchlist first so the agent knows what to trade.");
      return;
    }
    setLoading(true);
    try {
      const base = getBaseUrl();
      if (running) {
        await fetch(`${base}/api/autopilot/stop`, { method: "POST" });
        setRunning(false);
        setNextScan(null);
      } else {
        const strategy = getActiveStrategy();
        if (selectedStrategyId === "custom" && !strategy.trim()) {
          Alert.alert("No Strategy", "Please write your custom trading rules before starting.");
          setLoading(false);
          return;
        }
        await fetch(`${base}/api/autopilot/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ symbols, budget, strategy }),
        });
        setRunning(true);
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch {
      Alert.alert("Error", "Could not toggle autopilot. Check connection.");
    } finally {
      setLoading(false);
    }
  };

  const marketStatusColor = marketOpen === true ? "#00D4AA" : marketOpen === false ? "#FF4757" : colors.mutedForeground;
  const marketStatusLabel = marketOpen === true ? "Market Open" : marketOpen === false ? "Market Closed" : "Checking...";

  return (
    <View style={styles.flex}>
      {/* Mode toggle */}
      <View style={[styles.modeToggleBar, { backgroundColor: colors.secondary, borderBottomColor: colors.border }]}>
        {(["solo", "race"] as const).map((mode) => (
          <TouchableOpacity
            key={mode}
            onPress={() => setAutopilotMode(mode)}
            style={[styles.modeToggleBtn, autopilotMode === mode && { backgroundColor: mode === "race" ? "#A78BFA" : colors.primary }]}
          >
            <Feather name={mode === "race" ? "flag" : "cpu"} size={13} color={autopilotMode === mode ? "#fff" : colors.mutedForeground} />
            <Text style={[styles.modeToggleBtnText, { color: autopilotMode === mode ? "#fff" : colors.mutedForeground }]}>
              {mode === "solo" ? "Solo Trader" : "4-Bot Race"}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {autopilotMode === "race" ? (
        <RaceModeUI marketOpen={marketOpen} getBaseUrl={getBaseUrl} />
      ) : (
      <ScrollView
        contentContainerStyle={[styles.tabContent, { paddingBottom: Platform.OS === "web" ? 84 + 34 : 20 }]}
        showsVerticalScrollIndicator={false}
      >
        {/* Hero toggle card */}
        <Animated.View entering={FadeInDown.springify()} style={[styles.autopilotCard, { backgroundColor: colors.card, borderColor: running ? "#00D4AA44" : colors.border }]}>
          <View style={styles.autopilotCardTop}>
            <View style={styles.autopilotCardLeft}>
              <View style={styles.autopilotStatusRow}>
                <View style={[styles.autopilotStatusDot, { backgroundColor: running ? "#00D4AA" : colors.mutedForeground }]} />
                <Text style={[styles.autopilotStatusLabel, { color: running ? "#00D4AA" : colors.mutedForeground }]}>
                  {running ? "RUNNING" : "STANDBY"}
                </Text>
              </View>
              <Text style={[styles.autopilotTitle, { color: colors.foreground }]}>
                Day Trader Agent
              </Text>
              <Text style={[styles.autopilotSubtitle, { color: colors.mutedForeground }]}>
                ${budget} budget · {symbols.length} symbols · 5-min scans
              </Text>
            </View>

            <TouchableOpacity
              onPress={handleToggle}
              disabled={loading}
              style={[
                styles.autopilotToggle,
                { backgroundColor: running ? "#FF475722" : "#00D4AA22", borderColor: running ? "#FF4757" : "#00D4AA" },
              ]}
            >
              {loading ? (
                <ActivityIndicator size="small" color={running ? "#FF4757" : "#00D4AA"} />
              ) : (
                <>
                  <Feather name={running ? "pause" : "play"} size={20} color={running ? "#FF4757" : "#00D4AA"} />
                  <Text style={[styles.autopilotToggleText, { color: running ? "#FF4757" : "#00D4AA" }]}>
                    {running ? "Stop" : "Start"}
                  </Text>
                </>
              )}
            </TouchableOpacity>
          </View>

          {/* Stats row */}
          <View style={[styles.autopilotStats, { borderTopColor: colors.border }]}>
            <View style={styles.autopilotStat}>
              <View style={[styles.autopilotStatDot, { backgroundColor: marketStatusColor }]} />
              <Text style={[styles.autopilotStatLabel, { color: marketStatusColor }]}>{marketStatusLabel}</Text>
            </View>
            <View style={[styles.autopilotStatDivider, { backgroundColor: colors.border }]} />
            <View style={styles.autopilotStat}>
              <Feather name="repeat" size={11} color={colors.mutedForeground} />
              <Text style={[styles.autopilotStatLabel, { color: colors.mutedForeground }]}>{tradesCount} trades</Text>
            </View>
            <View style={[styles.autopilotStatDivider, { backgroundColor: colors.border }]} />
            <View style={styles.autopilotStat}>
              <Feather name="layers" size={11} color={colors.mutedForeground} />
              <Text style={[styles.autopilotStatLabel, { color: colors.mutedForeground }]}>
                {symbols.slice(0, 4).join(", ")}{symbols.length > 4 ? `+${symbols.length - 4}` : ""}
              </Text>
            </View>
          </View>

          {running && <CountdownTimer nextScan={nextScan} />}
        </Animated.View>

        {/* Strategy Builder */}
        {!running && (
          <View style={[styles.strategyCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <TouchableOpacity
              onPress={() => setShowStrategyBuilder((v) => !v)}
              style={styles.strategyBuilderHeader}
            >
              <View style={styles.strategyBuilderHeaderLeft}>
                <Text style={[styles.strategyTitle, { color: colors.foreground }]}>Trading Strategy</Text>
                <Text style={[styles.strategyBuilderSubtitle, { color: colors.mutedForeground }]}>
                  {STRATEGY_PRESETS.find((s) => s.id === selectedStrategyId)?.emoji}{" "}
                  {STRATEGY_PRESETS.find((s) => s.id === selectedStrategyId)?.name}
                </Text>
              </View>
              <Feather
                name={showStrategyBuilder ? "chevron-up" : "chevron-down"}
                size={18}
                color={colors.mutedForeground}
              />
            </TouchableOpacity>

            {showStrategyBuilder && (
              <View style={styles.strategyBuilderBody}>
                {/* Preset grid */}
                <View style={styles.strategyGrid}>
                  {STRATEGY_PRESETS.map((preset) => {
                    const isActive = selectedStrategyId === preset.id;
                    return (
                      <TouchableOpacity
                        key={preset.id}
                        onPress={() => selectStrategy(preset.id)}
                        style={[
                          styles.strategyPresetCard,
                          {
                            backgroundColor: isActive ? `${preset.color}18` : colors.background,
                            borderColor: isActive ? preset.color : colors.border,
                          },
                        ]}
                      >
                        <Text style={styles.strategyPresetEmoji}>{preset.emoji}</Text>
                        <Text style={[styles.strategyPresetName, { color: isActive ? preset.color : colors.foreground }]}>
                          {preset.name}
                        </Text>
                        <Text style={[styles.strategyPresetTagline, { color: colors.mutedForeground }]}>
                          {preset.tagline}
                        </Text>
                        {isActive && (
                          <View style={[styles.strategyPresetCheck, { backgroundColor: preset.color }]}>
                            <Feather name="check" size={9} color="#fff" />
                          </View>
                        )}
                      </TouchableOpacity>
                    );
                  })}
                </View>

                {/* Rules preview / custom input */}
                {selectedStrategyId === "custom" ? (
                  <View style={styles.strategyCustomBox}>
                    <Text style={[styles.strategyCustomLabel, { color: colors.mutedForeground }]}>
                      Describe your trading rules in plain English:
                    </Text>
                    <TextInput
                      value={customRules}
                      onChangeText={saveCustomRules}
                      placeholder={`Example:\n- Buy AAPL when it's down >1% and bouncing\n- Use max $200 per trade\n- Cut losses at -2%, take profit at +2.5%`}
                      placeholderTextColor={colors.mutedForeground}
                      multiline
                      numberOfLines={6}
                      style={[
                        styles.strategyCustomInput,
                        { color: colors.foreground, backgroundColor: colors.background, borderColor: colors.border },
                      ]}
                    />
                  </View>
                ) : (
                  <View style={[styles.strategyRulesBox, { backgroundColor: colors.background, borderColor: colors.border }]}>
                    <Text style={[styles.strategyRulesLabel, { color: colors.mutedForeground }]}>RULES THE AI WILL FOLLOW</Text>
                    {(STRATEGY_PRESETS.find((s) => s.id === selectedStrategyId)?.rules ?? "")
                      .split("\n")
                      .filter((l) => l.trim())
                      .map((line, i) => (
                        <Text key={i} style={[styles.strategyRuleLine, { color: colors.foreground }]}>{line}</Text>
                      ))}
                  </View>
                )}
              </View>
            )}

            {symbols.length === 0 && (
              <View style={[styles.warningBox, { backgroundColor: "#FFB34722", borderColor: "#FFB347" }]}>
                <Feather name="alert-triangle" size={13} color="#FFB347" />
                <Text style={[styles.warningText, { color: "#FFB347" }]}>
                  Add stocks to your Watchlist before starting
                </Text>
              </View>
            )}
          </View>
        )}

        {/* Activity feed */}
        {logs.length > 0 && (
          <View style={styles.listSection}>
            <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>ACTIVITY FEED</Text>
            <View style={[styles.logContainer, { backgroundColor: colors.card, borderColor: colors.border }]}>
              {logs.slice(0, 40).map((log) => (
                <AutopilotLogRow key={log.id} log={log} />
              ))}
            </View>
          </View>
        )}
      </ScrollView>
      )}
    </View>
  );
}

// ─── Feedback Loop Tab ────────────────────────────────────────────────────────

interface FeedbackStatus {
  export: { created_at: string; bot_count: number } | null;
  feedback: {
    created_at: string;
    summary: string;
    status: string;
    packet_id: string;
    source?: string;
    problems_count?: number;
    changes_count?: number;
    has_replit_prompt?: boolean;
  } | null;
  replit_prompt: { exists: boolean; path: string } | null;
  queue_count: number;
  llm_source?: string;
}

interface AnalysisResult {
  ok: boolean;
  packet_id: string;
  summary: string;
  problems_count: number;
  changes_count: number;
  files_count: number;
  replit_prompt_saved: boolean;
}

interface FeedbackPacket {
  packet_id: string;
  created_at: string;
  source: string;
  status: string;
  summary: string;
  problems_found: string[];
  recommended_changes: string[];
  files_to_modify: string[];
  tests_to_run: string[];
  next_prompt_for_replit: string;
}

function FeedbackLoopTab() {
  const colors = useColors();
  const [status, setStatus] = useState<FeedbackStatus | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(false);

  // Step 1 — Generate Export
  const [generating, setGenerating] = useState(false);

  // Step 2 — Analyze Export (automated)
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisResult, setAnalysisResult] = useState<AnalysisResult | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);

  // Step 3 — Review modals
  const [showFeedback, setShowFeedback] = useState(false);
  const [feedbackPacket, setFeedbackPacket] = useState<FeedbackPacket | null>(null);
  const [showReplitPrompt, setShowReplitPrompt] = useState(false);
  const [replitPromptText, setReplitPromptText] = useState<string | null>(null);

  // Manual fallback (collapsible)
  const [showManual, setShowManual] = useState(false);
  const [feedbackInput, setFeedbackInput] = useState("");
  const [queuingFeedback, setQueuingFeedback] = useState(false);
  const [lastQueued, setLastQueued] = useState<string | null>(null);

  function getBaseUrl() {
    if (Platform.OS === "web") {
      const domain = process.env.EXPO_PUBLIC_DOMAIN ?? "";
      return domain ? `https://${domain}` : "";
    }
    return `https://${process.env.EXPO_PUBLIC_DOMAIN ?? ""}`;
  }

  const fetchStatus = async () => {
    setLoadingStatus(true);
    try {
      const res = await fetch(`${getBaseUrl()}/api/ai-brain/feedback-status`);
      if (res.ok) setStatus(await res.json() as FeedbackStatus);
    } catch { /* ignore */ } finally { setLoadingStatus(false); }
  };

  useEffect(() => { void fetchStatus(); }, []);

  // ── Step 1: Generate Export ─────────────────────────────────────────────────
  const handleGenerateExport = async () => {
    setGenerating(true);
    try {
      const res = await fetch(`${getBaseUrl()}/api/ai-brain/export-snapshot`);
      if (res.ok) {
        const data = await res.json() as { snapshot?: { mode?: string; summary?: { total_trades?: number; total_pnl?: number } } };
        const mode   = data.snapshot?.mode ?? "snapshot";
        const trades = data.snapshot?.summary?.total_trades ?? 0;
        const pnl    = (data.snapshot?.summary?.total_pnl ?? 0).toFixed(2);
        Alert.alert("Export Ready", `${mode} captured.\n${trades} trades · P&L $${pnl}\n\nNow tap "Analyze Export" to send it to the AI.`);
        void fetchStatus();
      } else {
        Alert.alert("Error", "Export failed. Check server logs.");
      }
    } catch { Alert.alert("Error", "Could not reach server."); }
    finally { setGenerating(false); }
  };

  // ── Step 2: Analyze Export (fully automated) ────────────────────────────────
  const handleAnalyzeExport = async () => {
    setAnalyzing(true);
    setAnalysisError(null);
    setAnalysisResult(null);
    try {
      const res = await fetch(`${getBaseUrl()}/api/ai-brain/analyze-export`, { method: "POST" });
      const data = await res.json() as AnalysisResult & { error?: string; raw_preview?: string };
      if (res.ok && data.ok) {
        setAnalysisResult(data);
        void fetchStatus();
      } else {
        setAnalysisError(data.error ?? "Analysis failed.");
        if (data.raw_preview) {
          setAnalysisError((prev) => `${prev ?? ""}\n\nRaw preview:\n${data.raw_preview}`);
        }
      }
    } catch (e) {
      setAnalysisError(`Network error: ${String(e)}`);
    } finally { setAnalyzing(false); }
  };

  // ── Step 3a: View full feedback ─────────────────────────────────────────────
  const handleViewFeedback = async () => {
    try {
      const res = await fetch(`${getBaseUrl()}/api/ai-brain/latest-feedback`);
      if (res.ok) {
        setFeedbackPacket(await res.json() as FeedbackPacket);
        setShowFeedback(true);
      } else {
        Alert.alert("Not Found", "Run Analyze Export first.");
      }
    } catch { Alert.alert("Error", "Could not load feedback."); }
  };

  // ── Step 3b: Copy/view Replit prompt ────────────────────────────────────────
  const handleViewReplitPrompt = async () => {
    try {
      const res = await fetch(`${getBaseUrl()}/api/ai-brain/latest-replit-prompt`);
      if (res.ok) {
        const text = await res.text();
        setReplitPromptText(text);
        setShowReplitPrompt(true);
      } else {
        Alert.alert("Not Found", "Run Analyze Export first.");
      }
    } catch { Alert.alert("Error", "Could not load Replit prompt."); }
  };

  const copyToClipboard = async (text: string, label: string) => {
    try {
      if (Platform.OS === "web" && typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(text);
        Alert.alert("Copied!", `${label} copied to clipboard.`);
      } else {
        await Share.share({ message: text });
      }
    } catch { Alert.alert("Error", "Could not copy."); }
  };

  const downloadText = async (text: string, filename: string, label: string) => {
    if (Platform.OS === "web") {
      const blob = new Blob([text], { type: "text/plain" });
      const url  = URL.createObjectURL(blob);
      const a    = Object.assign(document.createElement("a"), { href: url, download: filename });
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } else {
      await Share.share({ message: text, title: label });
    }
  };

  const handleDownloadFeedback = async () => {
    try {
      const res = await fetch(`${getBaseUrl()}/api/ai-brain/latest-feedback`);
      if (res.ok) {
        const text = JSON.stringify(await res.json(), null, 2);
        await downloadText(text, "latest_feedback.json", "Feedback JSON");
      } else {
        Alert.alert("Not Found", "Run Analyze Export first.");
      }
    } catch { Alert.alert("Error", "Download failed."); }
  };

  const handleDownloadReplitPrompt = async () => {
    try {
      const res = await fetch(`${getBaseUrl()}/api/ai-brain/latest-replit-prompt`);
      if (res.ok) {
        const text = await res.text();
        await downloadText(text, "latest_replit_prompt.txt", "Replit Prompt");
      } else {
        Alert.alert("Not Found", "Run Analyze Export first.");
      }
    } catch { Alert.alert("Error", "Download failed."); }
  };

  // ── Manual fallback: paste ChatGPT JSON ────────────────────────────────────
  const handleQueueFeedback = async () => {
    if (!feedbackInput.trim()) { Alert.alert("Empty", "Paste the JSON feedback first."); return; }
    const stripped = feedbackInput.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(stripped) as Record<string, unknown>; }
    catch { Alert.alert("Invalid JSON", "The pasted text is not valid JSON."); return; }
    if (!parsed.summary) { Alert.alert("Missing Field", "The JSON must have a 'summary' field."); return; }
    setQueuingFeedback(true);
    try {
      const res = await fetch(`${getBaseUrl()}/api/ai-brain/feedback`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: feedbackInput,
      });
      if (res.ok) {
        const data = await res.json() as { packet_id: string };
        setLastQueued(data.packet_id);
        setFeedbackInput("");
        Alert.alert("Queued", `Feedback packet ${data.packet_id.slice(0, 8)} saved.`);
        void fetchStatus();
      } else {
        const err = await res.json() as { error: string };
        Alert.alert("Error", err.error ?? "Queue failed.");
      }
    } catch { Alert.alert("Error", "Could not reach server."); }
    finally { setQueuingFeedback(false); }
  };

  const formatTs = (ts: string) => new Date(ts).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

  const hasExport   = !!status?.export;
  const hasFeedback = !!status?.feedback;
  const hasPrompt   = !!status?.replit_prompt?.exists;

  return (
    <ScrollView
      contentContainerStyle={[styles.tabContent, { paddingBottom: Platform.OS === "web" ? 84 + 34 : 24 }]}
      showsVerticalScrollIndicator={false}
    >
      {/* ── Header card ──────────────────────────────────────────────────────── */}
      <Animated.View entering={FadeInDown.springify()} style={[styles.loopHeaderCard, { backgroundColor: colors.card, borderColor: "#A78BFA44" }]}>
        <View style={styles.loopHeaderTop}>
          <View style={[styles.loopIconWrap, { backgroundColor: "#A78BFA22" }]}>
            <Feather name="refresh-cw" size={22} color="#A78BFA" />
          </View>
          <View style={{ flex: 1, gap: 3 }}>
            <Text style={[styles.loopTitle, { color: colors.foreground }]}>Feedback Loop</Text>
            <Text style={[styles.loopSubtitle, { color: colors.mutedForeground }]}>
              Export → AI analyzes → Replit prompt queued
            </Text>
          </View>
          <TouchableOpacity onPress={() => void fetchStatus()} disabled={loadingStatus} style={styles.loopRefreshBtn}>
            {loadingStatus ? <ActivityIndicator size="small" color="#A78BFA" /> : <Feather name="refresh-cw" size={15} color="#A78BFA" />}
          </TouchableOpacity>
        </View>

        {/* Status pills row */}
        <View style={[styles.loopStatusRow, { borderTopColor: colors.border }]}>
          <View style={styles.loopStatusItem}>
            <Feather name="package" size={11} color={hasExport ? "#00D4AA" : colors.mutedForeground} />
            <Text style={[styles.loopStatusLabel, { color: hasExport ? "#00D4AA" : colors.mutedForeground }]}>
              {hasExport ? `Export: ${formatTs(status!.export!.created_at)}` : "No export"}
            </Text>
          </View>
          <View style={[styles.loopStatusDivider, { backgroundColor: colors.border }]} />
          <View style={styles.loopStatusItem}>
            <Feather name="cpu" size={11} color={hasFeedback ? "#A78BFA" : colors.mutedForeground} />
            <Text style={[styles.loopStatusLabel, { color: hasFeedback ? "#A78BFA" : colors.mutedForeground }]}>
              {hasFeedback ? `${status!.feedback!.problems_count ?? 0} issues found` : "No analysis"}
            </Text>
          </View>
          <View style={[styles.loopStatusDivider, { backgroundColor: colors.border }]} />
          <View style={styles.loopStatusItem}>
            <Feather name="terminal" size={11} color={hasPrompt ? "#60A5FA" : colors.mutedForeground} />
            <Text style={[styles.loopStatusLabel, { color: hasPrompt ? "#60A5FA" : colors.mutedForeground }]}>
              {hasPrompt ? "Prompt queued" : "No prompt"}
            </Text>
          </View>
        </View>

        {/* LLM source badge */}
        {status?.llm_source && (
          <View style={[styles.loopLlmBadge, { backgroundColor: status.llm_source === "OPENAI_API_KEY" ? "#00D4AA18" : "#A78BFA18", borderColor: status.llm_source === "OPENAI_API_KEY" ? "#00D4AA44" : "#A78BFA44" }]}>
            <Feather name="key" size={10} color={status.llm_source === "OPENAI_API_KEY" ? "#00D4AA" : "#A78BFA"} />
            <Text style={[styles.loopLlmBadgeText, { color: status.llm_source === "OPENAI_API_KEY" ? "#00D4AA" : "#A78BFA" }]}>
              {status.llm_source === "OPENAI_API_KEY" ? "Using OPENAI_API_KEY" : "Using Replit AI proxy"}
            </Text>
          </View>
        )}
      </Animated.View>

      {/* ── Latest feedback summary card ─────────────────────────────────────── */}
      {hasFeedback && (
        <Animated.View entering={FadeInDown.delay(50).springify()} style={[styles.loopInfoCard, { backgroundColor: "#A78BFA0D", borderColor: "#A78BFA44" }]}>
          <View style={styles.loopFeedbackTopRow}>
            <Text style={[styles.loopSectionLabel, { color: "#A78BFA" }]}>LATEST ANALYSIS</Text>
            <View style={[styles.loopStatusBadge, { backgroundColor: "#A78BFA22" }]}>
              <Text style={[styles.loopStatusBadgeText, { color: "#A78BFA" }]}>
                {(status!.feedback!.source ?? "manual").replace("_", " ").toUpperCase()}
              </Text>
            </View>
          </View>
          <Text style={[styles.loopInfoLine, { color: colors.foreground }]} numberOfLines={3}>
            {status!.feedback!.summary}
          </Text>
          <View style={styles.loopFeedbackMeta}>
            <View style={[styles.loopChip, { backgroundColor: "#FF475722" }]}>
              <Text style={[styles.loopChipText, { color: "#FF4757" }]}>{status!.feedback!.problems_count ?? 0} problems</Text>
            </View>
            <View style={[styles.loopChip, { backgroundColor: "#00D4AA22" }]}>
              <Text style={[styles.loopChipText, { color: "#00D4AA" }]}>{status!.feedback!.changes_count ?? 0} changes</Text>
            </View>
            <Text style={[styles.loopInfoMeta, { color: colors.mutedForeground }]}>
              {formatTs(status!.feedback!.created_at)}
            </Text>
          </View>
          {/* Action buttons */}
          <View style={styles.loopActionRow}>
            <TouchableOpacity
              onPress={() => void handleViewFeedback()}
              style={[styles.loopSmallBtn, { backgroundColor: "#A78BFA22", borderColor: "#A78BFA55" }]}
            >
              <Feather name="eye" size={12} color="#A78BFA" />
              <Text style={[styles.loopSmallBtnText, { color: "#A78BFA" }]}>View Full</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => void handleDownloadFeedback()}
              style={[styles.loopSmallBtn, { backgroundColor: "#60A5FA22", borderColor: "#60A5FA55" }]}
            >
              <Feather name="download" size={12} color="#60A5FA" />
              <Text style={[styles.loopSmallBtnText, { color: "#60A5FA" }]}>Download JSON</Text>
            </TouchableOpacity>
          </View>
        </Animated.View>
      )}

      {/* ── Replit prompt ready card ─────────────────────────────────────────── */}
      {hasPrompt && (
        <Animated.View entering={FadeInDown.delay(70).springify()} style={[styles.loopInfoCard, { backgroundColor: "#60A5FA0D", borderColor: "#60A5FA44" }]}>
          <Text style={[styles.loopSectionLabel, { color: "#60A5FA" }]}>REPLIT PROMPT QUEUED</Text>
          <Text style={[styles.loopInfoMeta, { color: colors.mutedForeground }]}>
            Saved to <Text style={{ fontFamily: "monospace" }}>feedback/replit/latest_prompt.txt</Text>
            {"\n"}Review it below, approve, then paste into Replit Agent to apply changes.
          </Text>
          <View style={styles.loopActionRow}>
            <TouchableOpacity
              onPress={() => void handleViewReplitPrompt()}
              style={[styles.loopSmallBtn, { backgroundColor: "#60A5FA22", borderColor: "#60A5FA55" }]}
            >
              <Feather name="eye" size={12} color="#60A5FA" />
              <Text style={[styles.loopSmallBtnText, { color: "#60A5FA" }]}>View Prompt</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => void handleDownloadReplitPrompt()}
              style={[styles.loopSmallBtn, { backgroundColor: "#A78BFA22", borderColor: "#A78BFA55" }]}
            >
              <Feather name="download" size={12} color="#A78BFA" />
              <Text style={[styles.loopSmallBtnText, { color: "#A78BFA" }]}>Download Prompt</Text>
            </TouchableOpacity>
          </View>
        </Animated.View>
      )}

      {/* ── Step 1: Generate Export ──────────────────────────────────────────── */}
      <Animated.View entering={FadeInDown.delay(100).springify()} style={[styles.loopStepCard, { backgroundColor: colors.card, borderColor: hasExport ? "#00D4AA33" : colors.border }]}>
        <View style={styles.loopStepHeader}>
          <View style={[styles.loopStepBadge, { backgroundColor: hasExport ? "#00D4AA22" : colors.secondary }]}>
            {hasExport
              ? <Feather name="check" size={14} color="#00D4AA" />
              : <Text style={[styles.loopStepNum, { color: colors.mutedForeground }]}>1</Text>}
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.loopStepTitle, { color: colors.foreground }]}>Generate Export</Text>
            {hasExport && (
              <Text style={[styles.loopStepNote, { color: "#00D4AA", marginTop: 0 }]}>
                {status!.export!.bot_count} bots · {formatTs(status!.export!.created_at)}
              </Text>
            )}
          </View>
        </View>
        <Text style={[styles.loopStepDesc, { color: colors.mutedForeground }]}>
          Captures the current race/solo state to{" "}
          <Text style={{ fontFamily: "monospace", color: colors.foreground }}>exports/ai_brain/latest_export.json</Text>
          . Also written automatically after every bot cycle.
        </Text>
        <TouchableOpacity
          onPress={() => void handleGenerateExport()}
          disabled={generating}
          style={[styles.loopBtn, { backgroundColor: "#00D4AA22", borderColor: "#00D4AA" }]}
        >
          {generating ? <ActivityIndicator size="small" color="#00D4AA" /> : <Feather name="download" size={14} color="#00D4AA" />}
          <Text style={[styles.loopBtnText, { color: "#00D4AA" }]}>
            {generating ? "Generating…" : hasExport ? "Re-generate Export" : "Generate Export"}
          </Text>
        </TouchableOpacity>
      </Animated.View>

      {/* ── Step 2: Analyze Export (automated) ──────────────────────────────── */}
      <Animated.View entering={FadeInDown.delay(140).springify()} style={[styles.loopStepCard, { backgroundColor: colors.card, borderColor: hasFeedback ? "#A78BFA33" : colors.border }]}>
        <View style={styles.loopStepHeader}>
          <View style={[styles.loopStepBadge, { backgroundColor: hasFeedback ? "#A78BFA22" : colors.secondary }]}>
            {hasFeedback
              ? <Feather name="check" size={14} color="#A78BFA" />
              : <Text style={[styles.loopStepNum, { color: colors.mutedForeground }]}>2</Text>}
          </View>
          <Text style={[styles.loopStepTitle, { color: colors.foreground }]}>Analyze Export</Text>
        </View>
        <Text style={[styles.loopStepDesc, { color: colors.mutedForeground }]}>
          Sends the export to an LLM on the server. The key never leaves the backend. Returns a structured JSON with problems, improvements, and a Replit implementation prompt — no copy/paste required.
        </Text>

        {analysisError && (
          <View style={[styles.loopErrorBox, { backgroundColor: "#FF475715", borderColor: "#FF475744" }]}>
            <Feather name="alert-circle" size={13} color="#FF4757" />
            <Text style={[styles.loopErrorText, { color: "#FF4757" }]}>{analysisError}</Text>
          </View>
        )}

        {analysisResult && (
          <View style={[styles.loopSuccessRow, { backgroundColor: "#A78BFA11" }]}>
            <Feather name="check-circle" size={13} color="#A78BFA" />
            <Text style={[styles.loopSuccessText, { color: "#A78BFA" }]}>
              Done · {analysisResult.problems_count} problems · {analysisResult.changes_count} changes · {analysisResult.files_count} files
            </Text>
          </View>
        )}

        <TouchableOpacity
          onPress={() => void handleAnalyzeExport()}
          disabled={analyzing || !hasExport}
          style={[styles.loopBtn, { backgroundColor: "#A78BFA22", borderColor: "#A78BFA", opacity: hasExport ? 1 : 0.4 }]}
        >
          {analyzing ? <ActivityIndicator size="small" color="#A78BFA" /> : <Feather name="cpu" size={14} color="#A78BFA" />}
          <Text style={[styles.loopBtnText, { color: "#A78BFA" }]}>
            {analyzing ? "Analyzing… (10-20s)" : hasFeedback ? "Re-analyze Export" : "Analyze Export"}
          </Text>
        </TouchableOpacity>

        {!hasExport && (
          <Text style={[styles.loopStepNote, { color: colors.mutedForeground }]}>
            Generate an export first (Step 1).
          </Text>
        )}
      </Animated.View>

      {/* ── Step 3: Review & Apply ───────────────────────────────────────────── */}
      <Animated.View entering={FadeInDown.delay(180).springify()} style={[styles.loopStepCard, { backgroundColor: colors.card, borderColor: hasPrompt ? "#60A5FA33" : colors.border }]}>
        <View style={styles.loopStepHeader}>
          <View style={[styles.loopStepBadge, { backgroundColor: hasPrompt ? "#60A5FA22" : colors.secondary }]}>
            {hasPrompt
              ? <Feather name="check" size={14} color="#60A5FA" />
              : <Text style={[styles.loopStepNum, { color: colors.mutedForeground }]}>3</Text>}
          </View>
          <Text style={[styles.loopStepTitle, { color: colors.foreground }]}>Review & Apply</Text>
        </View>
        <Text style={[styles.loopStepDesc, { color: colors.mutedForeground }]}>
          The AI generates a ready-to-paste Replit Agent prompt. Review it here, approve it, then paste it into Replit Agent to apply changes. No auto-apply — you stay in control.
        </Text>

        <View style={styles.loopActionRow}>
          <TouchableOpacity
            onPress={() => void handleViewReplitPrompt()}
            disabled={!hasPrompt}
            style={[styles.loopSmallBtn, { backgroundColor: "#60A5FA22", borderColor: "#60A5FA55", flex: 1, opacity: hasPrompt ? 1 : 0.4 }]}
          >
            <Feather name="eye" size={13} color="#60A5FA" />
            <Text style={[styles.loopSmallBtnText, { color: "#60A5FA" }]}>View Replit Prompt</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => void handleViewFeedback()}
            disabled={!hasFeedback}
            style={[styles.loopSmallBtn, { backgroundColor: "#A78BFA22", borderColor: "#A78BFA55", flex: 1, opacity: hasFeedback ? 1 : 0.4 }]}
          >
            <Feather name="file-text" size={13} color="#A78BFA" />
            <Text style={[styles.loopSmallBtnText, { color: "#A78BFA" }]}>View Feedback</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.loopActionRow}>
          <TouchableOpacity
            onPress={() => void handleDownloadFeedback()}
            disabled={!hasFeedback}
            style={[styles.loopSmallBtn, { backgroundColor: colors.secondary, borderColor: colors.border, flex: 1, opacity: hasFeedback ? 1 : 0.4 }]}
          >
            <Feather name="download" size={13} color={colors.mutedForeground} />
            <Text style={[styles.loopSmallBtnText, { color: colors.mutedForeground }]}>Download JSON</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => void handleDownloadReplitPrompt()}
            disabled={!hasPrompt}
            style={[styles.loopSmallBtn, { backgroundColor: colors.secondary, borderColor: colors.border, flex: 1, opacity: hasPrompt ? 1 : 0.4 }]}
          >
            <Feather name="download" size={13} color={colors.mutedForeground} />
            <Text style={[styles.loopSmallBtnText, { color: colors.mutedForeground }]}>Download Prompt</Text>
          </TouchableOpacity>
        </View>

        {!hasPrompt && (
          <Text style={[styles.loopStepNote, { color: colors.mutedForeground }]}>
            Run Analyze Export (Step 2) to generate the Replit prompt.
          </Text>
        )}
      </Animated.View>

      {/* ── Manual fallback (collapsible) ────────────────────────────────────── */}
      <TouchableOpacity
        onPress={() => setShowManual((v) => !v)}
        style={[styles.loopCollapseHeader, { borderColor: colors.border }]}
      >
        <Text style={[styles.loopCollapseLabel, { color: colors.mutedForeground }]}>
          Manual feedback (paste ChatGPT JSON)
        </Text>
        <Feather name={showManual ? "chevron-up" : "chevron-down"} size={15} color={colors.mutedForeground} />
      </TouchableOpacity>

      {showManual && (
        <Animated.View entering={FadeInDown.duration(200)} style={[styles.loopStepCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.loopStepDesc, { color: colors.mutedForeground }]}>
            Paste the ChatGPT JSON below if you prefer the manual route. Must match the 6-field schema.
          </Text>
          <TextInput
            value={feedbackInput}
            onChangeText={setFeedbackInput}
            placeholder={'{\n  "summary": "...",\n  "problems_found": [],\n  "recommended_changes": [],\n  "files_to_modify": [],\n  "tests_to_run": [],\n  "next_prompt_for_replit": "..."\n}'}
            placeholderTextColor={colors.mutedForeground}
            multiline
            numberOfLines={8}
            style={[styles.loopTextarea, { backgroundColor: colors.background, borderColor: colors.border, color: colors.foreground }]}
          />
          {lastQueued && (
            <View style={[styles.loopSuccessRow, { backgroundColor: "#00D4AA11" }]}>
              <Feather name="check-circle" size={13} color="#00D4AA" />
              <Text style={[styles.loopSuccessText, { color: "#00D4AA" }]}>Queued · packet {lastQueued.slice(0, 8)}</Text>
            </View>
          )}
          <TouchableOpacity
            onPress={() => void handleQueueFeedback()}
            disabled={queuingFeedback || !feedbackInput.trim()}
            style={[styles.loopBtn, { backgroundColor: "#A78BFA22", borderColor: "#A78BFA", opacity: feedbackInput.trim() ? 1 : 0.4 }]}
          >
            {queuingFeedback ? <ActivityIndicator size="small" color="#A78BFA" /> : <Feather name="zap" size={14} color="#A78BFA" />}
            <Text style={[styles.loopBtnText, { color: "#A78BFA" }]}>Queue Manual Feedback</Text>
          </TouchableOpacity>
        </Animated.View>
      )}

      {/* ── How It Works ─────────────────────────────────────────────────────── */}
      <Animated.View entering={FadeInDown.delay(220).springify()} style={[styles.loopInfoCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Text style={[styles.loopSectionLabel, { color: colors.mutedForeground }]}>HOW IT WORKS</Text>
        {[
          ["package",    "Step 1 — Export",         "Snapshots the race/solo bot state (P&L, trades, logs, scan results) to exports/ai_brain/latest_export.json. Written automatically every bot cycle too."],
          ["cpu",        "Step 2 — Analyze",         "Backend-only: loads the export, builds a structured prompt, calls the LLM with your API key. Returns JSON with 6 fields. Key never touches the client."],
          ["terminal",   "Step 3 — Prompt queued",   "The next_prompt_for_replit field is saved to feedback/replit/latest_prompt.txt. You review it, approve it, then paste it into Replit Agent manually."],
          ["shield",     "Safety guarantee",          "No code is changed automatically. Every step requires human approval. Raw invalid responses are saved to latest_feedback_raw.txt for debugging."],
        ].map(([icon, title, desc]) => (
          <View key={title} style={styles.loopHowRow}>
            <View style={[styles.loopHowIcon, { backgroundColor: colors.secondary }]}>
              <Feather name={icon as "cpu"} size={14} color={colors.mutedForeground} />
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={[styles.loopHowTitle, { color: colors.foreground }]}>{title}</Text>
              <Text style={[styles.loopHowDesc, { color: colors.mutedForeground }]}>{desc}</Text>
            </View>
          </View>
        ))}
      </Animated.View>

      {/* ── Full Feedback Modal ───────────────────────────────────────────────── */}
      <Modal visible={showFeedback} animationType="slide" presentationStyle="pageSheet">
        <View style={[styles.loopModalWrap, { backgroundColor: colors.background }]}>
          <View style={[styles.loopModalHeader, { borderBottomColor: colors.border }]}>
            <Text style={[styles.loopModalTitle, { color: colors.foreground }]}>Feedback Analysis</Text>
            <TouchableOpacity onPress={() => setShowFeedback(false)}>
              <Feather name="x" size={22} color={colors.foreground} />
            </TouchableOpacity>
          </View>
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, gap: 16 }}>
            {feedbackPacket && (
              <>
                {/* Summary */}
                <View style={[styles.loopInfoCard, { backgroundColor: "#A78BFA11", borderColor: "#A78BFA44" }]}>
                  <Text style={[styles.loopSectionLabel, { color: "#A78BFA" }]}>SUMMARY</Text>
                  <Text style={[styles.loopInfoLine, { color: colors.foreground }]}>{feedbackPacket.summary}</Text>
                </View>
                {/* Problems */}
                {feedbackPacket.problems_found?.length > 0 && (
                  <View style={[styles.loopInfoCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                    <Text style={[styles.loopSectionLabel, { color: "#FF4757" }]}>PROBLEMS FOUND ({feedbackPacket.problems_found.length})</Text>
                    {feedbackPacket.problems_found.map((p, i) => (
                      <View key={i} style={styles.loopListRow}>
                        <Text style={{ color: "#FF4757", fontWeight: "800" }}>·</Text>
                        <Text style={[styles.loopListText, { color: colors.foreground }]}>{p}</Text>
                      </View>
                    ))}
                  </View>
                )}
                {/* Recommended changes */}
                {feedbackPacket.recommended_changes?.length > 0 && (
                  <View style={[styles.loopInfoCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                    <Text style={[styles.loopSectionLabel, { color: "#00D4AA" }]}>RECOMMENDED CHANGES ({feedbackPacket.recommended_changes.length})</Text>
                    {feedbackPacket.recommended_changes.map((c, i) => (
                      <View key={i} style={styles.loopListRow}>
                        <Text style={{ color: "#00D4AA", fontWeight: "800" }}>·</Text>
                        <Text style={[styles.loopListText, { color: colors.foreground }]}>{c}</Text>
                      </View>
                    ))}
                  </View>
                )}
                {/* Files to modify */}
                {feedbackPacket.files_to_modify?.length > 0 && (
                  <View style={[styles.loopInfoCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                    <Text style={[styles.loopSectionLabel, { color: "#60A5FA" }]}>FILES TO MODIFY</Text>
                    {feedbackPacket.files_to_modify.map((f, i) => (
                      <Text key={i} style={[styles.loopListText, { color: colors.foreground, fontFamily: "monospace" }]}>{f}</Text>
                    ))}
                  </View>
                )}
                {/* Tests to run */}
                {feedbackPacket.tests_to_run?.length > 0 && (
                  <View style={[styles.loopInfoCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                    <Text style={[styles.loopSectionLabel, { color: "#FFB347" }]}>TESTS TO RUN</Text>
                    {feedbackPacket.tests_to_run.map((t, i) => (
                      <View key={i} style={styles.loopListRow}>
                        <Text style={{ color: "#FFB347", fontWeight: "800" }}>·</Text>
                        <Text style={[styles.loopListText, { color: colors.foreground }]}>{t}</Text>
                      </View>
                    ))}
                  </View>
                )}
              </>
            )}
          </ScrollView>
          <View style={[styles.loopModalFooter, { borderTopColor: colors.border, backgroundColor: colors.background, gap: 10 }]}>
            <TouchableOpacity
              onPress={() => void handleDownloadFeedback()}
              style={[styles.loopCopyBtn, { backgroundColor: "#60A5FA22", borderColor: "#60A5FA" }]}
            >
              <Feather name="download" size={15} color="#60A5FA" />
              <Text style={[styles.loopBtnText, { color: "#60A5FA" }]}>Download Feedback JSON</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* ── Replit Prompt Modal ───────────────────────────────────────────────── */}
      <Modal visible={showReplitPrompt} animationType="slide" presentationStyle="pageSheet">
        <View style={[styles.loopModalWrap, { backgroundColor: colors.background }]}>
          <View style={[styles.loopModalHeader, { borderBottomColor: colors.border }]}>
            <Text style={[styles.loopModalTitle, { color: colors.foreground }]}>Replit Agent Prompt</Text>
            <TouchableOpacity onPress={() => setShowReplitPrompt(false)}>
              <Feather name="x" size={22} color={colors.foreground} />
            </TouchableOpacity>
          </View>
          <View style={[styles.loopSafetyBanner, { backgroundColor: "#FFB34718", borderColor: "#FFB34744" }]}>
            <Feather name="shield" size={13} color="#FFB347" />
            <Text style={[styles.loopSafetyText, { color: "#FFB347" }]}>
              Review this prompt carefully before pasting it into Replit Agent. No code will change until you do.
            </Text>
          </View>
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }}>
            <Text style={[styles.loopPromptText, { color: colors.foreground, backgroundColor: colors.card, borderColor: colors.border }]}>
              {replitPromptText ?? ""}
            </Text>
          </ScrollView>
          <View style={[styles.loopModalFooter, { borderTopColor: colors.border, backgroundColor: colors.background, gap: 10 }]}>
            <TouchableOpacity
              onPress={async () => {
                if (replitPromptText) await copyToClipboard(replitPromptText, "Replit prompt");
              }}
              style={[styles.loopCopyBtn, { backgroundColor: "#60A5FA22", borderColor: "#60A5FA" }]}
            >
              <Feather name="copy" size={15} color="#60A5FA" />
              <Text style={[styles.loopBtnText, { color: "#60A5FA" }]}>Copy Replit Prompt to Clipboard</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => void handleDownloadReplitPrompt()}
              style={[styles.loopCopyBtn, { backgroundColor: "#A78BFA22", borderColor: "#A78BFA" }]}
            >
              <Feather name="download" size={15} color="#A78BFA" />
              <Text style={[styles.loopBtnText, { color: "#A78BFA" }]}>Download Prompt File</Text>
            </TouchableOpacity>
            <Text style={[styles.loopModalHint, { color: colors.mutedForeground }]}>
              Paste this prompt into Replit Agent (Build Mode) to implement the changes.
            </Text>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

// ─── Screen ────────────────────────────────────────────────────────────────────

export default function AIScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [activeTab, setActiveTab] = useState<Tab>("chat");
  const topPad = Platform.OS === "web" ? insets.top + 67 : insets.top;

  const TABS: { key: Tab; label: string; icon: string }[] = [
    { key: "chat", label: "Chat", icon: "message-circle" },
    { key: "signals", label: "Signals", icon: "zap" },
    { key: "coach", label: "Coach", icon: "award" },
    { key: "portfolio", label: "Portfolio", icon: "briefcase" },
    { key: "autopilot", label: "Autopilot", icon: "cpu" },
    { key: "loop", label: "Loop", icon: "refresh-cw" },
  ];

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.navBar, { paddingTop: topPad + 16, borderBottomColor: colors.border }]}>
        <Text style={[styles.title, { color: colors.foreground }]}>TradeBot</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View style={[styles.tabPills, { backgroundColor: colors.secondary }]}>
            {TABS.map((t) => (
              <TouchableOpacity
                key={t.key}
                onPress={() => {
                  setActiveTab(t.key);
                  Haptics.selectionAsync();
                }}
                style={[
                  styles.tabPill,
                  activeTab === t.key && { backgroundColor: t.key === "autopilot" || t.key === "loop" ? "#A78BFA" : colors.primary },
                ]}
              >
                <Feather
                  name={t.icon as "message-circle"}
                  size={13}
                  color={activeTab === t.key ? "#fff" : colors.mutedForeground}
                />
                <Text
                  style={[
                    styles.tabPillText,
                    { color: activeTab === t.key ? "#fff" : colors.mutedForeground },
                  ]}
                >
                  {t.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </ScrollView>
      </View>

      <View style={styles.flex}>
        {activeTab === "chat" && <ChatTab />}
        {activeTab === "signals" && <SignalsTab />}
        {activeTab === "coach" && <CoachTab />}
        {activeTab === "portfolio" && <PortfolioTab />}
        {activeTab === "autopilot" && <AutopilotTab />}
        {activeTab === "loop" && <FeedbackLoopTab />}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { flex: 1 },
  navBar: {
    paddingHorizontal: 20,
    paddingBottom: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 14,
  },
  title: { fontSize: 32, fontWeight: "800", letterSpacing: -0.5 },
  tabPills: {
    flexDirection: "row",
    borderRadius: 10,
    padding: 3,
    gap: 2,
  },
  tabPill: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    paddingVertical: 7,
    paddingHorizontal: 12,
    borderRadius: 8,
  },
  tabPillText: { fontSize: 12, fontWeight: "700" },

  emptyChat: {
    flexGrow: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    gap: 12,
  },
  aiIcon: {
    width: 72,
    height: 72,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 8,
  },
  emptyTitle: { fontSize: 20, fontWeight: "800", textAlign: "center" },
  emptySubtitle: { fontSize: 14, textAlign: "center", lineHeight: 20, maxWidth: 280 },
  quickPrompts: { width: "100%", gap: 8, marginTop: 16 },
  promptChip: { paddingHorizontal: 16, paddingVertical: 12, borderRadius: 12, borderWidth: 1 },
  promptText: { fontSize: 14, lineHeight: 18 },

  chatList: { paddingHorizontal: 16, paddingTop: 16, gap: 12 },
  bubbleWrap: { flexDirection: "row", alignItems: "flex-end", gap: 8 },
  bubbleLeft: { justifyContent: "flex-start" },
  bubbleRight: { justifyContent: "flex-end" },
  aiAvatar: {
    width: 24,
    height: 24,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  bubble: { maxWidth: "80%", padding: 12, borderRadius: 14 },
  userBubble: { borderBottomRightRadius: 4 },
  aiBubble: { borderWidth: 1, borderBottomLeftRadius: 4 },
  bubbleText: { fontSize: 14, lineHeight: 20 },
  toolCall: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    margin: 16,
    marginTop: 4,
    padding: 10,
    borderRadius: 10,
    borderWidth: 1,
  },
  toolCallText: { fontSize: 12, fontWeight: "500" },

  inputBar: {
    flexDirection: "row",
    alignItems: "flex-end",
    paddingHorizontal: 16,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
  clearBtn: { paddingBottom: 12 },
  inputWrap: {
    flex: 1,
    flexDirection: "row",
    alignItems: "flex-end",
    borderRadius: 14,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
  },
  input: { flex: 1, fontSize: 14, maxHeight: 120, lineHeight: 20 },
  sendBtn: {
    width: 32,
    height: 32,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },

  tabContent: { padding: 20, gap: 16 },
  signalsHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 16,
    borderRadius: 14,
    borderWidth: 1,
  },
  signalsHeaderLeft: { gap: 2 },
  signalsTitle: { fontSize: 16, fontWeight: "700" },
  signalsSubtitle: { fontSize: 12, fontWeight: "500" },
  analyzeBtn: { paddingHorizontal: 18, paddingVertical: 10, borderRadius: 10 },
  analyzeBtnText: { fontSize: 14, fontWeight: "700" },
  signalsEmpty: { alignItems: "center", paddingVertical: 40, gap: 12 },
  analysisCard: { borderRadius: 14, borderWidth: 1, padding: 16 },
  analysisText: { fontSize: 14, lineHeight: 22 },

  // Portfolio
  errorBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
  },
  errorText: { fontSize: 13, flex: 1 },
  accountCard: { borderRadius: 16, borderWidth: 1, padding: 16, gap: 14 },
  accountHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" },
  accountLabel: { fontSize: 12, fontWeight: "600", marginBottom: 2 },
  accountValue: { fontSize: 28, fontWeight: "800", letterSpacing: -0.5 },
  accountPl: { fontSize: 13, fontWeight: "600", marginTop: 2 },
  refreshBtn: { width: 36, height: 36, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  accountStats: { flexDirection: "row", alignItems: "center" },
  accountStat: { flex: 1, alignItems: "center", gap: 2 },
  accountStatLabel: { fontSize: 11, fontWeight: "500" },
  accountStatValue: { fontSize: 15, fontWeight: "700" },
  accountStatDivider: { width: 1, height: 32 },
  paperTag: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    alignSelf: "flex-start",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  paperTagText: { fontSize: 11, fontWeight: "500" },
  loadingBox: { alignItems: "center", gap: 8, paddingVertical: 32 },
  loadingText: { fontSize: 14 },

  // Budget UI
  budgetEditRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 4 },
  budgetDollar: { fontSize: 24, fontWeight: "800" },
  budgetInput: {
    fontSize: 24,
    fontWeight: "800",
    borderBottomWidth: 2,
    paddingBottom: 2,
    minWidth: 80,
  },
  budgetSaveBtn: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8 },
  budgetSaveBtnText: { fontSize: 13, fontWeight: "700" },
  budgetValueRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 2 },
  budgetBarSection: { gap: 6 },
  budgetBarTrack: { height: 8, borderRadius: 4, overflow: "hidden" },
  budgetBarFill: { height: 8, borderRadius: 4 },
  budgetBarLabels: { flexDirection: "row", justifyContent: "space-between" },
  budgetBarLabel: { fontSize: 11, fontWeight: "600" },

  // Autopilot
  autopilotCard: { borderRadius: 16, borderWidth: 1, padding: 16, gap: 14 },
  autopilotCardTop: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between" },
  autopilotCardLeft: { flex: 1, gap: 4 },
  autopilotStatusRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  autopilotStatusDot: { width: 7, height: 7, borderRadius: 4 },
  autopilotStatusLabel: { fontSize: 10, fontWeight: "800", letterSpacing: 1 },
  autopilotTitle: { fontSize: 22, fontWeight: "800", letterSpacing: -0.3 },
  autopilotSubtitle: { fontSize: 12, fontWeight: "500" },
  autopilotToggle: {
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    width: 68,
    height: 68,
    borderRadius: 16,
    borderWidth: 1.5,
  },
  autopilotToggleText: { fontSize: 11, fontWeight: "800" },
  autopilotStats: {
    flexDirection: "row",
    alignItems: "center",
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 12,
    gap: 4,
  },
  autopilotStat: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 4 },
  autopilotStatDot: { width: 6, height: 6, borderRadius: 3 },
  autopilotStatLabel: { fontSize: 11, fontWeight: "600" },
  autopilotStatDivider: { width: 1, height: 18 },
  countdown: { fontSize: 11, fontWeight: "600", textAlign: "center" },
  strategyCard: { borderRadius: 14, borderWidth: 1, padding: 16, gap: 12 },
  strategyTitle: { fontSize: 15, fontWeight: "700" },
  strategyRow: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  strategyText: { fontSize: 13, lineHeight: 18, flex: 1 },

  // Strategy Builder
  strategyBuilderHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  strategyBuilderHeaderLeft: { gap: 2 },
  strategyBuilderSubtitle: { fontSize: 12, fontWeight: "500" },
  strategyBuilderBody: { gap: 12 },
  strategyGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  strategyPresetCard: {
    width: "47%",
    borderRadius: 12,
    borderWidth: 1.5,
    padding: 12,
    gap: 3,
    position: "relative",
  },
  strategyPresetEmoji: { fontSize: 22 },
  strategyPresetName: { fontSize: 12, fontWeight: "700" },
  strategyPresetTagline: { fontSize: 11, lineHeight: 15 },
  strategyPresetCheck: {
    position: "absolute",
    top: 8,
    right: 8,
    width: 16,
    height: 16,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  strategyRulesBox: { borderRadius: 10, borderWidth: 1, padding: 12, gap: 5 },
  strategyRulesLabel: { fontSize: 10, fontWeight: "700", letterSpacing: 0.8, marginBottom: 2 },
  strategyRuleLine: { fontSize: 12, lineHeight: 18 },
  strategyCustomBox: { gap: 8 },
  strategyCustomLabel: { fontSize: 12, fontWeight: "600" },
  strategyCustomInput: {
    borderRadius: 10,
    borderWidth: 1,
    padding: 12,
    fontSize: 13,
    lineHeight: 20,
    minHeight: 140,
    textAlignVertical: "top",
  },
  warningBox: { flexDirection: "row", alignItems: "center", gap: 8, padding: 10, borderRadius: 10, borderWidth: 1, marginTop: 4 },
  warningText: { fontSize: 12, flex: 1 },
  logContainer: { borderRadius: 12, borderWidth: 1, overflow: "hidden" },
  logRow: { flexDirection: "row", alignItems: "flex-start", gap: 8, padding: 10, borderLeftWidth: 3 },
  logContent: { flex: 1, gap: 2 },
  logMessage: { fontSize: 13, lineHeight: 18 },
  logTime: { fontSize: 10, fontWeight: "500" },

  // Mode toggle
  modeToggleBar: {
    flexDirection: "row",
    padding: 4,
    gap: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  modeToggleBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 8,
    borderRadius: 8,
  },
  modeToggleBtnText: { fontSize: 12, fontWeight: "700" },

  // Race UI
  raceHeaderCard: { borderRadius: 16, borderWidth: 1, padding: 16, gap: 12 },
  raceHeaderTop: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between" },
  raceTitle: { fontSize: 24, fontWeight: "800", letterSpacing: -0.5 },
  raceSubtitle: { fontSize: 12, fontWeight: "500", marginTop: 2 },
  raceToggleBtn: {
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    width: 68,
    height: 68,
    borderRadius: 16,
    borderWidth: 1.5,
  },
  raceToggleBtnText: { fontSize: 11, fontWeight: "800" },
  raceStatusRow: {
    flexDirection: "row",
    alignItems: "center",
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 12,
    gap: 4,
  },
  raceStatusItem: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 4 },
  raceStatusDot: { width: 6, height: 6, borderRadius: 3 },
  raceStatusText: { fontSize: 11, fontWeight: "600" },
  raceStatusDivider: { width: 1, height: 16 },
  raceBotGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  raceBotCard: { width: "47.5%", borderRadius: 14, borderWidth: 1.5, padding: 12, gap: 8 },
  raceBotHeader: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  raceBotEmoji: { fontSize: 26, lineHeight: 32 },
  raceBotHeaderRight: { flex: 1, gap: 2 },
  raceBotStatusRow: { flexDirection: "row", alignItems: "center", gap: 5 },
  raceBotDot: { width: 6, height: 6, borderRadius: 3 },
  raceBotStatus: { fontSize: 9, fontWeight: "800", letterSpacing: 0.8 },
  raceMedal: { fontSize: 11, marginLeft: 2 },
  raceBotName: { fontSize: 12, fontWeight: "700", lineHeight: 16 },
  raceBotStats: { flexDirection: "row", alignItems: "center", gap: 4 },
  raceBotStat: { flex: 1, alignItems: "center" },
  raceBotStatValue: { fontSize: 15, fontWeight: "800" },
  raceBotStatLabel: { fontSize: 9, fontWeight: "600", letterSpacing: 0.5 },
  raceBotStatDivider: { width: 1, height: 28 },
  raceBotLastLog: { fontSize: 10, lineHeight: 14 },
  raceExplainRow: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  raceExplainEmoji: { fontSize: 18, width: 24 },
  raceExplainName: { fontSize: 13, fontWeight: "700" },
  raceExplainDesc: { fontSize: 12, lineHeight: 17 },
  raceExplainNote: { fontSize: 12, lineHeight: 17, fontStyle: "italic", marginTop: 4 },
  raceLogRow: { flexDirection: "row", alignItems: "flex-start", gap: 6, padding: 8, borderLeftWidth: 3 },
  raceLogBotEmoji: { fontSize: 12, lineHeight: 16 },
  raceCategoryBadge: { alignSelf: "flex-start" as const, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 5, borderWidth: 1 },
  raceCategoryBadgeText: { fontSize: 9, fontWeight: "700" as const, letterSpacing: 0.4 },
  raceStandingsCard: { borderRadius: 14, borderWidth: 1, padding: 14, gap: 10 },
  raceLeaderText: { fontSize: 17, fontWeight: "800" as const, letterSpacing: -0.2 },
  raceCategoryRow: { flexDirection: "row" as const, gap: 8, flexWrap: "wrap" as const },
  raceCategoryPill: { flexDirection: "row" as const, alignItems: "center" as const, gap: 5, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8, backgroundColor: "rgba(255,255,255,0.04)" },
  raceCategoryDot: { width: 6, height: 6, borderRadius: 3 },
  raceCategoryPillText: { fontSize: 11, fontWeight: "600" as const },

  // Feedback Loop Tab
  loopHeaderCard: { borderRadius: 16, borderWidth: 1, padding: 16, gap: 14 },
  loopHeaderTop: { flexDirection: "row", alignItems: "center", gap: 12 },
  loopIconWrap: { width: 44, height: 44, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  loopTitle: { fontSize: 20, fontWeight: "800", letterSpacing: -0.3 },
  loopSubtitle: { fontSize: 12, fontWeight: "500" },
  loopRefreshBtn: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
  loopStatusRow: { flexDirection: "row", alignItems: "center", borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 12, gap: 4 },
  loopStatusItem: { flex: 1, flexDirection: "row", alignItems: "center", gap: 4 },
  loopStatusLabel: { fontSize: 10, fontWeight: "600", flex: 1 },
  loopStatusDivider: { width: 1, height: 16 },
  loopInfoCard: { borderRadius: 14, borderWidth: 1, padding: 14, gap: 6 },
  loopSectionLabel: { fontSize: 10, fontWeight: "700", letterSpacing: 0.6 },
  loopInfoLine: { fontSize: 13, fontWeight: "600", lineHeight: 18 },
  loopInfoMeta: { fontSize: 11, fontWeight: "500" },
  loopFeedbackMeta: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 2 },
  loopStatusBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  loopStatusBadgeText: { fontSize: 10, fontWeight: "800", letterSpacing: 0.5 },
  loopStepCard: { borderRadius: 14, borderWidth: 1, padding: 16, gap: 10 },
  loopStepHeader: { flexDirection: "row", alignItems: "center", gap: 10 },
  loopStepBadge: { width: 28, height: 28, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  loopStepNum: { fontSize: 14, fontWeight: "900" },
  loopStepTitle: { fontSize: 15, fontWeight: "700" },
  loopStepDesc: { fontSize: 12, lineHeight: 18 },
  loopStepNote: { fontSize: 11, lineHeight: 16, fontStyle: "italic" },
  loopBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center",
    gap: 8, paddingVertical: 12, borderRadius: 12, borderWidth: 1,
  },
  loopBtnText: { fontSize: 13, fontWeight: "700" },
  loopTextarea: {
    borderWidth: 1, borderRadius: 12, padding: 12,
    fontSize: 12, lineHeight: 18, fontFamily: "monospace",
    minHeight: 160, textAlignVertical: "top",
  },
  loopSuccessRow: { flexDirection: "row", alignItems: "center", gap: 6, padding: 10, borderRadius: 10 },
  loopSuccessText: { fontSize: 12, fontWeight: "600" },
  loopHowRow: { flexDirection: "row", alignItems: "flex-start", gap: 10, paddingVertical: 8 },
  loopHowIcon: { width: 32, height: 32, borderRadius: 9, alignItems: "center", justifyContent: "center", marginTop: 1 },
  loopHowTitle: { fontSize: 13, fontWeight: "700" },
  loopHowDesc: { fontSize: 11, lineHeight: 16 },
  loopModalWrap: { flex: 1 },
  loopModalHeader: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    padding: 20, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  loopModalTitle: { fontSize: 18, fontWeight: "800" },
  loopModalFooter: { padding: 16, borderTopWidth: StyleSheet.hairlineWidth },
  loopModalHint: { fontSize: 12, lineHeight: 17, textAlign: "center" },
  loopCopyBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 10,
    borderWidth: 1,
  },
  loopPromptText: {
    fontSize: 11, lineHeight: 17, fontFamily: "monospace",
    padding: 14, borderRadius: 12, borderWidth: 1,
  },

  // Feedback Loop — new styles
  loopLlmBadge: {
    flexDirection: "row", alignItems: "center", gap: 5,
    alignSelf: "flex-start", paddingHorizontal: 8, paddingVertical: 3,
    borderRadius: 6, borderWidth: 1,
  },
  loopLlmBadgeText: { fontSize: 10, fontWeight: "700", letterSpacing: 0.4 },
  loopFeedbackTopRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  loopChip: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  loopChipText: { fontSize: 10, fontWeight: "700" },
  loopActionRow: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  loopSmallBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center",
    gap: 5, paddingVertical: 9, paddingHorizontal: 12,
    borderRadius: 10, borderWidth: 1,
  },
  loopSmallBtnText: { fontSize: 12, fontWeight: "700" },
  loopErrorBox: {
    flexDirection: "row", alignItems: "flex-start", gap: 8,
    padding: 10, borderRadius: 10, borderWidth: 1,
  },
  loopErrorText: { fontSize: 12, lineHeight: 17, flex: 1 },
  loopCollapseHeader: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingVertical: 12, paddingHorizontal: 4, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  loopCollapseLabel: { fontSize: 13, fontWeight: "600" },
  loopSafetyBanner: {
    flexDirection: "row", alignItems: "flex-start", gap: 8,
    paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1,
  },
  loopSafetyText: { fontSize: 12, lineHeight: 17, flex: 1 },
  loopListRow: { flexDirection: "row", alignItems: "flex-start", gap: 6, paddingVertical: 2 },
  loopListText: { fontSize: 13, lineHeight: 18, flex: 1 },

  viewToggle: {
    flexDirection: "row",
    borderRadius: 10,
    padding: 3,
    gap: 2,
  },
  viewToggleBtn: { flex: 1, alignItems: "center", paddingVertical: 8, borderRadius: 8 },
  viewToggleBtnText: { fontSize: 13, fontWeight: "700" },
  listSection: { gap: 8 },
  sectionLabel: { fontSize: 11, fontWeight: "700", letterSpacing: 0.5, marginBottom: 4 },
  positionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
  },
  positionAvatar: {
    width: 38,
    height: 38,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  positionAvatarText: { fontSize: 12, fontWeight: "800" },
  positionInfo: { flex: 1, gap: 2 },
  positionSymbol: { fontSize: 14, fontWeight: "700" },
  positionMeta: { fontSize: 11, fontWeight: "500" },
  positionRight: { alignItems: "flex-end", gap: 2 },
  positionValue: { fontSize: 14, fontWeight: "700" },
  positionPl: { fontSize: 11, fontWeight: "600" },
  positionActions: { flexDirection: "row", gap: 4 },
  tradeBtn: {
    width: 28,
    height: 28,
    borderRadius: 7,
    alignItems: "center",
    justifyContent: "center",
  },
  tradeBtnText: { fontSize: 11, fontWeight: "800" },
  orderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
  },
  orderSideBadge: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6 },
  orderSideText: { fontSize: 11, fontWeight: "800" },
  orderInfo: { flex: 1, gap: 2 },
  orderSymbol: { fontSize: 13, fontWeight: "700" },
  orderMeta: { fontSize: 11, fontWeight: "500" },
  orderRight: { alignItems: "flex-end", gap: 4 },
  orderStatus: { fontSize: 11, fontWeight: "700", textTransform: "capitalize" },

  // Modal
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "flex-end",
  },
  modalCard: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: 1,
    padding: 24,
    gap: 16,
  },
  modalHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  modalTitle: { fontSize: 20, fontWeight: "800" },
  modalField: { gap: 6 },
  modalLabel: { fontSize: 12, fontWeight: "600" },
  modalInput: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    fontWeight: "600",
  },
  orderTypeRow: { flexDirection: "row", gap: 8 },
  orderTypeBtn: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
  },
  orderTypeBtnText: { fontSize: 14, fontWeight: "700" },
  paperBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    padding: 10,
    borderRadius: 10,
  },
  paperBadgeText: { fontSize: 12 },
  submitBtn: {
    alignItems: "center",
    paddingVertical: 14,
    borderRadius: 14,
  },
  submitBtnText: { fontSize: 16, fontWeight: "800", color: "#fff" },
});
