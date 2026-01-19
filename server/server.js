import express from "express";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 8080;

const API_BASE = "https://openapi.opinion.trade/openapi";

async function openApiGet(path) {
  const r = await fetch(API_BASE + path, {
    headers: {
      "content-type": "application/json",
    },
  });
  if (!r.ok) throw new Error(`OpenAPI ${r.status}`);
  return r.json();
}

// 🔥 ЄДИНА ФУНКЦІЯ ПОШУКУ МАРКЕТУ (БЕЗ DETAIL)
async function findMarketById(targetId) {
  const target = String(targetId);
  const LIMIT = 20;
  const MAX_PAGES = 60;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await openApiGet(`/market?page=${page}&limit=${LIMIT}&marketType=2`);
    const list = r?.result?.list || r?.list || [];
    if (!Array.isArray(list)) continue;

    for (const parent of list) {
      // 1️⃣ прямий маркет
      if (String(parent.marketId) === target) return parent;

      // 2️⃣ дочірній маркет
      if (Array.isArray(parent.childMarkets)) {
        for (const child of parent.childMarkets) {
          if (String(child.marketId) === target) return child;
        }
      }
    }
  }

  return null;
}

// ================= ROUTES =================

app.get("/", (_, res) => {
  res.send("OpinionIQ API is running");
});

app.get("/api/debug", async (req, res) => {
  try {
    const { marketId } = req.query;
    if (!marketId) {
      return res.status(400).json({ ok: false, error: "marketId required" });
    }

    const market = await findMarketById(marketId);

    if (!market) {
      return res.status(404).json({ ok: false, error: "Market not found" });
    }

    res.json({
      ok: true,
      marketId: market.marketId,
      marketTitle: market.marketTitle,
      yesTokenId: market.yesTokenId || null,
      noTokenId: market.noTokenId || null,
      hasTokens: Boolean(market.yesTokenId || market.noTokenId),
      raw: market,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ==========================================

app.listen(PORT, () => {
  console.log(`OpinionIQ running on port ${PORT}`);
});
