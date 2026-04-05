// =====================================================
// EnviroVoice Server v3.0
// =====================================================

const express = require('express');
const http    = require('http');
const { WebSocketServer } = require('ws');
const path    = require('path');
const axios   = require('axios');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

// ── CORS ──────────────────────────────────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());
app.use(express.static(path.join(__dirname, '..')));

// ── STATE ─────────────────────────────────────────────
let minecraftData = null;
const clients             = new Map(); // ws → { gamertag }
const pttStates           = new Map(); // gamertag → { isTalking, isMuted }
const voiceDetectionStates = new Map(); // gamertag → { isTalking, volume }

// ── HELPERS ───────────────────────────────────────────
function isGamertagTaken(gamertag) {
  for (const [, data] of clients) {
    if (data.gamertag === gamertag) return true;
  }
  return false;
}

function broadcast(senderWs, message) {
  wss.clients.forEach(client => {
    if (client !== senderWs && client.readyState === 1)
      client.send(JSON.stringify(message));
  });
}

function broadcastToAll(message) {
  wss.clients.forEach(client => {
    if (client.readyState === 1)
      client.send(JSON.stringify(message));
  });
}

function getParticipantsList() {
  return Array.from(clients.values()).map(c => c.gamertag);
}

function buildMinecraftPayload() {
  return {
    type: 'minecraft-update',
    data: minecraftData,
    muteStates: (minecraftData?.players || []).map(p => ({
      gamertag:   p.name,
      isMuted:    p.data?.isMuted    || false,
      isDeafened: p.data?.isDeafened || false,
      micVolume:  p.data?.micVolume  ?? 1.0,
    })),
    pttStates: Array.from(pttStates.entries()).map(([gamertag, s]) => ({ gamertag, ...s })),
    voiceStates: Array.from(voiceDetectionStates.entries()).map(([gamertag, s]) => ({
      gamertag,
      isTalking: s.isTalking,
      volume:    s.volume,
    })),
  };
}

// ── REST: Minecraft data push ─────────────────────────
app.post('/minecraft-data', (req, res) => {
  minecraftData = req.body;
  console.log('📦 Minecraft data received');

  const payload = buildMinecraftPayload();
  broadcastToAll(payload);

  res.json({
    success: true,
    pttStates:   payload.pttStates,
    voiceStates: payload.voiceStates,
  });
});

// ── REST: Health ──────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status:              'ok',
    connected_users:     clients.size,
    minecraft_data:      !!minecraftData,
    ptt_active_users:    pttStates.size,
    voice_detect_users:  voiceDetectionStates.size,
    uptime:              process.uptime(),
  });
});

// ── REST: PTT states ──────────────────────────────────
app.get('/ptt-states', (req, res) => {
  const states = Array.from(pttStates.entries()).map(([gamertag, s]) => ({ gamertag, ...s }));
  res.json({ pttStates: states });
});

// ── REST: Voice states ────────────────────────────────
app.get('/voice-states', (req, res) => {
  const states = Array.from(voiceDetectionStates.entries()).map(([gamertag, s]) => ({ gamertag, ...s }));
  res.json({ voiceStates: states });
});

// ── REST: Gamertag validation ─────────────────────────
app.get('/gamertag/:tag', async (req, res) => {
  const tag = req.params.tag;
  try {
    const { data: html } = await axios.get(`https://xboxgamertag.com/search/${encodeURIComponent(tag)}`);
    res.json({ gamertag: tag, exists: html.includes('Gamerscore') });
  } catch (err) {
    res.status(500).json({ error: 'Verification failed', message: err.message });
  }
});

// ── WEBSOCKET ─────────────────────────────────────────
wss.on('connection', (ws) => {
  console.log('🔌 Client connected');

  // Send current Minecraft state if available
  if (minecraftData) {
    ws.send(JSON.stringify(buildMinecraftPayload()));
  }

  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw.toString()); }
    catch { return; }

    // ─── JOIN ───────────────────────────────────────
    if (data.type === 'join') {
      if (isGamertagTaken(data.gamertag)) {
        ws.send(JSON.stringify({ type: 'error', message: 'Gamertag already in use. Choose a different one.' }));
        ws.close();
        return;
      }

      clients.set(ws, { gamertag: data.gamertag });
      pttStates.set(data.gamertag,            { isTalking: true,  isMuted: false });
      voiceDetectionStates.set(data.gamertag, { isTalking: false, volume: 0 });

      console.log(`👤 ${data.gamertag} joined (${clients.size} total)`);

      broadcast(ws, { type: 'join', gamertag: data.gamertag });

      const list = getParticipantsList();
      ws.send(JSON.stringify({ type: 'participants-list', list }));
      broadcast(ws, { type: 'participants-list', list });
      return;
    }

    // ─── LEAVE ──────────────────────────────────────
    if (data.type === 'leave') {
      _handleLeave(ws);
      return;
    }

    // ─── VOICE DETECTION ────────────────────────────
    if (data.type === 'voice-detection') {
      voiceDetectionStates.set(data.gamertag, {
        isTalking: data.isTalking,
        volume:    data.volume || 0,
      });
      // Minecraft plugin will pick this up on the next POST
      return;
    }

    // ─── PTT STATUS ─────────────────────────────────
    if (data.type === 'ptt-status') {
      pttStates.set(data.gamertag, { isTalking: data.isTalking, isMuted: data.isMuted });
      console.log(`🎙️ PTT: ${data.gamertag} → ${data.isTalking ? 'TALKING' : 'MUTED'}`);
      broadcastToAll({ type: 'ptt-update', gamertag: data.gamertag, isTalking: data.isTalking, isMuted: data.isMuted });
      return;
    }

    // ─── WEBRTC SIGNALING ───────────────────────────
    if (['offer', 'answer', 'ice-candidate'].includes(data.type)) {
      if (!data.to || !data.from) return;
      let targetWs = null;
      for (const [clientWs, d] of clients) {
        if (d.gamertag === data.to) { targetWs = clientWs; break; }
      }
      if (targetWs?.readyState === 1) {
        targetWs.send(JSON.stringify(data));
        if (data.type !== 'ice-candidate') console.log(`📨 ${data.type}: ${data.from} → ${data.to}`);
      } else {
        console.warn(`⚠️ Recipient not found: ${data.to}`);
      }
      return;
    }

    // ─── HEARTBEAT ──────────────────────────────────
    if (data.type === 'heartbeat') return;

    // ─── REQUEST PARTICIPANTS ───────────────────────
    if (data.type === 'request-participants') {
      const list = getParticipantsList();
      ws.send(JSON.stringify({ type: 'participants-list', list }));
      broadcastToAll({ type: 'participants-list', list });
      return;
    }

    console.warn(`⚠️ Unknown message type: ${data.type}`);
  });

  ws.on('close', () => _handleLeave(ws));

  ws.on('error', (err) => {
    const d = clients.get(ws);
    console.error(`❌ WS error for ${d?.gamertag || 'unknown'}:`, err.message);
  });
});

function _handleLeave(ws) {
  const clientData = clients.get(ws);
  if (!clientData) return;

  const { gamertag } = clientData;
  clients.delete(ws);
  pttStates.delete(gamertag);
  voiceDetectionStates.delete(gamertag);

  console.log(`👋 ${gamertag} left (${clients.size} remaining)`);

  broadcast(ws, { type: 'leave', gamertag });

  const list = getParticipantsList();
  broadcastToAll({ type: 'participants-list', list });
}

// ── GRACEFUL SHUTDOWN ─────────────────────────────────
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down...');
  broadcastToAll({ type: 'server-shutdown' });
  wss.clients.forEach(c => c.close());
  server.close(() => { console.log('✅ Server closed'); process.exit(0); });
});

// ── START ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 EnviroVoice Server v3.0`);
  console.log(`🌐 HTTP/WS  → http://localhost:${PORT}`);
  console.log(`🎮 Minecraft → POST /minecraft-data`);
  console.log(`💚 Health   → GET  /health`);
  console.log(`🎙️ PTT      → GET  /ptt-states`);
  console.log(`🎤 Voice    → GET  /voice-states`);
});
