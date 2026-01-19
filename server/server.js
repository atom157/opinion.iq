const path = require("path");
const express = require("express");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const app = express();
const PORT = process.env.PORT || 3000;

const OPINION_API_BASE = (process.env.OPINION_API_BASE || "").trim();
const OPINION_API_KEY = (process.env.OPINION_API_KEY || "").trim();

if (!OPINION_API_BASE || !OPINION_API_KEY) {
  console.warn("Missing OPINION_API_BASE or OPINION_API_KEY.");
}

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/health", (_req, res) => res.json({ ok: true }));

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

async function fetchText(url) {
  const res = await fetch(url, { headers: getHeaders() });
  const text = await res.text();
  return { res, text };
}

async function fetchJsonStrict(url) {
  const { res, text } = await fetchText(url);

  if (!res.ok) {
    throw new Error(`Request failed (${res.status}): ${text}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Bad JSON from ${url}: ${text.slice(0, 200)}`);
  }
}

function uniq(arr) {
  return Array.from(new Set(arr.filter(Boolean)));
}

function normalizeBases(base) {
  const b = base.replace(/\/+$/, "");
  const noOpenapi = b.replace(/\/openapi$/i, "");
  return uniq([b, noOpenapi, `${noOpenapi}/openapi`]);
}

async function fetchFirstWorking(urls) {
  let lastErr = null;

  for (const url of urls) {
    try {
      const data = await fetchJsonStrict(url);
      return { data, usedUrl: url };
    } catch (e) {
      lastErr = e;

      // 404 / no route → пробуємо далі
      const msg = String(e.message || "");
      if (msg.includes("(404)") || msg.includes("no Route matched")) continue;

      // інші помилки (401/403/429/500) — показуємо одразу
      throw e;
    }
  }

  throw lastErr || new Error("All endpoint candidates failed");
}

function buildCandidates(bases, id) {
  // Найчастіші префікси
  const prefixes = ["", "/v1", "/api/v1", "/openapi", "/openapi/v1"];

  // Варіанти кореневих ресурсів
  const marketRoots = [
    `/market/${id}`,
    `/markets/${id}`,
    `/topic/${id}`,
    `/topics/${id}`,
  ];

  // Для випадку topicId != marketId: треба витягнути список і знайти відповідність
  const listRoots = ["/market", "/markets"];

  // Сафікси
  const priceSuffixes = ["/price", "/prices/latest", "/ticker"];
  const orderbookSuffixes = ["/orderbook", "/order-book", "/book"];
  const historySuffixes = [
    "/history?interval=1h&limit=48",
    "/candles?interval=1h&limit=48",
    "/kline?interval=1h&limit=48",
  ];

  const marketUrls = [];
  const listUrls = [];
  const priceUrls = [];
  const orderbookUrls = [];
  const historyUrls = [];

  for (const base of bases) {
    for (const pref of prefixes) {
      for (const p of marketRoots) {
        const root = `${base}${pref}${p}`;
        marketUrls.push(root);
        for (const s of priceSuffixes) priceUrls.push(`${root}${s}`);
        for (const s of orderbookSuffixes) orderbookUrls.push(`${root}${s}`);
        for (const s of historySuffixes) historyUrls.push(`${root}${s}`);
      }
      for (const lp of listRoots) {
        listUrls.push(`${base}${pref}${lp}`);
      }
    }
  }

  return {
    marketUrls: uniq(marketUrls),
    listUrls: uniq(listUrls),
    priceUrls: uniq(priceUrls),
    orderbookUrls: uniq(orderbookUrls),
    historyUrls: uniq(historyUrls),
  };
}

function extractArray(resp) {
  if (!resp) return [];
  if (Array.isArray(resp)) return resp;
  if (Array.isArray(resp.data)) return resp.data;
  if (Array.isArray(resp.markets)) return resp.markets;
  if (Array.isArray(resp.items)) return resp.items;
  if (Array.isArray(resp.result)) return resp.result;
  return [];
}

async function resolveMarketIdFromTopicId(topicId, listUrls) {
  // Пробуємо дістати список markets і знайти market.id по topicId
  const listRes = await fetchFirstWorking(listUrls);
  const arr = extractArray(listRes.data);

  if (!arr.length) {
    throw new Error("Market list endpoint returned no array (unexpected format).");
  }

  const found = arr.find((m) => String(m?.topicId) === String(topicId));
  if (!found?.id) {
    throw new Error(`Market not found in list for topicId ${topicId}`);
  }

  return { marketId: found.id, usedUrl: listRes.usedUrl };
}

function sumDepthWithinPercent(orderbook, mid, percent) {
  if (!orderbook || !mid) return 0;

  const threshold = mid * (percent / 100);
  const maxBid = mid + threshold;
  const minAsk = mid - threshold;

  const bids = Array.isArray(orderbook.bids) ? orderbook.bids : [];
  const asks = Array.isArray(orderbook.asks) ? orderbook.asks : [];

  const bidDepth = bids
    .filter((bid) => Number(bid.price) >= minAsk)
    .reduce((t, bid) => t + Number(bid.size || 0), 0);

  const askDepth = asks
    .filter((ask) => Number(ask.price) <= maxBid)
    .reduce((t, ask) => t + Number(ask.size || 0), 0);

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

function pickHistoryArray(history) {
  if (!history) return [];
  if (Array.isArray(history.data)) return history.data;
  if (Array.isArray(history.history)) return history.history;
  if (Array.isArray(history.items)) return history.items;
  if (Array.isArray(history.result)) return history.result;
  return [];
}

app.post("/api/analyze", async (req, res) => {
  const { url } = req.body;
  const topicId = parseTopicId(url);

  if (!topicId) return res.status(400).json({ error: "Invalid URL. Could not find topicId." });
  if (!OPINION_API_BASE || !OPINION_API_KEY)
    return res.status(500).json({ error: "Missing API configuration." });

  const bases = normalizeBases(OPINION_API_BASE);

  try {
    // 1) Спершу пробуємо “напряму” по topicId
    let candidates = buildCandidates(bases, topicId);

    let marketRes, priceRes, orderbookRes, historyRes;
    let debug = { basesTried: bases, used: {} };

    try {
      marketRes = await fetchFirstWorking(candidates.marketUrls);
      priceRes = await fetchFirstWorking(candidates.priceUrls);
      orderbookRes = await fetchFirstWorking(candidates.orderbookUrls);
      historyRes = await fetchFirstWorking(candidates.historyUrls);

      debug.used.market = marketRes.usedUrl;
      debug.used.price = priceRes.usedUrl;
      debug.used.orderbook = orderbookRes.usedUrl;
      debug.used.history = historyRes.usedUrl;
    } catch (e) {
      // 2) Якщо 404/no route — значить topicId не marketId або інший ресурс.
      // Спробуємо резолв через список markets: topicId -> marketId
      const msg = String(e.message || "");
      if (!(msg.includes("(404)") || msg.includes("no Route matched"))) {
        throw e;
      }

      const resolved = await resolveMarketIdFromTopicId(topicId, candidates.listUrls);
      const marketId = resolved.marketId;

      // rebuild candidates for real marketId
      candidates = buildCandidates(bases, marketId);

      marketRes = await fetchFirstWorking(candidates.marketUrls);
      priceRes = await fetchFirstWorking(candidates.priceUrls);
      orderbookRes = await fetchFirstWorking(candidates.orderbookUrls);
      historyRes = await fetchFirstWorking(candidates.historyUrls);

      debug.used.market = marketRes.usedUrl;
      debug.used.price = priceRes.usedUrl;
      debug.used.orderbook = orderbookRes.usedUrl;
      debug.used.history = historyRes.usedUrl;
      debug.used.marketList = resolved.usedUrl;
      debug.resolved = { topicId, marketId };
    }

    const market = marketRes.data;
    const latestPrice = priceRes.data;
    const orderbook = orderbookRes.data;
    const history = historyRes.data;

    const bestBid = Number(orderbook?.bids?.[0]?.price || 0);
    const bestAsk = Number(orderbook?.asks?.[0]?.price || 0);
    const mid =
      bestBid && bestAsk ? (bestBid + bestAsk) / 2 : Number(latestPrice?.price || latestPrice?.value || 0);

    const spreadPercent = mid ? ((bestAsk - bestBid) / mid) * 100 : 0;
    const depth = sumDepthWithinPercent(orderbook, mid, 1);

    const historyPoints = pickHistoryArray(history);
    let movePercent = 0;
    if (historyPoints.length > 1) {
      const latest = Number(historyPoints[historyPoints.length - 1]?.price || historyPoints[historyPoints.length - 1]?.value || 0);
      const prior = Number(historyPoints[historyPoints.length - 2]?.price || historyPoints[historyPoints.length - 2]?.value || 0);
      if (prior) movePercent = Math.abs(((latest - prior) / prior) * 100);
    }

    const volume24h = Number(market?.volume24h || market?.volume_24h || market?.volume || 0);

    const liquidityScore = scoreMetric(depth, { ok: 25000, wait: 10000 });
    const spreadScore = scoreInverseMetric(spreadPercent, { ok: 2.5, wait: 5 });
    const moveScore = scoreInverseMetric(movePercent, { ok: 6, wait: 12 });
    const volumeScore = scoreMetric(volume24h, { ok: 50000, wait: 20000 });

    const totalScore = liquidityScore.score + spreadScore.score + moveScore.score + volumeScore.score;
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

    return res.json({
      topicId,
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
      debug,
      market,
      latestPrice,
      orderbook,
      history,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.message || "Failed to analyze" });
  }
});

app.listen(PORT, () => {
  console.log(`Opinion IQ running on http://localhost:${PORT}`);
});
