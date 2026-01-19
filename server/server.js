import express from "express";

const app = express();
const PORT = process.env.PORT || 8080;

const API_BASE = "https://openapi.opinion.trade/openapi";

// 🔒 SAFE FETCH
async function api(path) {
  const r = await fetch(API_BASE + path);
  if (!r.ok) throw new Error(`API ${r.status}`);
  return r.json();
}

// ✅ ОБМЕЖЕНИЙ ПОШУК (НЕ ВБИВАЄ RAILWAY)
async function findChildMarket(childId) {
  const TARGET = String(childId);
  const LIMIT = 20;
  const MAX_PAGES = 10; // ❗ ВАЖЛИВО

  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await api(`/market?page=${page}&limit=${LIMIT}&marketType=2`);
    const list = data?.result?.list || data?.list || [];

    for (const parent of list) {
      if (!Array.isArray(parent.childMarkets)) continue;

      for (const child of parent.childMarkets) {
        if (String(child.marketId) === TARGET) {
          return child;
        }
      }
    }
  }

  return null;
}

// ================= ROUTES =================

app.get("/", (_, res) => {
  res.send("OpinionIQ OK");
});

app.get("/api/debug", async (req, res) => {
  try {
    const { marketId } = req.query;
    if (!marketId) {
      return res.status(400).json({ ok: false, error: "marketId required" });
    }

    const market = await findChildMarket(marketId);

    if (!market) {
      return res.status(404).json({ ok: false, error: "Market not found" });
    }

    res.json({
      ok: true,
      marketId: market.marketId,
      title: market.marketTitle,
      yesTokenId: market.yesTokenId,
      noTokenId: market.noTokenId,
      volume: market.volume,
      chainId: market.chainId,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ==========================================

app.listen(PORT, () => {
  console.log("OpinionIQ running on", PORT);
});
