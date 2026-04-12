require("dotenv").config();

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");
const helmet = require("helmet");

const { getPublicContactConfig, isContactConfigured, sendContactEmail, verifyHCaptchaToken } = require("./contact");
const { capturePayPalOrder, createPayPalOrder, verifyWebhookSignature } = require("./paypal");
const { formatEuro, getProduct, listProducts } = require("./products");
const store = require("./store");

const app = express();
const port = Number(process.env.PORT || 3000);
const rootDir = path.resolve(__dirname, "..");
const requestTokenSecret = process.env.REQUEST_TOKEN_SECRET
  || process.env.DOWNLOAD_TOKEN_SECRET
  || crypto.randomBytes(32).toString("hex");
const requestTokenTtlMs = 1000 * 60 * 30;
const htmlPageRoutes = [
  { route: "/", filePath: path.join(rootDir, "index.html"), injectRequestToken: true, injectContactConfig: true, allowHcaptcha: true },
  { route: "/index.html", filePath: path.join(rootDir, "index.html"), injectRequestToken: true, injectContactConfig: true, allowHcaptcha: true },
  { route: "/impressum", filePath: path.join(rootDir, "impressum.html") },
  { route: "/impressum.html", filePath: path.join(rootDir, "impressum.html") },
  { route: "/datenschutz", filePath: path.join(rootDir, "datenschutz.html") },
  { route: "/datenschutz.html", filePath: path.join(rootDir, "datenschutz.html") },
  { route: "/a1.html", filePath: path.join(rootDir, "a1.html") },
  { route: "/a1/", filePath: path.join(rootDir, "a1", "index.html") },
  { route: "/a1/index.html", filePath: path.join(rootDir, "a1", "index.html") },
  { route: "/a1/personalpronomen.html", filePath: path.join(rootDir, "a1", "personalpronomen.html") }
];

app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: "same-site" },
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    strictTransportSecurity: false
  })
);
app.use((req, res, next) => {
  res.setHeader(
    "Permissions-Policy",
    "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()"
  );

  if (isSecureRequest(req)) {
    res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  }

  if (req.path === "/health" || req.path.startsWith("/api/")) {
    res.setHeader("Cache-Control", "no-store");
  }

  next();
});
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: false, limit: "10kb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/products", (_req, res) => {
  res.json({
    ok: true,
    products: listProducts()
  });
});

app.get("/api/public-config", (_req, res) => {
  const paymentEnabled = isPayPalConfigured();

  res.json({
    ok: true,
    paymentEnabled,
    paymentStatusMessage: paymentEnabled
      ? "Das Produkt ist bereit. Du kannst direkt bezahlen oder optional ein Trinkgeld hinzufügen."
      : "Diese Zahlungsart kommt bald. Bis dahin kannst du das Material weiterhin über Etsy kaufen."
  });
});

app.post(
  "/api/contact",
  requireTrustedBrowserRequest,
  createRateLimiter({
    max: 5,
    windowMs: 1000 * 60 * 15,
    message: "Bitte warte kurz, bevor du eine weitere Nachricht sendest."
  }),
  async (req, res) => {
    try {
      if (!isContactConfigured()) {
        return res.status(503).json({ ok: false, message: "Das Kontaktformular ist noch nicht vollständig eingerichtet." });
      }

      const body = req.body && typeof req.body === "object" ? req.body : {};
      const website = normalizeOptionalText(body.website, 200);
      if (website) {
        return res.json({ ok: true, message: "Danke, deine Nachricht wurde empfangen." });
      }

      const name = normalizeRequiredText(body.name, { minLength: 2, maxLength: 80 });
      if (!name) {
        return res.status(400).json({ ok: false, message: "Bitte gib deinen Namen an." });
      }

      const email = normalizeEmail(body.email);
      if (!email) {
        return res.status(400).json({ ok: false, message: "Bitte gib eine gültige E-Mail-Adresse an." });
      }

      const topic = normalizeOptionalText(body.topic, 120);
      const message = normalizeRequiredText(body.message, { minLength: 20, maxLength: 4000 });
      if (!message) {
        return res.status(400).json({ ok: false, message: "Bitte schreibe eine etwas genauere Nachricht." });
      }

      const hCaptchaToken = normalizeHCaptchaToken(body.hCaptchaToken);
      if (!hCaptchaToken) {
        return res.status(400).json({ ok: false, message: "Bitte bestätige zuerst das hCaptcha-Feld." });
      }

      const captchaResult = await verifyHCaptchaToken({
        token: hCaptchaToken,
        remoteIp: req.ip || req.socket?.remoteAddress || ""
      });
      if (!captchaResult.ok) {
        return res.status(400).json({ ok: false, message: "Die Bot-Prüfung konnte nicht bestätigt werden. Bitte versuche es erneut." });
      }

      await sendContactEmail({
        name,
        email,
        topic,
        message
      });

      return res.json({
        ok: true,
        message: "Danke, deine Nachricht wurde gesendet. Ich melde mich in der Regel innerhalb von 24 Stunden."
      });
    } catch (error) {
      return handleServerError(res, "contact.submit", error, "Die Nachricht konnte gerade nicht gesendet werden.");
    }
  }
);

app.post(
  "/api/paypal/create-order",
  requireTrustedBrowserRequest,
  createRateLimiter({
    max: 12,
    windowMs: 1000 * 60 * 10,
    message: "Bitte warte kurz, bevor du eine neue Zahlung startest."
  }),
  async (req, res) => {
    try {
      if (!isPayPalConfigured()) {
        return res.status(503).json({ ok: false, message: "PayPal ist noch nicht live eingerichtet." });
      }

      const body = req.body && typeof req.body === "object" ? req.body : {};
      const hasProductSelection = body.productId !== undefined && body.productId !== null && body.productId !== "";
      const normalizedProductId = normalizeProductId(body.productId);
      if (hasProductSelection && !normalizedProductId) {
        return res.status(400).json({ ok: false, message: "Die Produktauswahl ist ungültig." });
      }

      const product = normalizedProductId ? getProduct(normalizedProductId) : null;
      const tipCents = parseEuroToCents(body.tipAmount);

      if (Number.isNaN(tipCents)) {
        return res.status(400).json({ ok: false, message: "Bitte gib ein gültiges Trinkgeld ein." });
      }

      if (normalizedProductId && !product) {
        return res.status(404).json({ ok: false, message: "Produkt nicht gefunden." });
      }

      if (!product && tipCents <= 0) {
        return res.status(400).json({ ok: false, message: "Wähle ein PDF oder gib ein Trinkgeld ein." });
      }

      if (tipCents > 50000) {
        return res.status(400).json({ ok: false, message: "Das Trinkgeld ist für dieses Formular zu hoch." });
      }

      const totalCents = (product ? product.priceCents : 0) + tipCents;
      const referenceId = crypto.randomUUID();
      const baseUrl = getBaseUrl();
      const description = product
        ? `${product.title}${tipCents > 0 ? ` + Trinkgeld ${formatEuro(tipCents)}` : ""}`
        : `Trinkgeld für LeonicAURA (${formatEuro(tipCents)})`;

      store.createOrderDraft({
        referenceId,
        paypalOrderId: null,
        status: "CREATED",
        kind: product ? "product" : "tip",
        productId: product ? product.id : null,
        amountCents: totalCents,
        tipCents,
        currency: "EUR",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });

      const paypalOrder = await createPayPalOrder({
        amountCents: totalCents,
        currencyCode: "EUR",
        description,
        customId: referenceId,
        returnUrl: `${baseUrl}/?payment=success`,
        cancelUrl: `${baseUrl}/?payment=cancelled`
      });

      store.attachPayPalOrderId(referenceId, paypalOrder.id);

      const approvalLink = (paypalOrder.links || []).find(
        (link) => link.rel === "approve" || link.rel === "payer-action"
      );
      if (!approvalLink) {
        return res.status(502).json({ ok: false, message: "Kein PayPal-Freigabelink erhalten." });
      }

      if (!isTrustedPayPalApprovalUrl(approvalLink.href)) {
        return res.status(502).json({ ok: false, message: "PayPal hat einen unerwarteten Freigabelink gesendet." });
      }

      return res.json({
        ok: true,
        orderId: paypalOrder.id,
        approvalUrl: approvalLink.href
      });
    } catch (error) {
      return handleServerError(res, "paypal.create-order", error, "PayPal konnte gerade nicht vorbereitet werden.");
    }
  }
);

app.post(
  "/api/paypal/capture-order",
  requireTrustedBrowserRequest,
  createRateLimiter({
    max: 24,
    windowMs: 1000 * 60 * 10,
    message: "Bitte warte kurz, bevor du die Zahlung erneut bestätigst."
  }),
  async (req, res) => {
    try {
      if (!isPayPalConfigured()) {
        return res.status(503).json({ ok: false, message: "PayPal ist noch nicht live eingerichtet." });
      }

      const normalizedOrderId = normalizePayPalOrderId(req.body?.orderId);
      if (!normalizedOrderId) {
        return res.status(400).json({ ok: false, message: "Die Bestell-ID ist ungültig." });
      }

      const existingOrder = store.getOrderByPayPalOrderId(normalizedOrderId);
      if (!existingOrder) {
        return res.status(404).json({ ok: false, message: "Lokale Bestellung nicht gefunden." });
      }

      if (existingOrder.status === "COMPLETED") {
        return res.json(buildCheckoutResponse(existingOrder));
      }

      const captureResult = await capturePayPalOrder(normalizedOrderId);
      if (captureResult.status !== "COMPLETED") {
        const updatedOrder = store.updateOrder(existingOrder.referenceId, {
          status: captureResult.status || "PENDING"
        });
        return res.status(202).json({
          ok: false,
          message: "Die Zahlung ist noch nicht abgeschlossen.",
          status: updatedOrder?.status || "PENDING"
        });
      }

      const completedOrder = markOrderCompleted(existingOrder.referenceId, captureResult);
      return res.json(buildCheckoutResponse(completedOrder));
    } catch (error) {
      return handleServerError(res, "paypal.capture-order", error, "Die Zahlung konnte noch nicht bestätigt werden.");
    }
  }
);

app.post("/api/paypal/webhook", async (req, res) => {
  try {
    if (!req.is("application/json")) {
      return res.status(415).json({ ok: false, message: "Webhook erwartet JSON." });
    }

    if (!hasRequiredPayPalWebhookHeaders(req.headers)) {
      return res.status(400).json({ ok: false, message: "Webhook-Header fehlen." });
    }

    const verified = await verifyWebhookSignature({
      headers: req.headers,
      eventBody: req.body
    });

    if (!verified) {
      return res.status(400).json({ ok: false, message: "Webhook-Signatur ungültig." });
    }

    const orderId = resolveOrderIdFromWebhook(req.body);
    if (!orderId) {
      return res.status(200).json({ ok: true, message: "Webhook ohne bestellrelevante ID empfangen." });
    }

    const existingOrder = store.getOrderByPayPalOrderId(orderId);
    if (!existingOrder) {
      return res.status(200).json({ ok: true, message: "Webhook verifiziert, aber keine lokale Bestellung gefunden." });
    }

    const eventType = req.body.event_type;
    if (eventType === "PAYMENT.CAPTURE.COMPLETED" || eventType === "CHECKOUT.ORDER.COMPLETED") {
      markOrderCompleted(existingOrder.referenceId, req.body.resource || {});
    } else if (eventType === "CHECKOUT.ORDER.APPROVED") {
      store.updateOrder(existingOrder.referenceId, { status: "APPROVED" });
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    return handleServerError(res, "paypal.webhook", error, "Webhook konnte nicht verarbeitet werden.");
  }
});

app.get("/api/download/:token", (req, res) => {
  const downloadToken = normalizeDownloadToken(req.params.token);
  if (!downloadToken) {
    return res.status(400).json({ ok: false, message: "Download-Link ungültig." });
  }

  const tokenRecord = store.getToken(downloadToken);
  if (!tokenRecord) {
    return res.status(404).json({ ok: false, message: "Download-Link nicht gefunden." });
  }

  const now = Date.now();
  if (new Date(tokenRecord.expiresAt).getTime() < now) {
    return res.status(410).json({ ok: false, message: "Download-Link ist abgelaufen. Bitte lade dein PDF immer direkt nach dem Kauf herunter und speichere es lokal, da eine spätere Bereitstellung über denselben Link nicht garantiert werden kann." });
  }

  if ((tokenRecord.downloadCount || 0) >= (tokenRecord.maxDownloads || 5)) {
    return res.status(410).json({ ok: false, message: "Download-Limit erreicht." });
  }

  const order = store.getOrderByReference(tokenRecord.referenceId);
  if (!order || order.status !== "COMPLETED") {
    return res.status(403).json({ ok: false, message: "Zahlung noch nicht bestätigt." });
  }

  const product = order.productId ? getProduct(order.productId) : null;
  if (!product) {
    return res.status(404).json({ ok: false, message: "Zu diesem Token gehört kein Produkt." });
  }

  if (!fs.existsSync(product.filePath)) {
    return res.status(404).json({ ok: false, message: "PDF-Datei wurde noch nicht hinterlegt." });
  }

  store.incrementDownloadCount(downloadToken);
  res.setHeader("Cache-Control", "private, no-store");
  return res.download(product.filePath, product.fileName);
});

app.get("/a1", (_req, res) => {
  res.redirect(301, "/a1/");
});

htmlPageRoutes.forEach(({ route, filePath, injectRequestToken, injectContactConfig, allowHcaptcha }) => {
  app.get(route, (req, res) => {
    renderHtmlPage(req, res, filePath, { injectRequestToken, injectContactConfig, allowHcaptcha });
  });
});

app.use(express.static(rootDir, {
  dotfiles: "ignore",
  index: false,
  setHeaders(res, filePath) {
    if (filePath.endsWith(".html")) {
      res.setHeader("Cache-Control", "no-store");
    }
  }
}));

app.use((error, _req, res, _next) => {
  if (error instanceof SyntaxError && error.status === 400 && "body" in error) {
    return res.status(400).json({ ok: false, message: "Ungültige JSON-Anfrage." });
  }

  return handleServerError(res, "express.unhandled", error, "Interner Serverfehler.");
});

app.listen(port, () => {
  console.log(`LeonicAURA server listening on http://localhost:${port}`);
});

function parseEuroToCents(value) {
  if (value === undefined || value === null || value === "") {
    return 0;
  }

  const normalized = String(value).trim().replace(/\s+/g, "").replace(",", ".");
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) {
    return Number.NaN;
  }

  const amount = Number(normalized);
  if (!Number.isFinite(amount) || amount < 0) {
    return Number.NaN;
  }

  return Math.round(amount * 100);
}

function markOrderCompleted(referenceId, capturePayload) {
  const existingOrder = store.getOrderByReference(referenceId);
  const completedOrder = store.updateOrder(referenceId, {
    status: "COMPLETED",
    capturedAt: new Date().toISOString(),
    captureSummary: summarizeCapturePayload(capturePayload)
  });

  if (completedOrder && completedOrder.kind === "product") {
    ensureDownloadToken(completedOrder);
  }

  return completedOrder || existingOrder;
}

function ensureDownloadToken(order) {
  const existingToken = store.findTokenByReference(order.referenceId);
  if (existingToken) {
    return existingToken;
  }

  const product = order.productId ? getProduct(order.productId) : null;
  if (!product) {
    return null;
  }

  const tokenSecret = process.env.DOWNLOAD_TOKEN_SECRET || crypto.randomUUID();
  const token = crypto
    .createHmac("sha256", tokenSecret)
    .update(`${order.referenceId}:${order.paypalOrderId}:${Date.now()}`)
    .digest("hex");

  return store.saveDownloadToken(order.referenceId, {
    token,
    paypalOrderId: order.paypalOrderId,
    productId: order.productId,
    expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString(),
    downloadCount: 0,
    maxDownloads: 5
  });
}

function buildCheckoutResponse(order) {
  if (!order) {
    return { ok: false, message: "Bestellung konnte nicht aufgebaut werden." };
  }

  if (order.kind === "tip") {
    return {
      ok: true,
      status: order.status,
      kind: order.kind,
      message: "Danke für dein Trinkgeld. Die Zahlung wurde bestätigt."
    };
  }

  const tokenRecord = ensureDownloadToken(order);
  return {
    ok: true,
    status: order.status,
    kind: order.kind,
    message: "Zahlung bestätigt. Bitte lade dein PDF jetzt direkt herunter und speichere es lokal. Der Download-Link ist zeitlich begrenzt; eine spätere Bereitstellung über denselben Link kann nicht garantiert werden.",
    downloadUrl: tokenRecord ? `/api/download/${tokenRecord.token}` : null,
    productId: order.productId
  };
}

function resolveOrderIdFromWebhook(eventBody) {
  if (!eventBody || !eventBody.resource) {
    return null;
  }

  if (eventBody.event_type === "PAYMENT.CAPTURE.COMPLETED") {
    return normalizePayPalOrderId(eventBody.resource.supplementary_data?.related_ids?.order_id);
  }

  return normalizePayPalOrderId(eventBody.resource.id);
}

function renderHtmlPage(req, res, filePath, options = {}) {
  try {
    const nonce = crypto.randomBytes(16).toString("base64");
    let html = fs.readFileSync(filePath, "utf8");
    html = applyNonceToHtml(html, nonce);

    if (options.injectRequestToken) {
      html = injectRequestTokenMeta(html, createRequestToken());
    }

    if (options.injectContactConfig) {
      html = injectContactConfigMeta(html, getPublicContactConfig());
    }

    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Security-Policy", buildContentSecurityPolicy(nonce, req, options));
    res.type("html");
    res.send(html);
  } catch (error) {
    handleServerError(res, `html.render:${path.basename(filePath)}`, error, "Seite konnte nicht geladen werden.");
  }
}

function buildContentSecurityPolicy(nonce, req, options = {}) {
  const connectSources = ["'self'"];
  const frameSources = ["'none'"];
  const scriptSources = ["'self'", `'nonce-${nonce}'`];

  if (options.allowHcaptcha) {
    connectSources.push("https://hcaptcha.com", "https://*.hcaptcha.com");
    frameSources.splice(0, frameSources.length, "https://hcaptcha.com", "https://*.hcaptcha.com");
    scriptSources.push("https://js.hcaptcha.com", "https://hcaptcha.com", "https://*.hcaptcha.com");
  }

  const directives = [
    "default-src 'self'",
    "base-uri 'self'",
    `connect-src ${connectSources.join(" ")}`,
    "font-src 'self' https://fonts.gstatic.com data:",
    "form-action 'self'",
    "frame-ancestors 'none'",
    `frame-src ${frameSources.join(" ")}`,
    "img-src 'self' data: https:",
    "manifest-src 'self'",
    "object-src 'none'",
    `script-src ${scriptSources.join(" ")}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com"
  ];

  const host = req.get("host") || "";
  if (isSecureRequest(req) && !isLocalHost(host)) {
    directives.push("upgrade-insecure-requests");
  }

  return directives.join("; ");
}

function applyNonceToHtml(html, nonce) {
  return html
    .replace(/<script\b(?![^>]*\bnonce=)/gi, `<script nonce="${nonce}"`)
    .replace(/<style\b(?![^>]*\bnonce=)/gi, `<style nonce="${nonce}"`);
}

function injectRequestTokenMeta(html, requestToken) {
  return html.replace(
    /<\/head>/i,
    `  <meta name="request-token" content="${requestToken}">\n</head>`
  );
}

function injectContactConfigMeta(html, contactConfig) {
  return html.replace(
    /<\/head>/i,
    `  <meta name="hcaptcha-site-key" content="${escapeHtmlAttribute(contactConfig.hCaptchaSiteKey || "")}">\n</head>`
  );
}

function createRequestToken() {
  const issuedAt = Date.now().toString(36);
  const nonce = crypto.randomBytes(12).toString("hex");
  const payload = `${issuedAt}.${nonce}`;
  const signature = crypto
    .createHmac("sha256", requestTokenSecret)
    .update(payload)
    .digest("hex");

  return Buffer.from(`${payload}.${signature}`, "utf8").toString("base64url");
}

function verifyRequestToken(requestToken) {
  if (!requestToken || requestToken.length > 256) {
    return false;
  }

  let decoded;
  try {
    decoded = Buffer.from(requestToken, "base64url").toString("utf8");
  } catch (_error) {
    return false;
  }

  const parts = decoded.split(".");
  if (parts.length !== 3) {
    return false;
  }

  const [issuedAtBase36, nonce, signature] = parts;
  if (!/^[a-z0-9]+$/i.test(issuedAtBase36) || !/^[a-f0-9]{24}$/i.test(nonce) || !/^[a-f0-9]{64}$/i.test(signature)) {
    return false;
  }

  const issuedAt = Number.parseInt(issuedAtBase36, 36);
  if (!Number.isFinite(issuedAt)) {
    return false;
  }

  const age = Date.now() - issuedAt;
  if (age < 0 || age > requestTokenTtlMs) {
    return false;
  }

  const expectedSignature = crypto
    .createHmac("sha256", requestTokenSecret)
    .update(`${issuedAtBase36}.${nonce}`)
    .digest("hex");

  return timingSafeEqual(expectedSignature, signature);
}

function createRateLimiter({ max, windowMs, message }) {
  const requestState = new Map();

  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip || req.socket?.remoteAddress || "unknown";

    if (requestState.size > 500) {
      for (const [candidateKey, candidate] of requestState.entries()) {
        if (candidate.expiresAt <= now) {
          requestState.delete(candidateKey);
        }
      }
    }

    const existing = requestState.get(key);
    if (!existing || existing.expiresAt <= now) {
      requestState.set(key, { count: 1, expiresAt: now + windowMs });
      return next();
    }

    if (existing.count >= max) {
      return res.status(429).json({ ok: false, message });
    }

    existing.count += 1;
    return next();
  };
}

function requireTrustedBrowserRequest(req, res, next) {
  if (!req.is("application/json")) {
    return res.status(415).json({ ok: false, message: "Ungültiger Anfrage-Typ." });
  }

  if (req.get("x-requested-with") !== "fetch") {
    return res.status(403).json({ ok: false, message: "Sicherheitsprüfung fehlgeschlagen. Lade die Seite bitte neu." });
  }

  if (!verifyRequestToken(req.get("x-request-token"))) {
    return res.status(403).json({ ok: false, message: "Sicherheitsprüfung fehlgeschlagen. Lade die Seite bitte neu." });
  }

  const allowedOrigin = getRequestOrigin(req);
  const origin = req.get("origin");
  const referer = req.get("referer");
  if (allowedOrigin) {
    if (origin && origin !== allowedOrigin) {
      return res.status(403).json({ ok: false, message: "Sicherheitsprüfung fehlgeschlagen. Lade die Seite bitte neu." });
    }

    if (!origin && referer && !referer.startsWith(`${allowedOrigin}/`)) {
      return res.status(403).json({ ok: false, message: "Sicherheitsprüfung fehlgeschlagen. Lade die Seite bitte neu." });
    }
  }

  return next();
}

function getRequestOrigin(req) {
  const host = req.get("host");
  if (!host) {
    return "";
  }

  return `${req.protocol}://${host}`;
}

function getBaseUrl() {
  const fallback = `http://localhost:${port}`;
  const configured = String(process.env.BASE_URL || fallback).trim();

  try {
    const url = new URL(configured);
    if (!/^https?:$/.test(url.protocol)) {
      throw new Error("Unsupported BASE_URL protocol");
    }

    return `${url.origin}${url.pathname}`.replace(/\/$/, "");
  } catch (_error) {
    return fallback;
  }
}

function isSecureRequest(req) {
  return req.secure || req.get("x-forwarded-proto") === "https";
}

function isLocalHost(host) {
  return /^localhost(?::\d+)?$/i.test(host) || /^127\.0\.0\.1(?::\d+)?$/.test(host);
}

function normalizeProductId(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  if (!/^[a-z0-9-]{2,64}$/.test(normalized)) {
    return null;
  }

  return normalized;
}

function normalizePayPalOrderId(value) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z0-9]{10,32}$/.test(normalized)) {
    return null;
  }

  return normalized;
}

function normalizeDownloadToken(value) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    return null;
  }

  return normalized;
}

function normalizeRequiredText(value, { minLength, maxLength }) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length < minLength || normalized.length > maxLength) {
    return null;
  }

  return normalized;
}

function normalizeOptionalText(value, maxLength) {
  if (value === undefined || value === null || value === "") {
    return "";
  }

  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }

  return normalized.length <= maxLength ? normalized : null;
}

function normalizeEmail(value) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized.length > 254) {
    return null;
  }

  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ? normalized : null;
}

function normalizeHCaptchaToken(value) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  if (!normalized || normalized.length > 4096) {
    return null;
  }

  return normalized;
}

function isPayPalConfigured() {
  return hasConfiguredEnv("PAYPAL_CLIENT_ID") && hasConfiguredEnv("PAYPAL_CLIENT_SECRET");
}

function hasConfiguredEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) {
    return false;
  }

  return !/^(PASTE_|YOUR_|CHANGE_THIS|CHANGE_ME)/i.test(value);
}

function isTrustedPayPalApprovalUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && ["www.paypal.com", "www.sandbox.paypal.com"].includes(url.hostname);
  } catch (_error) {
    return false;
  }
}

function summarizeCapturePayload(capturePayload) {
  const capture = capturePayload?.purchase_units?.[0]?.payments?.captures?.[0] || null;

  return {
    orderId: normalizePayPalOrderId(capturePayload?.id) || null,
    captureId: typeof capture?.id === "string" ? capture.id : null,
    status: capturePayload?.status || capture?.status || null,
    amount: capture?.amount || capturePayload?.purchase_units?.[0]?.amount || null,
    updateTime: capturePayload?.update_time || capture?.update_time || null
  };
}

function hasRequiredPayPalWebhookHeaders(headers) {
  const requiredHeaders = [
    "paypal-auth-algo",
    "paypal-cert-url",
    "paypal-transmission-id",
    "paypal-transmission-sig",
    "paypal-transmission-time"
  ];

  return requiredHeaders.every((headerName) => typeof headers[headerName] === "string" && headers[headerName].trim());
}

function handleServerError(res, context, error, publicMessage) {
  console.error(`[${new Date().toISOString()}] ${context}`, error);
  return res.status(500).json({ ok: false, message: publicMessage });
}

function timingSafeEqual(left, right) {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function escapeHtmlAttribute(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}