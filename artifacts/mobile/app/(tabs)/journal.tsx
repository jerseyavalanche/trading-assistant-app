import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import React from "react";
import {
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import Animated, { FadeInDown } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { EmptyState } from "@/components/EmptyState";
import { JournalEntry, useJournal } from "@/contexts/JournalContext";
import { useColors } from "@/hooks/useColors";

function JournalCard({ entry, onDelete }: { entry: JournalEntry; onDelete: () => void }) {
  const colors = useColors();
  const isPnlPositive = entry.pnl >= 0;

  return (
    <Pressable
      onLongPress={() => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        Alert.alert("Delete Entry", "Remove this trade from your journal?", [
          { text: "Cancel", style: "cancel" },
          { text: "Delete", style: "destructive", onPress: onDelete },
        ]);
      }}
      style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}
    >
      <View style={styles.cardHeader}>
        <View style={styles.cardLeft}>
          <View style={[styles.sideBadge, { backgroundColor: entry.side === "BUY" ? "rgba(0,212,170,0.15)" : "rgba(255,71,87,0.15)" }]}>
            <Text style={[styles.sideText, { color: entry.side === "BUY" ? colors.positive : colors.negative }]}>
              {entry.side}
            </Text>
          </View>
          <Text style={[styles.symbol, { color: colors.foreground }]}>{entry.symbol}</Text>
        </View>
        <View style={[styles.pnlBadge, { backgroundColor: isPnlPositive ? "rgba(0,212,170,0.12)" : "rgba(255,71,87,0.12)" }]}>
          <Text style={[styles.pnl, { color: isPnlPositive ? colors.positive : colors.negative }]}>
            {isPnlPositive ? "+" : ""}${entry.pnl.toFixed(2)}
          </Text>
        </View>
      </View>

      <View style={styles.metaRow}>
        <Text style={[styles.meta, { color: colors.mutedForeground }]}>
          Entry ${entry.entryPrice.toFixed(2)} · Exit ${entry.exitPrice.toFixed(2)} · Qty {entry.quantity}
        </Text>
      </View>

      <View style={styles.metaRow}>
        <Text style={[styles.meta, { color: colors.mutedForeground }]}>
          {entry.date} · {entry.pnlPercent >= 0 ? "+" : ""}{entry.pnlPercent.toFixed(2)}%
        </Text>
      </View>

      {entry.notes ? (
        <Text style={[styles.notes, { color: colors.foreground, borderTopColor: colors.border }]} numberOfLines={2}>
          {entry.notes}
        </Text>
      ) : null}
    </Pressable>
  );
}

export default function JournalScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { entries, deleteEntry, totalPnl, winRate, tradeCount } = useJournal();
  const router = useRouter();

  const topPad = Platform.OS === "web" ? insets.top + 67 : insets.top;

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.navBar, { paddingTop: topPad + 16, borderBottomColor: colors.border }]}>
        <Text style={[styles.title, { color: colors.foreground }]}>Journal</Text>
        <TouchableOpacity onPress={() => router.push("/new-entry")} hitSlop={8}>
          <Feather name="plus" size={22} color={colors.primary} />
        </TouchableOpacity>
      </View>

      {tradeCount > 0 && (
        <View style={[styles.statsRow, { borderBottomColor: colors.border }]}>
          <View style={styles.stat}>
            <Text style={[styles.statValue, { color: totalPnl >= 0 ? colors.positive : colors.negative }]}>
              {totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)}
            </Text>
            <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>Total P&L</Text>
          </View>
          <View style={[styles.statDivider, { backgroundColor: colors.border }]} />
          <View style={styles.stat}>
            <Text style={[styles.statValue, { color: colors.foreground }]}>{winRate.toFixed(0)}%</Text>
            <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>Win Rate</Text>
          </View>
          <View style={[styles.statDivider, { backgroundColor: colors.border }]} />
          <View style={styles.stat}>
            <Text style={[styles.statValue, { color: colors.foreground }]}>{tradeCount}</Text>
            <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>Trades</Text>
          </View>
        </View>
      )}

      {entries.length === 0 ? (
        <EmptyState
          icon="book"
          title="No trades logged"
          subtitle="Tap + to log your first trade and start tracking your P&L"
        />
      ) : (
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={[
            styles.list,
            { paddingBottom: Platform.OS === "web" ? 84 + 34 : 100 },
          ]}
        >
          {entries.map((entry, idx) => (
            <Animated.View key={entry.id} entering={FadeInDown.delay(idx * 40).springify()}>
              <JournalCard entry={entry} onDelete={() => deleteEntry(entry.id)} />
            </Animated.View>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  navBar: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingBottom: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { fontSize: 32, fontWeight: "800", letterSpacing: -0.5 },
  statsRow: {
    flexDirection: "row",
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  stat: { flex: 1, alignItems: "center" },
  statValue: { fontSize: 18, fontWeight: "800" },
  statLabel: { fontSize: 11, fontWeight: "500", marginTop: 2, letterSpacing: 0.5 },
  statDivider: { width: 1, marginVertical: 4 },
  list: { paddingHorizontal: 20, paddingTop: 16, gap: 12 },
  card: {
    borderRadius: 14,
    borderWidth: 1,
    padding: 16,
    gap: 8,
  },
  cardHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  cardLeft: { flexDirection: "row", alignItems: "center", gap: 10 },
  sideBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  sideText: { fontSize: 11, fontWeight: "800", letterSpacing: 1 },
  symbol: { fontSize: 17, fontWeight: "800" },
  pnlBadge: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8 },
  pnl: { fontSize: 15, fontWeight: "800" },
  metaRow: {},
  meta: { fontSize: 12, fontWeight: "500" },
  notes: {
    fontSize: 13,
    lineHeight: 18,
    paddingTop: 8,
    marginTop: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
