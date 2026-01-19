const path = require("path");
const express = require("express");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const app = express();
const PORT = Number(process.env.PORT || 8080);

const OPINION_API_BASE = String(
  process.env.OPINION_API_BASE || "https://openapi.opinion.trade/openapi"
).replace(/\/+$/, "");

const OPINION_API_KEY = String(process.env.OPINION_API_KEY || "").trim();

if (!OPINION_API_BASE) console.warn("Missing OPINION_API_BASE.");
if (!OPINION_API_KEY) console.warn("Missing OPINION_API_KEY.");

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

/* ---------------- helpers ---------------- */

function parseTopicId(input) {
  if (!input) return null;
  try {
    const u = new URL(input);
    const id = u.searchParams.get("topicId");
    return id && /^\d+$/.test(id) ? id : null;
  } catch {
    const match = String(input).match(/topicId=(\d+)/);
    return match ? match[1] : null;
  }
}

function headers() {
  return { accept: "application/json", apikey: OPINION_API_KEY };
}

function join(base, p) {
  const b = base.replace(/\/+$/, "");
  const pp = String(p || "").startsWith("/") ? p : `/${p}`;
  return `${b}${pp}`;
}

function isPlainObject(x) {
  return x && typeof x === "object" && !Array.isArray(x);
}

/**
 * Supports envelopes:
 * 1) { code, msg, result }
 * 2) { errno, errmsg, result }
 * If no envelope: returns raw payload.
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

  // code/msg/result
  if (isPlainObject(payload) && "result" in payload && "code" in payload) {
    if (Number(payload.code) !== 0) {
      throw new Error(payload.msg || "OpenAPI error");
    }
    return payload.result;
  }

  // errno/errmsg/result
  if (isPlainObject(payload) && "result" in payload && "errno" in payload) {
    if (Number(payload.errno) !== 0) {
      throw new Error(payload.errmsg || "OpenAPI error");
    }
    return payload.result;
  }

  return payload;
}

function deepFindArrayByPredicate(root, itemPredicate) {
  const seen = new Set();

  function visit(node, depth) {
    if (depth > 10 || node == null) return null;

    if (typeof node === "object") {
      if (seen.has(node)) return null;
      seen.add(node);
    }

    if (Array.isArray(node)) {
      const sample = node.slice(0, 20);
      if (sample.some(itemPredicate)) return node;

      for (const it of node) {
        const found = visit(it, depth + 1);
        if (found) return found;
      }
      return null;
    }

    if (isPlainObject(node)) {
      // common containers first
      const preferred = ["list", "data", "items", "rows", "records", "markets", "result"];
      for (const k of preferred) {
        if (k in node) {
          const found = visit(node[k], depth + 1);
          if (found) return found;
        }
      }
      for (const k of Object.keys(node)) {
        const found = visit(node[k], depth + 1);
        if (found) return found;
      }
    }

    return null;
  }

  return visit(root, 0);
}

function looksLikeMarketListItem(obj) {
  if (!isPlainObject(obj)) return false;
  // list item might NOT include token ids; require topicId + (id/marketId) at least
  const hasTopic = obj.topicId !== undefined || obj.topic_id !== undefined;
  const hasId =
    obj.id !== undefined ||
    obj.marketId !== undefined ||
    obj.market_id !== undefined ||
    obj.mid !== undefined;
  return hasTopic && hasId;
}

function looksLikeMarketDetail(obj) {
  if (!isPlainObject(obj)) return false;
  const hasTopic = obj.topicId !== undefined || obj.topic_id !== undefined;
  const hasYes = obj.yesTokenId !== undefined || obj.yes_token_id !== undefined;
  const hasNo = obj.noTokenId !== undefined || obj.no_token_id !== undefined;
  return hasTopic && (hasYes || hasNo);
}

function pickMarketId(m) {
  return m.id ?? m.marketId ?? m.market_id ?? m.mid ?? null;
}

function pickTopicId(m) {
  return m.topicId ?? m.topic_id ?? null;
}

function pickTokenIds(m) {
  const yesTokenId = m.yesTokenId ?? m.yes_token_id ?? null;
  const noTokenId = m.noTokenId ?? m.no_token_id ?? null;
  return { yesTokenId, noTokenId };
}

/* ---------------- scoring ---------------- */

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

function extractHistoryPoints(historyResult) {
  if (Array.isArray(historyResult)) return historyResult;
  if (isPlainObject(historyResult)) {
    const candidates = [
      historyResult.history,
      historyResult.data,
      historyResult.items,
      historyResult.list,
      historyResult.records,
      historyResult.rows,
      historyResult.prices,
    ];
    for (const c of candidates) if (Array.isArray(c)) return c;

    const found = deepFindArrayByPredicate(historyResult, (x) => isPlainObject(x) && ("price" in x || "p" in x));
    return found || [];
  }
  return [];
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

/* ---------------- market discovery ---------------- */

async function fetchMarketsRoot() {
  // don’t over-guess, just a couple realistic options
  const candidates = [
    "/market?page=1&limit=20&marketType=2",
    "/market?page=1&limit=20",
    "/market?page=1",
    "/market",
  ];
  let lastErr = null;
  for (const c of candidates) {
    try {
      return await openApiGet(c);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("Failed to fetch markets");
}

async function fetchMarketDetailById(marketId) {
  const id = encodeURIComponent(String(marketId));
  const candidates = [
    `/market/${id}`,
    `/market/detail?market_id=${id}`,
  ];
  let lastErr = null;
  for (const c of candidates) {
    try {
      const r = await openApiGet(c);
      // Sometimes detail is wrapped; find object that looks like a market detail
      if (looksLikeMarketDetail(r)) return r;

      const maybe = isPlainObject(r)
        ? (deepFindArrayByPredicate(r, looksLikeMarketDetail)?.[0] || null)
        : null;

      if (maybe) return maybe;
      // If it's an object but not matching, still return it (might contain token ids with different names)
      if (isPlainObject(r)) return r;

    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("Failed to fetch market detail");
}

async function findMarketByTopicId(topicId) {
  const root = await fetchMarketsRoot();

  // find list item array by topicId+id
  const marketsList = deepFindArrayByPredicate(root, looksLikeMarketListItem);
  if (!Array.isArray(marketsList)) {
    throw new Error(`Could not locate markets list array. rootKeys=${JSON.stringify(isPlainObject(root) ? Object.keys(root).slice(0, 60) : null)}`);
  }

  const listItem = marketsList.find((m) => String(pickTopicId(m)) === String(topicId));
  if (!listItem) return null;

  // If list already has token ids, we’re done
  const tokens = pickTokenIds(listItem);
  if (tokens.yesTokenId && tokens.noTokenId) return listItem;

  // Otherwise, fetch detail by id
  const marketId = pickMarketId(listItem);
  if (!marketId) return listItem;

  const detail = await fetchMarketDetailById(marketId);
  // merge list + detail
  return { ...listItem, ...detail };
}

/* ---------------- endpoints ---------------- */

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    base: OPINION_API_BASE,
    hasKey: Boolean(OPINION_API_KEY),
  });
});

app.get("/api/debug", async (req, res) => {
  try {
    const root = await fetchMarketsRoot();

    const marketsList = deepFindArrayByPredicate(root, looksLikeMarketListItem);
    const sample = Array.isArray(marketsList) ? marketsList[0] : null;

    res.json({
      ok: true,
      base: OPINION_API_BASE,
      rootKeys: isPlainObject(root) ? Object.keys(root).slice(0, 60) : null,
      marketsFound: Array.isArray(marketsList),
      marketsCount: Array.isArray(marketsList) ? marketsList.length : null,
      sampleKeys: sample && isPlainObject(sample) ? Object.keys(sample).slice(0, 60) : null,
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

  try {
    const market = await findMarketByTopicId(topicId);
    if (!market) return res.status(404).json({ error: "Market not found for topicId." });

    const { yesTokenId, noTokenId } = pickTokenIds(market);
    if (!yesTokenId || !noTokenId) {
      return res.status(500).json({
        error: "Could not resolve yes/no token IDs for this market.",
        hint: "Market list may not include token IDs and market detail endpoint might differ.",
        marketSampleKeys: isPlainObject(market) ? Object.keys(market).slice(0, 80) : null,
      });
    }

    const volume24h = Number(market.volume24h ?? market.volume_24h ?? market.volume ?? 0);

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
  console.log(`Base: ${OPINION_API_BASE}`);
});
