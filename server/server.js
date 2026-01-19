const path = require("path");
const express = require("express");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const app = express();
const PORT = process.env.PORT || 3000;

const OPINION_API_BASE = (process.env.OPINION_API_BASE || "").trim();
const OPINION_API_KEY = (process.env.OPINION_API_KEY || "").trim();

if (!OPINION_API_BASE || !OPINION_API_KEY) {
  console.warn(
    "Missing OPINION_API_BASE or OPINION_API_KEY. Set Railway Variables (or .env locally)."
  );
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
    // віддаємо текст помилки, щоб в логах Railway було видно реальний endpoint/причину
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
  // Підтримує:
  // - https://openapi.opinion.trade
  // - https://openapi.opinion.trade/openapi
  // І пробує з /openapi та без нього
  const b = base.replace(/\/+$/, "");
  const noOpenapi = b.replace(/\/openapi$/i, "");
  return uniq([b, noOpenapi, `${noOpenapi}/openapi`]);
}

async function fetchFirstWorking(urls) {
  let lastErr = null;

  for (const url of urls) {
    try {
      return { data: await fetchJsonStrict(url), usedUrl: url };
    } catch (e) {
      lastErr = e;

      // Якщо 404 — пробуємо наступний кандидат
      if (String(e.message).includes("(404)")) continue;

      // Якщо інша помилка (401/403/500) — краще одразу показати її, бо це вже не "не той endpoint"
      throw e;
    }
  }

  // Усі кандидати дали 404
  throw lastErr || new Error("All endpoint candidates failed");
}

function buildCandidates(bases, topicId) {
  // Ми не знаємо точний контракт API, тому робимо “умний перебір”.
  // Найчастіші варіанти:
  // /market/:id  або /markets/:id
  // price/orderbook/history можуть бути під ними
  const marketPaths = [
    `/market/${topicId}`,
    `/markets/${topicId}`,
  ];

  const priceSuffixes = [
    `/price`,
    `/prices/latest`,
    `/ticker`,
  ];

  const orderbookSuffixes = [
    `/orderbook`,
    `/order-book`,
    `/book`,
  ];

  const historySuffixes = [
    `/history?interval=1h&limit=48`,
    `/candles?interval=1h&limit=48`,
    `/kline?interval=1h&limit=48`,
  ];

  const marketUrls = [];
  const priceUrls = [];
  const orderbookUrls = [];
  const historyUrls = [];

  for (const base of bases) {
    for (const p of marketPaths) {
      const root = `${base}${p}`;
      marketUrls.push(root);
      for (const s of priceSuffixes) priceUrls.push(`${root}${s}`);
      for (const s of orderbookSuffixes) orderbookUrls.push(`${root}${s}`);
      for (const s of historySuffixes) historyUrls.push(`${root}${s}`);
    }
  }

  return {
    marketUrls: uniq(marketUrls),
    priceUrls: uniq(priceUrls),
    orderbookUrls: uniq(orderbookUrls),
    historyUrls: uniq(historyUrls),
  };
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
  return [];
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
    const bases = normalizeBases(OPINION_API_BASE);
    const { marketUrls, priceUrls, orderbookUrls, historyUrls } = buildCandidates(bases, topicId);

    // ВАЖЛИВО: робимо послідовно, щоб не шмаляти 20 запитів паралельно
    const marketRes = await fetchFirstWorking(marketUrls);
    const priceRes = await fetchFirstWorking(priceUrls);
    const orderbookRes = await fetchFirstWorking(orderbookUrls);
    const historyRes = await fetchFirstWorking(historyUrls);

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

    res.json({
      topicId,
      verdict,
      confidence,
      facts,
      why: why.slice(0, 3),

      // щоб ти бачив, що реально спрацювало (ДУЖЕ корисно для дебага)
      debug: {
        used: {
          market: marketRes.usedUrl,
          price: priceRes.usedUrl,
          orderbook: orderbookRes.usedUrl,
          history: historyRes.usedUrl,
        },
        basesTried: bases,
      },

      // сирі дані — лишив як було
      market,
      latestPrice,
      orderbook,
      history,
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
