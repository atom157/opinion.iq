const path = require("path");
const express = require("express");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const app = express();
const PORT = Number(process.env.PORT || 8080);

/**
 * Railway variables you have:
 * OPINION_API_BASE can be:
 *  - https://proxy.opinion.trade:8443
 *  - https://proxy.opinion.trade:8443/openapi
 *
 * We ALWAYS call OpenAPI endpoints under: {base}/openapi/v1/...
 */
function buildOpenApiBase(raw) {
  const base = String(raw || "").trim();
  if (!base) return "";
  // If already ends with /openapi -> keep, else append
  return /\/openapi\/?$/i.test(base) ? base.replace(/\/+$/, "") : base.replace(/\/+$/, "") + "/openapi";
}

const RAW_OPINION_API_BASE =
  process.env.OPINION_API_BASE || "https://proxy.opinion.trade:8443/openapi";

const OPINION_OPENAPI_BASE = buildOpenApiBase(RAW_OPINION_API_BASE);
const OPINION_API_KEY = process.env.OPINION_API_KEY;

if (!OPINION_API_KEY) {
  console.warn("Missing OPINION_API_KEY. Set it in Railway Variables.");
}
if (!OPINION_OPENAPI_BASE) {
  console.warn("Missing OPINION_API_BASE. Set it in Railway Variables.");
}

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

function parseTopicId(input) {
  if (!input) return null;
  try {
    const u = new URL(input);
    return u.searchParams.get("topicId");
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

function joinUrl(base, pathnameAndQuery) {
  const b = base.replace(/\/+$/, "");
  const p = String(pathnameAndQuery || "").startsWith("/")
    ? pathnameAndQuery
    : `/${pathnameAndQuery}`;
  return `${b}${p}`;
}

/**
 * Opinion OpenAPI envelope:
 * { code, msg, result }
 * If code !== 0 => error(msg)
 */
async function fetchOpenApi(pathnameAndQuery) {
  const url = joinUrl(OPINION_OPENAPI_BASE, pathnameAndQuery);

  const resp = await fetch(url, { headers: getHeaders() });
  const text = await resp.text();

  if (!resp.ok) {
    console.error(`HTTP error for ${url}: ${text}`);
    throw new Error(`Request failed (${resp.status}): ${text}`);
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    console.error(`Non-JSON response for ${url}: ${text}`);
    throw new Error(`Non-JSON response from API: ${text.slice(0, 300)}`);
  }

  // Strict envelope handling (as you requested)
  if (payload && typeof payload === "object" && "code" in payload && "msg" in payload && "result" in payload) {
    if (payload.code !== 0) {
      console.error(`OpenAPI envelope error for ${url}: ${JSON.stringify(payload)}`);
      throw new Error(payload.msg || "OpenAPI error");
    }
    return payload.result;
  }

  // If some endpoint ever returns raw JSON (rare) - still allow, but log once
  console.warn(`Warning: response without OpenAPI envelope for ${url}`);
  return payload;
}

function pickMarketsArray(result) {
  if (Array.isArray(result)) return result;

  // Some APIs wrap lists, so be defensive:
  if (result && typeof result === "object") {
    if (Array.isArray(result.list)) return result.list;
    if (Array.isArray(result.items)) return result.items;
    if (Array.isArray(result.markets)) return result.markets;
    if (Array.isArray(result.data)) return result.data;
  }

  const hintKeys = result && typeof result === "object" ? Object.keys(result).slice(0, 30) : null;
  const preview = (() => {
    try {
      return JSON.stringify(result).slice(0, 600);
    } catch {
      return String(result).slice(0, 600);
    }
  })();

  throw new Error(
    `Markets endpoint returned unexpected format (expected array). keys=${hintKeys} preview=${preview}`
  );
}

function sumDepthWithinPercent(orderbook, mid, percent) {
  if (!orderbook || !mid) return 0;

  const threshold = mid * (percent / 100);
  const maxPrice = mid + threshold;
  const minPrice = mid - threshold;

  const bids = Array.isArray(orderbook.bids) ? orderbook.bids : [];
  const asks = Array.isArray(orderbook.asks) ? orderbook.asks : [];

  const bidDepth = bids
    .filter((b) => Number(b.price || 0) >= minPrice)
    .reduce((t, b) => t + Number(b.size || 0), 0);

  const askDepth = asks
    .filter((a) => Number(a.price || 0) <= maxPrice)
    .reduce((t, a) => t + Number(a.size || 0), 0);

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

  const pts = Array.isArray(history)
    ? history
    : Array.isArray(history?.data)
      ? history.data
      : Array.isArray(history?.list)
        ? history.list
        : [];

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
    rawBase: RAW_OPINION_API_BASE,
    openapiBase: OPINION_OPENAPI_BASE,
    hasKey: Boolean(OPINION_API_KEY),
  });
});

app.get("/api/debug", async (req, res) => {
  try {
    const result = await fetchOpenApi("/v1/markets");
    const markets = pickMarketsArray(result);
    const sample = markets[0] || null;

    res.json({
      ok: true,
      openapiBase: OPINION_OPENAPI_BASE,
      marketsType: Array.isArray(markets) ? "array" : typeof markets,
      marketsCount: markets.length,
      sampleKeys: sample && typeof sample === "object" ? Object.keys(sample).slice(0, 40) : null,
      sample,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/analyze", async (req, res) => {
  const { url } = req.body || {};
  const topicId = parseTopicId(url);

  if (!topicId) return res.status(400).json({ error: "Invalid URL. Could not find topicId." });
  if (!OPINION_API_KEY) return res.status(500).json({ error: "Missing API key." });
  if (!OPINION_OPENAPI_BASE) return res.status(500).json({ error: "Missing OPINION_API_BASE." });

  try {
    // 1) markets list
    const marketsResult = await fetchOpenApi("/v1/markets");
    const markets = pickMarketsArray(marketsResult);

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
        const tokenQ = encodeURIComponent(tokenId);

        const [latestPrice, orderbook, history] = await Promise.all([
          fetchOpenApi(`/v1/token/latest-price?token_id=${tokenQ}`),
          fetchOpenApi(`/v1/token/orderbook?token_id=${tokenQ}`),
          fetchOpenApi(`/v1/token/price-history?token_id=${tokenQ}&interval=1h`),
        ]);

        const metrics = calcMetrics({ latestPrice, orderbook, history, volume24h });

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
          metrics: {
            spread: metrics.spreadPercent,
            depth: metrics.depth,
            move1h: metrics.movePercent,
          },
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
  console.log(`OpenAPI base: ${OPINION_OPENAPI_BASE}`);
});
