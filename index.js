const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys")
const qrcode = require("qrcode-terminal")

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState("auth_info")

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true // shows QR code in Render logs
    })

    sock.ev.on("creds.update", saveCreds)

    sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect } = update
        if (connection === "close") {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
            if (shouldReconnect) {
                startBot()
            } else {
                console.log("Logged out. Please delete auth_info and scan again.")
            }
        } else if (connection === "open") {
            console.log("✅ Bot is connected!")
        }
    })

    sock.ev.on("messages.upsert", async (msgUpdate) => {
        const msg = msgUpdate.messages[0]
        if (!msg.message || msg.key.fromMe) return

        const from = msg.key.remoteJid
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text

        console.log("📩 New message:", text)

        if (text?.toLowerCase() === "hi") {
            await sock.sendMessage(from, { text: "Hello 👋, I am your bot!" })
        }
    })
}

startBot()
