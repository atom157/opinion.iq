const path = require("path");
const express = require("express");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const app = express();
const PORT = process.env.PORT || 8080;

/**
 * IMPORTANT:
 * - OPINION_API_BASE should be the API host/root (NO /openapi at the end)
 * - OPINION_OPENAPI_URL should point to the OpenAPI doc endpoint (often .../openapi)
 */
function normalizeApiBase(raw) {
  if (!raw) return "";
  // If user accidentally put /openapi as base, strip it.
  return String(raw).replace(/\/openapi\/?$/i, "");
}

const OPINION_API_BASE = normalizeApiBase(process.env.OPINION_API_BASE || "https://proxy.opinion.trade:8443");
const OPINION_OPENAPI_URL =
  process.env.OPINION_OPENAPI_URL ||
  // If they provided OPINION_API_BASE but not OPENAPI_URL, assume /openapi
  `${OPINION_API_BASE}/openapi`;

const OPINION_API_KEY = process.env.OPINION_API_KEY;

if (!OPINION_API_KEY) {
  console.warn("Missing OPINION_API_KEY. Set it in Railway Variables.");
}

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

function parseTopicId(input) {
  if (!input) return null;
  try {
    const url = new URL(input);
    return url.searchParams.get("topicId");
  } catch {
    const match = String(input).match(/topicId=(\d+)/);
    return match ? match[1] : null;
  }
}

function getHeaders() {
  return {
    accept: "application/json",
    apikey: OPINION_API_KEY,
  };
}

/**
 * Opinion OpenAPI envelope:
 * { code, msg, result }
 */
async function fetchOpenApiJson(fullUrl) {
  const resp = await fetch(fullUrl, { headers: getHeaders() });
  const text = await resp.text();

  if (!resp.ok) {
    console.error(`HTTP error for ${fullUrl}: ${text}`);
    throw new Error(`Request failed (${resp.status}): ${text}`);
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    console.error(`Non-JSON response for ${fullUrl}: ${text}`);
    throw new Error(`Non-JSON response from API: ${text.slice(0, 200)}`);
  }

  // Some endpoints may not use envelope; support both
  if (payload && typeof payload === "object" && "code" in payload && "result" in payload) {
    if (payload.code !== 0) {
      console.error(`OpenAPI envelope error for ${fullUrl}: ${JSON.stringify(payload)}`);
      throw new Error(payload.msg || "OpenAPI error");
    }
    return payload.result;
  }

  return payload;
}

async function fetchApi(pathnameAndQuery) {
  const url = `${OPINION_API_BASE}${pathnameAndQuery}`;
  return fetchOpenApiJson(url);
}

function sumDepthWithinPercent(orderbook, mid, percent) {
  if (!orderbook || !mid) return 0;
  const threshold = mid * (percent / 100);
  const maxPrice = mid + threshold;
  const minPrice = mid - threshold;

  const bidDepth = Array.isArray(orderbook.bids)
    ? orderbook.bids
        .filter((b) => Number(b.price || 0) >= minPrice)
        .reduce((t, b) => t + Number(b.size || 0), 0)
    : 0;

  const askDepth = Array.isArray(orderbook.asks)
    ? orderbook.asks
        .filter((a) => Number(a.price || 0) <= maxPrice)
        .reduce((t, a) => t + Number(a.size || 0), 0)
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

function calcMetrics({ latestPrice, orderbook, history, volume24h }) {
  const bestBid = Number(orderbook?.bids?.[0]?.price || 0);
  const bestAsk = Number(orderbook?.asks?.[0]?.price || 0);

  const fallback = Number(latestPrice?.price || latestPrice?.latestPrice || 0);
  const mid = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : fallback;

  const spreadPercent = mid ? ((bestAsk - bestBid) / mid) * 100 : 0;
  const depth = sumDepthWithinPercent(orderbook, mid, 1);

  // history could be array, or { data: [...] }
  const pts = Array.isArray(history) ? history : Array.isArray(history?.data) ? history.data : [];
  let movePercent = 0;
  if (pts.length > 1) {
    const latest = Number(pts[pts.length - 1]?.price || 0);
    const prior = Number(pts[pts.length - 2]?.price || 0);
    if (prior) movePercent = Math.abs(((latest - prior) / prior) * 100);
  }

  return { bestBid, bestAsk, mid, spreadPercent, depth, movePercent, volume24h };
}

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    apiBase: OPINION_API_BASE,
    openapiUrl: OPINION_OPENAPI_URL,
    hasKey: Boolean(OPINION_API_KEY),
  });
});

/**
 * Debug helper: checks if /v1/markets is reachable and returns first keys.
 * Use this to confirm the base is correct.
 */
app.get("/api/debug", async (req, res) => {
  try {
    const markets = await fetchApi("/v1/markets");
    const sample = Array.isArray(markets) ? markets[0] : markets;
    res.json({
      ok: true,
      marketsType: Array.isArray(markets) ? "array" : typeof markets,
      sampleKeys: sample && typeof sample === "object" ? Object.keys(sample).slice(0, 30) : null,
      sample,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/analyze", async (req, res) => {
  const { url } = req.body;
  const topicId = parseTopicId(url);

  if (!topicId) return res.status(400).json({ error: "Invalid URL. Could not find topicId." });
  if (!OPINION_API_KEY) return res.status(500).json({ error: "Missing API key." });

  try {
    // 1) markets list
    const markets = await fetchApi("/v1/markets");
    if (!Array.isArray(markets)) {
      return res.status(500).json({
        error: "Markets endpoint returned unexpected format (expected array).",
        hint: "Check OPINION_API_BASE. It must NOT end with /openapi.",
      });
    }

    // 2) find market by topicId
    const market = markets.find((m) => String(m.topicId) === String(topicId));
    if (!market) return res.status(404).json({ error: "Market not found for topicId." });

    // 3) token ids
    const yesTokenId = market.yesTokenId ?? market.yes_token_id;
    const noTokenId = market.noTokenId ?? market.no_token_id;
    if (!yesTokenId || !noTokenId) {
      return res.status(500).json({ error: "Market data missing yes/no token IDs." });
    }

    const volume24h = Number(market.volume24h ?? market.volume_24h ?? 0);

    const tokenRequests = [
      { side: "YES", tokenId: yesTokenId },
      { side: "NO", tokenId: noTokenId },
    ];

    const tokens = await Promise.all(
      tokenRequests.map(async ({ side, tokenId }) => {
        const [latestPrice, orderbook, history] = await Promise.all([
          fetchApi(`/v1/token/latest-price?token_id=${encodeURIComponent(tokenId)}`),
          fetchApi(`/v1/token/orderbook?token_id=${encodeURIComponent(tokenId)}`),
          fetchApi(`/v1/token/price-history?token_id=${encodeURIComponent(tokenId)}&interval=1h`),
        ]);

        const metrics = calcMetrics({ latestPrice, orderbook, history, volume24h });

        // scoring
        const liquidityScore = scoreMetric(metrics.depth, { ok: 25000, wait: 10000 });
        const spreadScore = scoreInverseMetric(metrics.spreadPercent, { ok: 2.5, wait: 5 });
        const moveScore = scoreInverseMetric(metrics.movePercent, { ok: 6, wait: 12 });
        const volumeScore = scoreMetric(metrics.volume24h, { ok: 50000, wait: 20000 });

        const totalScore =
          liquidityScore.score + spreadScore.score + moveScore.score + volumeScore.score;

        const verdict = getVerdict(totalScore);
        const confidence = Math.round(((totalScore + 4) / 8) * 100);

        const facts = [
          { label: "Liquidity (top 1% depth)", value: `$${formatNumber(metrics.depth)}`, status: liquidityScore.label },
          { label: "Spread", value: `${metrics.spreadPercent.toFixed(2)}%`, status: spreadScore.label },
          { label: "1h move", value: `${metrics.movePercent.toFixed(2)}%`, status: moveScore.label },
          { label: "24h volume", value: `$${formatNumber(metrics.volume24h)}`, status: volumeScore.label },
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
          side,
          tokenLabel: side, // keep frontend compatibility
          tokenId,
          verdict,
          confidence,
          totalScore,
          metrics: { spread: metrics.spreadPercent, depth: metrics.depth, move1h: metrics.movePercent },
          facts,
          why: why.slice(0, 3),
        };
      })
    );

    const overallScore = tokens.reduce((s, t) => s + t.totalScore, 0) / tokens.length;
    const overallVerdict = getVerdict(overallScore);
    const overallConfidence = Math.round(tokens.reduce((s, t) => s + t.confidence, 0) / tokens.length);

    res.json({
      topicId,
      market,
      overall: { verdict: overallVerdict, confidence: overallConfidence },
      tokens,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "Failed to analyze" });
  }
});

app.listen(PORT, () => {
  console.log(`Opinion IQ running on http://localhost:${PORT}`);
});
