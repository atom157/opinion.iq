const path = require("path");
const express = require("express");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const app = express();
const PORT = process.env.PORT || 3000;

const OPINION_API_KEY = process.env.OPINION_API_KEY;

// Normalize base: allow either "https://openapi.opinion.trade" or ".../openapi"
function normalizeApiBase(raw) {
  if (!raw) return null;
  const base = String(raw).trim().replace(/\/+$/, "");
  return base.endsWith("/openapi") ? base : `${base}/openapi`;
}

const OPINION_API_BASE = normalizeApiBase(process.env.OPINION_API_BASE);

if (!OPINION_API_BASE || !OPINION_API_KEY) {
  console.warn(
    "Missing OPINION_API_BASE or OPINION_API_KEY. Create a .env file from .env.example."
  );
}

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

function parseTopicId(input) {
  if (!input) return null;

  try {
    const url = new URL(input);
    return url.searchParams.get("topicId");
  } catch (error) {
    if (input.includes("topicId")) {
      const match = input.match(/topicId=(\d+)/);
      return match ? match[1] : null;
    }
    return null;
  }
}

function getHeaders() {
  return {
    accept: "application/json",
    apikey: OPINION_API_KEY,
  };
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: getHeaders() });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Request failed (${response.status}): ${text}`);
  }
  return response.json();
}

// ---- Opinion helpers ----

// Fetch list and find market by topicId (topicId from app.opinion.trade URL is NOT marketId in OpenAPI)
async function getMarketIdByTopicId(topicId)  {
  const listUrl = `${OPINION_API_BASE}/market`;
  const list = await fetchJson(listUrl);

  const markets =
    list?.data ||
    list?.markets ||
    list?.items ||
    (Array.isArray(list) ? list : []);

  if (!Array.isArray(markets)) {
    throw new Error("Unexpected /market response format");
  }

  const found = markets.find(
    (m) => String(m.topicId) === String(topicId)
  );

  if (!found?.id) {
    throw new Error(`Market not found for topicId ${topicId}`);
  }

  return found.id;
}

// Optional: pull market detail (binary or categorical)
async function getMarketDetail(marketId) {
  try {
    return await fetchJson(`${OPINION_API_BASE}/market/${marketId}`);
  } catch (e) {
    // Fallback categorical (some markets might be categorical)
    try {
      return await fetchJson(`${OPINION_API_BASE}/market/categorical/${marketId}`);
    } catch {
      throw e;
    }
  }
}

function sumDepthWithinPercent(orderbook, mid, percent) {
  if (!orderbook || !mid) return 0;

  const threshold = mid * (percent / 100);
  const maxBid = mid + threshold;
  const minAsk = mid - threshold;

  const bidDepth = Array.isArray(orderbook.bids)
    ? orderbook.bids
        .filter((bid) => bid.price >= minAsk)
        .reduce((total, bid) => total + Number(bid.size || 0), 0)
    : 0;

  const askDepth = Array.isArray(orderbook.asks)
    ? orderbook.asks
        .filter((ask) => ask.price <= maxBid)
        .reduce((total, ask) => total + Number(ask.size || 0), 0)
    : 0;

  return bidDepth + askDepth;
}

function scoreMetric(value, thresholds) {
  if (value >= thresholds.ok) return { label: "OK", score: 1 };
  if (value >= thresholds.wait) return { label: "WAIT", score: 0 };
  return { label: "NO TRADE", score: -1 };
}

function scoreInverseMetric(value, thresholds) {
  if (value <= thresholds.ok) return { label: "OK", score: 1 };
  if (value <= thresholds.wait) return { label: "WAIT", score: 0 };
  return { label: "NO TRADE", score: -1 };
}

function getVerdict(total) {
  if (total >= 1) return "OK";
  if (total === 0) return "WAIT";
  return "NO TRADE";
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

app.post("/api/analyze", async (req, res) => {
  const { url } = req.body;
  const topicId = parseTopicId(url);

  if (!topicId) {
    return res.status(400).json({ error: "Invalid URL. Could not find topicId." });
  }

  if (!OPINION_API_BASE || !OPINION_API_KEY) {
    return res.status(500).json({ error: "Missing API configuration." });
  }

  try {
    // 1) topicId -> marketId
    const marketId = await getMarketIdByTopicId(topicId);

    // 2) use marketId for endpoints
    const priceUrl = `${OPINION_API_BASE}/market/${marketId}/price`;
    const orderbookUrl = `${OPINION_API_BASE}/market/${marketId}/orderbook`;
    const historyUrl = `${OPINION_API_BASE}/market/${marketId}/history?interval=1h&limit=48`;

    // Market detail (binary/categorical)
    const marketPromise = getMarketDetail(marketId);

    const [market, latestPrice, orderbook, history] = await Promise.all([
      marketPromise,
      fetchJson(priceUrl),
      fetchJson(orderbookUrl),
      fetchJson(historyUrl),
    ]);

    const bestBid = Number(orderbook?.bids?.[0]?.price || 0);
    const bestAsk = Number(orderbook?.asks?.[0]?.price || 0);
    const mid = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : Number(latestPrice?.price || 0);
    const spreadPercent = mid ? ((bestAsk - bestBid) / mid) * 100 : 0;

    const depth = sumDepthWithinPercent(orderbook, mid, 1);

    const historyPoints = Array.isArray(history?.data) ? history.data : history?.history;
    let movePercent = 0;
    if (Array.isArray(historyPoints) && historyPoints.length > 1) {
      const latest = Number(historyPoints[historyPoints.length - 1]?.price || 0);
      const prior = Number(historyPoints[historyPoints.length - 2]?.price || 0);
      if (prior) movePercent = Math.abs(((latest - prior) / prior) * 100);
    }

    const volume24h = Number(market?.volume24h || market?.volume_24h || 0);

    const liquidityScore = scoreMetric(depth, { ok: 25000, wait: 10000 });
    const spreadScore = scoreInverseMetric(spreadPercent, { ok: 2.5, wait: 5 });
    const moveScore = scoreInverseMetric(movePercent, { ok: 6, wait: 12 });
    const volumeScore = scoreMetric(volume24h, { ok: 50000, wait: 20000 });

    const totalScore =
      liquidityScore.score + spreadScore.score + moveScore.score + volumeScore.score;

    const verdict = getVerdict(totalScore);
    const confidence = Math.round(((totalScore + 4) / 8) * 100);

    const facts = [
      { label: "Liquidity (top 1% depth)", value: `$${formatNumber(depth)}`, status: liquidityScore.label },
      { label: "Spread", value: `${spreadPercent.toFixed(2)}%`, status: spreadScore.label },
      { label: "1h move", value: `${movePercent.toFixed(2)}%`, status: moveScore.label },
      { label: "24h volume", value: `$${formatNumber(volume24h)}`, status: volumeScore.label },
    ];

    const why = [
      liquidityScore.label !== "OK"
        ? "Orderbook depth inside 1% is below the target for aggressive entries."
        : "Orderbook depth inside 1% meets the aggressive target.",
      spreadScore.label !== "OK"
        ? "Spread is wider than ideal, indicating higher entry cost."
        : "Spread is tight enough for aggressive entries.",
      moveScore.label !== "OK"
        ? "Recent 1h move is large, increasing short-term volatility risk."
        : "Recent 1h move is within the aggressive tolerance.",
    ];

    res.json({
      topicId,
      marketId,
      market,
      latestPrice,
      orderbook,
      history,
      verdict,
      confidence,
      facts,
      why: why.slice(0, 3),
      scores: {
        liquidity: liquidityScore,
        spread: spreadScore,
        move1h: moveScore,
        volume24h: volumeScore,
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || "Failed to analyze" });
  }
});

app.listen(PORT, () => {
  console.log(`Opinion IQ running on http://localhost:${PORT}`);
});
