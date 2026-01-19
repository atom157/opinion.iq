# Opinion IQ

Opinion IQ is a lightweight Node.js + HTML app that scores Opinion markets in an aggressive mode.

## Setup

1. Copy the environment template and add your Opinion OpenAPI credentials:

```bash
cp .env.example .env
```

2. Install dependencies:

```bash
npm install
```

3. Start the server:

```bash
npm start
```

The app runs at [http://localhost:8080](http://localhost:8080) by default.

## Usage

Paste an Opinion topic URL (for example, `https://app.opinion.trade/detail?topicId=61&type=multi`) and click **Analyze**.

The backend reads `topicId` from the URL, fetches market data from the Opinion OpenAPI, and returns an aggressive-mode verdict based on liquidity depth, spread, 1h move, and 24h volume.
