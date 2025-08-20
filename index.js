// --- Fix for "crypto is not defined" on some Node/ESM hosts ---
import * as nodeCrypto from "crypto";
if (!globalThis.crypto) globalThis.crypto = nodeCrypto.webcrypto;

// --- Imports ---
import * as baileys from "@whiskeysockets/baileys";

const { makeWASocket, useMultiFileAuthState, DisconnectReason } = baileys;

import qrcode from "qrcode-terminal";
import express from "express";
import axios from "axios";

// Optional: if you already have an n8n webhook, set this in Render env vars
// Render → your service → Environment → Add Variable → N8N_WEBHOOK_URL=https://your-n8n/webhook/...
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || "";

// ---- WhatsApp Bot ----
async function startBot() {
  // Persist session files in ./auth_info (Render will keep them between restarts on the same instance)
  const { state, saveCreds } = await useMultiFileAuthState("./auth_info");

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false, // we draw QR with qrcode-terminal (ASCII) in logs
    browser: ["RenderBot", "Chrome", "1.0"]
  });

  // Save updated creds to disk when they change
  sock.ev.on("creds.update", saveCreds);

  // Connection + QR handling
  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("Scan this QR with WhatsApp → Linked Devices:");
      qrcode.generate(qr, { small: true }); // shows ASCII QR in Render logs
    }

    if (connection === "open") {
      console.log("✅ WhatsApp connected!");
    }

    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      const reason = lastDisconnect?.error?.message || code;
      console.log("❌ Connection closed:", reason);

      // Reconnect unless the session was explicitly logged out from phone
      if (code !== DisconnectReason.loggedOut) {
        startBot();
      } else {
        console.log("Logged out — delete ./auth_info and redeploy to re-scan QR.");
      }
    }
  });

  // Message listener
  sock.ev.on("messages.upsert", async (m) => {
    const msg = m.messages?.[0];
    if (!msg || !msg.message) return;

    // ignore status broadcasts
    if (msg.key.remoteJid === "status@broadcast") return;

    const text =
      msg.message.conversation ||
      msg.message?.extendedTextMessage?.text ||
      msg.message?.ephemeralMessage?.message?.extendedTextMessage?.text;

    if (!text) return;

    console.log("📩 From:", msg.key.remoteJid, "Name:", msg.pushName, "Text:", text);

    // Simple test command
    if (text.trim().toLowerCase() === "ping") {
      await sock.sendMessage(msg.key.remoteJid, { text: "pong ✅" });
    }

    // OPTIONAL: forward to n8n webhook (for Google Sheets, etc.)
    if (N8N_WEBHOOK_URL) {
      try {
        await axios.post(N8N_WEBHOOK_URL, {
          jid: msg.key.remoteJid,
          fromMe: msg.key.fromMe,
          pushName: msg.pushName,
          text,
          timestamp: msg.messageTimestamp
        });
      } catch (e) {
        console.log("n8n webhook error:", e?.message);
      }
    }
  });
}

// ---- Minimal HTTP server so Render health checks pass ----
const app = express();
app.get("/", (_req, res) => res.send("Baileys bot is running."));
app.get("/healthz", (_req, res) => res.send("ok"));

// Render provides PORT; default to 3000 locally
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("HTTP health server listening on", PORT);
  // start the WhatsApp socket after HTTP server is ready
  startBot();
});
