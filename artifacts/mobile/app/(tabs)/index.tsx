import { useRouter } from "expo-router";
import React, { useMemo } from "react";
import {
  ActivityIndicator,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { MarketCard } from "@/components/MarketCard";
import { SymbolRow } from "@/components/SymbolRow";
import { useChart } from "@/contexts/ChartContext";
import { useWatchlist } from "@/contexts/WatchlistContext";
import { useColors } from "@/hooks/useColors";

const INDICES = [
  { symbol: "^GSPC", label: "S&P 500" },
  { symbol: "^IXIC", label: "NASDAQ" },
  { symbol: "^DJI", label: "Dow Jones" },
  { symbol: "BTC-USD", label: "Bitcoin" },
];

export default function MarketsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { prices, loading, refreshPrices, symbols } = useWatchlist();
  const { setSymbol } = useChart();
  const router = useRouter();

  const topMovers = useMemo(() => {
    return Object.values(prices)
      .filter((p) => !INDICES.find((i) => i.symbol === p.symbol))
      .sort((a, b) => Math.abs(b.regularMarketChangePercent) - Math.abs(a.regularMarketChangePercent))
      .slice(0, 6);
  }, [prices]);

  const handleSymbolPress = (sym: string) => {
    setSymbol(sym);
    router.push("/(tabs)/chart");
  };

  const topPad = Platform.OS === "web" ? insets.top + 67 : insets.top;

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: colors.background }]}
      contentContainerStyle={[styles.content, { paddingTop: topPad + 16 }]}
      showsVerticalScrollIndicator={false}
      refreshControl={
        <RefreshControl
          refreshing={loading}
          onRefresh={refreshPrices}
          tintColor={colors.primary}
          colors={[colors.primary]}
        />
      }
    >
      <View style={styles.header}>
        <Text style={[styles.greeting, { color: colors.mutedForeground }]}>Good morning</Text>
        <Text style={[styles.title, { color: colors.foreground }]}>Markets</Text>
      </View>

      <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>INDICES</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.cardsRow}>
        {INDICES.map((idx) => {
          const q = prices[idx.symbol];
          return (
            <MarketCard
              key={idx.symbol}
              symbol={idx.symbol}
              label={idx.label}
              price={q?.regularMarketPrice}
              changePercent={q?.regularMarketChangePercent}
              onPress={() => handleSymbolPress(idx.symbol)}
            />
          );
        })}
        {loading && !Object.keys(prices).length && (
          <ActivityIndicator color={colors.primary} style={styles.loader} />
        )}
      </ScrollView>

      {topMovers.length > 0 && (
        <>
          <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>TOP MOVERS</Text>
          <View style={[styles.listCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            {topMovers.map((q, i) => (
              <SymbolRow
                key={q.symbol}
                symbol={q.symbol}
                name={q.shortName || q.longName}
                price={q.regularMarketPrice}
                change={q.regularMarketChange}
                changePercent={q.regularMarketChangePercent}
                currency={q.currency}
                onPress={() => handleSymbolPress(q.symbol)}
              />
            ))}
          </View>
        </>
      )}

      <View style={{ height: Platform.OS === "web" ? 84 + 34 : 100 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { flexGrow: 1 },
  header: { paddingHorizontal: 20, marginBottom: 24 },
  greeting: { fontSize: 13, fontWeight: "500", marginBottom: 4, letterSpacing: 0.3 },
  title: { fontSize: 32, fontWeight: "800", letterSpacing: -0.5 },
  sectionTitle: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1.5,
    marginBottom: 12,
    marginTop: 4,
    paddingHorizontal: 20,
  },
  cardsRow: {
    paddingHorizontal: 20,
    gap: 12,
    paddingBottom: 8,
    marginBottom: 24,
  },
  listCard: {
    marginHorizontal: 20,
    borderRadius: 14,
    borderWidth: 1,
    overflow: "hidden",
    marginBottom: 24,
  },
  loader: { alignSelf: "center", marginLeft: 20 },
});
