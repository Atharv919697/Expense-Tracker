// --- 1) WebCrypto polyfill (Render/Node compat) ---
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
const GROUP_JID = "120363419674431478@g.us";   // your WhatsApp group ID
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || "";

// Writable cred location: /data if disk exists, else /tmp (non-persistent)
const AUTH_BASE =
  process.env.AUTH_DIR || (fs.existsSync("/data") ? "/data" : "/tmp");
console.log("Auth directory:", `${AUTH_BASE}/auth_info`);

// --- 4) Natural-language expense parser (no fixed format) ---
const STOPWORDS = new Set([
  "i","we","for","on","of","and","the","to","a","an","my","our","your","with","at",
  "rs","rs.","inr","₹","rupees","paid","pay","spent","buy","bought","purchase","purchased",
  "gave","give","expense","bill","fees","fare","cost","price","amt","amount","is","=","-","–","—"
]);

function cleanToken(t) {
  return t.replace(/[^\p{L}\p{N}]/gu, "").trim();
}

function parseNaturalExpense(rawText) {
  if (!rawText) return null;

  const text = rawText.toLowerCase()
    .replace(/[₹]/g, " rs ")
    .replace(/rs\./g, " rs ")
    .replace(/\s+/g, " ")
    .trim();

  // take the LAST amount in the message
  const amountRe = /\b(?:rs|inr)?\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]+)?|[0-9]+(?:\.[0-9]+)?)\b/gi;
  let m, last = null;
  while ((m = amountRe.exec(text)) !== null) last = { value: m[1] };
  if (!last) return null;

  const price = parseFloat(last.value.replace(/,/g, ""));
  if (!isFinite(price) || price <= 0) return null;

  const tokens = text.split(" ").map(cleanToken).filter(Boolean);
  const idx = tokens.findIndex(t => t.includes(last.value.replace(/,/g, "")));
  const around = tokens.slice(Math.max(0, idx - 4), Math.min(tokens.length, idx + 5));
  const itemTokens = around.filter(t => !STOPWORDS.has(t) && !/^\d/.test(t));
  let item = itemTokens.join(" ").trim();
  if (!item) item = "misc";

  return { item, price };
}

// --- 5) Resolve @mention to a display name (optional helper) ---
async function resolveMentionName(sock, jid) {
  try {
    const c = await sock?.onWhatsApp?.(jid);
    return c?.[0]?.notify || c?.[0]?.name || c?.[0]?.jid || "";
  } catch {
    return "";
  }
}

// --- 6) Bot bootstrap ---
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(`${AUTH_BASE}/auth_info`);
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
      else console.log(`Logged out — delete ${AUTH_BASE}/auth_info and redeploy to rescan QR.`);
    }
  });

  // --- 7) Message handler (with anti-loop guards) ---
  sock.ev.on("messages.upsert", async (m) => {
    const msg = m.messages?.[0];
    if (!msg || !msg.message) return;

    const jid = String(msg.key.remoteJid || "");
    if (jid === "status@broadcast") return;     // ignore status
    if (jid !== GROUP_JID) return;              // only your group

    // 🔒 prevent reply loops: ignore our own messages
    const myIdBare = (sock?.user?.id || "").split(":")[0];
    const participant = msg.key.participant || msg.participant || "";
    const isFromMe = msg.key.fromMe || (participant && participant.includes(myIdBare));
    if (isFromMe) return;

    // extract plain text
    const text =
      msg.message.conversation ||
      msg.message?.extendedTextMessage?.text ||
      msg.message?.ephemeralMessage?.message?.extendedTextMessage?.text ||
      "";

    if (!text) return;

    // also ignore our confirmation lines if someone copies/forwards them
    if (/^\s*✅\s*added:/i.test(text)) return;

    // decide payer name (sender by default, or @mention if present)
    let payerName = msg.pushName || "";
    const mentioned =
      msg.message?.extendedTextMessage?.contextInfo?.mentionedJid ||
      msg.message?.ephemeralMessage?.message?.extendedTextMessage?.contextInfo?.mentionedJid;
    if (Array.isArray(mentioned) && mentioned.length > 0) {
      const mentionName = await resolveMentionName(sock, mentioned[0]);
      if (mentionName) payerName = mentionName;
    }

    console.log("📩", payerName, ":", text);

    const parsed = parseNaturalExpense(text);
    if (!parsed) return; // not an expense-like message

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
        console.log("Posting to n8n:", N8N_WEBHOOK_URL);
        await axios.post(N8N_WEBHOOK_URL, payload, { timeout: 8000 });
        postedOK = true;
        console.log("n8n POST ok");
      } catch (e) {
        console.log("n8n webhook error:", e?.response?.status, e?.message);
      }
    } else {
      console.log("N8N_WEBHOOK_URL not set; skipping POST.");
    }

    // confirmation message
    await sock.sendMessage(jid, {
      text: `✅ added:  · ${payload.name.toLowerCase()} ${payload.item.toLowerCase()} · ₹${payload.price}`
    });
  });
}

// --- 8) Minimal health server (Render pings) ---
const app = express();
app.get("/", (_req, res) => res.send("Baileys bot running."));
app.get("/healthz", (_req, res) => res.send("ok"));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("HTTP server on", PORT);
  startBot();
});
