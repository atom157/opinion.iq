const path = require("path");
const express = require("express");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const app = express();
const PORT = process.env.PORT || 8080;

const OPINION_API_BASE = process.env.OPINION_API_BASE;
const OPINION_API_KEY = process.env.OPINION_API_KEY;

if (!OPINION_API_BASE || !OPINION_API_KEY) {
  console.warn("Missing OPINION_API_BASE or OPINION_API_KEY");
}

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

/* ---------------- utils ---------------- */

function parseTopicId(input) {
  try {
    const url = new URL(input);
    return url.searchParams.get("topicId");
  } catch {
    const m = input?.match(/topicId=(\d+)/);
    return m ? m[1] : null;
  }
}

function headers() {
  return {
    accept: "application/json",
    apikey: OPINION_API_KEY,
  };
}

async function fetchJson(url) {
  const r = await fetch(url, { headers: headers() });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Request failed (${r.status}): ${t}`);
  }
  return r.json();
}

/* ---------------- core logic ---------------- */

async function getAllMarkets() {
  const url = `${OPINION_API_BASE}/v1/markets`;
  const data = await fetchJson(url);

  // OpenAPI returns { data: [...] }
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;

  throw new Error("Market list endpoint returned no array");
}

async function resolveMarketFromTopicId(topicId) {
  const markets = await getAllMarkets();
  const market = markets.find(
    (m) => String(m.topicId) === String(topicId)
  );

  if (!market) {
    throw new Error(`No market found for topicId ${topicId}`);
  }
  return market;
}

/* ---------------- scoring helpers ---------------- */

function sumDepth(orderbook, mid, pct = 1) {
  if (!orderbook || !mid) return 0;
  const delta = mid * (pct / 100);

  const bids =
    orderbook.bids?.filter((b) => b.price >= mid - delta)
      .reduce((s, b) => s + Number(b.size || 0), 0) || 0;

  const asks =
    orderbook.asks?.filter((a) => a.price <= mid + delta)
      .reduce((s, a) => s + Number(a.size || 0), 0) || 0;

  return bids + asks;
}

function score(v, ok, wait, inverse = false) {
  if ((!inverse && v >= ok) || (inverse && v <= ok)) return { label: "OK", score: 1 };
  if ((!inverse && v >= wait) || (inverse && v <= wait)) return { label: "WAIT", score: 0 };
  return { label: "NO TRADE", score: -1 };
}

/* ---------------- API ---------------- */

app.post("/api/analyze", async (req, res) => {
  const topicId = parseTopicId(req.body?.url);

  if (!topicId) {
    return res.status(400).json({ error: "Invalid URL (topicId not found)" });
  }

  try {
    const market = await resolveMarketFromTopicId(topicId);
    const marketId = market.id;

    const [price, orderbook, history] = await Promise.all([
      fetchJson(`${OPINION_API_BASE}/v1/markets/${marketId}/price`),
      fetchJson(`${OPINION_API_BASE}/v1/markets/${marketId}/orderbook`),
      fetchJson(`${OPINION_API_BASE}/v1/markets/${marketId}/history?interval=1h&limit=48`)
    ]);

    const bid = Number(orderbook?.bids?.[0]?.price || 0);
    const ask = Number(orderbook?.asks?.[0]?.price || 0);
    const mid = bid && ask ? (bid + ask) / 2 : Number(price?.price || 0);
    const spreadPct = mid ? ((ask - bid) / mid) * 100 : 0;

    const depth = sumDepth(orderbook, mid, 1);

    const candles = history?.data || [];
    let move1h = 0;
    if (candles.length > 1) {
      const a = candles[candles.length - 1].price;
      const b = candles[candles.length - 2].price;
      move1h = Math.abs(((a - b) / b) * 100);
    }

    const volume24h = Number(market.volume24h || 0);

    const sLiq = score(depth, 25000, 10000);
    const sSpr = score(spreadPct, 2.5, 5, true);
    const sMov = score(move1h, 6, 12, true);
    const sVol = score(volume24h, 50000, 20000);

    const total = sLiq.score + sSpr.score + sMov.score + sVol.score;
    const verdict = total >= 1 ? "OK" : total === 0 ? "WAIT" : "NO TRADE";
    const confidence = Math.round(((total + 4) / 8) * 100);

    res.json({
      topicId,
      marketId,
      verdict,
      confidence,
      facts: [
        { label: "Liquidity (1%)", value: `$${depth.toFixed(0)}`, status: sLiq.label },
        { label: "Spread", value: `${spreadPct.toFixed(2)}%`, status: sSpr.label },
        { label: "1h move", value: `${move1h.toFixed(2)}%`, status: sMov.label },
        { label: "24h volume", value: `$${volume24h.toFixed(0)}`, status: sVol.label }
      ]
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

/* ---------------- start ---------------- */

app.listen(PORT, () => {
  console.log(`Opinion IQ running on http://localhost:${PORT}`);
});
