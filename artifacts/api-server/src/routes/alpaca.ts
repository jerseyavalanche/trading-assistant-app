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
    headers: { ...alpacaHeaders(), ...(options.headers as Record<string, string> ?? {}) },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Alpaca API error ${res.status}: ${text}`);
  }
  return res.json();
}

router.get("/alpaca/clock", async (req, res) => {
  try {
    const clock = await alpacaFetch("/clock");
    res.json(clock);
  } catch (err) {
    req.log.error({ err }, "alpaca clock error");
    res.status(500).json({ error: String(err) });
  }
});

router.get("/alpaca/account", async (req, res) => {
  try {
    const account = await alpacaFetch("/account");
    res.json(account);
  } catch (err) {
    req.log.error({ err }, "alpaca account error");
    res.status(500).json({ error: String(err) });
  }
});

router.get("/alpaca/positions", async (req, res) => {
  try {
    const positions = await alpacaFetch("/positions");
    res.json(positions);
  } catch (err) {
    req.log.error({ err }, "alpaca positions error");
    res.status(500).json({ error: String(err) });
  }
});

router.get("/alpaca/orders", async (req, res) => {
  try {
    const status = (req.query.status as string) ?? "all";
    const limit = (req.query.limit as string) ?? "20";
    const orders = await alpacaFetch(`/orders?status=${status}&limit=${limit}&direction=desc`);
    res.json(orders);
  } catch (err) {
    req.log.error({ err }, "alpaca orders error");
    res.status(500).json({ error: String(err) });
  }
});

router.post("/alpaca/orders", async (req, res) => {
  const { symbol, qty, side, type, time_in_force, limit_price, notional } = req.body as {
    symbol: string;
    qty?: number;
    notional?: number;
    side: "buy" | "sell";
    type: "market" | "limit" | "stop" | "stop_limit";
    time_in_force: "day" | "gtc" | "ioc" | "fok";
    limit_price?: number;
  };

  if (!symbol || !side || !type || !time_in_force) {
    res.status(400).json({ error: "symbol, side, type, and time_in_force are required" });
    return;
  }
  if (!qty && !notional) {
    res.status(400).json({ error: "either qty or notional is required" });
    return;
  }

  try {
    const body: Record<string, unknown> = { symbol, side, type, time_in_force };
    if (qty) body.qty = String(qty);
    if (notional) body.notional = String(notional);
    if (limit_price) body.limit_price = String(limit_price);

    const order = await alpacaFetch("/orders", {
      method: "POST",
      body: JSON.stringify(body),
    });
    req.log.info({ order }, "paper trade placed");
    res.json(order);
  } catch (err) {
    req.log.error({ err }, "alpaca place order error");
    res.status(500).json({ error: String(err) });
  }
});

router.delete("/alpaca/orders/:id", async (req, res) => {
  try {
    await fetch(`${ALPACA_BASE}/orders/${req.params.id}`, {
      method: "DELETE",
      headers: alpacaHeaders(),
    });
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "alpaca cancel order error");
    res.status(500).json({ error: String(err) });
  }
});

export default router;
