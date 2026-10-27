const fs = require("node:fs");
const path = require("node:path");

let cached = {
  app: null,
  firestore: null,
};

const FALLBACK_FILE = path.join(__dirname, "../data/settings.json");
const LOCAL_SETTINGS_FILE = path.join(__dirname, "../data/settings.local.json");

function ensureDirectoryExistence(filePath) {
  const dirname = path.dirname(filePath);
  if (fs.existsSync(dirname)) {
    return true;
  }
  ensureDirectoryExistence(dirname);
  fs.mkdirSync(dirname);
}

function getServiceAccountJson() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function getFirestore() {
  if (cached.firestore) {
    return cached.firestore;
  }

  // eslint-disable-next-line global-require
  const admin = require("firebase-admin");

  if (!cached.app) {
    const serviceAccount = getServiceAccountJson();
    if (serviceAccount) {
      cached.app = admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
    } else {
      cached.app = admin.initializeApp();
    }
  }

  cached.firestore = admin.firestore();
  return cached.firestore;
}

function getLocalSettingsFallback() {
  let settings = {};
  for (const file of [FALLBACK_FILE, LOCAL_SETTINGS_FILE]) {
    try {
      if (fs.existsSync(file)) settings = { ...settings, ...JSON.parse(fs.readFileSync(file, "utf8")) };
    } catch { console.error("A local settings file could not be read."); }
  }
  return settings;
}

function saveLocalSettingsFallback(payload) {
  // Vercel's filesystem is not durable. Never report a failed database write
  // as saved merely because an in-memory or ephemeral fallback was attempted.
  if (process.env.VERCEL) return false;
  try {
    ensureDirectoryExistence(LOCAL_SETTINGS_FILE);
    const current = fs.existsSync(LOCAL_SETTINGS_FILE) ? JSON.parse(fs.readFileSync(LOCAL_SETTINGS_FILE, "utf8")) : {};
    fs.writeFileSync(LOCAL_SETTINGS_FILE, JSON.stringify({ ...current, ...payload }, null, 2), { encoding: "utf8", mode: 0o600 });
    return true;
  } catch { return false; }
}

async function getAdminSettings() {
  // Do not wait for Google metadata-server retries in an unconfigured local server.
  if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON && !process.env.GOOGLE_APPLICATION_CREDENTIALS && !process.env.FIRESTORE_EMULATOR_HOST && !process.env.GOOGLE_CLOUD_PROJECT) return getLocalSettingsFallback();
  try {
    const firestore = getFirestore();
    const snapshot = await firestore.collection("admin").doc("settings").get();
    if (!snapshot.exists) {
      return getLocalSettingsFallback();
    }
    return snapshot.data() || getLocalSettingsFallback();
  } catch (err) {
    return getLocalSettingsFallback();
  }
}

async function setAdminSettings(payload) {
  try {
    const firestore = getFirestore();
    await firestore.collection("admin").doc("settings").set(payload, { merge: true });
    saveLocalSettingsFallback(payload);
  } catch (err) {
    if (!saveLocalSettingsFallback(payload)) throw new Error("Settings could not be saved to the server. Check the database configuration.");
  }
}

module.exports = {
  getFirestore,
  getAdminSettings,
  setAdminSettings,
};
