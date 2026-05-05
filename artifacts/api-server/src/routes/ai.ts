import { db } from "@workspace/db";
import { conversations, insertConversationSchema, messages } from "@workspace/db/schema";
import { openai } from "@workspace/integrations-openai-ai-server";
import { eq, asc } from "drizzle-orm";
import { Router } from "express";

const router = Router();

const ALPACA_BASE = "https://paper-api.alpaca.markets/v2";

function alpacaHeaders() {
  return {
    "APCA-API-KEY-ID": process.env.ALPACA_API_KEY ?? "",
    "APCA-API-SECRET-KEY": process.env.ALPACA_API_SECRET ?? "",
    "Content-Type": "application/json",
  };
}

async function alpacaFetch(path: string, options: RequestInit = {}) {
  const res = await fetch(`${ALPACA_BASE}${path}`, {
    ...options,
    headers: { ...alpacaHeaders(), ...((options.headers as Record<string, string>) ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Alpaca ${res.status}: ${text}`);
  return JSON.parse(text);
}

const ALPACA_TOOLS: Parameters<typeof openai.chat.completions.create>[0]["tools"] = [
  {
    type: "function",
    function: {
      name: "get_account",
      description: "Get the Alpaca paper trading account info: buying power, equity, cash, P&L.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_positions",
      description: "Get all current open positions in the Alpaca paper trading account.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_orders",
      description: "Get recent orders from the Alpaca paper trading account.",
      parameters: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["open", "closed", "all"],
            description: "Filter orders by status. Defaults to 'all'.",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "place_order",
      description:
        "Place a paper trade order on Alpaca. Use market orders for immediate execution. Always confirm the details with the user before placing.",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Stock ticker symbol, e.g. AAPL" },
          side: { type: "string", enum: ["buy", "sell"], description: "Buy or sell" },
          qty: { type: "number", description: "Number of shares. Use this OR notional, not both." },
          notional: {
            type: "number",
            description: "Dollar amount to trade. Use this OR qty, not both.",
          },
          type: {
            type: "string",
            enum: ["market", "limit"],
            description: "Order type. Use market for immediate fill.",
          },
          time_in_force: {
            type: "string",
            enum: ["day", "gtc"],
            description: "day = expires end of day, gtc = good till cancelled",
          },
          limit_price: {
            type: "number",
            description: "Required if type is limit. The max price to pay (buy) or min to accept (sell).",
          },
        },
        required: ["symbol", "side", "type", "time_in_force"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cancel_order",
      description: "Cancel an open paper trade order by its order ID.",
      parameters: {
        type: "object",
        properties: {
          order_id: { type: "string", description: "The Alpaca order ID to cancel." },
        },
        required: ["order_id"],
      },
    },
  },
];

async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
  try {
    if (name === "get_account") {
      const data = await alpacaFetch("/account");
      return JSON.stringify(data);
    }
    if (name === "get_positions") {
      const data = await alpacaFetch("/positions");
      return JSON.stringify(data);
    }
    if (name === "get_orders") {
      const status = (args.status as string) ?? "all";
      const data = await alpacaFetch(`/orders?status=${status}&limit=20&direction=desc`);
      return JSON.stringify(data);
    }
    if (name === "place_order") {
      const body: Record<string, unknown> = {
        symbol: args.symbol,
        side: args.side,
        type: args.type,
        time_in_force: args.time_in_force,
      };
      if (args.qty) body.qty = String(args.qty);
      if (args.notional) body.notional = String(args.notional);
      if (args.limit_price) body.limit_price = String(args.limit_price);
      const data = await alpacaFetch("/orders", {
        method: "POST",
        body: JSON.stringify(body),
      });
      return JSON.stringify(data);
    }
    if (name === "cancel_order") {
      await fetch(`${ALPACA_BASE}/orders/${args.order_id}`, {
        method: "DELETE",
        headers: alpacaHeaders(),
      });
      return JSON.stringify({ success: true, order_id: args.order_id });
    }
    return JSON.stringify({ error: `Unknown tool: ${name}` });
  } catch (err) {
    return JSON.stringify({ error: String(err) });
  }
}

router.post("/ai/conversations", async (req, res) => {
  try {
    const parsed = insertConversationSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid body" });
      return;
    }
    const [conv] = await db.insert(conversations).values(parsed.data).returning();
    res.json(conv);
  } catch (err) {
    req.log.error({ err }, "create conversation error");
    res.status(500).json({ error: "Failed to create conversation" });
  }
});

router.get("/ai/conversations/:id/messages", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const msgs = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, id))
      .orderBy(asc(messages.createdAt));
    res.json(msgs);
  } catch (err) {
    req.log.error({ err }, "get messages error");
    res.status(500).json({ error: "Failed to get messages" });
  }
});

router.post("/ai/conversations/:id/messages", async (req, res) => {
  const id = parseInt(req.params.id);
  const { content, systemPrompt } = req.body as {
    content: string;
    systemPrompt?: string;
  };

  if (!content?.trim()) {
    res.status(400).json({ error: "content is required" });
    return;
  }

  try {
    await db.insert(messages).values({ conversationId: id, role: "user", content });

    const history = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, id))
      .orderBy(asc(messages.createdAt));

    type ChatMsg = { role: "user" | "assistant" | "system"; content: string };
    const chatMessages: ChatMsg[] = history.map((m) => ({
      role: m.role as "user" | "assistant" | "system",
      content: m.content,
    }));

    if (systemPrompt) {
      chatMessages.unshift({ role: "system", content: systemPrompt });
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    let fullResponse = "";

    // Agentic loop: keep running until the model stops calling tools
    const runMessages: Parameters<typeof openai.chat.completions.create>[0]["messages"] =
      chatMessages as Parameters<typeof openai.chat.completions.create>[0]["messages"];

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const response = await openai.chat.completions.create({
        model: "gpt-5.4",
        max_completion_tokens: 8192,
        messages: runMessages,
        tools: ALPACA_TOOLS,
        tool_choice: "auto",
        stream: false,
      });

      const choice = response.choices[0];
      if (!choice) break;

      const msg = choice.message;

      // If the model wants to call tools
      if (choice.finish_reason === "tool_calls" && msg.tool_calls?.length) {
        // Push the assistant's tool-call message into the loop
        runMessages.push(msg as Parameters<typeof openai.chat.completions.create>[0]["messages"][number]);

        // Signal to the client that a tool is being called
        for (const tc of msg.tool_calls) {
          const toolName = tc.function.name;
          res.write(
            `data: ${JSON.stringify({ tool_call: toolName })}\n\n`
          );

          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
          } catch {
            /* ignore */
          }

          const result = await executeTool(toolName, args);

          runMessages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: result,
          } as Parameters<typeof openai.chat.completions.create>[0]["messages"][number]);
        }
        // Continue loop — model will now respond with text
        continue;
      }

      // Final text response — stream it token by token
      const textContent = msg.content ?? "";
      if (textContent) {
        // Simulate streaming by chunking words (non-streaming call was used for tool support)
        const words = textContent.split(/(?<=\s)/);
        for (const word of words) {
          fullResponse += word;
          res.write(`data: ${JSON.stringify({ content: word })}\n\n`);
        }
      }
      break;
    }

    await db.insert(messages).values({
      conversationId: id,
      role: "assistant",
      content: fullResponse,
    });

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (err) {
    req.log.error({ err }, "send message error");
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to process message" });
    } else {
      res.write(`data: ${JSON.stringify({ error: "Stream error" })}\n\n`);
      res.end();
    }
  }
});

router.post("/ai/analyze-watchlist", async (req, res) => {
  const { symbols, prices } = req.body as {
    symbols: string[];
    prices: Record<
      string,
      { price: number; change: number; changePercent: number; name: string }
    >;
  };

  if (!symbols?.length) {
    res.status(400).json({ error: "symbols required" });
    return;
  }

  const priceContext = symbols
    .map((s) => {
      const q = prices?.[s];
      if (!q) return `${s}: no data`;
      const direction = q.changePercent >= 0 ? "up" : "down";
      return `${s} (${q.name}): $${q.price.toFixed(2)}, ${direction} ${Math.abs(q.changePercent).toFixed(2)}% today`;
    })
    .join("\n");

  try {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const stream = await openai.chat.completions.create({
      model: "gpt-5.4",
      max_completion_tokens: 2048,
      stream: true,
      messages: [
        {
          role: "system",
          content: `You are a sharp, concise trading analyst. Analyze the user's watchlist and provide brief, actionable insights. 
Format your response as a list of signals using these emojis:
🟢 for bullish signals / consider buying
🔴 for bearish signals / consider caution  
🟡 for neutral / watch closely
⚡ for notable momentum

Keep each signal to 1-2 sentences. Be direct and specific. Mention key levels, patterns, or catalysts where relevant.
Do not give financial advice disclaimers — the user knows this is informational only.`,
        },
        {
          role: "user",
          content: `Analyze my watchlist:\n\n${priceContext}\n\nGive me trading signals and actionable insights for each.`,
        },
      ],
    });

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        res.write(`data: ${JSON.stringify({ content })}\n\n`);
      }
    }

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (err) {
    req.log.error({ err }, "analyze watchlist error");
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to analyze" });
    } else {
      res.write(`data: ${JSON.stringify({ error: "Stream error" })}\n\n`);
      res.end();
    }
  }
});

router.post("/ai/review-journal", async (req, res) => {
  const { entries } = req.body as {
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
    }>;
  };

  if (!entries?.length) {
    res.status(400).json({ error: "entries required" });
    return;
  }

  const tradeContext = entries
    .slice(0, 20)
    .map(
      (e) =>
        `${e.date} | ${e.side} ${e.symbol} | Entry: $${e.entryPrice} → Exit: $${e.exitPrice} | Qty: ${e.quantity} | P&L: ${e.pnl >= 0 ? "+" : ""}$${e.pnl.toFixed(2)} (${e.pnlPercent.toFixed(2)}%)${e.notes ? ` | Notes: ${e.notes}` : ""}`
    )
    .join("\n");

  const totalPnl = entries.reduce((sum, e) => sum + e.pnl, 0);
  const wins = entries.filter((e) => e.pnl > 0).length;
  const winRate = ((wins / entries.length) * 100).toFixed(1);

  try {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const stream = await openai.chat.completions.create({
      model: "gpt-5.4",
      max_completion_tokens: 2048,
      stream: true,
      messages: [
        {
          role: "system",
          content: `You are a professional trading coach reviewing a trader's journal. Be direct, insightful, and specific. 
Structure your review with these sections:
**Performance Summary** — key stats and overall assessment
**Patterns & Strengths** — what they're doing well
**Areas to Improve** — specific weaknesses in their trading behavior
**Actionable Advice** — 2-3 concrete steps to improve

Be honest but constructive. Reference specific trades from their journal. Keep it under 400 words.`,
        },
        {
          role: "user",
          content: `Here are my recent trades:\n\nTotal P&L: ${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)}\nWin Rate: ${winRate}%\nTrades: ${entries.length}\n\n${tradeContext}\n\nPlease review my trading journal and give me feedback.`,
        },
      ],
    });

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        res.write(`data: ${JSON.stringify({ content })}\n\n`);
      }
    }

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (err) {
    req.log.error({ err }, "review journal error");
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to review journal" });
    } else {
      res.write(`data: ${JSON.stringify({ error: "Stream error" })}\n\n`);
      res.end();
    }
  }
});

export default router;
