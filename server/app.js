require("dotenv").config();

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");
const helmet = require("helmet");

const { capturePayPalOrder, createPayPalOrder, verifyWebhookSignature } = require("./paypal");
const { formatEuro, getProduct, listProducts } = require("./products");
const store = require("./store");

const app = express();
const port = Number(process.env.PORT || 3000);
const rootDir = path.resolve(__dirname, "..");

app.disable("x-powered-by");
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
  })
);
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, mode: process.env.PAYPAL_MODE || "sandbox" });
});

app.get("/api/products", (_req, res) => {
  res.json({
    ok: true,
    products: listProducts()
  });
});

app.post("/api/paypal/create-order", async (req, res) => {
  try {
    const { productId, tipAmount } = req.body || {};
    const product = productId ? getProduct(productId) : null;
    const tipCents = parseEuroToCents(tipAmount);

    if (Number.isNaN(tipCents)) {
      return res.status(400).json({ ok: false, message: "Bitte gib ein gültiges Trinkgeld ein." });
    }

    if (productId && !product) {
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
    const baseUrl = (process.env.BASE_URL || `http://localhost:${port}`).replace(/\/$/, "");
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

    return res.json({
      ok: true,
      orderId: paypalOrder.id,
      approvalUrl: approvalLink.href
    });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message });
  }
});

app.post("/api/paypal/capture-order", async (req, res) => {
  try {
    const { orderId } = req.body || {};
    if (!orderId) {
      return res.status(400).json({ ok: false, message: "orderId fehlt." });
    }

    const existingOrder = store.getOrderByPayPalOrderId(orderId);
    if (!existingOrder) {
      return res.status(404).json({ ok: false, message: "Lokale Bestellung nicht gefunden." });
    }

    if (existingOrder.status === "COMPLETED") {
      return res.json(buildCheckoutResponse(existingOrder));
    }

    const captureResult = await capturePayPalOrder(orderId);
    if (captureResult.status !== "COMPLETED") {
      const updatedOrder = store.updateOrder(existingOrder.referenceId, {
        status: captureResult.status || "PENDING"
      });
      return res.status(202).json({
        ok: false,
        message: "Die Zahlung ist noch nicht abgeschlossen.",
        status: updatedOrder.status
      });
    }

    const completedOrder = markOrderCompleted(existingOrder.referenceId, captureResult);
    return res.json(buildCheckoutResponse(completedOrder));
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message });
  }
});

app.post("/api/paypal/webhook", async (req, res) => {
  try {
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
    return res.status(500).json({ ok: false, message: error.message });
  }
});

app.get("/api/download/:token", (req, res) => {
  const tokenRecord = store.getToken(req.params.token);
  if (!tokenRecord) {
    return res.status(404).json({ ok: false, message: "Download-Token nicht gefunden." });
  }

  const now = Date.now();
  if (new Date(tokenRecord.expiresAt).getTime() < now) {
    return res.status(410).json({ ok: false, message: "Download-Link ist abgelaufen." });
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

  store.incrementDownloadCount(req.params.token);
  res.setHeader("Cache-Control", "private, no-store");
  return res.download(product.filePath, product.fileName);
});

app.get("/", (_req, res) => {
  res.sendFile(path.join(rootDir, "index.html"));
});

app.use(express.static(rootDir, { dotfiles: "ignore", index: false }));

app.listen(port, () => {
  console.log(`LeonicAURA server listening on http://localhost:${port}`);
});

function parseEuroToCents(value) {
  if (value === undefined || value === null || value === "") {
    return 0;
  }

  const normalized = String(value).trim().replace(/\s+/g, "").replace(",", ".");
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
    capturePayload
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
    message: "Zahlung bestätigt. Dein PDF ist jetzt freigeschaltet.",
    downloadUrl: tokenRecord ? `/api/download/${tokenRecord.token}` : null,
    productId: order.productId
  };
}

function resolveOrderIdFromWebhook(eventBody) {
  if (!eventBody || !eventBody.resource) {
    return null;
  }

  if (eventBody.event_type === "PAYMENT.CAPTURE.COMPLETED") {
    return eventBody.resource.supplementary_data?.related_ids?.order_id || null;
  }

  return eventBody.resource.id || null;
}