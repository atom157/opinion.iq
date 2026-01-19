const path = require("path");

const express = require("express");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const app = express();
const PORT = process.env.PORT || 8080;

const OPINION_API_BASE =
  process.env.OPINION_API_BASE || "https://proxy.opinion.trade:8443/openapi";
const OPINION_API_KEY = process.env.OPINION_API_KEY;

if (!OPINION_API_BASE || !OPINION_API_KEY) {
  console.warn(
    "Missing OPINION_API_BASE or OPINION_API_KEY. Create a .env file from .env.example."
  );
}

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

function parseTopicId(input) {
  if (!input) {
    return null;
  }

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

async function fetchJson(path) {
  const url = `${OPINION_API_BASE}${path}`;
  const response = await fetch(url, { headers: getHeaders() });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Request failed (${response.status}): ${text}`);
  }
  const payload = await response.json();
  if (payload?.code !== 0) {
    throw new Error(payload?.msg || "OpenAPI error");
  }
  return payload.result;
}

function sumDepthWithinPercent(orderbook, mid, percent) {
  if (!orderbook || !mid) {
    return 0;
  }
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
  if (value >= thresholds.ok) {
    return { label: "OK", score: 1 };
  }
  if (value >= thresholds.wait) {
    return { label: "WAIT", score: 0 };
  }
  return { label: "NO TRADE", score: -1 };
}

function scoreInverseMetric(value, thresholds) {
  if (value <= thresholds.ok) {
    return { label: "OK", score: 1 };
  }
  if (value <= thresholds.wait) {
    return { label: "WAIT", score: 0 };
  }
  return { label: "NO TRADE", score: -1 };
}

function getVerdict(total) {
  if (total >= 1) {
    return "OK";
  }
  if (total === 0) {
    return "WAIT";
  }
  return "NO TRADE";
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString(undefined, {
    maximumFractionDigits: 2,
  });
}

function calculateTokenMetrics({ latestPrice, orderbook, history, volume24h }) {
  const bestBid = Number(orderbook?.bids?.[0]?.price || 0);
  const bestAsk = Number(orderbook?.asks?.[0]?.price || 0);
  const mid = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : Number(latestPrice?.price || 0);
  const spreadPercent = mid ? ((bestAsk - bestBid) / mid) * 100 : 0;
  const depth = sumDepthWithinPercent(orderbook, mid, 1);

  const historyPoints = Array.isArray(history) ? history : history?.data;
  let movePercent = 0;
  if (Array.isArray(historyPoints) && historyPoints.length > 1) {
    const latest = Number(historyPoints[historyPoints.length - 1]?.price || 0);
    const prior = Number(historyPoints[historyPoints.length - 2]?.price || 0);
    if (prior) {
      movePercent = Math.abs(((latest - prior) / prior) * 100);
    }
  }

  return {
    bestBid,
    bestAsk,
    mid,
    spreadPercent,
    depth,
    movePercent,
    volume24h,
  };
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
    const market = await fetchJson(`/market/${topicId}`);
    const yesTokenId = market?.yesTokenId || market?.yes_token_id;
    const noTokenId = market?.noTokenId || market?.no_token_id;

    if (!yesTokenId || !noTokenId) {
      return res.status(500).json({ error: "Market data missing token IDs." });
    }

    const volume24h = Number(market?.volume24h || market?.volume_24h || 0);

    const tokenRequests = [
      { tokenLabel: "YES", tokenId: yesTokenId },
      { tokenLabel: "NO", tokenId: noTokenId },
    ];

    const tokens = await Promise.all(
      tokenRequests.map(async ({ tokenLabel, tokenId }) => {
        const [latestPrice, orderbook, history] = await Promise.all([
          fetchJson(`/token/latest-price?token_id=${tokenId}`),
          fetchJson(`/token/orderbook?token_id=${tokenId}`),
          fetchJson(`/token/price-history?token_id=${tokenId}&interval=1h`),
        ]);

        const metrics = calculateTokenMetrics({
          latestPrice,
          orderbook,
          history,
          volume24h,
        });

        const liquidityScore = scoreMetric(metrics.depth, { ok: 25000, wait: 10000 });
        const spreadScore = scoreInverseMetric(metrics.spreadPercent, { ok: 2.5, wait: 5 });
        const moveScore = scoreInverseMetric(metrics.movePercent, { ok: 6, wait: 12 });
        const volumeScore = scoreMetric(metrics.volume24h, { ok: 50000, wait: 20000 });

        const totalScore =
          liquidityScore.score + spreadScore.score + moveScore.score + volumeScore.score;

        const verdict = getVerdict(totalScore);
        const confidence = Math.round(((totalScore + 4) / 8) * 100);

        const facts = [
          {
            label: "Liquidity (top 1% depth)",
            value: `$${formatNumber(metrics.depth)}`,
            status: liquidityScore.label,
          },
          {
            label: "Spread",
            value: `${metrics.spreadPercent.toFixed(2)}%`,
            status: spreadScore.label,
          },
          {
            label: "1h move",
            value: `${metrics.movePercent.toFixed(2)}%`,
            status: moveScore.label,
          },
          {
            label: "24h volume",
            value: `$${formatNumber(metrics.volume24h)}`,
            status: volumeScore.label,
          },
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

        return {
          tokenLabel,
          tokenId,
          verdict,
          confidence,
          totalScore,
          metrics,
          facts,
          why: why.slice(0, 3),
        };
      })
    );

    const overallScore =
      tokens.reduce((sum, token) => sum + token.totalScore, 0) / tokens.length;
    const overallVerdict = getVerdict(overallScore);
    const overallConfidence = Math.round(
      tokens.reduce((sum, token) => sum + token.confidence, 0) / tokens.length
    );

    res.json({
      topicId,
      market,
      overall: {
        verdict: overallVerdict,
        confidence: overallConfidence,
      },
      tokens,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || "Failed to analyze" });
  }
});

app.listen(PORT, () => {
  console.log(`Opinion IQ running on http://localhost:${PORT}`);
});
