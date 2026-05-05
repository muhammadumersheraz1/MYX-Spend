import express from "express";

const app = express();
app.set("trust proxy", 1);
app.use(express.json());

const VALID_API_KEY = "UMERSHERAZ";
/** @type {Map<string, Record<string, unknown>>} */
const checkoutSessions = new Map();

/** Public origin for payment_link; set PUBLIC_URL in production (no trailing slash). */
function publicOrigin(req) {
  const configured = process.env.PUBLIC_URL?.replace(/\/$/, "");
  if (configured) return configured;
  const proto =
    req.get("x-forwarded-proto")?.split(",")[0]?.trim() ||
    req.protocol ||
    "http";
  const host =
    req.get("x-forwarded-host")?.split(",")[0]?.trim() ||
    req.get("host") ||
    "localhost";
  return `${proto}://${host}`;
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

function requireApiKey(req, res, next) {
  const key = req.get("x-api-key");
  if (key !== VALID_API_KEY) {
    return res.status(401).json({
      success: false,
      response: "Missing or invalid API key",
    });
  }
  next();
}

function isOptionalStringOrNull(v) {
  return v === null || v === undefined || typeof v === "string";
}

function isValidExpireDate(v) {
  if (v === null || v === undefined) return true;
  if (typeof v !== "string") return false;
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v);
}

function generateTxnId() {
  const hex = Array.from({ length: 12 }, () =>
    Math.floor(Math.random() * 16).toString(16).toUpperCase()
  ).join("");
  return `TRN_${hex}`;
}

function escapeHtml(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function parseExpireDate(expireDate) {
  if (!expireDate || typeof expireDate !== "string") return null;
  const d = new Date(expireDate);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatMoney(amount, currency) {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: String(currency).toUpperCase().slice(0, 3),
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `${amount} ${String(currency).toUpperCase()}`;
  }
}

function renderCheckoutPage(session, txnId) {
  const amount = session.amount;
  const currency = session.currency;
  const service = session.service;
  const first = session.client_first_name;
  const last = session.client_last_name;
  const email = session.client_email;
  const phone = session.client_phone_number;
  const metadata = session.metadata;
  const expireAt = parseExpireDate(session.expire_date);
  const expired = expireAt != null && Date.now() > expireAt.getTime();
  const successUrl = session.success_url;
  const errorUrl = session.error_url;

  const payeeLine = [first, last].filter(Boolean).join(" ");
  const amountLabel = formatMoney(amount, currency);
  const expireLabel = expireAt
    ? expireAt.toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "";

  const successJson = JSON.stringify(successUrl ?? null);
  const errorJson = JSON.stringify(errorUrl ?? null);
  const txnJson = JSON.stringify(txnId);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Secure checkout · ${escapeHtml(txnId)}</title>
  <style>
    :root {
      --bg0: #07080d;
      --bg1: #0e1018;
      --card: rgba(20, 24, 36, 0.85);
      --stroke: rgba(120, 140, 200, 0.18);
      --text: #e8ebf4;
      --muted: #8b95b3;
      --accent: #22d3a3;
      --accent-dim: rgba(34, 211, 163, 0.15);
      --danger: #f87171;
      --radius: 20px;
      --shadow: 0 24px 80px rgba(0, 0, 0, 0.55);
      --font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: var(--font);
      color: var(--text);
      background:
        radial-gradient(1200px 600px at 10% -10%, rgba(34, 211, 163, 0.12), transparent 55%),
        radial-gradient(900px 500px at 100% 0%, rgba(99, 102, 241, 0.14), transparent 50%),
        linear-gradient(165deg, var(--bg0), var(--bg1) 40%, #06070c);
    }
    .wrap {
      max-width: 440px;
      margin: 0 auto;
      padding: clamp(24px, 5vw, 48px) 20px 48px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 28px;
      letter-spacing: 0.06em;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      color: var(--muted);
    }
    .brand-mark {
      width: 28px;
      height: 28px;
      border-radius: 9px;
      background: linear-gradient(135deg, var(--accent), #6366f1);
      box-shadow: 0 8px 24px rgba(34, 211, 163, 0.35);
    }
    .card {
      position: relative;
      border-radius: var(--radius);
      padding: 28px 26px 26px;
      background: var(--card);
      border: 1px solid var(--stroke);
      box-shadow: var(--shadow);
      backdrop-filter: blur(12px);
    }
    .card::before {
      content: "";
      position: absolute;
      inset: 0;
      border-radius: inherit;
      padding: 1px;
      background: linear-gradient(145deg, rgba(255,255,255,0.12), transparent 40%, transparent);
      -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
      mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
      -webkit-mask-composite: xor;
      mask-composite: exclude;
      pointer-events: none;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 10px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      background: var(--accent-dim);
      color: var(--accent);
      border: 1px solid rgba(34, 211, 163, 0.25);
    }
    .amount {
      margin: 18px 0 6px;
      font-size: clamp(2rem, 8vw, 2.45rem);
      font-weight: 700;
      letter-spacing: -0.03em;
      line-height: 1.1;
    }
    .sub {
      font-size: 14px;
      color: var(--muted);
      margin-bottom: 22px;
    }
    dl {
      margin: 0;
      padding: 16px 0 0;
      border-top: 1px solid var(--stroke);
      display: grid;
      gap: 12px;
    }
    dt {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--muted);
    }
    dd {
      margin: 2px 0 0;
      font-size: 15px;
      font-weight: 500;
    }
    .row-actions {
      display: flex;
      flex-direction: column;
      gap: 10px;
      margin-top: 26px;
    }
    button {
      font: inherit;
      cursor: pointer;
      border: none;
      border-radius: 14px;
      padding: 15px 18px;
      font-weight: 600;
      font-size: 15px;
      transition: transform 0.15s ease, box-shadow 0.15s ease, opacity 0.15s;
    }
    button:active { transform: scale(0.98); }
    .btn-primary {
      color: #04120d;
      background: linear-gradient(135deg, #34e4b8, #22d3a3);
      box-shadow: 0 12px 32px rgba(34, 211, 163, 0.35);
    }
    .btn-primary:hover:not(:disabled) {
      box-shadow: 0 16px 40px rgba(34, 211, 163, 0.45);
    }
    .btn-primary:disabled {
      opacity: 0.45;
      cursor: not-allowed;
      box-shadow: none;
    }
    .btn-ghost {
      color: var(--muted);
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid var(--stroke);
    }
    .btn-ghost:hover {
      color: var(--text);
      border-color: rgba(120, 140, 200, 0.35);
    }
    .foot {
      margin-top: 22px;
      font-size: 12px;
      color: var(--muted);
      line-height: 1.5;
      text-align: center;
    }
    .expired-banner {
      border-radius: 12px;
      padding: 12px 14px;
      margin-bottom: 18px;
      font-size: 13px;
      background: rgba(248, 113, 113, 0.12);
      border: 1px solid rgba(248, 113, 113, 0.35);
      color: #fecaca;
    }
    .txn {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
      color: var(--muted);
      word-break: break-all;
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="brand">
      <span class="brand-mark" aria-hidden="true"></span>
      <span>MYXSpend · Checkout</span>
    </div>
    <div class="card" id="card">
      ${
        expired
          ? `<div class="expired-banner">This payment link has expired${
              expireLabel ? ` (${escapeHtml(expireLabel)})` : ""
            }.</div>`
          : ""
      }
      <span class="badge">${escapeHtml(String(service))}</span>
      <div class="amount">${escapeHtml(amountLabel)}</div>
      <div class="sub">Complete your payment securely.</div>
      <dl>
        <div>
          <dt>Payer</dt>
          <dd>${escapeHtml(payeeLine || "—")}</dd>
        </div>
        <div>
          <dt>Email</dt>
          <dd>${escapeHtml(String(email || "—"))}</dd>
        </div>
        ${
          phone
            ? `<div>
          <dt>Phone</dt>
          <dd>${escapeHtml(String(phone))}</dd>
        </div>`
            : ""
        }
        ${
          metadata
            ? `<div>
          <dt>Reference</dt>
          <dd>${escapeHtml(String(metadata))}</dd>
        </div>`
            : ""
        }
        ${
          expireLabel && !expired
            ? `<div>
          <dt>Link expires</dt>
          <dd>${escapeHtml(expireLabel)}</dd>
        </div>`
            : ""
        }
        <div>
          <dt>Transaction</dt>
          <dd class="txn">${escapeHtml(txnId)}</dd>
        </div>
      </dl>
      <div class="row-actions">
        <button type="button" class="btn-primary" id="payBtn" ${expired ? "disabled" : ""}>
          Pay ${escapeHtml(amountLabel)}
        </button>
        <button type="button" class="btn-ghost" id="cancelBtn">Cancel</button>
      </div>
    </div>
    <p class="foot">Demo checkout · no funds are moved. Buttons redirect when URLs were provided at creation.</p>
  </div>
  <script>
    (function () {
      var txnId = ${txnJson};
      var successUrl = ${successJson};
      var errorUrl = ${errorJson};
      var expired = ${expired ? "true" : "false"};

      function withQuery(url, extra) {
        try {
          var u = new URL(url, window.location.origin);
          u.searchParams.set("txn_id", txnId);
          if (extra) Object.keys(extra).forEach(function (k) {
            u.searchParams.set(k, extra[k]);
          });
          return u.toString();
        } catch (e) {
          return url;
        }
      }

      document.getElementById("payBtn").addEventListener("click", function () {
        if (expired) return;
        if (successUrl) {
          window.location.href = withQuery(successUrl, { status: "paid" });
          return;
        }
        var card = document.getElementById("card");
        card.querySelector(".row-actions").innerHTML =
          '<p style="margin:0;text-align:center;color:var(--accent);font-weight:600;">Payment recorded (demo). No redirect URL was configured.</p>';
      });

      document.getElementById("cancelBtn").addEventListener("click", function () {
        if (errorUrl) {
          window.location.href = withQuery(errorUrl, { status: "cancelled" });
          return;
        }
        history.back();
      });
    })();
  </script>
</body>
</html>`;
}

function renderCheckoutNotFound() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Checkout not found</title>
  <style>
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      font-family: ui-sans-serif, system-ui, sans-serif;
      background: #07080d;
      color: #e8ebf4;
      padding: 24px;
      text-align: center;
    }
    h1 { font-size: 1.25rem; margin: 0 0 8px; }
    p { color: #8b95b3; margin: 0; font-size: 14px; max-width: 320px; line-height: 1.5; }
    a { color: #22d3a3; }
  </style>
</head>
<body>
  <div>
    <h1>Payment link not found</h1>
    <p>This checkout session is missing or expired from memory. Create a new payment from your app.</p>
  </div>
</body>
</html>`;
}

function missingRequiredFields(body) {
  const missing = [];
  if (body.amount === undefined || body.amount === null) missing.push("amount");
  else if (!Number.isInteger(body.amount)) missing.push("amount");
  if (!isNonEmptyString(body.currency)) missing.push("currency");
  if (!isNonEmptyString(body.client_first_name)) missing.push("client_first_name");
  if (!isNonEmptyString(body.client_last_name)) missing.push("client_last_name");
  if (!isNonEmptyString(body.client_email)) missing.push("client_email");
  if (!isNonEmptyString(body.service)) missing.push("service");
  return missing;
}

app.get("/", (_req, res) => {
  res.type("html").send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>MYXSpend Backend</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0a0a0f; color: #e8ebf4; }
    main { text-align: center; padding: 24px; }
    h1 { font-size: 1.5rem; font-weight: 600; margin: 0 0 8px; color: #22d3a3; }
    p { margin: 0; color: #8b95b3; font-size: 14px; }
  </style>
</head>
<body>
  <main>
    <h1>All OK</h1>
    <p>MYXSpend Backend is running.</p>
  </main>
</body>
</html>`);
});

app.use("/v1", requireApiKey);

app.post("/v1/createPayment", (req, res) => {
  const body = req.body ?? {};

  const missing = missingRequiredFields(body);
  if (missing.length > 0) {
    return res.status(400).json({
      success: false,
      response: "Missing parameters",
    });
  }

  if (!isOptionalStringOrNull(body.client_phone_number)) {
    return res.status(400).json({
      success: false,
      response: "Missing parameters",
    });
  }

  const optionalUrls = [
    body.callback_url,
    body.success_url,
    body.error_url,
  ];
  for (const u of optionalUrls) {
    if (u !== undefined && u !== null && typeof u !== "string") {
      return res.status(400).json({
        success: false,
        response: "Missing parameters",
      });
    }
  }

  if (
    body.metadata !== undefined &&
    body.metadata !== null &&
    typeof body.metadata !== "string"
  ) {
    return res.status(400).json({
      success: false,
      response: "Missing parameters",
    });
  }

  if (!isValidExpireDate(body.expire_date)) {
    return res.status(400).json({
      success: false,
      response: "Missing parameters",
    });
  }

  const txnId = generateTxnId();
  checkoutSessions.set(txnId, {
    amount: body.amount,
    currency: body.currency,
    client_first_name: body.client_first_name,
    client_last_name: body.client_last_name,
    client_email: body.client_email,
    client_phone_number: body.client_phone_number ?? null,
    service: body.service,
    success_url: body.success_url ?? null,
    error_url: body.error_url ?? null,
    callback_url: body.callback_url ?? null,
    metadata: body.metadata ?? null,
    expire_date: body.expire_date ?? null,
  });

  const paymentLink = `${publicOrigin(req)}/checkout/${txnId}`;

  return res.status(200).json({
    success: true,
    response: {
      payment_link: paymentLink,
      txn_id: txnId,
    },
  });
});

app.get("/checkout/:txnId", (req, res) => {
  const session = checkoutSessions.get(req.params.txnId);
  if (!session) {
    res.status(404).type("html").send(renderCheckoutNotFound());
    return;
  }
  res.type("html").send(renderCheckoutPage(session, req.params.txnId));
});

export default app;
