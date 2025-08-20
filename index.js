// --- 1) WebCrypto polyfill (fixes "crypto is not defined" on some hosts) ---
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
const GROUP_JID = "120363419674431478@g.us";   // your WhatsApp group
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || "";

// Choose a writable auth directory:
// - If a Disk is attached on Render, /data exists -> persistent
// - Otherwise (Free plan), use /tmp -> NOT persistent across deploys
const AUTH_BASE = process.env.AUTH_DIR || (fs.existsSync("/data") ? "/data" : "/tmp");
console.log("Auth directory:", `${AUTH_BASE}/auth_info`);

// --- 4) Natural parser (no fixed format) ---
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

  // find the LAST number in the message
  const amountRe = /\b(?:rs|inr)?\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]+)?|[0-9]+(?:\.[0-9]+)?)\b/gi;
  let m, last = null;
  while ((m = amountRe.exec(text)) !== null) {
    last = { value: m[1] };
  }
  if (!last) return null;

  const price = parseFloat(last.value.replace(/,/g, ""));
  if (!isFinite(price) || price <= 0) return null;

  const tokens = text.split(" ").map(cleanToken).filter(Boolean);

  // take 4 tokens around the amount and filter stopwords/numbers
  const idx = tokens.findIndex(t => t.includes(last.value.replace(/,/g, "")));
  const around = tokens.slice(Math.max(0, idx - 4), Math.min(tokens.length, idx + 5));
  const itemTokens = around.filter(t => !STOPWORDS.has(t) && !/^\d/.test(t));
  let item = itemTokens.join(" ").trim();
  if (!item) item = "misc";

  return { item, price };
}

// --- 5) Resolve @mention to a display name (optional) ---
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
      console.log("Scan QR code in WhatsApp → Linked Devices:");
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

  // --- 7) Message handler ---
  sock.ev.on("messages.upsert", async (m) => {
    const msg = m.messages?.[0];
    if (!msg || !msg.message) return;

    const jid = String(msg.key.remoteJid || "");
    if (jid !== GROUP_JID) return;                   // only your group

    const text =
      msg.message.conversation ||
      msg.message?.extendedTextMessage?.text ||
      msg.message?.ephemeralMessage?.message?.extendedTextMessage?.text;

    if (!text) return;

    // pick name = sender; if @mention exists, use mentioned person
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
    if (!parsed) return;  // not an expense-like message

    const payload = {
      name: payerName,
      item: parsed.item,
      price: parsed.price,
      jid,
      raw: text,
      ts: Number(msg.messageTimestamp) * 1000
    };

    // Send to n8n (if configured)
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

    // Confirm in group
    await sock.sendMessage(jid, {
      text: `✅ ${postedOK ? "added" : "noted"}: ${payload.name} · ${payload.item} · ₹${payload.price}`
    });
  });
}

// --- 8) Minimal Express server (for Render health checks) ---
const app = express();
app.get("/", (_req, res) => res.send("Baileys bot running."));
app.get("/healthz", (_req, res) => res.send("ok"));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("HTTP server on", PORT);
  startBot();
});
