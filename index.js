// index.js
const makeWASocket = require('@adiwajshing/baileys').default;

async function startBot() {
    const sock = makeWASocket({
        printQRInTerminal: true // Shows QR in Render logs
    });

    // Handle connection updates
    sock.ev.on('connection.update', (update) => {
        const { connection } = update;
        if (connection === 'close') {
            console.log('Connection closed, restarting...');
            startBot();
        } else if (connection === 'open') {
            console.log('✅ WhatsApp bot is connected');
        }
    });

    // Handle incoming messages
    sock.ev.on('messages.upsert', async (m) => {
        console.log('New message:', JSON.stringify(m, null, 2));

        if (m.messages && m.messages[0].message) {
            const msg = m.messages[0].message.conversation || "";
            console.log('Received:', msg);

            // Example auto-reply
            await sock.sendMessage(m.messages[0].key.remoteJid, { text: 'Got your message: ' + msg });
        }
    });
}

// Start the bot
startBot();
