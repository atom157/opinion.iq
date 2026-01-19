const path = require("path");
const express = require("express");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const app = express();
const PORT = Number(process.env.PORT || 8080);

const OPINION_API_BASE = String(
  process.env.OPINION_API_BASE || "https://openapi.opinion.trade/openapi"
).replace(/\/+$/, "");

const OPINION_API_KEY = String(process.env.OPINION_API_KEY || "").trim();

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

function isObj(x) {
  return x && typeof x === "object" && !Array.isArray(x);
}

function join(base, p) {
  const b = String(base || "").replace(/\/+$/, "");
  const pp = String(p || "").startsWith("/") ? p : `/${p}`;
  return `${b}${pp}`;
}

function headers() {
  return { accept: "application/json", apikey: OPINION_API_KEY };
}

/**
 * Supports envelopes:
 * - { code, msg, result }
 * - { errno, errmsg, result }
 */
async function openApiGet(pathnameAndQuery) {
  const url = join(OPINION_API_BASE, pathnameAndQuery);

  const resp = await fetch(url, { headers: headers() });
  const text = await resp.text();

  if (!resp.ok) {
    console.error(`HTTP ${resp.status} for ${url}: ${text}`);
    throw new Error(`Request failed (${resp.status}): ${text}`);
  }

  let payload;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    console.error(`Non-JSON for ${url}: ${text}`);
    throw new Error(`Non-JSON response: ${text.slice(0, 300)}`);
  }

  if (isObj(payload) && "result" in payload && "code" in payload) {
    if (Number(payload.code) !== 0) throw new Error(payload.msg || "OpenAPI error");
    return payload.result;
  }

  if (isObj(payload) && "result" in payload && "errno" in payload) {
    if (Number(payload.errno) !== 0) throw new Error(payload.errmsg || "OpenAPI error");
    return payload.result;
  }

  return payload;
}

function parseMarketId(input) {
  if (!input) return null;

  // plain number
  if (typeof input === "number" && Number.isFinite(input)) return String(input);

  const s = String(input).trim();

  // direct numeric
  if (/^\d+$/.test(s)) return s;

  // try URL: marketId= or market_id=
  try {
    const u = new URL(s);
    const mid =
      u.searchParams.get("marketId") ||
      u.searchParams.get("market_id") ||
      u.searchParams.get("mid");
    if (mid && /^\d+$/.test(mid)) return mid;
  } catch {}

  // fallback regex
  const m = s.match(/(?:marketId|market_id|mid)=(\d+)/i);
  return m ? m[1] : null;
}

function pickTokenIds(m) {
  const yesTokenId = m?.yesTokenId ?? m?.yes_token_id ?? null;
  const noTokenId = m?.noTokenId ?? m?.no_token_id ?? null;
  return { yesTokenId, noTokenId };
}

function extractHistoryPoints(history) {
  if (Array.isArray(history)) return history;
  if (isObj(history)) {
    const cands = [
      history.data,
      history.list,
      history.items,
      history.records,
      history.rows,
      history.history,
      history.prices,
    ];
    for (const c of cands) if (Array.isArray(c)) return c;
  }
  return [];
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

  const pts = extractHistoryPoints(history);
  let movePercent = 0;
  if (pts.length > 1) {
    const latest = Number(pts[pts.length - 1]?.price ?? pts[pts.length - 1]?.p ?? 0);
    const prior = Number(pts[pts.length - 2]?.price ?? pts[pts.length - 2]?.p ?? 0);
    if (prior) movePercent = Math.abs(((latest - prior) / prior) * 100);
  }

  return { bestBid, bestAsk, mid, spreadPercent, depth, movePercent, volume24h };
}

/**
 * Market detail fetcher (tries multiple known/likely endpoints).
 * Returns object with keys like yesTokenId/noTokenId when possible.
 */
async function fetchMarketDetail(marketId) {
  const id = encodeURIComponent(String(marketId));

  const candidates = [
    `/market/${id}`,
    `/market/detail?marketId=${id}`,
    `/market/detail?market_id=${id}`,
    `/market/detail?id=${id}`,
    `/market/info?marketId=${id}`,
    `/market/info?id=${id}`,
  ];

  let lastErr = null;
  for (const c of candidates) {
    try {
      const r = await openApiGet(c);
      if (r) return r;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("Failed to fetch market detail");
}

function resolveTokensFromMarket(market) {
  // Direct tokens on market
  let { yesTokenId, noTokenId } = pickTokenIds(market);
  if (yesTokenId && noTokenId) return { yesTokenId, noTokenId, kind: "root" };

  // Or tokens might be inside childMarkets[0] if user passed parent
  const child = Array.isArray(market?.childMarkets) ? market.childMarkets[0] : null;
  if (child) {
    ({ yesTokenId, noTokenId } = pickTokenIds(child));
    if (yesTokenId && noTokenId) return { yesTokenId, noTokenId, kind: "child0" };
  }

  return { yesTokenId: null, noTokenId: null, kind: null };
}

/* ---------------- endpoints ---------------- */

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    base: OPINION_API_BASE,
    hasKey: Boolean(OPINION_API_KEY),
  });
});

/**
 * Quick debug: /api/debug?marketId=1588
 */
app.get("/api/debug", async (req, res) => {
  const marketId = parseMarketId(req.query.marketId || req.query.market_id || req.query.mid);
  if (!marketId) return res.status(400).json({ ok: false, error: "Provide ?marketId=<number>" });
  if (!OPINION_API_KEY) return res.status(500).json({ ok: false, error: "Missing OPINION_API_KEY" });

  try {
    const market = await fetchMarketDetail(marketId);
    const tokens = resolveTokensFromMarket(market);

    res.json({
      ok: true,
      base: OPINION_API_BASE,
      marketId,
      marketKeys: isObj(market) ? Object.keys(market).slice(0, 80) : null,
      hasChildMarkets: Array.isArray(market?.childMarkets),
      childCount: Array.isArray(market?.childMarkets) ? market.childMarkets.length : 0,
      tokenSource: tokens.kind,
      yesTokenId: tokens.yesTokenId ? String(tokens.yesTokenId) : null,
      noTokenId: tokens.noTokenId ? String(tokens.noTokenId) : null,
      sampleTitle: market?.marketTitle ?? market?.title ?? market?.market_name ?? null,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * ANALYZE (MVP): only marketId
 * - POST /api/analyze { marketId: "1588" }
 * - GET  /api/analyze?marketId=1588
 */
async function analyzeByMarketId(marketId) {
  const market = await fetchMarketDetail(marketId);

  const { yesTokenId, noTokenId, kind } = resolveTokensFromMarket(market);
  if (!yesTokenId || !noTokenId) {
    throw new Error(
      `No tokenIds found for marketId=${marketId}. Tip: use /api/debug?marketId=${marketId} and pass a CHILD marketId that has yesTokenId/noTokenId.`
    );
  }

  const volume24h = Number(market.volume24h ?? market.volume_24h ?? 0);

  const tokenRequests = [
    { side: "YES", tokenId: yesTokenId },
    { side: "NO", tokenId: noTokenId },
  ];

  const tokens = await Promise.all(
    tokenRequests.map(async ({ side, tokenId }) => {
      const q = encodeURIComponent(String(tokenId));

      const [latestPrice, orderbook, history] = await Promise.all([
        openApiGet(`/token/latest-price?token_id=${q}`),
        openApiGet(`/token/orderbook?token_id=${q}`),
        openApiGet(`/token/price-history?token_id=${q}&interval=1h`),
      ]);

      const metrics = calcMetrics({ latestPrice, orderbook, history, volume24h });

      // scoring thresholds (can tune later)
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
        side,
        tokenLabel: side,
        tokenId: String(tokenId),
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

  return {
    marketId: String(marketId),
    tokenSource: kind,
    market: {
      marketId: market?.marketId ?? marketId,
      marketTitle: market?.marketTitle ?? null,
      statusEnum: market?.statusEnum ?? null,
      marketType: market?.marketType ?? null,
      volume24h: volume24h,
      quoteToken: market?.quoteToken ?? null,
      chainId: market?.chainId ?? null,
    },
    overall: { verdict: overallVerdict, confidence: overallConfidence },
    tokens,
  };
}

app.get("/api/analyze", async (req, res) => {
  const marketId = parseMarketId(req.query.marketId || req.query.market_id || req.query.mid);
  if (!marketId) return res.status(400).json({ error: "Provide ?marketId=<number>" });
  if (!OPINION_API_KEY) return res.status(500).json({ error: "Missing API key." });

  try {
    const out = await analyzeByMarketId(marketId);
    res.json(out);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "Failed to analyze" });
  }
});

app.post("/api/analyze", async (req, res) => {
  const marketId = parseMarketId(req.body?.marketId || req.body?.market_id || req.body?.mid);
  if (!marketId) return res.status(400).json({ error: "Provide { marketId: <number> }" });
  if (!OPINION_API_KEY) return res.status(500).json({ error: "Missing API key." });

  try {
    const out = await analyzeByMarketId(marketId);
    res.json(out);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "Failed to analyze" });
  }
});

app.listen(PORT, () => {
  console.log(`Opinion IQ running on http://localhost:${PORT}`);
});
