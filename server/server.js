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

/* ---------------- utils ---------------- */

function isObj(x) {
  return x && typeof x === "object" && !Array.isArray(x);
}

function join(base, p) {
  const b = base.replace(/\/+$/, "");
  const pp = String(p || "").startsWith("/") ? p : `/${p}`;
  return `${b}${pp}`;
}

function headers() {
  return {
    accept: "application/json",
    apikey: OPINION_API_KEY,
  };
}

function parseUrlParams(input) {
  const out = { topicId: null, marketId: null, childMarketId: null };
  if (!input) return out;

  try {
    const u = new URL(input);
    const topicId = u.searchParams.get("topicId");
    const marketId = u.searchParams.get("marketId") || u.searchParams.get("mid");
    const childMarketId =
      u.searchParams.get("childMarketId") ||
      u.searchParams.get("childId") ||
      u.searchParams.get("subMarketId");

    out.topicId = topicId && /^\d+$/.test(topicId) ? topicId : null;
    out.marketId = marketId && /^\d+$/.test(marketId) ? marketId : null;
    out.childMarketId = childMarketId && /^\d+$/.test(childMarketId) ? childMarketId : null;
    return out;
  } catch {
    // fallback regex
    const t = String(input).match(/topicId=(\d+)/);
    const m = String(input).match(/marketId=(\d+)/);
    const c = String(input).match(/childMarketId=(\d+)/);
    out.topicId = t ? t[1] : null;
    out.marketId = m ? m[1] : null;
    out.childMarketId = c ? c[1] : null;
    return out;
  }
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

  let payload = null;
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

/* ---------------- market helpers ---------------- */

function pickTopicId(m) {
  return m?.topicId ?? m?.topic_id ?? m?.topicID ?? null;
}

function pickTokenIds(m) {
  const yesTokenId =
    m?.yesTokenId ??
    m?.yes_token_id ??
    m?.rules?.yesTokenId ??
    m?.rules?.yesTokenID ??
    null;

  const noTokenId =
    m?.noTokenId ??
    m?.no_token_id ??
    m?.rules?.noTokenId ??
    m?.rules?.noTokenID ??
    null;

  return { yesTokenId, noTokenId };
}

function hasTokens(m) {
  const { yesTokenId, noTokenId } = pickTokenIds(m);
  return Boolean(yesTokenId && noTokenId);
}

async function getMarketListPage(page, limit) {
  const r = await openApiGet(`/market?page=${page}&limit=${limit}&marketType=2`);
  if (!isObj(r) || !Array.isArray(r.list)) {
    const keys = isObj(r) ? Object.keys(r) : null;
    throw new Error(`Unexpected market list shape. keys=${JSON.stringify(keys)}`);
  }
  return r;
}

async function findMarketByTopicId(topicId) {
  const limit = 20;
  let page = 1;

  const first = await getMarketListPage(page, limit);
  const total = Number(first.total || 0);
  const pages = total ? Math.ceil(total / limit) : 50;

  const findIn = (list) =>
    list.find((m) => String(pickTopicId(m)) === String(topicId)) || null;

  let found = findIn(first.list);
  if (found) return found;

  const maxPages = Math.min(pages, 120);
  for (page = 2; page <= maxPages; page++) {
    const r = await getMarketListPage(page, limit);
    found = findIn(r.list);
    if (found) return found;
  }
  return null;
}

/**
 * Picks the "target market object" that actually contains YES/NO tokenIds.
 * - If parent has tokens -> use parent
 * - Else use childMarkets:
 *   - if URL had marketId/childMarketId -> pick that child
 *   - else pick first child that has tokens
 */
function pickTargetMarket(parentMarket, { marketId, childMarketId }) {
  if (!parentMarket) return { target: null, pickedFrom: "none" };

  if (hasTokens(parentMarket)) {
    return { target: parentMarket, pickedFrom: "parent" };
  }

  const children = Array.isArray(parentMarket.childMarkets)
    ? parentMarket.childMarkets
    : [];

  if (!children.length) {
    return { target: null, pickedFrom: "no-children" };
  }

  const wantedId = childMarketId || marketId;
  if (wantedId) {
    const exact = children.find((c) => String(c.marketId) === String(wantedId));
    if (exact && hasTokens(exact)) return { target: exact, pickedFrom: "child:exact" };
  }

  const firstWithTokens = children.find((c) => hasTokens(c));
  if (firstWithTokens) return { target: firstWithTokens, pickedFrom: "child:firstWithTokens" };

  return { target: null, pickedFrom: "child:noneHaveTokens" };
}

/* ---------------- token + metrics ---------------- */

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

  const fallback = Number(
    latestPrice?.price ??
      latestPrice?.latestPrice ??
      latestPrice?.last ??
      latestPrice?.p ??
      0
  );

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

async function fetchTokenBundle(tokenId) {
  const q = encodeURIComponent(String(tokenId));
  const [latestPrice, orderbook, history] = await Promise.all([
    openApiGet(`/token/latest-price?token_id=${q}`),
    openApiGet(`/token/orderbook?token_id=${q}`),
    openApiGet(`/token/price-history?token_id=${q}&interval=1h`),
  ]);
  return { latestPrice, orderbook, history };
}

/* ---------------- endpoints ---------------- */

app.get("/api/health", (req, res) => {
  res.json({ ok: true, base: OPINION_API_BASE, hasKey: Boolean(OPINION_API_KEY) });
});

app.get("/api/debug", async (req, res) => {
  try {
    const r = await getMarketListPage(1, 1);
    const sample = r.list?.[0] ?? null;

    res.json({
      ok: true,
      base: OPINION_API_BASE,
      total: r.total ?? null,
      sampleKeys: sample ? Object.keys(sample).slice(0, 80) : null,
      sample,
      note:
        "If sample has empty yesTokenId/noTokenId, tokens are likely inside sample.childMarkets[].",
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/analyze", async (req, res) => {
  const { url } = req.body || {};
  const params = parseUrlParams(url);
  const topicId = params.topicId;

  if (!topicId) return res.status(400).json({ error: "Invalid URL. Could not find topicId." });
  if (!OPINION_API_KEY) return res.status(500).json({ error: "Missing API key (OPINION_API_KEY)." });

  try {
    const parent = await findMarketByTopicId(topicId);
    if (!parent) return res.status(404).json({ error: "Market not found for topicId." });

    const { target, pickedFrom } = pickTargetMarket(parent, params);
    if (!target) {
      return res.status(500).json({
        error:
          "Found topic market, but could not resolve a YES/NO token pair (parent + childMarkets).",
        pickedFrom,
        parentHasChildren: Array.isArray(parent.childMarkets) ? parent.childMarkets.length : 0,
      });
    }

    const { yesTokenId, noTokenId } = pickTokenIds(target);

    const volume24h = Number(
      target?.volume24h ??
        target?.volume_24h ??
        parent?.volume24h ??
        parent?.volume_24h ??
        parent?.volume ??
        0
    );

    const tokenRequests = [
      { side: "YES", tokenId: yesTokenId },
      { side: "NO", tokenId: noTokenId },
    ];

    const tokens = await Promise.all(
      tokenRequests.map(async ({ side, tokenId }) => {
        const { latestPrice, orderbook, history } = await fetchTokenBundle(tokenId);
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
          tokenLabel: side,
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
      market: {
        // send both for debugging/frontend
        parent,
        pickedFrom,
        selected: target,
      },
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
