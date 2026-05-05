import express from "express";

const app = express();
app.set("trust proxy", 1);
app.use(express.json());

const VALID_API_KEY = "UMERSHERAZ";

/** Sent on every webhook POST as `x-mxs-webhook-key` (set `MXS_WEBHOOK_KEY` in production). */
const MXS_WEBHOOK_KEY =
  process.env.MXS_WEBHOOK_KEY?.trim() || "mxs_webhook_dev_secret_change_me";

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

function buildRedirectUrl(baseUrl, txnId, extra) {
  if (!baseUrl || typeof baseUrl !== "string") return null;
  try {
    const u = new URL(baseUrl);
    u.searchParams.set("txn_id", txnId);
    for (const [k, v] of Object.entries(extra ?? {})) {
      u.searchParams.set(k, String(v));
    }
    return u.toString();
  } catch {
    return baseUrl;
  }
}

const WEBHOOK_STATUSES = new Set([
  "COMPLETED",
  "FAILED",
  "PARTIAL",
  "CANCELED",
  "EXPIRED",
]);

function defaultFailReason(status) {
  switch (status) {
    case "FAILED":
      return "General rejection";
    case "CANCELED":
      return "Canceled before completion";
    case "EXPIRED":
      return "Payment window expired before completion";
    case "PARTIAL":
      return "Received amount is lower than the requested amount";
    default:
      return "";
  }
}

function buildPayinWebhookPayload(session, txnId, status, opts = {}) {
  const requested = session.amount;
  let paid = 0;
  if (status === "COMPLETED") {
    paid = requested;
  } else if (status === "PARTIAL") {
    paid = Math.floor(Number(opts.paid_amount));
    if (!Number.isFinite(paid)) paid = 0;
  }

  const payload = {
    type: "payin",
    status,
    txn_id: txnId,
    requested_amount: requested,
    paid_amount: paid,
    service: String(session.service),
    currency: String(session.currency).toUpperCase().slice(0, 3),
    custom_value:
      session.metadata != null && session.metadata !== ""
        ? String(session.metadata)
        : "",
  };

  if (status !== "COMPLETED") {
    const fr =
      typeof opts.fail_reason === "string" && opts.fail_reason.trim()
        ? opts.fail_reason.trim()
        : defaultFailReason(status);
    if (fr) payload.fail_reason = fr;
  }
  return payload;
}

async function postJsonToCallback(callbackUrl, payload) {
  if (!callbackUrl || typeof callbackUrl !== "string") return;
  try {
    const res = await fetch(callbackUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-mxs-webhook-key": MXS_WEBHOOK_KEY,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      console.error("Webhook POST non-OK", callbackUrl, res.status);
    }
  } catch (e) {
    console.error("Webhook POST failed", callbackUrl, e?.message ?? e);
  }
}

function redirectForOutcome(session, txnId, status) {
  const q = { outcome: status.toLowerCase() };
  if (status === "COMPLETED" || status === "PARTIAL") {
    return buildRedirectUrl(session.success_url, txnId, q);
  }
  return buildRedirectUrl(session.error_url, txnId, q);
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
  const defaultPartial =
    amount > 1 ? Math.max(1, Math.floor(amount / 2)) : 0;

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
    .btn-amber {
      color: #fcd34d;
      background: rgba(251, 191, 36, 0.1);
      border: 1px solid rgba(251, 191, 36, 0.35);
    }
    .btn-amber:hover {
      background: rgba(251, 191, 36, 0.18);
    }
    .btn-danger {
      color: #fecaca;
      background: rgba(248, 113, 113, 0.12);
      border: 1px solid rgba(248, 113, 113, 0.4);
    }
    .btn-danger:hover {
      background: rgba(248, 113, 113, 0.2);
    }
    .btn-muted {
      color: var(--muted);
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid var(--stroke);
      font-size: 13px;
    }
    .outcomes {
      display: flex;
      flex-direction: column;
      gap: 12px;
      margin-top: 22px;
    }
    .outcomes-label {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--muted);
    }
    .outcome-grid {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .outcome-grid button {
      flex: 1 1 42%;
      min-width: 140px;
      padding: 12px 14px;
      font-size: 13px;
    }
    .partial-row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 10px;
      padding: 12px;
      border-radius: 12px;
      border: 1px solid var(--stroke);
      background: rgba(0, 0, 0, 0.2);
    }
    .partial-row label {
      font-size: 12px;
      color: var(--muted);
    }
    .partial-row input {
      width: 88px;
      padding: 8px 10px;
      border-radius: 8px;
      border: 1px solid var(--stroke);
      background: var(--bg1);
      color: var(--text);
      font: inherit;
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
      <div class="outcomes" id="outcomes">
        <div class="outcomes-label">Final outcome (sends webhook to callback_url)</div>
        <button type="button" class="btn-primary" id="btnCompleted">Completed</button>
        <div class="partial-row">
          <label for="partialPaid">Partial — paid amount (${escapeHtml(String(currency).toUpperCase().slice(0, 3))})</label>
          <input type="number" id="partialPaid" min="1" max="${amount > 1 ? amount - 1 : 1}" step="1" value="${defaultPartial > 0 ? defaultPartial : ""}" ${amount <= 1 ? "disabled" : ""} />
          <button type="button" class="btn-amber" id="btnPartial" ${amount <= 1 ? "disabled" : ""}>Partial</button>
        </div>
        <div class="outcome-grid">
          <button type="button" class="btn-danger" id="btnFailed">Failed</button>
          <button type="button" class="btn-ghost" id="btnCanceled">Canceled</button>
          <button type="button" class="btn-amber" id="btnExpired">Expired</button>
        </div>
      </div>
    </div>
    <p class="foot">Demo checkout · each outcome <code>POST</code>s JSON to your <code>callback_url</code> (if set), then redirects when URLs exist.</p>
  </div>
  <script>
    (function () {
      var txnId = ${txnJson};
      var requestedAmount = ${amount};

      function setAllBusy(busy) {
        document.querySelectorAll("#outcomes button").forEach(function (b) {
          b.disabled = !!busy;
          b.style.opacity = busy ? "0.55" : "";
        });
      }

      async function postOutcome(status, extra) {
        var body = Object.assign({ status: status }, extra || {});
        var r = await fetch("/checkout/" + encodeURIComponent(txnId) + "/outcome", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        var data = await r.json().catch(function () { return {}; });
        return { ok: r.ok, data: data };
      }

      function finish(ok, data) {
        if (!ok) {
          alert((data && data.response) || "Request failed");
          setAllBusy(false);
          return;
        }
        var redir = data.response && data.response.redirectUrl;
        if (redir) {
          window.location.href = redir;
          return;
        }
        var el = document.getElementById("outcomes");
        el.innerHTML =
          '<p style="margin:0;text-align:center;color:var(--accent);font-weight:600;">Webhook sent. No redirect URL for this outcome.</p>';
      }

      document.getElementById("btnCompleted").addEventListener("click", async function () {
        setAllBusy(true);
        try {
          var r = await postOutcome("COMPLETED");
          finish(r.ok, r.data);
        } catch (e) {
          alert("Network error");
          setAllBusy(false);
        }
      });

      document.getElementById("btnPartial").addEventListener("click", async function () {
        var inp = document.getElementById("partialPaid");
        var paid = parseInt(inp.value, 10);
        if (!Number.isFinite(paid) || paid <= 0 || paid >= requestedAmount) {
          alert("Enter paid amount: integer greater than 0 and less than " + requestedAmount);
          return;
        }
        setAllBusy(true);
        try {
          var r = await postOutcome("PARTIAL", { paid_amount: paid });
          finish(r.ok, r.data);
        } catch (e) {
          alert("Network error");
          setAllBusy(false);
        }
      });

      document.getElementById("btnFailed").addEventListener("click", async function () {
        var fr = window.prompt("Fail reason (optional)", "General rejection");
        if (fr === null) return;
        setAllBusy(true);
        try {
          var r = await postOutcome("FAILED", { fail_reason: fr || "General rejection" });
          finish(r.ok, r.data);
        } catch (e) {
          alert("Network error");
          setAllBusy(false);
        }
      });

      document.getElementById("btnCanceled").addEventListener("click", async function () {
        setAllBusy(true);
        try {
          var r = await postOutcome("CANCELED", {
            fail_reason: "Canceled before completion",
          });
          finish(r.ok, r.data);
        } catch (e) {
          alert("Network error");
          setAllBusy(false);
        }
      });

      document.getElementById("btnExpired").addEventListener("click", async function () {
        setAllBusy(true);
        try {
          var r = await postOutcome("EXPIRED", {
            fail_reason: "Payment window expired before completion",
          });
          finish(r.ok, r.data);
        } catch (e) {
          alert("Network error");
          setAllBusy(false);
        }
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

app.post("/checkout/:txnId/outcome", async (req, res) => {
  const { txnId } = req.params;
  const body = req.body ?? {};
  const status = body.status;

  if (!WEBHOOK_STATUSES.has(status)) {
    return res.status(400).json({
      success: false,
      response: "Invalid status",
    });
  }

  const session = checkoutSessions.get(txnId);
  if (!session) {
    return res.status(404).json({ success: false, response: "Not found" });
  }

  if (session.terminal_status) {
    if (session.terminal_status === status) {
      return res.status(200).json({
        success: true,
        response: {
          redirectUrl: redirectForOutcome(session, txnId, status),
          duplicate: true,
        },
      });
    }
    return res.status(409).json({
      success: false,
      response: `Transaction already finalized as ${session.terminal_status}`,
    });
  }

  const expireAt = parseExpireDate(session.expire_date);
  const timeExpired = expireAt != null && Date.now() > expireAt.getTime();
  if (timeExpired && (status === "COMPLETED" || status === "PARTIAL")) {
    return res.status(400).json({
      success: false,
      response:
        "This payment link has expired — use Expired, Failed, or Canceled instead",
    });
  }

  if (status === "PARTIAL") {
    const paid = body.paid_amount;
    if (
      !Number.isInteger(paid) ||
      paid <= 0 ||
      paid >= session.amount ||
      session.amount <= 1
    ) {
      return res.status(400).json({
        success: false,
        response:
          "paid_amount must be an integer with 0 < paid_amount < requested amount",
      });
    }
  }

  session.terminal_status = status;
  const payload = buildPayinWebhookPayload(session, txnId, status, {
    paid_amount: body.paid_amount,
    fail_reason: body.fail_reason,
  });
  await postJsonToCallback(session.callback_url, payload);

  return res.status(200).json({
    success: true,
    response: {
      redirectUrl: redirectForOutcome(session, txnId, status),
    },
  });
});

export default app;
