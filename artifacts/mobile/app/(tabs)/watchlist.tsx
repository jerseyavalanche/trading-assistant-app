import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import React, { useState } from "react";
import {
  Alert,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import Animated, { FadeInDown, FadeOutLeft } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { EmptyState } from "@/components/EmptyState";
import { SymbolRow } from "@/components/SymbolRow";
import { useChart } from "@/contexts/ChartContext";
import { useWatchlist } from "@/contexts/WatchlistContext";
import { useColors } from "@/hooks/useColors";

export default function WatchlistScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { symbols, prices, loading, refreshPrices, removeSymbol } = useWatchlist();
  const { setSymbol } = useChart();
  const router = useRouter();
  const [editMode, setEditMode] = useState(false);

  const topPad = Platform.OS === "web" ? insets.top + 67 : insets.top;

  const handlePress = (sym: string) => {
    setSymbol(sym);
    router.push("/(tabs)/chart");
  };

  const handleRemove = (sym: string) => {
    Alert.alert("Remove", `Remove ${sym} from watchlist?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: () => {
          removeSymbol(sym);
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        },
      },
    ]);
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.navBar, { paddingTop: topPad + 16, borderBottomColor: colors.border }]}>
        <Text style={[styles.title, { color: colors.foreground }]}>Watchlist</Text>
        <View style={styles.actions}>
          <TouchableOpacity
            onPress={() => {
              setEditMode((e) => !e);
              Haptics.selectionAsync();
            }}
            hitSlop={8}
          >
            <Text style={[styles.editBtn, { color: editMode ? colors.primary : colors.mutedForeground }]}>
              {editMode ? "Done" : "Edit"}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => router.push("/add-symbol")}
            hitSlop={8}
          >
            <Feather name="plus" size={22} color={colors.primary} />
          </TouchableOpacity>
        </View>
      </View>

      {symbols.length === 0 ? (
        <EmptyState
          icon="star"
          title="No symbols yet"
          subtitle="Tap + to add stocks, ETFs or crypto to your watchlist"
        />
      ) : (
        <ScrollView
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={loading}
              onRefresh={refreshPrices}
              tintColor={colors.primary}
              colors={[colors.primary]}
            />
          }
          contentContainerStyle={{ paddingBottom: Platform.OS === "web" ? 84 + 34 : 100 }}
        >
          <View style={[styles.listCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            {symbols.map((sym, idx) => {
              const q = prices[sym];
              return (
                <Animated.View
                  key={sym}
                  entering={FadeInDown.delay(idx * 40).springify()}
                  exiting={FadeOutLeft}
                >
                  <SymbolRow
                    symbol={sym}
                    name={q?.shortName ?? q?.longName}
                    price={q?.regularMarketPrice}
                    change={q?.regularMarketChange}
                    changePercent={q?.regularMarketChangePercent}
                    onPress={() => !editMode && handlePress(sym)}
                    rightAction={
                      editMode ? (
                        <Pressable onPress={() => handleRemove(sym)} hitSlop={8}>
                          <Feather name="minus-circle" size={20} color={colors.destructive} />
                        </Pressable>
                      ) : undefined
                    }
                  />
                </Animated.View>
              );
            })}
          </View>
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
  actions: { flexDirection: "row", alignItems: "center", gap: 18, paddingBottom: 4 },
  editBtn: { fontSize: 15, fontWeight: "600" },
  listCard: {
    marginHorizontal: 20,
    marginTop: 16,
    borderRadius: 14,
    borderWidth: 1,
    overflow: "hidden",
  },
});
