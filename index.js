// --- 1) WebCrypto polyfill ---
import * as nodeCrypto from "crypto";
if (!globalThis.crypto) globalThis.crypto = nodeCrypto.webcrypto;

// --- 2) Imports ---
import * as baileys from "@whiskeysockets/baileys";
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = baileys;
import qrcode from "qrcode-terminal";
import express from "express";
import axios from "axios";

// --- 3) Config ---
const GROUP_JID = "120363419674431478@g.us"; // your group ID
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || "";

console.log("[BOOT] Group:", GROUP_JID);
console.log("[BOOT] N8N_WEBHOOK_URL:", N8N_WEBHOOK_URL ? "(set)" : "(NOT set)");

// --- 4) Free-form expense parser ---
function parseExpense(rawText) {
  if (!rawText) return null;

  const text = rawText
    .toLowerCase()
    .replace(/[₹]/g, " rs ")
    .replace(/rs\./g, " rs ")
    .replace(/\s+/g, " ")
    .trim();

  // find last number (₹, rs, or plain)
  const amountRe = /\b(?:rs|inr)?\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]+)?|[0-9]+(?:\.[0-9]+)?)\b/gi;
  let m, last = null;
  while ((m = amountRe.exec(text)) !== null) last = m[1];
  if (!last) return null;

  const price = parseFloat(last.replace(/,/g, ""));
  if (!Number.isFinite(price) || price <= 0) return null;

  // remove that number from text → remainder = item
  const item = text.replace(last, "").replace(/rs|inr|rupees/gi, "").trim();
  return { item: item || "misc", price };
}

// --- 5) Extract text from message ---
function extractText(msg) {
  const m = msg.message || {};
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.ephemeralMessage?.message?.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    ""
  );
}

// --- 6) Bot bootstrap ---
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("./auth_info");
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
      if (code !== DisconnectReason.loggedOut) startBot();
      else console.log("Logged out — delete ./auth_info and redeploy to rescan QR.");
    }
  });

  sock.ev.on("messages.upsert", async (up) => {
    try {
      const msg = up.messages?.[0];
      if (!msg || !msg.message) return;
      const jid = String(msg.key.remoteJid || "");
      const fromMe = !!msg.key.fromMe;

      if (jid === "status@broadcast") return;
      if (fromMe) return; // anti-loop
      if (jid !== GROUP_JID) return;

      const text = extractText(msg);
      if (!text || !text.trim()) return;

      const senderName = msg.pushName || "Unknown";
      const parsed = parseExpense(text);
      if (!parsed) return;

      const payload = {
        name: senderName,
        item: parsed.item,
        price: parsed.price,
        jid,
        raw: text,
        ts: Number(msg.messageTimestamp) * 1000,
      };

      // Send to n8n
      let postedOK = false;
      if (N8N_WEBHOOK_URL) {
        try {
          await axios.post(N8N_WEBHOOK_URL, payload, { timeout: 8000 });
          postedOK = true;
        } catch (e) {
          console.log("n8n webhook error:", e?.message);
        }
      }

      // Confirmation
      await sock.sendMessage(jid, {
        text: `✅ added: ${payload.name} | ${payload.item} | ₹${payload.price}`,
      });
    } catch (err) {
      console.log("handler error:", err?.message || err);
    }
  });
}

// --- 7) Minimal HTTP server ---
const app = express();
app.get("/", (_req, res) => res.send("Baileys bot running."));
app.get("/healthz", (_req, res) => res.send("ok"));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("HTTP server on", PORT);
  startBot();
});
