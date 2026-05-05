import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";

import { useColors } from "@/hooks/useColors";

interface MarketCardProps {
  symbol: string;
  label: string;
  price?: number;
  changePercent?: number;
  onPress?: () => void;
}

export function MarketCard({ symbol, label, price, changePercent, onPress }: MarketCardProps) {
  const colors = useColors();
  const scale = useSharedValue(1);
  const animStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  const isPositive = (changePercent ?? 0) >= 0;
  const changeColor = isPositive ? colors.positive : colors.negative;
  const bgColor = isPositive
    ? "rgba(0,212,170,0.08)"
    : "rgba(255,71,87,0.08)";

  const formatPrice = (p: number) => {
    if (p >= 1000) return p.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (p >= 1) return p.toFixed(2);
    return p.toFixed(4);
  };

  return (
    <Animated.View style={animStyle}>
      <Pressable
        onPress={() => {
          onPress?.();
          scale.value = withSpring(0.96, {}, () => {
            scale.value = withSpring(1);
          });
        }}
        style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}
      >
        <View style={[styles.badge, { backgroundColor: bgColor }]}>
          <Text style={[styles.badgeText, { color: changeColor }]}>
            {isPositive ? "▲" : "▼"}{" "}
            {changePercent !== undefined ? `${Math.abs(changePercent).toFixed(2)}%` : "--"}
          </Text>
        </View>
        <Text style={[styles.label, { color: colors.mutedForeground }]}>{label}</Text>
        {price !== undefined ? (
          <Text style={[styles.price, { color: colors.foreground }]}>{formatPrice(price)}</Text>
        ) : (
          <View style={[styles.priceSkeleton, { backgroundColor: colors.secondary }]} />
        )}
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: {
    width: 150,
    padding: 16,
    borderRadius: 14,
    borderWidth: 1,
    gap: 6,
  },
  badge: {
    alignSelf: "flex-start",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    marginBottom: 4,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: "700",
  },
  label: {
    fontSize: 12,
    fontWeight: "500",
  },
  price: {
    fontSize: 18,
    fontWeight: "700",
    letterSpacing: -0.3,
  },
  priceSkeleton: {
    height: 24,
    width: "70%",
    borderRadius: 6,
  },
});
