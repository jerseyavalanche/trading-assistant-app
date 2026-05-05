import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import React, { useState } from "react";
import {
  Alert,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { TradeSide, useJournal } from "@/contexts/JournalContext";
import { useColors } from "@/hooks/useColors";

export default function NewEntryScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { addEntry } = useJournal();

  const [symbol, setSymbol] = useState("");
  const [side, setSide] = useState<TradeSide>("BUY");
  const [entryPrice, setEntryPrice] = useState("");
  const [exitPrice, setExitPrice] = useState("");
  const [quantity, setQuantity] = useState("");
  const [notes, setNotes] = useState("");
  const [date] = useState(new Date().toISOString().split("T")[0]);

  const topPad = Platform.OS === "web" ? insets.top + 67 : insets.top;

  const handleSave = async () => {
    if (!symbol.trim()) {
      Alert.alert("Missing symbol", "Please enter a ticker symbol.");
      return;
    }
    const ep = parseFloat(entryPrice);
    const xp = parseFloat(exitPrice);
    const qty = parseFloat(quantity);
    if (isNaN(ep) || isNaN(xp) || isNaN(qty) || qty <= 0) {
      Alert.alert("Invalid values", "Please enter valid entry price, exit price, and quantity.");
      return;
    }

    await addEntry({
      symbol: symbol.toUpperCase(),
      side,
      entryPrice: ep,
      exitPrice: xp,
      quantity: qty,
      notes,
      date,
    });
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    router.back();
  };

  const InputField = ({
    label,
    value,
    onChange,
    placeholder,
    keyboardType = "default",
    autoCapitalize = "characters" as const,
  }: {
    label: string;
    value: string;
    onChange: (t: string) => void;
    placeholder?: string;
    keyboardType?: "default" | "decimal-pad";
    autoCapitalize?: "characters" | "none" | "sentences" | "words";
  }) => (
    <View style={styles.fieldGroup}>
      <Text style={[styles.label, { color: colors.mutedForeground }]}>{label}</Text>
      <TextInput
        style={[styles.input, { backgroundColor: colors.secondary, color: colors.foreground, borderColor: colors.border }]}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={colors.mutedForeground}
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize}
      />
    </View>
  );

  const pnlPreview = () => {
    const ep = parseFloat(entryPrice);
    const xp = parseFloat(exitPrice);
    const qty = parseFloat(quantity);
    if (isNaN(ep) || isNaN(xp) || isNaN(qty)) return null;
    const diff = side === "BUY" ? xp - ep : ep - xp;
    const pnl = diff * qty;
    const pct = ((Math.abs(diff) / ep) * 100 * (diff >= 0 ? 1 : -1)).toFixed(2);
    return { pnl, pct, positive: pnl >= 0 };
  };

  const preview = pnlPreview();

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: topPad + 12, borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={8}>
          <Feather name="x" size={22} color={colors.foreground} />
        </TouchableOpacity>
        <Text style={[styles.title, { color: colors.foreground }]}>Log Trade</Text>
        <TouchableOpacity onPress={handleSave} hitSlop={8}>
          <Text style={[styles.saveBtn, { color: colors.primary }]}>Save</Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.form, { paddingBottom: insets.bottom + 40 }]}
        keyboardShouldPersistTaps="handled"
      >
        <InputField label="SYMBOL" value={symbol} onChange={setSymbol} placeholder="AAPL" />

        <View style={styles.fieldGroup}>
          <Text style={[styles.label, { color: colors.mutedForeground }]}>SIDE</Text>
          <View style={styles.sideRow}>
            {(["BUY", "SELL"] as TradeSide[]).map((s) => (
              <TouchableOpacity
                key={s}
                onPress={() => setSide(s)}
                style={[
                  styles.sideBtn,
                  {
                    backgroundColor:
                      side === s
                        ? s === "BUY"
                          ? colors.positive
                          : colors.negative
                        : colors.secondary,
                    borderColor: colors.border,
                  },
                ]}
              >
                <Text
                  style={[
                    styles.sideBtnText,
                    { color: side === s ? "#fff" : colors.mutedForeground },
                  ]}
                >
                  {s}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        <InputField
          label="ENTRY PRICE"
          value={entryPrice}
          onChange={setEntryPrice}
          placeholder="150.00"
          keyboardType="decimal-pad"
          autoCapitalize="none"
        />
        <InputField
          label="EXIT PRICE"
          value={exitPrice}
          onChange={setExitPrice}
          placeholder="160.00"
          keyboardType="decimal-pad"
          autoCapitalize="none"
        />
        <InputField
          label="QUANTITY"
          value={quantity}
          onChange={setQuantity}
          placeholder="10"
          keyboardType="decimal-pad"
          autoCapitalize="none"
        />

        {preview && (
          <View style={[styles.pnlPreview, { backgroundColor: preview.positive ? "rgba(0,212,170,0.1)" : "rgba(255,71,87,0.1)", borderColor: preview.positive ? colors.positive : colors.negative }]}>
            <Text style={[styles.pnlLabel, { color: colors.mutedForeground }]}>Estimated P&L</Text>
            <Text style={[styles.pnlValue, { color: preview.positive ? colors.positive : colors.negative }]}>
              {preview.positive ? "+" : ""}${preview.pnl.toFixed(2)} ({preview.pct}%)
            </Text>
          </View>
        )}

        <View style={styles.fieldGroup}>
          <Text style={[styles.label, { color: colors.mutedForeground }]}>NOTES</Text>
          <TextInput
            style={[styles.notesInput, { backgroundColor: colors.secondary, color: colors.foreground, borderColor: colors.border }]}
            value={notes}
            onChangeText={setNotes}
            placeholder="Thesis, setup, lessons learned..."
            placeholderTextColor={colors.mutedForeground}
            multiline
            numberOfLines={4}
            textAlignVertical="top"
            autoCapitalize="sentences"
          />
        </View>
      </ScrollView>
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
  saveBtn: { fontSize: 16, fontWeight: "700" },
  form: { padding: 20, gap: 20 },
  fieldGroup: { gap: 8 },
  label: { fontSize: 11, fontWeight: "700", letterSpacing: 1 },
  input: {
    paddingHorizontal: 14,
    paddingVertical: 14,
    borderRadius: 12,
    fontSize: 15,
    fontWeight: "600",
    borderWidth: 1,
  },
  sideRow: { flexDirection: "row", gap: 12 },
  sideBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: "center",
    borderWidth: 1,
  },
  sideBtnText: { fontSize: 15, fontWeight: "800", letterSpacing: 1 },
  pnlPreview: {
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    gap: 4,
    alignItems: "center",
  },
  pnlLabel: { fontSize: 11, fontWeight: "600", letterSpacing: 0.5 },
  pnlValue: { fontSize: 24, fontWeight: "800" },
  notesInput: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 12,
    fontSize: 14,
    borderWidth: 1,
    minHeight: 110,
  },
});
