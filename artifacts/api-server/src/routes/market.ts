import { Router } from "express";

const router = Router();

let cachedCrumb: string | null = null;
let cachedCookies: string | null = null;
let crumbExpiry = 0;

const BASE_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
};

async function getCrumb(): Promise<{ crumb: string; cookie: string } | null> {
  if (cachedCrumb && cachedCookies && Date.now() < crumbExpiry) {
    return { crumb: cachedCrumb, cookie: cachedCookies };
  }
  try {
    // Step 1: get consent cookie
    const consentRes = await fetch(
      "https://fc.yahoo.com/v1/test/getcrumb",
      {
        headers: { ...BASE_HEADERS, "Accept": "*/*" },
        redirect: "follow",
      }
    );
    const setCookieHeader = consentRes.headers.get("set-cookie") ?? "";
    const crumbText = await consentRes.text();

    if (crumbText && crumbText.trim().length < 32 && !crumbText.includes("<")) {
      // Got crumb directly
      cachedCrumb = crumbText.trim();
      cachedCookies = setCookieHeader.split(";")[0];
      crumbExpiry = Date.now() + 23 * 60 * 60 * 1000;
      return { crumb: cachedCrumb, cookie: cachedCookies };
    }

    // Step 2: fallback — get consent from query2
    const q2Res = await fetch(
      "https://query2.finance.yahoo.com/v1/test/getcrumb",
      {
        headers: {
          ...BASE_HEADERS,
          "Cookie": setCookieHeader.split(";")[0] || "",
        },
      }
    );
    const rawCrumb = await q2Res.text();
    const newCookies = q2Res.headers.get("set-cookie") ?? setCookieHeader;

    if (rawCrumb && rawCrumb.length < 32 && !rawCrumb.includes("<")) {
      cachedCrumb = rawCrumb.trim();
      cachedCookies = newCookies.split(";")[0];
      crumbExpiry = Date.now() + 23 * 60 * 60 * 1000;
      return { crumb: cachedCrumb, cookie: cachedCookies };
    }
    return null;
  } catch {
    return null;
  }
}

async function fetchV8Chart(sym: string): Promise<{
  symbol: string; shortName: string; longName: string;
  regularMarketPrice: number; regularMarketChange: number;
  regularMarketChangePercent: number; regularMarketVolume: number; currency: string;
} | null> {
  try {
    const res = await fetch(
      `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=5m&range=1d`,
      { headers: BASE_HEADERS }
    );
    if (!res.ok) return null;
    const json = await res.json() as {
      chart?: {
        result?: Array<{
          meta?: {
            symbol: string; regularMarketPrice: number; chartPreviousClose: number;
            shortName?: string; currency?: string;
          };
          indicators?: { quote?: Array<{ volume?: number[] }> };
        }>;
        error?: { code: string };
      };
    };
    if (json?.chart?.error) return null;
    const result = json?.chart?.result?.[0];
    const meta = result?.meta;
    if (!meta?.regularMarketPrice || !meta?.chartPreviousClose) return null;
    const change = meta.regularMarketPrice - meta.chartPreviousClose;
    const changePct = (change / meta.chartPreviousClose) * 100;
    const volumes = result?.indicators?.quote?.[0]?.volume ?? [];
    const lastVol = [...volumes].reverse().find((v) => v != null && v > 0) ?? 0;
    return {
      symbol: meta.symbol ?? sym,
      shortName: meta.shortName ?? sym,
      longName: meta.shortName ?? sym,
      regularMarketPrice: meta.regularMarketPrice,
      regularMarketChange: change,
      regularMarketChangePercent: changePct,
      regularMarketVolume: lastVol,
      currency: meta.currency ?? "USD",
    };
  } catch {
    return null;
  }
}

async function yahooQuotes(symbols: string[]): Promise<unknown> {
  if (symbols.length === 0) return { quoteResponse: { result: [] } };

  // v7/quote returns 401 in this environment — go directly to v8/chart (5m, 1d)
  const results = await Promise.allSettled(symbols.map((s) => fetchV8Chart(s)));
  const quotes = results
    .filter((r): r is PromiseFulfilledResult<NonNullable<Awaited<ReturnType<typeof fetchV8Chart>>>> =>
      r.status === "fulfilled" && r.value !== null
    )
    .map((r) => r.value);

  return { quoteResponse: { result: quotes } };
}

async function yahooSearch(query: string): Promise<string[]> {
  const auth = await getCrumb();
  const hosts = ["https://query2.finance.yahoo.com", "https://query1.finance.yahoo.com"];
  for (const host of hosts) {
    try {
      const crumbParam = auth ? `&crumb=${encodeURIComponent(auth.crumb)}` : "";
      const cookieHeader = auth ? { Cookie: auth.cookie } : {};
      const res = await fetch(
        `${host}/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=8&newsCount=0${crumbParam}`,
        { headers: { ...BASE_HEADERS, ...cookieHeader } }
      );
      if (res.ok) {
        const json = await res.json() as { quotes?: Array<{ symbol: string }> };
        return (json?.quotes ?? []).map((q) => q.symbol);
      }
    } catch {
      continue;
    }
  }
  return [];
}

router.get("/market/quotes", async (req, res) => {
  try {
    const { symbols } = req.query;
    if (!symbols || typeof symbols !== "string") {
      res.status(400).json({ error: "symbols query param required" });
      return;
    }
    const data = await yahooQuotes(symbols.split(",").filter(Boolean));
    res.json(data);
  } catch (err) {
    req.log.error({ err }, "market quotes error");
    res.status(502).json({ error: "Failed to fetch quotes" });
  }
});

router.get("/market/search", async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || typeof q !== "string") {
      res.status(400).json({ error: "q query param required" });
      return;
    }
    const syms = await yahooSearch(q);
    if (syms.length === 0) {
      res.json({ quoteResponse: { result: [] } });
      return;
    }
    const data = await yahooQuotes(syms);
    res.json(data);
  } catch (err) {
    req.log.error({ err }, "market search error");
    res.status(502).json({ error: "Failed to search symbols" });
  }
});

export default router;
