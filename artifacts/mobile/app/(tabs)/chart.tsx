import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import React, { useCallback, useRef, useState } from "react";
import {
  Dimensions,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import WebView from "react-native-webview";

import { useChart } from "@/contexts/ChartContext";
import { useWatchlist } from "@/contexts/WatchlistContext";
import { useColors } from "@/hooks/useColors";

const INTERVALS = [
  { label: "1m", value: "1" },
  { label: "5m", value: "5" },
  { label: "15m", value: "15" },
  { label: "1H", value: "60" },
  { label: "4H", value: "240" },
  { label: "1D", value: "D" },
  { label: "1W", value: "W" },
];

const SCREEN_HEIGHT = Dimensions.get("window").height;

export default function ChartScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { symbol, setSymbol, interval, setInterval } = useChart();
  const { symbols } = useWatchlist();
  const [inputSymbol, setInputSymbol] = useState(symbol);
  const [webViewKey, setWebViewKey] = useState(0);
  const inputRef = useRef<TextInput>(null);

  const topPad = Platform.OS === "web" ? insets.top + 67 : insets.top;
  const chartHeight = SCREEN_HEIGHT - topPad - 60 - 52 - (Platform.OS === "web" ? 84 + 34 : 80);

  const tvUrl = `https://s.tradingview.com/widgetembed/?frameElementId=tvwidget&symbol=${encodeURIComponent(symbol)}&interval=${interval}&theme=dark&style=1&locale=en&allow_symbol_change=0&save_image=0&hide_top_toolbar=0&hide_legend=0&calendar=0&studies=[]&news=[]`;

  const applySymbol = useCallback(() => {
    const cleaned = inputSymbol.trim().toUpperCase();
    if (cleaned) {
      setSymbol(cleaned);
      setWebViewKey((k) => k + 1);
      inputRef.current?.blur();
    }
  }, [inputSymbol, setSymbol]);

  const handleIntervalChange = (iv: string) => {
    setInterval(iv);
    setWebViewKey((k) => k + 1);
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.navBar, { paddingTop: topPad + 12, borderBottomColor: colors.border }]}>
        <View style={[styles.searchBox, { backgroundColor: colors.secondary, borderColor: colors.border }]}>
          <Feather name="search" size={14} color={colors.mutedForeground} />
          <TextInput
            ref={inputRef}
            style={[styles.searchInput, { color: colors.foreground }]}
            value={inputSymbol}
            onChangeText={setInputSymbol}
            onSubmitEditing={applySymbol}
            autoCapitalize="characters"
            returnKeyType="search"
            placeholder="Symbol (e.g. AAPL)"
            placeholderTextColor={colors.mutedForeground}
            selectTextOnFocus
          />
        </View>
        <TouchableOpacity
          onPress={applySymbol}
          style={[styles.goBtn, { backgroundColor: colors.primary }]}
        >
          <Text style={[styles.goBtnText, { color: colors.primaryForeground }]}>Go</Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.intervalRow}
        style={[styles.intervalScroll, { borderBottomColor: colors.border }]}
      >
        {INTERVALS.map((iv) => (
          <TouchableOpacity
            key={iv.value}
            onPress={() => handleIntervalChange(iv.value)}
            style={[
              styles.intervalBtn,
              interval === iv.value && { backgroundColor: colors.primary },
            ]}
          >
            <Text
              style={[
                styles.intervalText,
                { color: interval === iv.value ? colors.primaryForeground : colors.mutedForeground },
              ]}
            >
              {iv.label}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      <View style={[styles.chartContainer, { height: chartHeight }]}>
        {Platform.OS === "web" ? (
          <View style={styles.webFallback}>
            <Feather name="bar-chart-2" size={40} color={colors.mutedForeground} />
            <Text style={[styles.webFallbackText, { color: colors.mutedForeground }]}>
              Open TradingView in your browser for charts
            </Text>
            <Text style={[styles.webFallbackLink, { color: colors.primary }]}>
              tradingview.com/chart?symbol={symbol}
            </Text>
          </View>
        ) : (
          <WebView
            key={webViewKey}
            source={{ uri: tvUrl }}
            style={[styles.webView, { backgroundColor: colors.background }]}
            originWhitelist={["*"]}
            javaScriptEnabled
            domStorageEnabled
            startInLoadingState
            allowsInlineMediaPlayback
            mediaPlaybackRequiresUserAction={false}
            scrollEnabled={false}
          />
        )}
      </View>

      <View style={[styles.quickSymbols, { borderTopColor: colors.border }]}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.quickRow}>
          {symbols.slice(0, 10).map((sym) => (
            <TouchableOpacity
              key={sym}
              onPress={() => {
                setSymbol(sym);
                setInputSymbol(sym);
                setWebViewKey((k) => k + 1);
              }}
              style={[
                styles.quickBtn,
                {
                  backgroundColor: symbol === sym ? colors.primary : colors.secondary,
                },
              ]}
            >
              <Text
                style={[
                  styles.quickBtnText,
                  { color: symbol === sym ? colors.primaryForeground : colors.foreground },
                ]}
              >
                {sym}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  navBar: {
    flexDirection: "row",
    alignItems: "flex-end",
    paddingHorizontal: 16,
    paddingBottom: 12,
    gap: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  searchBox: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    fontWeight: "600",
  },
  goBtn: {
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 10,
  },
  goBtnText: { fontSize: 14, fontWeight: "700" },
  intervalScroll: { borderBottomWidth: StyleSheet.hairlineWidth, maxHeight: 52 },
  intervalRow: {
    paddingHorizontal: 14,
    alignItems: "center",
    gap: 4,
  },
  intervalBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
  },
  intervalText: { fontSize: 13, fontWeight: "600" },
  chartContainer: { flex: 1 },
  webView: { flex: 1 },
  webFallback: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    padding: 40,
  },
  webFallbackText: { fontSize: 15, textAlign: "center" },
  webFallbackLink: { fontSize: 13, fontWeight: "600" },
  quickSymbols: { borderTopWidth: StyleSheet.hairlineWidth },
  quickRow: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 8,
    alignItems: "center",
    minHeight: Platform.OS === "web" ? 84 + 14 : 60,
  },
  quickBtn: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 20,
  },
  quickBtnText: { fontSize: 12, fontWeight: "700", letterSpacing: 0.3 },
});
