import makeWASocket, { useMultiFileAuthState, DisconnectReason } from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import express from "express";
import axios from "axios";

// Optional webhook to n8n (we'll set it later in Render → Environment)
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || "";

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("./auth_info");

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: ["RenderBot", "Chrome", "1.0"]
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("Scan this QR with WhatsApp → Linked devices:");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      console.log("✅ WhatsApp connected!");
    }

    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      const reason = lastDisconnect?.error?.message || code;
      console.log("❌ Connection closed:", reason);

      if (code !== DisconnectReason.loggedOut) {
        startBot(); // auto-reconnect
      } else {
        console.log("Logged out — delete auth_info and redeploy to re-scan QR.");
      }
    }
  });

  // Handle new messages
  sock.ev.on("messages.upsert", async (m) => {
    const msg = m.messages?.[0];
    if (!msg || !msg.message) return;
    if (msg.key.remoteJid === "status@broadcast") return;

    const text =
      msg.message.conversation ||
      msg.message?.extendedTextMessage?.text ||
      msg.message?.ephemeralMessage?.message?.extendedTextMessage?.text;

    if (!text) return;

    console.log("📩 From:", msg.key.remoteJid, "Text:", text);

    // Simple test command
    if (text.toLowerCase().trim() === "ping") {
      await sock.sendMessage(msg.key.remoteJid, { text: "pong ✅" });
    }

    // OPTIONAL: forward to n8n webhook for Google Sheets, etc.
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

// Tiny HTTP server so Render health checks pass
const app = express();
app.get("/", (req, res) => res.send("Baileys bot is running."));
app.get("/healthz", (req, res) => res.send("ok"));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("HTTP health server listening on", PORT);
  startBot();
});
