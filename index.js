// --- 1) WebCrypto polyfill (fixes "crypto is not defined" on some hosts) ---
import * as nodeCrypto from "crypto";
if (!globalThis.crypto) globalThis.crypto = nodeCrypto.webcrypto;

// --- 2) Imports ---
import * as baileys from "@whiskeysockets/baileys";
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = baileys;
import qrcode from "qrcode-terminal";
import express from "express";
import axios from "axios";

// --- 3) Config ---
// Your expense group (only this group is processed)
const GROUP_JID = "120363419674431478@g.us";
// Optional: set in Render -> wa-bot -> Environment
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || "";

// --- 4) Helpers ---
/** Parse:
 *  "Name | Item | Price"  (also supports commas/semicolons/dashes as separators)
 *  or short form: "Item | Price"  (uses sender's pushName as Name)
 */
function parseExpense(text, fallbackName) {
  // normalize separators to |
  const clean = text.replace(/[;,–-]+/g, "|").replace(/\s*\|\s*/g, "|").trim();

  // Name|Item|Price
  let m = clean.match(/^([^|]+)\|([^|]+)\|(\d+(?:\.\d{1,2})?)$/i);
  if (m) return { name: m[1].trim(), item: m[2].trim(), price: parseFloat(m[3]) };

  // Item|Price  (take sender name)
  m = clean.match(/^([^|]+)\|(\d+(?:\.\d{1,2})?)$/i);
  if (m) return { name: (fallbackName || "").trim(), item: m[1].trim(), price: parseFloat(m[2]) };

  return null;
}

// --- 5) Bot bootstrap ---
async function startBot() {
  // Persist session on disk
  const { state, saveCreds } = await useMultiFileAuthState("./auth_info");

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,                 // we render our own QR below
    browser: ["RenderBot", "Chrome", "1.0"], // just an identifier
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("Scan this QR with WhatsApp → Linked Devices:");
      qrcode.generate(qr, { small: true });   // ASCII QR in Render logs
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
        console.log("Logged out — delete ./auth_info and redeploy to re-scan QR.");
      }
    }
  });

  // --- message handler ---
  sock.ev.on("messages.upsert", async (m) => {
    const msg = m.messages?.[0];
    if (!msg || !msg.message) return;

    // ignore status broadcasts
    const jid = String(msg.key.remoteJid || "");
    if (jid === "status@broadcast") return;

    // only group messages, only YOUR group
    if (!jid.endsWith("@g.us") || jid !== GROUP_JID) return;

    // extract text
    const text =
      msg.message.conversation ||
      msg.message?.extendedTextMessage?.text ||
      msg.message?.ephemeralMessage?.message?.extendedTextMessage?.text;

    if (!text) return;

    const senderName = msg.pushName || "";
    console.log("📩 From group:", jid, "| Sender:", senderName, "| Text:", text);

    // quick health check
    if (text.trim().toLowerCase() === "ping") {
      await sock.sendMessage(jid, { text: "pong ✅" });
      return;
    }

    // parse expense line
    const parsed = parseExpense(text, senderName);
    if (!parsed) return; // silently ignore non-expense messages

    // 6) Send to n8n webhook (if configured)
    let postedOK = false;
    if (N8N_WEBHOOK_URL) {
      try {
        await axios.post(N8N_WEBHOOK_URL, {
          ...parsed,                           // { name, item, price }
          jid,
          pushName: senderName,
          raw: text,
          ts: Number(msg.messageTimestamp) * 1000 // ms
        });
        postedOK = true;
      } catch (e) {
        console.log("n8n webhook error:", e?.message);
      }
    }

    // 7) Confirmation message in the group
    const rupee = "₹";
    const status = postedOK ? "added" : "received";
    await sock.sendMessage(
      jid,
      { text: `✅ ${status}: ${parsed.name} | ${parsed.item} | ${rupee}${parsed.price}` }
    );
  });
}

// --- 8) Minimal HTTP server for Render health checks ---
const app = express();
app.get("/", (_req, res) => res.send("Baileys bot is running."));
app.get("/healthz", (_req, res) => res.send("ok"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("HTTP health server listening on", PORT);
  startBot();
});
