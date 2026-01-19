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

function parseTopicId(input) {
  if (!input) return null;
  try {
    const u = new URL(input);
    const id = u.searchParams.get("topicId");
    return id && /^\d+$/.test(id) ? id : null;
  } catch {
    const m = String(input).match(/topicId=(\d+)/);
    return m ? m[1] : null;
  }
}

function headers() {
  return {
    accept: "application/json",
    apikey: OPINION_API_KEY,
  };
}

function join(base, p) {
  const b = base.replace(/\/+$/, "");
  const pp = String(p || "").startsWith("/") ? p : `/${p}`;
  return `${b}${pp}`;
}

function isObj(x) {
  return x && typeof x === "object" && !Array.isArray(x);
}

/**
 * Supports envelopes:
 * - { code, msg, result }
 * - { errno, errmsg, result }
 */
async function openApiGet(pathnameAndQuery, { allowNoEnvelope = true } = {}) {
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
    if (Number(payload.code) !== 0) {
      console.error(`OpenAPI code!=0 for ${url}: ${JSON.stringify(payload)}`);
      throw new Error(payload.msg || "OpenAPI error");
    }
    return payload.result;
  }

  if (isObj(payload) && "result" in payload && "errno" in payload) {
    if (Number(payload.errno) !== 0) {
      console.error(`OpenAPI errno!=0 for ${url}: ${JSON.stringify(payload)}`);
      throw new Error(payload.errmsg || "OpenAPI error");
    }
    return payload.result;
  }

  if (!allowNoEnvelope) {
    console.error(`Expected envelope, got: ${text}`);
    throw new Error("Unexpected API response (missing envelope).");
  }

  return payload;
}

/* ---------------- OpenAPI path discovery (NO GUESSING) ---------------- */

let _specCache = null;
let _specFetchedAt = 0;

async function getOpenApiSpec() {
  const now = Date.now();
  if (_specCache && now - _specFetchedAt < 5 * 60 * 1000) return _specCache;

  if (!OPINION_API_KEY) {
    throw new Error("Missing OPINION_API_KEY (needed to fetch OpenAPI spec).");
  }

  // OPINION_API_BASE already points to .../openapi
  const url = OPINION_API_BASE;

  // IMPORTANT FIX: include apikey for spec too (401 otherwise)
  const resp = await fetch(url, {
    headers: {
      accept: "application/json",
      apikey: OPINION_API_KEY,
    },
  });

  const text = await resp.text();

  if (!resp.ok) {
    console.error(`OpenAPI spec fetch failed ${resp.status} for ${url}: ${text}`);
    throw new Error(`OpenAPI spec fetch failed (${resp.status})`);
  }

  let spec;
  try {
    spec = JSON.parse(text);
  } catch {
    console.error(`OpenAPI spec non-json for ${url}: ${text}`);
    throw new Error("OpenAPI spec is not JSON");
  }

  if (!isObj(spec) || !isObj(spec.paths)) {
    console.error(
      `OpenAPI spec missing paths. keys=${isObj(spec) ? Object.keys(spec) : null}`
    );
    throw new Error("OpenAPI spec missing paths");
  }

  _specCache = spec;
  _specFetchedAt = now;
  return spec;
}

function pickGetPaths(spec) {
  const paths = spec.paths || {};
  const out = [];
  for (const [p, def] of Object.entries(paths)) {
    if (isObj(def) && def.get) out.push(p);
  }
  return out;
}

function scorePath(p, mustHave = [], niceToHave = []) {
  const s = p.toLowerCase();
  let score = 0;
  for (const w of mustHave) if (s.includes(w)) score += 10;
  for (const w of niceToHave) if (s.includes(w)) score += 2;
  if (s.includes("token")) score += 3;
  if (s.includes("latest")) score += 1;
  return score;
}

async function resolveTokenPaths() {
  const spec = await getOpenApiSpec();
  const getPaths = pickGetPaths(spec);

  const latestCandidates = getPaths
    .map((p) => ({ p, score: scorePath(p, ["price"], ["latest", "token"]) }))
    .filter((x) => x.score >= 10);

  const orderbookCandidates = getPaths
    .map((p) => ({ p, score: scorePath(p, ["orderbook"], ["token"]) }))
    .filter((x) => x.score >= 10);

  const historyCandidates = getPaths
    .map((p) => ({ p, score: scorePath(p, ["history"], ["price", "token"]) }))
    .filter((x) => x.score >= 10);

  const pickBest = (arr) => arr.sort((a, b) => b.score - a.score)[0]?.p || null;

  return {
    latestPath: pickBest(latestCandidates),
    orderbookPath: pickBest(orderbookCandidates),
    historyPath: pickBest(historyCandidates),
    allGetPaths: getPaths,
    candidates: {
      latest: latestCandidates.slice(0, 20).map((x) => x.p),
      orderbook: orderbookCandidates.slice(0, 20).map((x) => x.p),
      history: historyCandidates.slice(0, 20).map((x) => x.p),
    },
  };
}

/* ---------------- market helpers (KNOWN WORKING: /market) ---------------- */

function pickTopicId(m) {
  return m?.topicId ?? m?.topic_id ?? m?.topicID ?? null;
}

function pickTokenIds(m) {
  const yesTokenId =
    m?.yesTokenId ?? m?.yes_token_id ?? m?.rules?.yesTokenId ?? m?.rules?.yesTokenID ?? null;
  const noTokenId =
    m?.noTokenId ?? m?.no_token_id ?? m?.rules?.noTokenId ?? m?.rules?.noTokenID ?? null;
  return { yesTokenId, noTokenId };
}

function pickMarketId(m) {
  return m?.marketId ?? m?.market_id ?? m?.id ?? null;
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

  const maxPages = Math.min(pages, 80);
  for (page = 2; page <= maxPages; page++) {
    const r = await getMarketListPage(page, limit);
    found = findIn(r.list);
    if (found) return found;
  }
  return null;
}

async function fetchMarketDetailById(marketId) {
  const id = encodeURIComponent(String(marketId));
  const candidates = [
    `/market/${id}`,
    `/market/detail?market_id=${id}`,
    `/market/detail?id=${id}`,
  ];

  let lastErr = null;
  for (const c of candidates) {
    try {
      return await openApiGet(c);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("Failed to fetch market detail");
}

/* ---------------- metrics ---------------- */

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

/* ---------------- endpoints ---------------- */

app.get("/api/health", (req, res) => {
  res.json({ ok: true, base: OPINION_API_BASE, hasKey: Boolean(OPINION_API_KEY) });
});

app.get("/api/debug", async (req, res) => {
  try {
    const r = await getMarketListPage(1, 1);
    const paths = await resolveTokenPaths();
    res.json({
      ok: true,
      base: OPINION_API_BASE,
      total: r.total ?? null,
      sampleKeys: r.list?.[0] ? Object.keys(r.list[0]).slice(0, 60) : null,
      sample: r.list?.[0] ?? null,
      tokenPaths: {
        latest: paths.latestPath,
        orderbook: paths.orderbookPath,
        history: paths.historyPath,
      },
      // show first 80 GET paths so you can see reality fast
      firstGetPaths: paths.allGetPaths.slice(0, 80),
      tokenPathCandidates: paths.candidates,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/analyze", async (req, res) => {
  const { url } = req.body || {};
  const topicId = parseTopicId(url);

  if (!topicId) return res.status(400).json({ error: "Invalid URL. Could not find topicId." });
  if (!OPINION_API_KEY) return res.status(500).json({ error: "Missing API key (OPINION_API_KEY)." });

  try {
    let market = await findMarketByTopicId(topicId);
    if (!market) return res.status(404).json({ error: "Market not found for topicId." });

    let { yesTokenId, noTokenId } = pickTokenIds(market);

    if (!yesTokenId || !noTokenId) {
      const marketId = pickMarketId(market);
      if (marketId) {
        const detail = await fetchMarketDetailById(marketId);
        if (isObj(detail)) market = { ...market, ...detail };
        ({ yesTokenId, noTokenId } = pickTokenIds(market));
      }
    }

    if (!yesTokenId || !noTokenId) {
      return res.status(500).json({
        error: "Could not resolve yes/no token IDs for this market.",
        marketKeys: isObj(market) ? Object.keys(market).slice(0, 120) : null,
      });
    }

    const paths = await resolveTokenPaths();
    if (!paths.latestPath || !paths.orderbookPath || !paths.historyPath) {
      return res.status(500).json({
        error: "Could not auto-resolve token endpoints from OpenAPI spec.",
        found: {
          latestPath: paths.latestPath,
          orderbookPath: paths.orderbookPath,
          historyPath: paths.historyPath,
        },
        candidates: paths.candidates,
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

        const latestUrl = `${paths.latestPath}?token_id=${q}`;
        const orderbookUrl = `${paths.orderbookPath}?token_id=${q}`;
        const historyUrl = `${paths.historyPath}?token_id=${q}&interval=1h`;

        const [latestPrice, orderbook, history] = await Promise.all([
          openApiGet(latestUrl),
          openApiGet(orderbookUrl),
          openApiGet(historyUrl),
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
          tokenLabel: side,
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
