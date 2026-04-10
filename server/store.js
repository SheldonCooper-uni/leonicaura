const fs = require("fs");
const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT_DIR, ".payment-data");
const STATE_FILE = path.join(DATA_DIR, "state.json");

let cachedState = null;

function createInitialState() {
  return {
    ordersByReference: {},
    paypalToReference: {},
    downloadTokens: {}
  };
}

function ensureStateFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  if (!fs.existsSync(STATE_FILE)) {
    fs.writeFileSync(STATE_FILE, JSON.stringify(createInitialState(), null, 2), "utf8");
  }
}

function loadState() {
  if (cachedState) {
    return cachedState;
  }

  ensureStateFile();
  cachedState = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  return cachedState;
}

function saveState(state) {
  ensureStateFile();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
  cachedState = state;
}

function createOrderDraft(order) {
  const state = loadState();
  state.ordersByReference[order.referenceId] = order;
  saveState(state);
  return order;
}

function attachPayPalOrderId(referenceId, paypalOrderId) {
  const state = loadState();
  const order = state.ordersByReference[referenceId];
  if (!order) {
    return null;
  }

  order.paypalOrderId = paypalOrderId;
  state.paypalToReference[paypalOrderId] = referenceId;
  saveState(state);
  return order;
}

function getOrderByReference(referenceId) {
  const state = loadState();
  return state.ordersByReference[referenceId] || null;
}

function getOrderByPayPalOrderId(paypalOrderId) {
  const state = loadState();
  const referenceId = state.paypalToReference[paypalOrderId];
  if (!referenceId) {
    return null;
  }

  return state.ordersByReference[referenceId] || null;
}

function updateOrder(referenceId, updates) {
  const state = loadState();
  const order = state.ordersByReference[referenceId];
  if (!order) {
    return null;
  }

  state.ordersByReference[referenceId] = {
    ...order,
    ...updates,
    updatedAt: new Date().toISOString()
  };

  saveState(state);
  return state.ordersByReference[referenceId];
}

function saveDownloadToken(referenceId, tokenRecord) {
  const state = loadState();
  state.downloadTokens[tokenRecord.token] = {
    ...tokenRecord,
    referenceId
  };
  saveState(state);
  return state.downloadTokens[tokenRecord.token];
}

function getToken(token) {
  const state = loadState();
  return state.downloadTokens[token] || null;
}

function findTokenByReference(referenceId) {
  const state = loadState();
  return Object.values(state.downloadTokens).find((tokenRecord) => tokenRecord.referenceId === referenceId) || null;
}

function incrementDownloadCount(token) {
  const state = loadState();
  const tokenRecord = state.downloadTokens[token];
  if (!tokenRecord) {
    return null;
  }

  tokenRecord.downloadCount = (tokenRecord.downloadCount || 0) + 1;
  tokenRecord.lastDownloadedAt = new Date().toISOString();
  saveState(state);
  return tokenRecord;
}

module.exports = {
  attachPayPalOrderId,
  createOrderDraft,
  findTokenByReference,
  getOrderByPayPalOrderId,
  getOrderByReference,
  getToken,
  incrementDownloadCount,
  saveDownloadToken,
  updateOrder
};