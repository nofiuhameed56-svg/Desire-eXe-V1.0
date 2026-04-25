const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const P = require('pino');
const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode');
const delay = ms => new Promise(res => setTimeout(res, ms));

// File paths
const AUTH_DIR = './auth_info';
const CONTACT_FILE = './Desire_contact.json';
const CONFIG_FILE = './config.json';
const BUG_LOG = './buglog.json';

let contactList = [];
let botStartTime = null;
let isConnected = false;
let qrCode = null;
let qrCodeImage = null;
let pairingCode = null;
let pairingPhoneNumber = null;
let pairingCodeExpiry = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
let globalSocket = null;
let keepAliveInterval = null;

global.botStatus = 'starting';
global.connectionTime = null;

// Load contacts
function loadContactsFromFile() {
  if (fs.existsSync(CONTACT_FILE)) {
    try {
      const raw = fs.readFileSync(CONTACT_FILE);
      contactList = JSON.parse(raw) || [];
      console.log(`📁 Loaded ${contactList.length} saved contacts.`);
    } catch (e) {
      console.error('❌ Failed to parse contact file:', e);
      contactList = [];
    }
  }
}

// Save contacts
function saveContactsToFile() {
  try {
    fs.writeFileSync(CONTACT_FILE, JSON.stringify(contactList, null, 2));
  } catch (e) {
    console.error('❌ Failed to save contacts:', e);
  }
}

// Save bug log
function logBugIncident(jid, type, detail) {
  const logEntry = {
    time: new Date().toISOString(),
    jid,
    type,
    detail
  };
  let logs = [];
  if (fs.existsSync(BUG_LOG)) {
    try {
      logs = JSON.parse(fs.readFileSync(BUG_LOG));
    } catch (e) {
      console.error('❌ Failed to parse bug log:', e);
    }
  }
  logs.push(logEntry);
  try {
    fs.writeFileSync(BUG_LOG, JSON.stringify(logs, null, 2));
  } catch (e) {
    console.error('❌ Failed to save bug log:', e);
  }
}

// Get uptime string
function getUptimeString() {
  if (!botStartTime) return 'Just started';
  const uptime = Date.now() - botStartTime;
  const seconds = Math.floor(uptime / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

// Generate QR Code as image
async function generateQRImage(qr) {
  try {
    const qrImage = await qrcode.toDataURL(qr);
    return qrImage;
  } catch (error) {
    console.error('❌ Failed to generate QR image:', error);
    return null;
  }
}

// Start keep-alive ping
function startKeepAlive(sock) {
  if (keepAliveInterval) clearInterval(keepAliveInterval);
  
  keepAliveInterval = setInterval(async () => {
    if (sock && isConnected) {
      try {
        await sock.sendPresenceUpdate('available');
        console.log('💓 Keep-alive ping sent');
      } catch (error) {
        console.error('❌ Keep-alive failed:', error);
      }
    }
  }, 45000);
}

// Stop keep-alive
function stopKeepAlive() {
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
    console.log('🛑 Keep-alive stopped');
  }
}

// Helper functions
function isNewsletterJid(jid) {
  return jid === 'status@broadcast';
}

function unwrapMessage(message) {
  if (message?.ephemeralMessage?.message) {
    return unwrapMessage(message.ephemeralMessage.message);
  }
  if (message?.viewOnceMessage?.message) {
    return unwrapMessage(message.viewOnceMessage.message);
  }
  if (message?.viewOnceMessageV2?.message) {
    return unwrapMessage(message.viewOnceMessageV2.message);
  }
  if (message?.viewOnceMessageV2Extension?.message) {
    return unwrapMessage(message.viewOnceMessageV2Extension.message);
  }
  return message;
}

function isGroupStatusMentionMessage(message) {
  return message?.groupStatusMentionMessage?.message?.protocolMessage !== undefined;
}

function extractMentionInfo(message) {
  const mentionMsg = message.groupStatusMentionMessage;
  return {
    type: 'group_mention',
    protocolMessage: mentionMsg.message?.protocolMessage,
    timestamp: mentionMsg.messageTimestamp,
    key: mentionMsg.message?.key
  };
}

function isDangerousText(msg) {
  const text = msg?.conversation || msg?.extendedTextMessage?.text || '';
  if (!text || text.length < 10) return false;
  const patterns = [
    /[\u200B\u200C\u200E\u200F\u202A-\u202E\u2060\uFEFF]/,
    /(.+)\1{100,}/,
    /.{6000,}/,
    /[\uFFF9-\uFFFF]/,
  ];
  return patterns.some(p => p.test(text));
}

function getParticipantActionText(participants, action) {
  const actionTexts = {
    'promote': 'promoted to admin',
    'demote': 'demoted from admin'
  };
  const actionText = actionTexts[action] || action;
  const participantNames = participants.map(p => `@${p.split('@')[0]}`).join(', ');
  return `${participantNames} ${actionText}`;
}

// ========== FIXED PAIRING CODE FUNCTION (Copied from working version) ==========
async function requestPairingCode(phoneNumber) {
  try {
    console.log(`📱 Requesting pairing code for: ${phoneNumber}`);
    
    // Validate phone number format
    if (!phoneNumber.match(/^\d{10,15}$/)) {
      throw new Error('Invalid phone number format. Use format: 2347017747337 (10-15 digits, no + sign)');
    }
    
    // Check if socket exists
    if (!globalSocket) {
      throw new Error('Bot socket not initialized. Please wait for the bot to start or refresh the page.');
    }
    
    // Check if requestPairingCode method exists
    if (typeof globalSocket.requestPairingCode !== 'function') {
      throw new Error('Pairing code feature not available. Please try QR code instead.');
    }
    
    // Generate pairing code using the working method
    const code = await globalSocket.requestPairingCode(phoneNumber.trim());
    
    if (!code || typeof code !== 'string') {
      throw new Error('Invalid pairing code received from WhatsApp');
    }
    
    pairingCode = code;
    pairingPhoneNumber = phoneNumber;
    pairingCodeExpiry = Date.now() + (2 * 60 * 1000);
    
    console.log(`✅ Pairing code generated: ${code} for ${phoneNumber}`);
    console.log(`⏰ Code expires at: ${new Date(pairingCodeExpiry).toLocaleTimeString()}`);
    
    return {
      success: true,
      code: code,
      phoneNumber: phoneNumber,
      expiresAt: new Date(pairingCodeExpiry).toISOString(),
      message: 'Pairing code generated successfully'
    };
    
  } catch (error) {
    console.error('❌ Failed to generate pairing code:', error);
    
    return {
      success: false,
      error: error.message,
      suggestion: 'Try using QR code authentication instead.'
    };
  }
}

function clearExpiredPairingCode() {
  if (pairingCodeExpiry && Date.now() > pairingCodeExpiry) {
    console.log('⏰ Pairing code expired');
    pairingCode = null;
    pairingPhoneNumber = null;
    pairingCodeExpiry = null;
  }
}

async function sendConnectionNotification(sock, config) {
  if (!config.OWNER_JID) {
    console.log('⚠️ No OWNER_JID configured - skipping connection notification');
    return;
  }
  try {
    const timestamp = new Date().toLocaleString();
    const uptime = getUptimeString();

    const connectionMessage = `*DΞSIRΞ-ΞXΞ V2.0 Connected!*

✅ *Status:* Online and Ready
🕒 *Connected At:* ${timestamp}
⏱️ *Uptime:* ${uptime}
🔗 *Session:* ${sock.authState.creds.registered ? 'Authenticated' : 'Not Registered'}
📱 *Platform:* ${sock.user?.platform || 'Unknown'}
The bot is now operational and listening for messages.`;

    await sock.sendMessage(config.OWNER_JID, { text: connectionMessage });
    console.log(`✅ Connection notification sent to owner: ${config.OWNER_JID}`);
  } catch (error) {
    console.error('❌ Failed to send connection notification:', error);
  }
}

// ========== FIXED CONNECTION HANDLER ==========
async function handleConnectionUpdate(update, sock, config) {
  const { connection, lastDisconnect, qr, isNewLogin } = update;

  // Store socket immediately when we get any update
  if (sock && !globalSocket) {
    globalSocket = sock;
    console.log('📡 Socket stored for pairing code generation');
  }

  if (qr) {
    console.log('📱 QR Code received - generating web QR...');
    qrCode = qr;
    qrCodeImage = await generateQRImage(qr);
    global.botStatus = 'qr_pending';
    isConnected = false;
    reconnectAttempts = 0;

    console.log('🌐 QR Code available at: /auth');
    console.log('🔑 Pairing code is ALSO available - you can use either method!');

    setTimeout(() => {
      if (!isConnected && qrCode === qr) {
        console.log('⏰ QR Code expired - will generate new one on next connection');
        qrCode = null;
        qrCodeImage = null;
      }
    }, 120000);
    return;
  }

  if (connection === 'close') {
    const statusCode = lastDisconnect?.error?.output?.statusCode;
    const shouldReconnect = statusCode !== DisconnectReason.loggedOut && 
                           statusCode !== 401 && 
                           statusCode !== 403;

    console.log(`🔌 Connection closed - Status: ${statusCode}, Reconnect: ${shouldReconnect}`);

    isConnected = false;
    qrCode = null;
    qrCodeImage = null;
    pairingCode = null;
    pairingPhoneNumber = null;
    pairingCodeExpiry = null;
    stopKeepAlive();

    if (shouldReconnect) {
      reconnectAttempts++;
      
      const baseDelay = 5000;
      const delayTime = Math.min(baseDelay * Math.pow(2, reconnectAttempts - 1), 120000);
      
      console.log(`🔄 Attempting reconnect (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}) in ${delayTime/1000}s...`);
      global.botStatus = 'reconnecting';

      if (reconnectAttempts <= MAX_RECONNECT_ATTEMPTS) {
        setTimeout(() => {
          console.log('🔄 Executing reconnect...');
          startBot().catch(err => {
            console.error('❌ Reconnection attempt failed:', err);
          });
        }, delayTime);
      } else {
        console.error('🚫 Max reconnection attempts reached. Will retry in 5 minutes.');
        global.botStatus = 'error';
        
        setTimeout(() => {
          reconnectAttempts = 0;
          console.log('🔄 Resetting reconnect attempts after cooldown');
          startBot().catch(console.error);
        }, 300000);
      }
    } else {
      console.log('🔒 Session invalid - requires new authentication');
      global.botStatus = 'needs_auth';
      try {
        if (fs.existsSync(AUTH_DIR)) {
          fs.rmSync(AUTH_DIR, { recursive: true });
          console.log('🧹 Cleared invalid session data');
        }
      } catch (e) {
        console.error('❌ Failed to clear session data:', e);
      }
      
      setTimeout(() => {
        console.log('🔄 Attempting fresh connection after logout...');
        reconnectAttempts = 0;
        startBot().catch(console.error);
      }, 10000);
    }
    return;
  }

  if (connection === 'open') {
    console.log('✅ DΞSIRΞ-ΞXΞ V2.0 CONNECTED SUCCESSFULLY');
    isConnected = true;
    reconnectAttempts = 0;
    globalSocket = sock;
    global.botStatus = 'connected';
    global.connectionTime = new Date().toISOString();

    // Start keep-alive pings
    startKeepAlive(sock);

    try {
      await sock.sendPresenceUpdate('available');
      await sendConnectionNotification(sock, config);
    } catch (error) {
      console.error('❌ Error during connection setup:', error);
    }
  }

  if (connection === 'connecting') {
    console.log('🔄 Connecting to WhatsApp...');
    isConnected = false;
    global.botStatus = 'connecting';
    if (sock && !globalSocket) {
      globalSocket = sock;
      console.log('📡 Socket stored for pairing code generation');
    }
  }
}

function setupMessageHandlers(sock, config) {
  // Remove old listeners to prevent duplicates
  sock.ev.removeAllListeners('messages.upsert');
  sock.ev.removeAllListeners('group-participants.update');

  sock.ev.on('messages.upsert', async ({ messages }) => {
    await delay(100);
    let msg;
    try {
      msg = messages[0];
      const jid = msg.key.remoteJid;

      if (jid === 'status@broadcast') {
        console.log('📵 Ignoring system broadcast message');
        return;
      }

      if (!msg.message) {
        console.log('📭 Ignoring empty message');
        return;
      }

      msg.message = unwrapMessage(msg.message);

      if (isGroupStatusMentionMessage(msg.message)) {
        console.log('🔔 Group mention detected:', jid);
        const configFile = './src/antimention.json';
        if (fs.existsSync(configFile)) {
          const cfg = JSON.parse(fs.readFileSync(configFile));
          if (cfg[jid]?.enabled) {
            const mentionUser = msg.key.participant || msg.key.remoteJid;
            try {
              await sock.sendMessage(jid, { delete: msg.key });
              console.log(`🗑️ Deleted mention message from ${mentionUser} in ${jid}`);
            } catch (e) {
              console.error('❌ Failed to delete mention message:', e);
            }
            await sock.sendMessage(jid, {
              text: `⚠️ *Mention Warning!*\n\n@${mentionUser.split('@')[0]} Please avoid mentioning everyone in the group.\n\n🚫 Mass mentions are not allowed and will be deleted automatically.`,
              mentions: [mentionUser]
            });
            logBugIncident(jid, 'group_mention', `User ${mentionUser} mentioned everyone - MESSAGE DELETED`);
            return;
          }
        }
      }

      if (!jid.endsWith('@g.us') && !jid.endsWith('@broadcast')) {
        if (isDangerousText(msg.message)) {
          console.warn(`🚨 Bug-like TEXT from ${jid}`);
          await sock.sendMessage(jid, { text: '⚠️' });
          await sock.updateBlockStatus(jid, 'block');
          logBugIncident(jid, 'text', JSON.stringify(msg.message).slice(0, 500));
          if (config.OWNER_JID) {
            await sock.sendMessage(config.OWNER_JID, {
              text: `🚨 Bug alert\nFrom: ${jid}\nType: Text\nAction: Blocked`
            });
          }
          return;
        }
      }

      if (jid && !jid.endsWith('@g.us') && jid !== 'status@broadcast') {
        const known = contactList.find(c => c.jid === jid);
        if (!known) {
          if (config.AUTO_BLOCK_UNKNOWN) {
            console.log(`🚫 Unknown contact blocked: ${jid}`);
            await sock.updateBlockStatus(jid, 'block');
            return;
          }
          const name = msg.pushName || 'Unknown';
          contactList.push({ jid, name, firstSeen: new Date().toISOString() });
          saveContactsToFile();
          console.log(`➕ Saved: ${name} (${jid})`);
        }
      }

      console.log('📩 Message received:', msg.message?.conversation || msg.message?.extendedTextMessage?.text || 'Media/Other');

      if (msg.key?.id) {
        await sock.readMessages([msg.key]);
      }

      const MessageHandler = require('../controllers/Message');
      await MessageHandler(sock, messages, contactList);

    } catch (err) {
      console.error('❌ Message handler error:', err);
      if (msg?.key?.id) {
        try {
          await sock.readMessages([msg.key]);
        } catch (e) {}
      }
    }
  });

  sock.ev.on('group-participants.update', async ({ id, participants, action }) => {
    console.log(`👥 Group update in ${id}: ${action} - ${participants.join(', ')}`);

    const now = new Date();
    const date = now.toLocaleDateString('en-GB').replace(/\//g, '-');
    const time = now.toLocaleTimeString('en-US', { hour12: false });

    if (action === 'promote' || action === 'demote') {
      try {
        const configFile = action === 'promote' ? './src/promote.json' : './src/demote.json';
        if (fs.existsSync(configFile)) {
          const configData = JSON.parse(fs.readFileSync(configFile));
          if (configData[id]?.enabled) {
            const customMessage = configData[id]?.message ||
              (action === 'promote' ? "👑 @user has been promoted to admin!" : "🔻 @user has been demoted from admin!");
            for (const user of participants) {
              const userMessage = customMessage.replace(/@user/g, `@${user.split('@')[0]}`);
              await sock.sendMessage(id, {
                text: `${userMessage}\n🕒 ${time}, ${date}`,
                mentions: [user]
              });
            }
            return;
          }
        }
        const actionText = action === 'promote' ? '👑 Promoted to Admin' : '🔻 Demoted from Admin';
        await sock.sendMessage(id, {
          text: `*${actionText}*\n👤 User: ${getParticipantActionText(participants, action)}\n🕒 Time: ${time}, ${date}`,
          mentions: participants
        });
      } catch (error) {
        console.error(`❌ Error sending ${action} notification:`, error);
      }
      return;
    }

    if (action === 'add') {
      const welcomeFile = './src/welcome.json';
      if (!fs.existsSync(welcomeFile)) return;
      let welcomeData = {};
      try {
        welcomeData = JSON.parse(fs.readFileSync(welcomeFile));
      } catch (e) { return; }
      if (!welcomeData[id]?.enabled) return;

      for (const user of participants) {
        const userJid = typeof user === 'string' ? user : user.id || user.jid;
        if (!userJid) continue;

        let pfpUrl;
        try {
          pfpUrl = await Promise.race([
            sock.profilePictureUrl(userJid, 'image'),
            new Promise((_, reject) => setTimeout(() => reject(), 5000))
          ]);
        } catch {
          pfpUrl = 'https://i.imgur.com/1s6Qz8v.png';
        }

        const userDisplay = userJid.split('@')[0];
        const welcomeText = (welcomeData[id]?.message || '👋 Welcome @user!').replace(/@user/g, `@${userDisplay}`);

        try {
          await sock.sendMessage(id, {
            image: { url: pfpUrl },
            caption: welcomeText,
            mentions: [userJid]
          });
        } catch {
          await sock.sendMessage(id, { text: welcomeText, mentions: [userJid] });
        }
      }
    }

    if (action === 'remove') {
      const settingsFile = './src/group_settings.json';
      if (!fs.existsSync(settingsFile)) return;
      let settings = {};
      try {
        settings = JSON.parse(fs.readFileSync(settingsFile));
      } catch { return; }
      if (!settings[id]?.goodbyeEnabled) return;

      for (const user of participants) {
        const userJid = typeof user === 'string' ? user : user.id || user.jid;
        if (!userJid) continue;

        const userDisplay = userJid.split('@')[0];
        const goodbyeText = `👋 Goodbye @${userDisplay}!\n⌚ Left at: ${time}, ${date}\nToo Bad We Won't Miss You! 💔`;

        let pfpUrl;
        try {
          pfpUrl = await Promise.race([
            sock.profilePictureUrl(userJid, 'image'),
            new Promise((_, reject) => setTimeout(() => reject(), 5000))
          ]);
        } catch {
          pfpUrl = 'https://i.imgur.com/1s6Qz8v.png';
        }

        try {
          await sock.sendMessage(id, {
            image: { url: pfpUrl },
            caption: goodbyeText,
            mentions: [userJid]
          });
        } catch {
          await sock.sendMessage(id, { text: goodbyeText, mentions: [userJid] });
        }
      }
    }
  });
}

// ========== FIXED START BOT FUNCTION ==========
async function startBot() {
  botStartTime = Date.now();

  let config = {
    AUTO_BLOCK_UNKNOWN: false,
    OWNER_JID: process.env.OWNER_JID || '2347017747337@s.whatsapp.net',
    MAX_MEDIA_SIZE: 15000
  };

  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const fileConfig = JSON.parse(fs.readFileSync(CONFIG_FILE));
      config = { ...config, ...fileConfig };
    }
  } catch (e) {
    console.error('❌ Failed to load config:', e);
  }

  const sessionExists = fs.existsSync(AUTH_DIR);
  console.log(`🔍 Session check: ${sessionExists ? 'Found existing session' : 'No session found'}`);

  let state, saveCreds;
  try {
    ({ state, saveCreds } = await useMultiFileAuthState(AUTH_DIR));
  } catch (error) {
    console.error('❌ Failed to load auth state:', error);
    try {
      if (fs.existsSync(AUTH_DIR)) {
        fs.rmSync(AUTH_DIR, { recursive: true });
        console.log('🧹 Cleared corrupted session data');
      }
    } catch (e) {
      console.error('❌ Failed to clear corrupted session:', e);
    }
    ({ state, saveCreds } = await useMultiFileAuthState(AUTH_DIR));
  }

  let sock;
  try {
    // Get latest Baileys version
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`📱 Using WhatsApp version: ${version.join('.')} ${isLatest ? '(latest)' : ''}`);

    // CRITICAL: Remove 'mobile: false' - let it auto-detect
    sock = makeWASocket({
      auth: state,
      logger: P({ level: 'silent' }),
      browser: Browsers.ubuntu('Chrome'),
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 60000, // Increased to match working version
      defaultQueryTimeoutMs: 60000,
      maxRetries: 5, // Reduced from 15
      retryRequestDelayMs: 5000,
      emitOwnEvents: false, // Changed from true
      markOnlineOnConnect: true,
      syncFullHistory: false,
      linkPreviewImageThumbnailWidth: 192,
      generateHighQualityLinkPreview: false,
      shouldIgnoreJid: jid => jid.endsWith('@bot') || jid === 'status@broadcast',
      getMessage: async () => null,
      fireInitQueries: true,
      // IMPORTANT: Remove 'mobile: false' or at least test without it
      version: version,
      printQRInTerminal: false,
    });

    // Store socket immediately after creation
    globalSocket = sock;
    console.log('📡 Socket initialized - Pairing codes ENABLED');
    
    // Check if pairing code method is available
    if (typeof sock.requestPairingCode === 'function') {
      console.log('✅ Pairing code method is AVAILABLE');
    } else {
      console.log('⚠️ Pairing code method not available');
    }
  } catch (err) {
    console.error('❌ Failed to initialize socket:', err);
    globalSocket = null;
    setTimeout(startBot, 10000);
    return null;
  }

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', (update) => {
    handleConnectionUpdate(update, sock, config).catch(err => {
      console.error('❌ Connection update handler error:', err);
    });
  });

  sock.ev.on('ws-close', () => {
    console.log('🔌 WebSocket closed unexpectedly');
    setTimeout(() => {
      console.log('🔄 Attempting to restart due to WS close');
      startBot().catch(console.error);
    }, 5000);
  });

  loadContactsFromFile();
  setupMessageHandlers(sock, config);

  return sock;
}

// HTML response function (using the working version's responsive design)
function getAuthPage() {
  const hasQR = !!qrCode;
  const hasPairingCode = !!pairingCode;
  const isConnecting = global.botStatus === 'connecting' || global.botStatus === 'reconnecting';
  const isConnectedStatus = global.botStatus === 'connected';

  clearExpiredPairingCode();
  
  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
    <title>DΞSIRΞ-ΞXΞ V2.0 • WhatsApp Bot Dashboard</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@400;500;600;700;800;900&family=Exo+2:wght@300;400;500;600;700&display=swap" rel="stylesheet">
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
            -webkit-tap-highlight-color: transparent;
        }
        
        :root {
            --primary: #8a2be2;
            --primary-dark: #5a1a9c;
            --secondary: #00ff88;
            --accent: #ff0080;
            --dark: #0a0a1a;
            --darker: #050510;
            --glass: rgba(255, 255, 255, 0.05);
            --glass-border: rgba(255, 255, 255, 0.1);
        }
        
        body {
            font-family: 'Exo 2', sans-serif;
            background: var(--darker);
            color: white;
            min-height: 100vh;
            background-image: 
                radial-gradient(circle at 10% 20%, rgba(138, 43, 226, 0.15) 0%, transparent 20%),
                radial-gradient(circle at 90% 80%, rgba(0, 255, 136, 0.1) 0%, transparent 20%);
        }
        
        .container {
            max-width: 1200px;
            margin: 0 auto;
            padding: 16px;
        }
        
        .header {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 16px;
            padding: 20px 0;
            margin-bottom: 24px;
            border-bottom: 1px solid var(--glass-border);
        }
        
        .logo-container {
            display: flex;
            align-items: center;
            gap: 16px;
            flex-wrap: wrap;
            justify-content: center;
        }
        
        .logo {
            width: 60px;
            height: 60px;
            background: linear-gradient(135deg, var(--primary), var(--accent));
            border-radius: 16px;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        
        .logo i {
            font-size: 32px;
            color: white;
        }
        
        .logo-text h1 {
            font-family: 'Orbitron', monospace;
            font-size: 1.6rem;
            background: linear-gradient(90deg, var(--primary), var(--secondary), var(--accent));
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            margin-bottom: 4px;
            text-align: center;
        }
        
        .logo-text .version {
            color: var(--secondary);
            font-size: 0.75rem;
            letter-spacing: 2px;
            font-weight: 600;
            text-align: center;
        }
        
        .status-badge {
            padding: 10px 20px;
            border-radius: 50px;
            font-weight: 600;
            display: inline-flex;
            align-items: center;
            gap: 8px;
            background: rgba(0, 0, 0, 0.3);
            border: 1px solid var(--glass-border);
            font-size: 0.85rem;
        }
        
        .status-badge.connecting { color: #ffcc00; border-color: #ffcc00; }
        .status-badge.qr-pending { color: var(--secondary); border-color: var(--secondary); }
        .status-badge.pairing-pending { color: #00bfff; border-color: #00bfff; }
        .status-badge.connected { color: var(--secondary); border-color: var(--secondary); }
        
        .dashboard {
            display: flex;
            flex-direction: column;
            gap: 24px;
        }
        
        .auth-panel {
            background: var(--glass);
            backdrop-filter: blur(15px);
            border: 1px solid var(--glass-border);
            border-radius: 20px;
            padding: 20px;
            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
        }
        
        .panel-header {
            display: flex;
            flex-direction: column;
            gap: 8px;
            margin-bottom: 20px;
            padding-bottom: 15px;
            border-bottom: 1px solid var(--glass-border);
        }
        
        .panel-title {
            font-family: 'Orbitron', monospace;
            font-size: 1.3rem;
            color: var(--secondary);
            display: flex;
            align-items: center;
            gap: 8px;
        }
        
        .uptime {
            color: #aaa;
            font-size: 0.75rem;
        }
        
        .method-tabs {
            display: flex;
            background: rgba(0, 0, 0, 0.3);
            border-radius: 12px;
            padding: 4px;
            margin-bottom: 20px;
            gap: 4px;
        }
        
        .method-tab {
            flex: 1;
            padding: 12px 8px;
            text-align: center;
            cursor: pointer;
            border-radius: 8px;
            font-weight: 600;
            transition: all 0.3s ease;
            color: #aaa;
            font-size: 0.85rem;
        }
        
        .method-tab.active {
            background: linear-gradient(135deg, var(--primary), var(--primary-dark));
            color: white;
        }
        
        .method-tab i {
            margin-right: 6px;
        }
        
        .qr-container {
            text-align: center;
            padding: 20px 0;
        }
        
        .qr-container h3 {
            font-size: 1.1rem;
            margin-bottom: 16px;
            color: var(--secondary);
        }
        
        .qr-image {
            width: 200px;
            height: 200px;
            border: 3px solid var(--primary);
            border-radius: 15px;
            padding: 10px;
            background: white;
            margin: 16px auto;
            display: block;
        }
        
        .countdown {
            font-size: 0.85rem;
            color: var(--accent);
            font-weight: 600;
            margin-top: 10px;
        }
        
        .pairing-code-display {
            text-align: center;
            padding: 20px;
            background: rgba(0, 0, 0, 0.3);
            border-radius: 15px;
            margin: 16px 0;
            border: 1px solid var(--glass-border);
        }
        
        .phone-number {
            font-size: 1.1rem;
            color: var(--secondary);
            margin: 12px 0;
            font-weight: 600;
            word-break: break-all;
        }
        
        .pairing-code {
            font-family: 'Orbitron', monospace;
            font-size: 2rem;
            font-weight: 800;
            letter-spacing: 6px;
            background: linear-gradient(90deg, #ff0080, #00ff88, #8a2be2);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            margin: 16px 0;
            padding: 16px;
            border: 2px dashed var(--glass-border);
            border-radius: 15px;
            word-break: break-all;
        }
        
        .form-group {
            margin: 20px 0;
        }
        
        .form-label {
            display: block;
            margin-bottom: 10px;
            font-weight: 600;
            color: var(--secondary);
            font-size: 0.9rem;
        }
        
        .form-input {
            width: 100%;
            padding: 14px;
            background: rgba(0, 0, 0, 0.4);
            border: 2px solid var(--glass-border);
            border-radius: 12px;
            color: white;
            font-size: 16px;
            transition: all 0.3s ease;
            font-family: 'Exo 2', sans-serif;
            box-sizing: border-box;
        }
        
        .form-input:focus {
            outline: none;
            border-color: var(--primary);
        }
        
        .btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            padding: 14px 24px;
            background: linear-gradient(135deg, var(--primary), var(--primary-dark));
            color: white;
            text-decoration: none;
            border: none;
            cursor: pointer;
            transition: all 0.3s ease;
            font-size: 0.9rem;
            font-family: 'Exo 2', sans-serif;
            width: 100%;
            margin-top: 8px;
            border-radius: 12px;
            font-weight: 600;
        }
        
        .btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 10px 25px rgba(138, 43, 226, 0.4);
        }
        
        .btn-warning {
            background: linear-gradient(135deg, #ff9900, #ff6600);
        }
        
        .info-panel {
            background: var(--glass);
            backdrop-filter: blur(15px);
            border: 1px solid var(--glass-border);
            border-radius: 20px;
            padding: 20px;
        }
        
        .info-section {
            margin-bottom: 24px;
        }
        
        .info-section h3 {
            color: var(--secondary);
            font-family: 'Orbitron', monospace;
            margin-bottom: 16px;
            font-size: 1.1rem;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        
        .contact-list {
            list-style: none;
        }
        
        .contact-item {
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 12px;
            background: rgba(0, 0, 0, 0.3);
            border-radius: 12px;
            margin-bottom: 10px;
            cursor: pointer;
            transition: all 0.3s ease;
        }
        
        .contact-item:hover {
            background: rgba(138, 43, 226, 0.2);
            transform: translateX(5px);
        }
        
        .contact-icon {
            width: 40px;
            height: 40px;
            background: linear-gradient(135deg, var(--primary), var(--accent));
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 18px;
        }
        
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 12px;
        }
        
        .stat-card {
            background: rgba(0, 0, 0, 0.3);
            padding: 16px;
            border-radius: 12px;
            text-align: center;
            border: 1px solid var(--glass-border);
        }
        
        .stat-value {
            font-size: 1.5rem;
            font-weight: 800;
            color: var(--secondary);
            font-family: 'Orbitron', monospace;
        }
        
        .stat-label {
            color: #aaa;
            font-size: 0.7rem;
            margin-top: 4px;
        }
        
        .instructions {
            background: rgba(0, 0, 0, 0.3);
            padding: 16px;
            border-radius: 15px;
            margin-top: 20px;
            border-left: 4px solid var(--primary);
        }
        
        .instructions ol, .instructions ul {
            padding-left: 20px;
            line-height: 1.6;
            font-size: 0.85rem;
        }
        
        .quick-actions {
            display: flex;
            flex-wrap: wrap;
            gap: 10px;
            margin-top: 20px;
        }
        
        .quick-actions .btn {
            flex: 1;
            min-width: 100px;
        }
        
        .footer {
            text-align: center;
            padding: 30px 0 20px;
            margin-top: 40px;
            border-top: 1px solid var(--glass-border);
            color: #aaa;
            font-size: 0.75rem;
        }
        
        .developer-credit {
            font-family: 'Orbitron', monospace;
            font-size: 0.9rem;
            color: var(--secondary);
            margin: 15px 0;
        }
        
        .social-links {
            display: flex;
            justify-content: center;
            gap: 16px;
            margin: 20px 0;
        }
        
        .social-link {
            width: 40px;
            height: 40px;
            background: rgba(0, 0, 0, 0.4);
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
            font-size: 18px;
            transition: all 0.3s ease;
            border: 1px solid var(--glass-border);
            text-decoration: none;
        }
        
        .social-link:hover {
            background: var(--primary);
            transform: translateY(-3px);
        }
        
        .hidden {
            display: none;
        }
        
        @media (min-width: 768px) {
            .container {
                padding: 24px;
            }
            
            .header {
                flex-direction: row;
                justify-content: space-between;
            }
            
            .logo-text h1 {
                font-size: 2rem;
                text-align: left;
            }
            
            .dashboard {
                flex-direction: row;
            }
            
            .auth-panel {
                flex: 2;
                padding: 30px;
            }
            
            .info-panel {
                flex: 1;
                padding: 30px;
            }
            
            .panel-header {
                flex-direction: row;
                justify-content: space-between;
                align-items: center;
            }
            
            .panel-title {
                font-size: 1.5rem;
            }
            
            .qr-image {
                width: 250px;
                height: 250px;
            }
            
            .pairing-code {
                font-size: 2.5rem;
                letter-spacing: 8px;
            }
            
            .method-tab {
                font-size: 1rem;
                padding: 12px 20px;
            }
        }
        
        @media (max-width: 480px) {
            .qr-image {
                width: 180px;
                height: 180px;
            }
            
            .pairing-code {
                font-size: 1.5rem;
                letter-spacing: 3px;
            }
            
            .quick-actions {
                flex-direction: column;
            }
            
            .quick-actions .btn {
                width: 100%;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <header class="header">
            <div class="logo-container">
                <div class="logo"><i class="fas fa-robot"></i></div>
                <div class="logo-text">
                    <h1>DΞSIRΞ-ΞXΞ</h1>
                    <div class="version">VERSION 2.0 • AI WHATSAPP BOT</div>
                </div>
            </div>
            <div class="status-badge ${isConnecting ? 'connecting' : hasQR ? 'qr-pending' : hasPairingCode ? 'pairing-pending' : isConnectedStatus ? 'connected' : 'connecting'}">
                <i class="fas ${isConnecting ? 'fa-sync fa-spin' : hasQR ? 'fa-qrcode' : hasPairingCode ? 'fa-key' : isConnectedStatus ? 'fa-check-circle' : 'fa-sync fa-spin'}"></i>
                ${isConnecting ? 'CONNECTING...' : hasQR ? 'QR CODE READY' : hasPairingCode ? 'PAIRING CODE ACTIVE' : isConnectedStatus ? 'BOT CONNECTED' : 'CONNECTING...'}
            </div>
        </header>
        
        <div class="dashboard">
            <div class="auth-panel">
                <div class="panel-header">
                    <div class="panel-title"><i class="fas fa-lock"></i> AUTHENTICATION</div>
                    <div class="uptime">🕒 ${getUptimeString()}</div>
                </div>
                
                <div class="method-tabs">
                    <div class="method-tab ${!hasPairingCode ? 'active' : ''}" onclick="showMethod('qr')"><i class="fas fa-qrcode"></i> QR Code</div>
                    <div class="method-tab ${hasPairingCode ? 'active' : ''}" onclick="showMethod('pairing')"><i class="fas fa-key"></i> Pairing Code</div>
                </div>
                
                <div id="qrMethod" class="auth-method ${hasPairingCode ? 'hidden' : ''}">
                    ${hasQR ? `
                    <div class="qr-container">
                        <h3><i class="fas fa-mobile-alt"></i> Scan with WhatsApp</h3>
                        <img src="${qrCodeImage}" alt="WhatsApp QR Code" class="qr-image">
                        <p class="countdown">⏰ QR Code expires in 2 minutes</p>
                    </div>
                    <div class="instructions">
                        <h4><i class="fas fa-info-circle"></i> How to Connect</h4>
                        <ol>
                            <li>Open WhatsApp on your mobile device</li>
                            <li>Tap <strong>Settings</strong> → <strong>Linked Devices</strong></li>
                            <li>Tap <strong>Link a Device</strong> or the QR code icon</li>
                            <li>Point your camera at the QR code above</li>
                            <li>Wait for connection confirmation</li>
                        </ol>
                    </div>
                    ` : `<div class="qr-container"><div style="font-size: 3rem; color: var(--primary); margin-bottom: 20px;"><i class="fas fa-qrcode"></i></div><h3>QR Code Not Available</h3><p>QR code will appear when needed for authentication.</p></div>`}
                </div>
                
                <div id="pairingMethod" class="auth-method ${!hasPairingCode ? 'hidden' : ''}">
                    ${hasPairingCode ? `
                    <div class="pairing-code-display">
                        <h3><i class="fas fa-phone-alt"></i> Pairing Code for:</h3>
                        <div class="phone-number">📱 ${pairingPhoneNumber}</div>
                        <div class="pairing-code">${pairingCode}</div>
                        <p class="countdown">⏰ Code expires in <span id="countdown">2:00</span></p>
                    </div>
                    <div class="instructions">
                        <h4><i class="fas fa-info-circle"></i> How to Use Pairing Code</h4>
                        <ol>
                            <li>Open WhatsApp on your mobile device</li>
                            <li>Tap <strong>Settings</strong> → <strong>Linked Devices</strong></li>
                            <li>Tap <strong>Link a Device</strong></li>
                            <li>Tap <strong>Link with phone number</strong></li>
                            <li>Enter the 6-digit code shown above</li>
                            <li>Wait for connection confirmation</li>
                        </ol>
                    </div>
                    ` : `
                    <div style="padding: 20px 0;">
                        <h3 style="text-align: center; margin-bottom: 20px;"><i class="fas fa-key"></i> Generate Pairing Code</h3>
                        ${globalSocket ? `
                        <form id="pairingForm" onsubmit="requestPairingCode(event)">
                            <div class="form-group">
                                <label class="form-label" for="phoneNumber"><i class="fas fa-phone"></i> WhatsApp Number</label>
                                <input type="tel" class="form-input" id="phoneNumber" placeholder="2347017747337" required pattern="^[1-9]\\d{9,14}$" title="Enter phone number without + sign">
                                <small style="color: #aaa; margin-top: 6px; display: block;">Enter without + sign (e.g., 2347017747337)</small>
                            </div>
                            <button type="submit" class="btn btn-warning"><i class="fas fa-key"></i> GENERATE PAIRING CODE</button>
                        </form>
                        ` : `
                        <div style="text-align: center; padding: 30px 20px; background: rgba(255, 0, 0, 0.1); border-radius: 15px;">
                            <div style="font-size: 3rem; color: #ff5555; margin-bottom: 20px;"><i class="fas fa-exclamation-triangle"></i></div>
                            <h3 style="color: #ff5555;">Bot Not Initialized</h3>
                            <p>Please wait for the bot to start or refresh the page.</p>
                            <button onclick="location.reload()" class="btn" style="margin-top: 20px;"><i class="fas fa-sync-alt"></i> Refresh</button>
                        </div>
                        `}
                    </div>
                    `}
                </div>
                
                <div class="quick-actions">
                    <a href="/status" class="btn"><i class="fas fa-chart-line"></i> Status</a>
                    <a href="/dashboard" class="btn"><i class="fas fa-home"></i> Dashboard</a>
                    ${hasQR || hasPairingCode ? '<a href="/auth" class="btn"><i class="fas fa-sync-alt"></i> Refresh</a>' : ''}
                </div>
            </div>
            
            <div class="info-panel">
                <div class="info-section">
                    <h3><i class="fas fa-user-circle"></i> DEVELOPER CONTACT</h3>
                    <ul class="contact-list">
                        <li class="contact-item" onclick="window.location.href='tel:+2347017747337'">
                            <div class="contact-icon"><i class="fas fa-phone"></i></div>
                            <div><h4>Phone Number</h4><p>+234 701 774 7337</p></div>
                        </li>
                        <li class="contact-item" onclick="window.open('https://whatsapp.com/channel/0029Vb5qsDv9cDDa98iVoC2H', '_blank')">
                            <div class="contact-icon"><i class="fab fa-whatsapp"></i></div>
                            <div><h4>WhatsApp Channel</h4><p>Latest Updates</p></div>
                        </li>
                        <li class="contact-item" onclick="window.open('https://chat.whatsapp.com/KjKvZwuJmGx2RpmhIM9SkS', '_blank')">
                            <div class="contact-icon"><i class="fas fa-users"></i></div>
                            <div><h4>Support Group</h4><p>Join Community</p></div>
                        </li>
                    </ul>
                </div>
                
                <div class="info-section">
                    <h3><i class="fas fa-chart-bar"></i> BOT STATISTICS</h3>
                    <div class="stats-grid">
                        <div class="stat-card">
                            <div class="stat-value">${contactList.length}</div>
                            <div class="stat-label">Contacts</div>
                        </div>
                        <div class="stat-card">
                            <div class="stat-value">${getUptimeString()}</div>
                            <div class="stat-label">Uptime</div>
                        </div>
                    </div>
                </div>
                
                <div class="info-section">
                    <h3><i class="fas fa-lightbulb"></i> Authentication Tips</h3>
                    <div class="instructions">
                        <ul>
                            <li style="margin: 8px 0;"><i class="fas fa-qrcode" style="color: var(--primary); margin-right: 8px;"></i> <strong>QR Code:</strong> Quick first-time setup</li>
                            <li style="margin: 8px 0;"><i class="fas fa-key" style="color: var(--secondary); margin-right: 8px;"></i> <strong>Pairing Code:</strong> Alternative method</li>
                            <li style="margin: 8px 0;"><i class="fas fa-random" style="color: var(--accent); margin-right: 8px;"></i> <strong>Flexible:</strong> Use either method</li>
                        </ul>
                    </div>
                </div>
            </div>
        </div>
        
        <footer class="footer">
            <div class="social-links">
                <a href="https://whatsapp.com/channel/0029Vb5qsDv9cDDa98iVoC2H" target="_blank" class="social-link"><i class="fab fa-whatsapp"></i></a>
                <a href="tel:+2347017747337" class="social-link"><i class="fas fa-phone"></i></a>
            </div>
            <div class="developer-credit">♠ 《 DΞSIRΞ-ΞXΞ V2.0 》 ♠</div>
            <div><p>Developed with ❤️ by <strong>Desire-eXe</strong></p><p>© ${new Date().getFullYear()} All Rights Reserved</p></div>
        </footer>
    </div>
    
    <script>
        function showMethod(method) {
            document.getElementById('qrMethod').classList.toggle('hidden', method !== 'qr');
            document.getElementById('pairingMethod').classList.toggle('hidden', method !== 'pairing');
            document.querySelectorAll('.method-tab').forEach(tab => {
                tab.classList.toggle('active',
                    (method === 'qr' && tab.textContent.includes('QR')) ||
                    (method === 'pairing' && tab.textContent.includes('Pairing'))
                );
            });
        }
        
        async function requestPairingCode(event) {
            event.preventDefault();
            const phoneNumber = document.getElementById('phoneNumber').value;
            const button = event.target.querySelector('button') || event.target;
            const originalText = button.innerHTML;
            button.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Generating...';
            button.disabled = true;
            
            try {
                const response = await fetch('/auth/pairing', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ phoneNumber })
                });
                const result = await response.json();
                
                if (result.success) {
                    button.innerHTML = '<i class="fas fa-check"></i> Code Generated!';
                    button.style.background = 'linear-gradient(135deg, #00cc66, #00994d)';
                    setTimeout(() => { location.reload(); }, 1500);
                } else {
                    alert('❌ Error: ' + (result.error || 'Failed to generate code') + '\\n\\n💡 ' + (result.suggestion || 'Try QR code first'));
                    button.innerHTML = originalText;
                    button.disabled = false;
                }
            } catch (error) {
                alert('⚠️ Network Error: ' + error.message);
                button.innerHTML = originalText;
                button.disabled = false;
            }
        }
        
        ${hasPairingCode ? `
        let timeLeft = 120;
        const countdownElement = document.getElementById('countdown');
        const countdown = setInterval(() => {
            timeLeft--;
            const minutes = Math.floor(timeLeft / 60);
            const seconds = timeLeft % 60;
            countdownElement.textContent = minutes + ':' + seconds.toString().padStart(2, '0');
            if (timeLeft <= 0) { clearInterval(countdown); location.reload(); }
        }, 1000);
        ` : ''}
        
        window.addEventListener('load', () => { 
            ${hasPairingCode ? "showMethod('pairing');" : "showMethod('qr');"} 
        });
    </script>
</body>
</html>`;
}

// Export
module.exports = {
  startBot,
  getAuthPage,
  getQRCode: () => ({
    qrCode,
    qrCodeImage,
    isConnected,
    pairingCode,
    pairingPhoneNumber,
    pairingCodeExpiry,
    botStatus: global.botStatus,
    uptime: getUptimeString()
  }),
  requestPairingCode,
  getUptimeString,
  getBotStatus: () => global.botStatus || 'unknown',
  getIsConnected: () => isConnected,
  clearSession: () => {
    if (fs.existsSync(AUTH_DIR)) {
      try {
        fs.rmSync(AUTH_DIR, { recursive: true });
        globalSocket = null;
        stopKeepAlive();
        console.log('✅ Session cleared successfully');
        return true;
      } catch (e) {
        console.error('❌ Failed to clear session:', e);
        return false;
      }
    }
    return false;
  }
};