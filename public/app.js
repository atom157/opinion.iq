const analyzeBtn = document.getElementById("analyze-btn");
const topicUrlInput = document.getElementById("topic-url");
const resultsSection = document.querySelector(".results");
const errorSection = document.querySelector(".error");
const errorMessage = document.getElementById("error-message");
const verdictEl = document.getElementById("verdict");
const confidenceEl = document.getElementById("confidence");
const factsList = document.getElementById("facts-list");
const whyList = document.getElementById("why-list");
const copyBtn = document.getElementById("copy-btn");
const copyStatus = document.getElementById("copy-status");

function resetState() {
  resultsSection.hidden = true;
  errorSection.hidden = true;
  copyStatus.textContent = "";
}

function renderFacts(facts) {
  factsList.innerHTML = "";
  facts.forEach((fact) => {
    const li = document.createElement("li");
    li.textContent = `${fact.label}: ${fact.value} (${fact.status})`;
    factsList.appendChild(li);
  });
}

function renderWhy(reasons) {
  whyList.innerHTML = "";
  reasons.forEach((reason) => {
    const li = document.createElement("li");
    li.textContent = reason;
    whyList.appendChild(li);
  });
}

function buildSummary({ verdict, confidence, tokenLabel, facts, why }) {
  const factLines = facts.map(
    (fact) => `- ${fact.label}: ${fact.value} (${fact.status})`
  );
  const whyLines = why.map((item) => `- ${item}`);

  return [
    `Opinion IQ Verdict: ${verdict}`,
    `Confidence: ${confidence}%`,
    tokenLabel ? `Token: ${tokenLabel}` : null,
    "Facts:",
    ...factLines,
    "Why:",
    ...whyLines,
  ]
    .filter(Boolean)
    .join("\n");
}

async function analyzeTopic() {
  resetState();
  analyzeBtn.disabled = true;
  analyzeBtn.textContent = "Analyzing...";

  try {
    const response = await fetch("/api/analyze", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url: topicUrlInput.value }),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Failed to analyze topic");
    }

    const overall = data.overall || {};
    const primaryToken = Array.isArray(data.tokens) ? data.tokens[0] : null;
    const facts = primaryToken?.facts || [];
    const why = primaryToken?.why || [];

    verdictEl.textContent = overall.verdict || "--";
    confidenceEl.textContent = overall.confidence ? `${overall.confidence}%` : "--";
    renderFacts(facts);
    renderWhy(why);

    resultsSection.hidden = false;
    resultsSection.dataset.summary = buildSummary({
      verdict: overall.verdict,
      confidence: overall.confidence,
      tokenLabel: primaryToken?.tokenLabel,
      facts,
      why,
    });
  } catch (error) {
    errorMessage.textContent = error.message;
    errorSection.hidden = false;
  } finally {
    analyzeBtn.disabled = false;
    analyzeBtn.textContent = "Analyze";
  }
}

analyzeBtn.addEventListener("click", analyzeTopic);
copyBtn.addEventListener("click", async () => {
  const summary = resultsSection.dataset.summary;
  if (!summary) {
    return;
  }
  try {
    await navigator.clipboard.writeText(summary);
    copyStatus.textContent = "Copied!";
  } catch (error) {
    copyStatus.textContent = "Copy failed";
  }
});

resetState();
