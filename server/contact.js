const nodemailer = require("nodemailer");

let cachedTransporter = null;
let cachedTransporterCacheKey = "";

function getPublicContactConfig() {
  return {
    hCaptchaSiteKey: readEnv("HCAPTCHA_SITE_KEY")
  };
}

function isContactConfigured() {
  return Boolean(
    readEnv("HCAPTCHA_SITE_KEY")
    && readEnv("HCAPTCHA_SECRET_KEY")
    && readEnv("SMTP_HOST")
    && readEnv("SMTP_PORT")
    && readEnv("SMTP_USER")
    && readEnv("SMTP_PASS")
  );
}

async function verifyHCaptchaToken({ token, remoteIp }) {
  const secret = readEnv("HCAPTCHA_SECRET_KEY");
  if (!secret) {
    throw new Error("HCAPTCHA_SECRET_KEY is not configured.");
  }

  const payload = new URLSearchParams({
    secret,
    response: token
  });

  if (remoteIp) {
    payload.set("remoteip", remoteIp);
  }

  const response = await fetch("https://api.hcaptcha.com/siteverify", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: payload.toString()
  });

  if (!response.ok) {
    throw new Error(`hCaptcha verification failed with status ${response.status}.`);
  }

  const data = await response.json();
  return {
    ok: Boolean(data.success),
    hostname: typeof data.hostname === "string" ? data.hostname : "",
    errorCodes: Array.isArray(data["error-codes"]) ? data["error-codes"] : []
  };
}

async function sendContactEmail({ name, email, topic, message }) {
  const transporter = getTransporter();
  const targetAddress = getContactTargetAddress();
  const fromAddress = getContactFromAddress();
  const normalizedTopic = topic || "Allgemeine Anfrage";

  const text = [
    `Name: ${name}`,
    `E-Mail: ${email}`,
    `Thema: ${normalizedTopic}`,
    "",
    "Nachricht:",
    message
  ].join("\n");

  await transporter.sendMail({
    from: formatMailbox(fromAddress, "LeonicAURA Kontaktformular"),
    to: targetAddress,
    replyTo: email,
    subject: `Neue Kontaktanfrage: ${normalizedTopic}`,
    text
  });
}

function getTransporter() {
  const transportOptions = {
    host: readEnv("SMTP_HOST"),
    port: Number.parseInt(readEnv("SMTP_PORT"), 10),
    secure: resolveSmtpSecure(),
    auth: {
      user: readEnv("SMTP_USER"),
      pass: readEnv("SMTP_PASS")
    }
  };

  const cacheKey = JSON.stringify(transportOptions);
  if (!cachedTransporter || cachedTransporterCacheKey !== cacheKey) {
    cachedTransporter = nodemailer.createTransport(transportOptions);
    cachedTransporterCacheKey = cacheKey;
  }

  return cachedTransporter;
}

function getContactTargetAddress() {
  return readEnv("CONTACT_TO_EMAIL") || readEnv("SMTP_USER");
}

function getContactFromAddress() {
  return readEnv("CONTACT_FROM_EMAIL") || readEnv("SMTP_USER") || getContactTargetAddress();
}

function resolveSmtpSecure() {
  const explicit = readEnv("SMTP_SECURE").toLowerCase();
  if (explicit === "true") {
    return true;
  }

  if (explicit === "false") {
    return false;
  }

  return Number.parseInt(readEnv("SMTP_PORT"), 10) === 465;
}

function formatMailbox(address, name) {
  if (!address) {
    return "";
  }

  return name ? `${name} <${address}>` : address;
}

function readEnv(name) {
  return String(process.env[name] || "").trim();
}

module.exports = {
  getPublicContactConfig,
  isContactConfigured,
  sendContactEmail,
  verifyHCaptchaToken
};