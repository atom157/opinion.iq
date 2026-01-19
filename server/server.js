import express from "express";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;
const BASE = "https://openapi.opinion.trade/openapi";

/* ================= utils ================= */

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

async function openApiGet(path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      "accept": "application/json",
      "user-agent": "opinioniq/1.0",
    },
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return res.json();
}

/* ================= core ================= */

async function fetchMarketDetail(marketId) {
  const id = encodeURIComponent(String(marketId));

  const endpoints = [
    `/market/${id}`,
    `/market/detail?marketId=${id}`,
    `/market/detail?id=${id}`,
    `/market/info?marketId=${id}`,
  ];

  for (const ep of endpoints) {
    try {
      const r = await openApiGet(ep);

      // 🔑 ГОЛОВНЕ ВИПРАВЛЕННЯ
      if (isObj(r?.data)) return r.data;
      if (isObj(r?.result)) return r.result;
      if (isObj(r)) return r;
    } catch (_) {}
  }

  throw new Error("Market not found");
}

/* ================= routes ================= */

app.get("/", (_, res) => {
  res.json({ ok: true, service: "opinioniq", status: "online" });
});

app.get("/api/debug", async (req, res) => {
  try {
    const { marketId } = req.query;
    if (!marketId) return res.status(400).json({ ok: false, error: "marketId required" });

    const market = await fetchMarketDetail(marketId);

    res.json({
      ok: true,
      marketId,
      marketKeys: Object.keys(market),
      yesTokenId: market.yesTokenId || null,
      noTokenId: market.noTokenId || null,
      market,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/analyze", async (req, res) => {
  try {
    const { marketId } = req.query;
    if (!marketId) return res.status(400).json({ ok: false, error: "marketId required" });

    const market = await fetchMarketDetail(marketId);

    if (!market.yesTokenId || !market.noTokenId) {
      return res.json({
        ok: false,
        reason: "NO_TOKENS",
        hint: "use child marketId",
        marketId,
      });
    }

    res.json({
      ok: true,
      marketId,
      title: market.marketTitle,
      yesTokenId: market.yesTokenId,
      noTokenId: market.noTokenId,
      volume: market.volume,
      chainId: market.chainId,
      quoteToken: market.quoteToken,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ================= start ================= */

app.listen(PORT, () => {
  console.log(`🚀 opinioniq running on :${PORT}`);
});
