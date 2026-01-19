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
    apikey: OPINION_API_KEY, // this header works for /market on your deploy
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
 * Logs full URL + response body on API errors.
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

  // Envelope style A
  if (isObj(payload) && "result" in payload && "code" in payload) {
    if (Number(payload.code) !== 0) {
      console.error(`OpenAPI code!=0 for ${url}: ${text}`);
      throw new Error(payload.msg || "OpenAPI error");
    }
    return payload.result;
  }

  // Envelope style B
  if (isObj(payload) && "result" in payload && "errno" in payload) {
    if (Number(payload.errno) !== 0) {
      console.error(`OpenAPI errno!=0 for ${url}: ${text}`);
      throw new Error(payload.errmsg || "OpenAPI error");
    }
    return payload.result;
  }

  // Raw
  return payload;
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
  return Number(value || 0).toLocaleString(undefined, {
    maximumFractionDigits: 2,
  });
}

function calcMetrics({ latestPrice, orderbook, history, volume24h }) {
  const bestBid = Number(orderbook?.bids?.[0]?.price || 0);
  const bestAsk = Number(orderbook?.asks?.[0]?.price || 0);

  const fallback = Number(
    latestPrice?.price || latestPrice?.latestPrice || 0
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

/**
 * OpenAPI: /market returns { total, list }
 * We page through until we find:
 * - root marketId === topicId (topicId is marketId)
 * - OR any childMarkets[].marketId === topicId (topicId is child marketId)
 */
async function getMarketListPage(page, limit) {
  const r = await openApiGet(`/market?page=${page}&limit=${limit}&marketType=2`);
  if (!isObj(r) || !Array.isArray(r.list)) {
    const keys = isObj(r) ? Object.keys(r) : null;
    throw new Error(`Unexpected /market shape. keys=${JSON.stringify(keys)}`);
  }
  return r;
}

function pickBestChildMarket(root) {
  const kids = Array.isArray(root?.childMarkets) ? root.childMarkets : [];
  if (!kids.length) return null;

  // Prefer child that already has token ids and has highest volume24h/volume
  const scored = kids
    .map((k) => {
      const { yesTokenId, noTokenId } = pickTokenIds(k);
      const v24 = Number(k.volume24h ?? k.volume_24h ?? 0);
      const v = Number(k.volume ?? 0);
      const hasTokens = Boolean(yesTokenId && noTokenId);
      return { k, score: (hasTokens ? 1e15 : 0) + v24 * 1e6 + v };
    })
    .sort((a, b) => b.score - a.score);

  return scored[0]?.k || null;
}

async function findMarketByTopicId(topicId) {
  const limit = 50;
  let page = 1;

  const first = await getMarketListPage(page, limit);
  const total = Number(first.total || 0);
  const pages = total ? Math.ceil(total / limit) : 50;

  function scanList(list) {
    for (const root of list) {
      if (String(root.marketId) === String(topicId)) {
        // topicId is root marketId
        const { yesTokenId, noTokenId } = pickTokenIds(root);
        if (yesTokenId && noTokenId) {
          return { kind: "root", market: root, parent: null };
        }
        // multi/root without tokens -> pick best child
        const bestChild = pickBestChildMarket(root);
        if (bestChild) return { kind: "childOfRoot", market: bestChild, parent: root };
        return { kind: "rootNoTokens", market: root, parent: null };
      }

      // topicId might be child marketId
      const kids = Array.isArray(root.childMarkets) ? root.childMarkets : [];
      const hit = kids.find((c) => String(c.marketId) === String(topicId));
      if (hit) {
        return { kind: "child", market: hit, parent: root };
      }
    }
    return null;
  }

  let found = scanList(first.list);
  if (found) return found;

  const maxPages = Math.min(pages, 120);
  for (page = 2; page <= maxPages; page++) {
    const r = await getMarketListPage(page, limit);
    found = scanList(r.list);
    if (found) return found;
  }
  return null;
}

/* ---------------- routes ---------------- */

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    base: OPINION_API_BASE,
    hasKey: Boolean(OPINION_API_KEY),
  });
});

/**
 * Debug:
 * - /api/debug               -> shows sample & totals
 * - /api/debug?marketId=61   -> tries to find marketId==61 (root or child)
 */
app.get("/api/debug", async (req, res) => {
  try {
    const target = String(req.query.marketId || "").trim();

    const r = await getMarketListPage(1, 50);

    let found = null;
    if (target) {
      // quick find inside first page
      const quick = r.list.find((m) => String(m.marketId) === target);
      if (quick) {
        found = { kind: "root", market: quick, parent: null };
      } else {
        for (const root of r.list) {
          const kids = Array.isArray(root.childMarkets) ? root.childMarkets : [];
          const hit = kids.find((c) => String(c.marketId) === target);
          if (hit) {
            found = { kind: "child", market: hit, parent: root };
            break;
          }
        }
      }
    }

    res.json({
      ok: true,
      base: OPINION_API_BASE,
      total: r.total ?? null,
      scanned: r.list.length,
      target: target || null,
      found: Boolean(found),
      foundKind: found?.kind || null,
      foundMarketKeys:
        found?.market && isObj(found.market)
          ? Object.keys(found.market).slice(0, 80)
          : null,
      foundMarket: found?.market || null,
      foundParentKeys:
        found?.parent && isObj(found.parent)
          ? Object.keys(found.parent).slice(0, 40)
          : null,
      foundParent: found?.parent ? { marketId: found.parent.marketId, marketTitle: found.parent.marketTitle } : null,
      sampleKeys: r.list?.[0] ? Object.keys(r.list[0]).slice(0, 60) : null,
      sample: r.list?.[0] ?? null,
      note:
        r.list?.[0] && (!r.list[0].yesTokenId || !r.list[0].noTokenId)
          ? "If root yes/no empty, tokens are inside sample.childMarkets[]."
          : null,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/analyze", async (req, res) => {
  const { url } = req.body || {};
  const topicId = parseTopicId(url);

  if (!topicId) {
    return res
      .status(400)
      .json({ error: "Invalid URL. Could not find topicId." });
  }
  if (!OPINION_API_KEY) {
    return res.status(500).json({ error: "Missing API key." });
  }

  try {
    const found = await findMarketByTopicId(topicId);
    if (!found) {
      return res.status(404).json({
        error: "Market not found for topicId (treated as marketId or child marketId).",
      });
    }

    const chosenMarket = found.market;
    const parentMarket = found.parent;

    // tokens
    const { yesTokenId, noTokenId } = pickTokenIds(chosenMarket);

    if (!yesTokenId || !noTokenId) {
      return res.status(500).json({
        error:
          "Found market, but it does not contain yesTokenId/noTokenId. (Likely unsupported market shape.)",
        foundKind: found.kind,
        marketId: chosenMarket?.marketId ?? null,
        marketKeys: isObj(chosenMarket)
          ? Object.keys(chosenMarket).slice(0, 120)
          : null,
      });
    }

    // volume: use chosen market volume24h, fallback to parent
    const volume24h = Number(
      chosenMarket.volume24h ??
        chosenMarket.volume_24h ??
        parentMarket?.volume24h ??
        parentMarket?.volume_24h ??
        0
    );

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

        const metrics = calcMetrics({
          latestPrice,
          orderbook,
          history,
          volume24h,
        });

        // scoring (tune later; now stable)
        const liquidityScore = scoreMetric(metrics.depth, {
          ok: 25000,
          wait: 10000,
        });
        const spreadScore = scoreInverseMetric(metrics.spreadPercent, {
          ok: 2.5,
          wait: 5,
        });
        const moveScore = scoreInverseMetric(metrics.movePercent, {
          ok: 6,
          wait: 12,
        });
        const volumeScore = scoreMetric(metrics.volume24h, {
          ok: 50000,
          wait: 20000,
        });

        const totalScore =
          liquidityScore.score +
          spreadScore.score +
          moveScore.score +
          volumeScore.score;

        const verdict = getVerdict(totalScore);
        const confidence = Math.max(
          0,
          Math.min(100, Math.round(((totalScore + 4) / 8) * 100))
        );

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

    const overallScore =
      tokens.reduce((s, t) => s + t.totalScore, 0) / tokens.length;
    const overallVerdict = getVerdict(overallScore);
    const overallConfidence = Math.round(
      tokens.reduce((s, t) => s + t.confidence, 0) / tokens.length
    );

    res.json({
      topicId,
      market: {
        // keep both for transparency
        foundKind: found.kind,
        chosen: chosenMarket,
        parent: parentMarket || null,
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
