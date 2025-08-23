// Expense bot (free-form) — lock to a group via GROUP_JID env

import * as nodeCrypto from "crypto";
if (!globalThis.crypto) globalThis.crypto = nodeCrypto.webcrypto;

import * as baileys from "@whiskeysockets/baileys";
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = baileys;
import qrcode from "qrcode-terminal";
import express from "express";
import axios from "axios";

const GROUP_JID = (process.env.GROUP_JID || "").trim();            // e.g. 120363419674431478@g.us
const N8N_WEBHOOK_URL = (process.env.N8N_WEBHOOK_URL || "").trim();

console.log("[BOOT] GROUP_JID:", GROUP_JID || "(NOT set! — set it in Render → Environment)");
console.log("[BOOT] N8N_WEBHOOK_URL:", N8N_WEBHOOK_URL ? "(set)" : "(not set — skipping POSTs)");

// ---- free-form parser: take the LAST amount and use the remainder as item
function parseExpense(rawText) {
  if (!rawText) return null;
  const text = rawText
    .toLowerCase()
    .replace(/[₹]/g, " rs ")
    .replace(/rs\./g, " rs ")
    .replace(/\s+/g, " ")
    .trim();

  const amountRe = /\b(?:rs|inr)?\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]+)?|[0-9]+(?:\.[0-9]+)?)\b/gi;
  let m, last = null;
  while ((m = amountRe.exec(text)) !== null) last = m[1];
  if (!last) return null;

  const price = parseFloat(last.replace(/,/g, ""));
  if (!Number.isFinite(price) || price <= 0) return null;

  const item = text
    .replace(last, " ")
    .replace(/\b(rs|inr|rupees)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim() || "misc";

  return { item, price };
}

function extractText(msg) {
  const m  = msg.message || {};
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

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState("./auth_info");
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: ["WaExpenseBot", "Chrome", "1.0"],
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log("Scan QR → WhatsApp › Linked Devices:");
      qrcode.generate(qr, { small: true });
    }
    if (connection === "open") console.log("✅ WhatsApp connected!");
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      const msg  = lastDisconnect?.error?.message || code;
      console.log("🔌 Connection closed:", msg);
      if (code !== DisconnectReason.loggedOut) start();
      else console.log("Logged out. Delete ./auth_info then redeploy to relink.");
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages?.[0];
    if (!msg || !msg.message) return;

    const jid    = String(msg.key.remoteJid || "");
    const fromMe = !!msg.key.fromMe;

    if (jid === "status@broadcast") return;
    if (fromMe) return;                 // anti-loop
    if (!jid.endsWith("@g.us")) return; // groups only
    if (GROUP_JID && jid !== GROUP_JID) return;

    const text = extractText(msg);
    if (!text || !text.trim()) return;

    // ignore our confirmation if someone forwards it
    if (/^\s*✅\s*added:/i.test(text)) return;

    const senderName = msg.pushName || "Unknown";
    const parsed = parseExpense(text);
    console.log("[DBG] text:", JSON.stringify(text), "→ parsed:", parsed);
    if (!parsed) return;

    const payload = {
      name: senderName,
      item: parsed.item,
      price: parsed.price,
      jid,
      raw: text,
      ts: Number(msg.messageTimestamp) * 1000,
    };

    // post to n8n if configured
    if (N8N_WEBHOOK_URL) {
      try {
        await axios.post(N8N_WEBHOOK_URL, payload, { timeout: 8000 });
      } catch (e) {
        console.log("n8n webhook error:", e?.response?.status, e?.message);
      }
    }

    // confirmation
    await sock.sendMessage(jid, {
      text: `✅ added:  · ${payload.name} ${payload.item} · ₹${payload.price}`
    });
  });
}

// ---- tiny web server for Render health checks
const app = express();
app.get("/", (_req, res) => res.send("wa-expense-bot up"));
app.get("/healthz", (_req, res) => res.send("ok"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("HTTP on", PORT);
  start();
});
