// --- 1) WebCrypto polyfill ---
import * as nodeCrypto from "crypto";
if (!globalThis.crypto) globalThis.crypto = nodeCrypto.webcrypto;

// --- 2) Imports ---
import * as baileys from "@whiskeysockets/baileys";
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = baileys;
import qrcode from "qrcode-terminal";
import express from "express";
import axios from "axios";

// --- 3) Config via ENV ---
const GROUP_JID = (process.env.GROUP_JID || "").trim();       // leave empty to auto-discover
const N8N_WEBHOOK_URL = (process.env.N8N_WEBHOOK_URL || "").trim();

console.log("[BOOT] GROUP_JID:", GROUP_JID || "(not set — discovery mode)");
console.log("[BOOT] N8N_WEBHOOK_URL:", N8N_WEBHOOK_URL ? "(set)" : "(not set — skipping POSTs)");

// --- 4) Free-form expense parser (no fixed format) ---
function parseExpense(rawText) {
  if (!rawText) return null;
  const text = rawText
    .toLowerCase()
    .replace(/[₹]/g, " rs ")
    .replace(/rs\./g, " rs ")
    .replace(/\s+/g, " ")
    .trim();

  // pick the LAST amount in the message
  const amountRe = /\b(?:rs|inr)?\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]+)?|[0-9]+(?:\.[0-9]+)?)\b/gi;
  let m, last = null;
  while ((m = amountRe.exec(text)) !== null) last = m[1];
  if (!last) return null;

  const price = parseFloat(last.replace(/,/g, ""));
  if (!Number.isFinite(price) || price <= 0) return null;

  // crude item = text without the amount & currency words
  const item = text
    .replace(last, " ")
    .replace(/\b(rs|inr|rupees)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim() || "misc";

  return { item, price };
}

// --- 5) Extract text from message (supports captions etc.) ---
function extractText(msg) {
  const m = msg.message || {};
  const em = m.ephemeralMessage?.message || {};
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    em.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    em.imageMessage?.caption ||
    em.videoMessage?.caption ||
    ""
  );
}

// --- 6) Bot bootstrap ---
async function startBot() {
  // NOTE: local folder; no /tmp or /data
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
      const reason = lastDisconnect?.error?.message || code;
      console.log("Connection closed:", reason);
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

      // 1) Only groups
      if (!jid.endsWith("@g.us")) return;

      // 2) If GROUP_JID is set, enforce it; else discover and print it
      if (GROUP_JID && jid !== GROUP_JID) return;
      if (!GROUP_JID) {
        console.log(`[DISCOVER] Received a group message from: ${jid}`);
        console.log(`Set this in Render → Environment: GROUP_JID=${jid}`);
      }

      // 3) Extract text
      const text = extractText(msg);
      console.log("[DBG] text:", JSON.stringify(text));
      if (!text || !text.trim()) return;

      // Ignore our confirmation if someone forwards it
      if (/^\s*✅\s*added:/i.test(text)) return;

      const senderName = msg.pushName || "Unknown";

      // 4) Parse expense
      const parsed = parseExpense(text);
      console.log("[DBG] parsed:", parsed);
      if (!parsed) return;

      const payload = {
        name: senderName,
        item: parsed.item,
        price: parsed.price,
        jid,
        raw: text,
        ts: Number(msg.messageTimestamp) * 1000,
      };

      // 5) Post to n8n (optional)
      if (N8N_WEBHOOK_URL) {
        try {
          console.log("[DBG] posting to n8n:", N8N_WEBHOOK_URL);
          await axios.post(N8N_WEBHOOK_URL, payload, { timeout: 8000 });
          console.log("[DBG] n8n POST ok");
        } catch (e) {
          console.log("[DBG] n8n error:", e?.response?.status, e?.message);
        }
      }

      // 6) Confirm in group
      await sock.sendMessage(jid, {
        text: `✅ added:  · ${payload.name} ${payload.item} · ₹${payload.price}`
      });

    } catch (err) {
      console.log("[DBG] handler error:", err?.message || err);
    }
  });
}

// --- 7) Minimal HTTP server for Render health checks ---
const app = express();
app.get("/", (_req, res) => res.send("Baileys bot running."));
app.get("/healthz", (_req, res) => res.send("ok"));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("HTTP server on", PORT);
  startBot();
});
