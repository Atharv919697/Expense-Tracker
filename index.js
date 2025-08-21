// Minimal message logger for Baileys (no filters, no n8n)
// 1) Deploy on Render
// 2) Scan the QR from WhatsApp → Linked Devices
// 3) Send anything in any group; check Render logs

import * as nodeCrypto from "crypto";
if (!globalThis.crypto) globalThis.crypto = nodeCrypto.webcrypto;

import * as baileys from "@whiskeysockets/baileys";
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = baileys;
import qrcode from "qrcode-terminal";
import express from "express";

// ---- helper: extract plain text from many message types ----
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
  // local folder for auth (no /tmp or /data)
  const { state, saveCreds } = await useMultiFileAuthState("./auth_info");
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: ["RenderLogger", "Chrome", "1.0"],
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log("Scan this QR in WhatsApp → Linked Devices:");
      qrcode.generate(qr, { small: true });
    }
    if (connection === "open") {
      console.log("✅ WhatsApp connected. Waiting for messages…");
    }
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      const msg  = lastDisconnect?.error?.message || code;
      console.log("🔌 Connection closed:", msg);
      if (code !== DisconnectReason.loggedOut) start();
      else console.log("Logged out. Delete ./auth_info then redeploy to relink.");
    }
  });

  // LOG EVERYTHING — no group filters
  sock.ev.on("messages.upsert", async ({ messages }) => {
    const m = messages?.[0];
    if (!m || !m.message) return;

    const jid     = String(m.key.remoteJid || "");
    const fromMe  = !!m.key.fromMe;
    const type    = Object.keys(m.message)[0];
    const text    = extractText(m);
    const tsMs    = Number(m.messageTimestamp) * 1000;

    console.log("----- INCOMING -----");
    console.log("jid      :", jid);                 // <- copy this to lock later
    console.log("fromMe   :", fromMe);
    console.log("type     :", type);
    console.log("text     :", JSON.stringify(text));
    console.log("timestamp:", new Date(tsMs).toISOString());
    console.log("--------------------");

    // Prove we can send: reply once in groups (avoid DM noise)
    if (!fromMe && jid.endsWith("@g.us")) {
      try {
        await sock.sendMessage(jid, { text: "👋 bot heard you" });
      } catch (e) {
        console.log("sendMessage error:", e?.message || e);
      }
    }
  });
}

// Tiny HTTP server for Render health checks
const app = express();
app.get("/", (_req, res) => res.send("logger up"));
app.get("/healthz", (_req, res) => res.send("ok"));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("HTTP on", PORT);
  start();
});
