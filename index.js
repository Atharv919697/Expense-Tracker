// --- 1) WebCrypto polyfill (for Node/Render) ---
import * as nodeCrypto from "crypto";
if (!globalThis.crypto) globalThis.crypto = nodeCrypto.webcrypto;

// --- 2) Imports ---
import * as baileys from "@whiskeysockets/baileys";
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = baileys;
import qrcode from "qrcode-terminal";
import express from "express";
import axios from "axios";
import fs from "fs";

// --- 3) Config ---
const GROUP_JID = "120363419674431478@g.us"; // your group
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || "";

// Writable creds: /data if Disk exists (Starter), else /tmp (Free)
const AUTH_BASE = process.env.AUTH_DIR || (fs.existsSync("/data") ? "/data" : "/tmp");
const AUTH_DIR = `${AUTH_BASE}/auth_info`;
console.log("[BOOT] Group:", GROUP_JID);
console.log("[BOOT] Auth directory:", AUTH_DIR);
console.log("[BOOT] N8N_WEBHOOK_URL:", N8N_WEBHOOK_URL ? "(set)" : "(NOT set)");

// --- 4) Natural-language expense parser (no fixed format) ---
const STOPWORDS = new Set([
  "i","we","for","on","of","and","the","to","a","an","my","our","your","with","at",
  "rs","rs.","inr","₹","rupees","paid","pay","spent","buy","bought","purchase","purchased",
  "gave","give","expense","bill","fees","fare","cost","price","amt","amount","is","=","-","–","—"
]);

function cleanToken(t) {
  return t.replace(/[^\p{L}\p{N}]/gu, "").trim();
}

// Returns { item, price } or null
function parseNaturalExpense(rawText) {
  if (!rawText) return null;

  const text = rawText
    .toLowerCase()
    .replace(/[₹]/g, " rs ")
    .replace(/rs\./g, " rs ")
    .replace(/\s+/g, " ")
    .trim();

  // Find all monetary-looking numbers; prefer the LAST one (typical natural phrasing)
  const amountRe = /\b(?:rs|inr)?\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]+)?|[0-9]+(?:\.[0-9]+)?)\b/gi;
  let m, matches = [];
  while ((m = amountRe.exec(text)) !== null) {
    matches.push({ value: m[1], index: m.index });
  }
  if (matches.length === 0) return null;

  // Choose the last match
  const last = matches[matches.length - 1];
  const numeric = last.value.replace(/,/g, "");
  const price = parseFloat(numeric);
  if (!Number.isFinite(price) || price <= 0) return null;

  // Tokenize and try to get words around the amount
  const tokens = text.split(" ").map(cleanToken).filter(Boolean);
  // Try to find the token that includes the raw numeric (without commas)
  const amountIdx = tokens.findIndex(t => t.includes(numeric));
  const around = tokens.slice(Math.max(0, amountIdx - 4), Math.min(tokens.length, amountIdx + 5));
  let itemTokens = around.filter(t => !STOPWORDS.has(t) && !/^\d/.test(t));

  // Fallbacks if we ended up with nothing meaningful
  let item = itemTokens.join(" ").trim();
  if (!item) {
    const preps = /(for|on|of)\s+([^0-9]+)$/i;
    const mm = rawText.match(preps);
    if (mm) item = mm[2].replace(/[^\p{L}\p{N}\s]/gu, "").trim().toLowerCase();
  }
  if (!item) {
    // take first 3 non-stopword tokens from the whole text
    const first = tokens.filter(t => !STOPWORDS.has(t) && !/^\d/.test(t)).slice(0, 3);
    item = first.join(" ").trim();
  }
  if (!item) item = "misc";

  return { item, price };
}

// --- 5) Mention → display name (optional) ---
async function resolveMentionName(sock, jid) {
  try {
    const c = await sock?.onWhatsApp?.(jid);
    return c?.[0]?.notify || c?.[0]?.name || c?.[0]?.jid || "";
  } catch {
    return "";
  }
}

// --- 6) Robust text extractor (many message types) ---
function extractTextFromMessage(msg) {
  const m = msg.message || {};
  const em = m.ephemeralMessage?.message || {};
  const qm = m.extendedTextMessage?.contextInfo?.quotedMessage || {};
  const qem = m.ephemeralMessage?.message?.extendedTextMessage?.contextInfo?.quotedMessage || {};

  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    em.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    em.imageMessage?.caption ||
    em.videoMessage?.caption ||
    em.documentMessage?.caption ||
    m.buttonsResponseMessage?.selectedButtonId ||
    m.listResponseMessage?.singleSelectReply?.selectedRowId ||
    m.listResponseMessage?.title ||
    // quoted text fallbacks
    qm?.conversation ||
    qem?.conversation ||
    ""
  );
}

// --- 7) Bot bootstrap ---
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: ["RenderBot", "Chrome", "1.0"],
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      console.log("Scan QR in WhatsApp → Linked Devices:");
      qrcode.generate(qr, { small: true });
    }
    if (connection === "open") console.log("✅ WhatsApp connected!");
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      const reason = lastDisconnect?.error?.message || code;
      console.log("Connection closed:", reason);
      if (code !== DisconnectReason.loggedOut) startBot();
      else console.log(`Logged out — delete ${AUTH_DIR} and redeploy to rescan QR.`);
    }
  });

  // --- 8) Message handler with anti-loop ---
  sock.ev.on("messages.upsert", async (up) => {
    try {
      const msg = up.messages?.[0];
      if (!msg || !msg.message) return;

      const jid = String(msg.key.remoteJid || "");
      const fromMe = !!msg.key.fromMe;

      // Filters
      if (jid === "status@broadcast") return;  // ignore status
      if (fromMe) return;                       // ignore our own messages (anti-loop)
      if (jid !== GROUP_JID) return;            // only your group

      const text = extractTextFromMessage(msg);
      if (!text || !text.trim()) return;

      // ignore our confirmation if forwarded
      if (/^\s*✅\s*added:/i.test(text)) return;

      // payer name = sender; if @mention exists, use mentioned person
      let payerName = msg.pushName || "";
      const mentioned =
        msg.message?.extendedTextMessage?.contextInfo?.mentionedJid ||
        msg.message?.ephemeralMessage?.message?.extendedTextMessage?.contextInfo?.mentionedJid;
      if (Array.isArray(mentioned) && mentioned.length > 0) {
        const mentionName = await resolveMentionName(sock, mentioned[0]);
        if (mentionName) payerName = mentionName;
      }

      const parsed = parseNaturalExpense(text);
      if (!parsed) return;

      const payload = {
        name: payerName,
        item: parsed.item,
        price: parsed.price,
        jid,
        raw: text,
        ts: Number(msg.messageTimestamp) * 1000
      };

      // POST to n8n
      let postedOK = false;
      if (N8N_WEBHOOK_URL) {
        try {
          await axios.post(N8N_WEBHOOK_URL, payload, { timeout: 8000 });
          postedOK = true;
        } catch (e) {
          console.log("n8n webhook error:", e?.response?.status, e?.message);
        }
      } else {
        console.log("N8N_WEBHOOK_URL not set; skipping POST.");
      }

      // confirmation in group
      await sock.sendMessage(jid, {
        text: `✅ added:  · ${payload.name} ${payload.item} · ₹${payload.price}`
      });
    } catch (err) {
      console.log("handler error:", err?.message || err);
    }
  });
}

// --- 9) Minimal HTTP server (health checks / pings) ---
const app = express();
app.get("/", (_req, res) => res.send("Baileys bot running."));
app.get("/healthz", (_req, res) => res.send("ok"));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("HTTP server on", PORT);
  startBot();
});
