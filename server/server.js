import express from "express";

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
      if (isObj(r?.data)) return r.data;
      if (isObj(r?.result)) return r.result;
      if (isObj(r)) return r;
    } catch (_) {}
  }

  throw new Error("Market not found");
}

/* ================= routes ================= */

app.get("/", (_, res) => {
  res.json({ ok: true, status: "online" });
});

app.get("/api/debug", async (req, res) => {
  try {
    const { marketId } = req.query;
    if (!marketId) return res.status(400).json({ ok: false, error: "marketId required" });

    const market = await fetchMarketDetail(marketId);

    res.json({
      ok: true,
      marketId,
      yesTokenId: market.yesTokenId || null,
      noTokenId: market.noTokenId || null,
      keys: Object.keys(market),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ================= start ================= */

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on ${PORT}`);
});
