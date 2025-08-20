// --- Fix for "crypto is not defined" on some Node/ESM hosts ---
import * as nodeCrypto from "crypto";
if (!globalThis.crypto) globalThis.crypto = nodeCrypto.webcrypto;

// --- Imports ---
import * as baileys from "@whiskeysockets/baileys";
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = baileys;

import qrcode from "qrcode-terminal";
import express from "express";
import axios from "axios";

// ====== CONFIG ======
// Your WhatsApp Group ID (JID) — we will only read messages from this group
const GROUP_JID = "120363419674431478@g.us";

// Optional: n8n webhook to receive parsed expenses (set in Render → Environment)
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || "";

// ====== HELPERS ======
/**
 * Parse expense lines like:
 *   "Name | Item | Price"
 *   "Name, Item, Price"
 *   "Name - Item - Price"
 * Also supports short form:
 *   "Item | Price"
 *   "Item, Price"
 *
 * @param {string} text
 * @param {string} fallbackName  Sender name used if no explicit name is provided
 * @returns {{name:string,item:string,price:number}|null}
 */
function parseExpense(text, fallbackName) {
  // normalize separators to |
  const clean = text.replace(/[;,–-]+/g, "|").replace(/\s*\|\s*/g, "|").trim();

  // Try: Name|Item|Price
  const m = clean.match(/^([^|]+)\|([^|]+)\|(\d+(?:\.\d{1,2})?)$/i);
  if (m) {
    return { name: m[1].trim(), item: m[2].trim(), price: parseFloat(m[3]) };
  }

  // Try: Item|Price -> use sender name
  const m2 = clean.match(/^([^|]+)\|(\d+(?:\.\d{1,2})?)$/i);
  if (m2) {
    return { name: (fallbackName || "").trim(), item: m2[1].trim(), price: parseFloat(m2[2]) };
  }

  return null; // not an expense line
}

// ====== BOT ======
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("./auth_info");

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false, // we print QR manually below
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
        // reconnect
        startBot();
      } else {
        console.log("Logged out — delete ./auth_info and redeploy to re-scan QR.");
      }
    }
  });

  // Handle incoming messages
  sock.ev.on("messages.upsert", async (m) => {
    const msg = m.messages?.[0];
    if (!msg || !msg.message) return;

    // ignore status broadcasts
    if (msg.key.remoteJid === "status@broadcast") return;

    // only group messages
    const jid = String(msg.key.remoteJid || "");
    if (!jid.endsWith("@g.us")) return;

    // only your chosen group
    if (jid !== GROUP_JID) return;

    // extract text
    const text =
      msg.message.conversation ||
      msg.message?.extendedTextMessage?.text ||
      msg.message?.ephemeralMessage?.message?.extendedTextMessage?.text;

    if (!text) return;

    const senderName = msg.pushName || "";
    console.log("📩 From group:", jid, "| Sender:", senderName, "| Text:", text);

    // simple health test
    if (text.trim().toLowerCase() === "ping") {
      await sock.sendMessage(jid, { text: "pong ✅" });
      return;
    }

    // try to parse an expense
    const parsed = parseExpense(text, senderName);
    if (!parsed) {
      // Not an expense — silently skip (or guide the format if you prefer)
      // await sock.sendMessage(jid, { text: "Use: Name | Item | Price  (or: Item | Price)" });
      return;
    }

    // Send to n8n if configured
    let postedOK = false;
    if (N8N_WEBHOOK_URL) {
      try {
        await axios.post(N8N_WEBHOOK_URL, {
          ...parsed,                    // { name, item, price }
          jid,
          pushName: senderName,
          raw: text,
          ts: Number(msg.messageTimestamp) * 1000 // milliseconds
        });
        postedOK = true;
      } catch (e) {
        console.log("n8n webhook error:", e?.message);
      }
    }

    // confirm inside the group
    const rupee = "₹";
    const status = postedOK ? "added" : "received";
    await sock.sendMessage(
      jid,
      { text: `✅ ${status}: ${parsed.name} | ${parsed.item} | ${rupee}${parsed.price}` }
    );
  });
}

// ====== HTTP health server (Render needs this) ======
const app = express();
app.get("/", (_req, res) => res.send("Baileys bot is running."));
app.get("/healthz", (_req, res) => res.send("ok"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("HTTP health server listening on", PORT);
  startBot();
});
