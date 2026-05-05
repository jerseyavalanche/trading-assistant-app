import React, { createContext, useCallback, useContext, useRef, useState } from "react";
import { Platform } from "react-native";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  id: string;
}

interface AIContextType {
  conversationId: number | null;
  messages: ChatMessage[];
  streaming: boolean;
  startConversation: (title: string) => Promise<number>;
  sendMessage: (content: string, systemPrompt?: string, onToolCall?: (toolName: string) => void) => Promise<void>;
  analyzeWatchlist: (
    symbols: string[],
    prices: Record<string, { price: number; change: number; changePercent: number; name: string }>,
    onChunk: (text: string) => void
  ) => Promise<void>;
  reviewJournal: (
    entries: Array<{
      symbol: string;
      side: string;
      entryPrice: number;
      exitPrice: number;
      quantity: number;
      pnl: number;
      pnlPercent: number;
      notes: string;
      date: string;
    }>,
    onChunk: (text: string) => void
  ) => Promise<void>;
  clearConversation: () => void;
}

const AIContext = createContext<AIContextType | null>(null);

function getBaseUrl() {
  if (Platform.OS === "web") {
    const domain = process.env.EXPO_PUBLIC_DOMAIN ?? "";
    return domain ? `https://${domain}` : "";
  }
  return `https://${process.env.EXPO_PUBLIC_DOMAIN ?? ""}`;
}

async function streamSSE(
  url: string,
  body: unknown,
  onChunk: (text: string) => void,
  onToolCall?: (toolName: string) => void
): Promise<void> {
  const base = getBaseUrl();
  const res = await fetch(`${base}${url}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  if (!res.body) throw new Error("No response body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        try {
          const parsed = JSON.parse(line.slice(6)) as {
            content?: string;
            tool_call?: string;
            done?: boolean;
            error?: string;
          };
          if (parsed.content) onChunk(parsed.content);
          if (parsed.tool_call && onToolCall) onToolCall(parsed.tool_call);
        } catch {
          /* ignore parse errors */
        }
      }
    }
  }
}

export function AIProvider({ children }: { children: React.ReactNode }) {
  const [conversationId, setConversationId] = useState<number | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const streamingMsgId = useRef<string | null>(null);

  const startConversation = useCallback(async (title: string): Promise<number> => {
    const base = getBaseUrl();
    const res = await fetch(`${base}/api/ai/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    const data = (await res.json()) as { id: number };
    setConversationId(data.id);
    setMessages([]);
    return data.id;
  }, []);

  const sendMessage = useCallback(
    async (content: string, systemPrompt?: string, onToolCall?: (toolName: string) => void) => {
      let convId = conversationId;
      if (!convId) {
        convId = await startConversation("Trading Chat");
      }

      const userMsg: ChatMessage = {
        role: "user",
        content,
        id: Date.now().toString(),
      };
      setMessages((prev) => [...prev, userMsg]);

      const assistantId = (Date.now() + 1).toString();
      streamingMsgId.current = assistantId;
      setMessages((prev) => [...prev, { role: "assistant", content: "", id: assistantId }]);
      setStreaming(true);

      try {
        await streamSSE(
          `/api/ai/conversations/${convId}/messages`,
          { content, systemPrompt },
          (chunk) => {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId ? { ...m, content: m.content + chunk } : m
              )
            );
          },
          onToolCall
        );
      } finally {
        setStreaming(false);
        streamingMsgId.current = null;
      }
    },
    [conversationId, startConversation]
  );

  const analyzeWatchlist = useCallback(
    async (
      symbols: string[],
      prices: Record<string, { price: number; change: number; changePercent: number; name: string }>,
      onChunk: (text: string) => void
    ) => {
      await streamSSE("/api/ai/analyze-watchlist", { symbols, prices }, onChunk);
    },
    []
  );

  const reviewJournal = useCallback(
    async (
      entries: Array<{
        symbol: string;
        side: string;
        entryPrice: number;
        exitPrice: number;
        quantity: number;
        pnl: number;
        pnlPercent: number;
        notes: string;
        date: string;
      }>,
      onChunk: (text: string) => void
    ) => {
      await streamSSE("/api/ai/review-journal", { entries }, onChunk);
    },
    []
  );

  const clearConversation = useCallback(() => {
    setConversationId(null);
    setMessages([]);
  }, []);

  return (
    <AIContext.Provider
      value={{
        conversationId,
        messages,
        streaming,
        startConversation,
        sendMessage,
        analyzeWatchlist,
        reviewJournal,
        clearConversation,
      }}
    >
      {children}
    </AIContext.Provider>
  );
}

export function useAI() {
  const ctx = useContext(AIContext);
  if (!ctx) throw new Error("useAI must be used inside AIProvider");
  return ctx;
}
