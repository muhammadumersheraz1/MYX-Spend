# MYXSpend Backend

Express.js backend that mirrors a MyXSpend-style payment API: create payments with JSON, enforce an API key on `/v1` routes, and serve an HTML checkout page for each transaction.

## Requirements

- [Node.js](https://nodejs.org/) 18 or newer

## Quick start (local)

```bash
npm install
npm start
```

The server listens on `PORT` (default `3000`). If that port is busy, it tries the next ports automatically.

For live reload during development:

```bash
npm run dev
```

## Environment variables

| Variable      | Required | Description |
|---------------|----------|-------------|
| `PORT`        | No       | Local HTTP port (default `3000`). |
| `PUBLIC_URL`  | No*      | Public site origin with **no** trailing slash (e.g. `https://your-app.vercel.app`). Used for `payment_link` when the request host is not the public URL (typical behind Vercel). |

\* Strongly recommended in production / on Vercel so returned `payment_link` values use your real HTTPS domain.

Do not commit secrets; use `.env` locally (see `.gitignore`).

## Authentication

All **`/v1/*`** routes require:

```http
X-API-KEY: UMERSHERAZ
Content-Type: application/json
```

The expected key is defined in `src/app.js` (`VALID_API_KEY`). Change it there for production, or refactor to read from `process.env` if you prefer.

The checkout page **`GET /checkout/:txnId`** is opened in the browser and does **not** send this header.

## API

### `POST /v1/createPayment`

**Headers:** `X-API-KEY`, `Content-Type: application/json`

**Body (JSON):**

| Field                 | Type    | Required | Notes |
|-----------------------|---------|----------|--------|
| `amount`              | integer | Yes      | Whole number only. |
| `currency`            | string  | Yes      | e.g. `USD`, `EUR`. |
| `client_first_name`   | string  | Yes      | |
| `client_last_name`    | string  | Yes      | |
| `client_email`        | string  | Yes      | |
| `service`             | string  | Yes      | e.g. `CRYPTO`. |
| `client_phone_number` | string  | No       | May be `null`. |
| `callback_url`        | string  | No       | |
| `success_url`         | string  | No       | Checkout “Pay” redirect. |
| `error_url`           | string  | No       | Checkout “Cancel” redirect. |
| `metadata`            | string  | No       | |
| `expire_date`         | string  | No       | Format `YYYY-MM-DDTHH:MM`. |

**Success (200):**

```json
{
  "success": true,
  "response": {
    "payment_link": "https://example.com/checkout/TRN_…",
    "txn_id": "TRN_…"
  }
}
```

**Error (400 / 401):**

```json
{
  "success": false,
  "response": "Missing parameters"
}
```

or, for auth failures:

```json
{
  "success": false,
  "response": "Missing or invalid API key"
}
```

### `GET /checkout/:txnId`

Returns the payment HTML page for a transaction created via `createPayment`. Sessions are stored **in memory** only.

## Deploy on Vercel

This repo follows [Express on Vercel](https://vercel.com/docs/frameworks/backend/express): the serverless entry is **`src/app.js`** (default export). Local listening uses **`run-local.mjs`** at the project root so Vercel does not treat it as a second app entry.

1. Connect the repository in the [Vercel dashboard](https://vercel.com/new) or run `vercel` from this directory.
2. Set **`PUBLIC_URL`** to your deployment URL (e.g. `https://my-project.vercel.app`), then redeploy.
3. Call `POST https://<your-deployment>/v1/createPayment` with the headers above.

**Note:** In-memory checkout data does not survive cold starts or multiple instances. For production, persist sessions (database or cache) and optionally invoke `callback_url` when a payment completes.

## Postman

Import **`MYXSpend-Backend.postman_collection.json`**. Set collection variables:

- **`baseUrl`** — e.g. `http://localhost:3000` or your Vercel URL  
- **`apiKey`** — must match `VALID_API_KEY` in code (default `UMERSHERAZ`)

## Project layout

```
├── README.md
├── MYXSpend-Backend.postman_collection.json
├── package.json
├── run-local.mjs          # Local HTTP server (npm start)
└── src/
    └── app.js             # Express app (Vercel + imported by run-local.mjs)
```

## License

Private project; all rights reserved unless you add your own license.
