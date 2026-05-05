import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";

import { useColors } from "@/hooks/useColors";

interface SymbolRowProps {
  symbol: string;
  name?: string;
  price?: number;
  change?: number;
  changePercent?: number;
  currency?: string;
  onPress?: () => void;
  onLongPress?: () => void;
  rightAction?: React.ReactNode;
  compact?: boolean;
}

export function SymbolRow({
  symbol,
  name,
  price,
  change,
  changePercent,
  currency = "USD",
  onPress,
  onLongPress,
  rightAction,
  compact = false,
}: SymbolRowProps) {
  const colors = useColors();
  const scale = useSharedValue(1);

  const animStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const isPositive = (change ?? 0) >= 0;
  const changeColor = isPositive ? colors.positive : colors.negative;

  const formatPrice = (p: number) => {
    if (p >= 1000) return p.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (p >= 1) return p.toFixed(2);
    return p.toFixed(4);
  };

  const formatChange = (c: number) => {
    const sign = c >= 0 ? "+" : "";
    return `${sign}${c.toFixed(2)} (${sign}${changePercent?.toFixed(2)}%)`;
  };

  return (
    <Animated.View style={animStyle}>
      <Pressable
        onPress={() => {
          onPress?.();
          Haptics.selectionAsync();
          scale.value = withSpring(0.97, {}, () => {
            scale.value = withSpring(1);
          });
        }}
        onLongPress={() => {
          onLongPress?.();
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        }}
        style={[styles.row, { borderBottomColor: colors.border }]}
      >
        <View style={styles.left}>
          <View style={[styles.tickerBadge, { backgroundColor: colors.secondary }]}>
            <Text style={[styles.tickerInitial, { color: colors.primary }]}>
              {symbol.charAt(0)}
            </Text>
          </View>
          <View style={styles.nameCol}>
            <Text style={[styles.symbol, { color: colors.foreground }]}>{symbol}</Text>
            {name && !compact && (
              <Text style={[styles.name, { color: colors.mutedForeground }]} numberOfLines={1}>
                {name}
              </Text>
            )}
          </View>
        </View>

        <View style={styles.right}>
          {price !== undefined ? (
            <View style={styles.priceCol}>
              <Text style={[styles.price, { color: colors.foreground }]}>
                {currency === "USD" ? "$" : ""}{formatPrice(price)}
              </Text>
              {change !== undefined && (
                <Text style={[styles.change, { color: changeColor }]}>
                  {formatChange(change)}
                </Text>
              )}
            </View>
          ) : (
            <View style={[styles.priceSkeleton, { backgroundColor: colors.secondary }]} />
          )}
          {rightAction ? (
            rightAction
          ) : (
            <Feather name="chevron-right" size={16} color={colors.mutedForeground} style={styles.chevron} />
          )}
        </View>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  left: {
    flexDirection: "row",
    alignItems: "center",
    flex: 1,
    gap: 12,
  },
  tickerBadge: {
    width: 40,
    height: 40,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  tickerInitial: {
    fontSize: 16,
    fontWeight: "700",
  },
  nameCol: {
    flex: 1,
  },
  symbol: {
    fontSize: 15,
    fontWeight: "700",
    letterSpacing: 0.3,
  },
  name: {
    fontSize: 12,
    marginTop: 2,
  },
  right: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  priceCol: {
    alignItems: "flex-end",
  },
  price: {
    fontSize: 15,
    fontWeight: "700",
  },
  change: {
    fontSize: 11,
    marginTop: 2,
    fontWeight: "500",
  },
  priceSkeleton: {
    width: 80,
    height: 20,
    borderRadius: 6,
  },
  chevron: {
    marginLeft: 4,
  },
});
