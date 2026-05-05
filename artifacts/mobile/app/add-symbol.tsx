import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import React, { useCallback, useRef, useState } from "react";
import {
  ActivityIndicator,
  Keyboard,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolRow } from "@/components/SymbolRow";
import { QuoteData, useWatchlist } from "@/contexts/WatchlistContext";
import { useColors } from "@/hooks/useColors";

export default function AddSymbolScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { addSymbol, searchSymbols, symbols } = useWatchlist();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<QuoteData[]>([]);
  const [searching, setSearching] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleSearch = useCallback(
    (text: string) => {
      setQuery(text);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (!text.trim()) {
        setResults([]);
        return;
      }
      debounceRef.current = setTimeout(async () => {
        setSearching(true);
        const res = await searchSymbols(text);
        setResults(res);
        setSearching(false);
      }, 500);
    },
    [searchSymbols]
  );

  const handleAdd = async (sym: string) => {
    await addSymbol(sym);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    router.back();
  };

  const topPad = Platform.OS === "web" ? insets.top + 67 : insets.top;

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: topPad + 12, borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={8}>
          <Feather name="x" size={22} color={colors.foreground} />
        </TouchableOpacity>
        <Text style={[styles.title, { color: colors.foreground }]}>Add Symbol</Text>
        <View style={{ width: 22 }} />
      </View>

      <View style={[styles.searchWrap, { borderBottomColor: colors.border }]}>
        <View style={[styles.searchBox, { backgroundColor: colors.secondary, borderColor: colors.border }]}>
          <Feather name="search" size={15} color={colors.mutedForeground} />
          <TextInput
            style={[styles.input, { color: colors.foreground }]}
            value={query}
            onChangeText={handleSearch}
            placeholder="Search stocks, ETF, crypto..."
            placeholderTextColor={colors.mutedForeground}
            autoFocus
            autoCapitalize="characters"
            returnKeyType="search"
          />
          {query.length > 0 && (
            <TouchableOpacity onPress={() => { setQuery(""); setResults([]); }} hitSlop={8}>
              <Feather name="x-circle" size={15} color={colors.mutedForeground} />
            </TouchableOpacity>
          )}
        </View>
      </View>

      {searching && (
        <ActivityIndicator color={colors.primary} style={styles.loader} />
      )}

      {results.length > 0 && !searching && (
        <View style={[styles.listCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
          {results.map((q) => {
            const alreadyAdded = symbols.includes(q.symbol);
            return (
              <SymbolRow
                key={q.symbol}
                symbol={q.symbol}
                name={q.shortName ?? q.longName}
                price={q.regularMarketPrice}
                changePercent={q.regularMarketChangePercent}
                onPress={() => !alreadyAdded && handleAdd(q.symbol)}
                rightAction={
                  alreadyAdded ? (
                    <Feather name="check" size={18} color={colors.positive} />
                  ) : (
                    <Pressable
                      onPress={() => handleAdd(q.symbol)}
                      style={[styles.addBtn, { backgroundColor: colors.primary }]}
                      hitSlop={8}
                    >
                      <Feather name="plus" size={14} color={colors.primaryForeground} />
                    </Pressable>
                  )
                }
              />
            );
          })}
        </View>
      )}

      {!searching && query.length > 2 && results.length === 0 && (
        <Text style={[styles.noResults, { color: colors.mutedForeground }]}>
          No results for "{query}"
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingBottom: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { fontSize: 17, fontWeight: "700" },
  searchWrap: {
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  searchBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
  },
  input: { flex: 1, fontSize: 15, fontWeight: "500" },
  loader: { marginTop: 30 },
  listCard: {
    marginHorizontal: 20,
    marginTop: 8,
    borderRadius: 14,
    borderWidth: 1,
    overflow: "hidden",
  },
  addBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  noResults: { textAlign: "center", marginTop: 40, fontSize: 14 },
});
