// =====================================================
// EnviroVoice Server v3.1
// =====================================================

const express = require('express');
const http    = require('http');
const { WebSocketServer } = require('ws');
const path    = require('path');
const axios   = require('axios');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server, maxPayload: 64 * 1024 }); // 64KB max message

// ── CORS ──────────────────────────────────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..')));

// ── STATE ─────────────────────────────────────────────
let minecraftData = null;
const clients              = new Map(); // ws → { gamertag }
const gamertagIndex        = new Map(); // gamertag → ws  (O(1) lookup)
const pttStates            = new Map(); // gamertag → { isTalking, isMuted }
const voiceDetectionStates = new Map(); // gamertag → { isTalking, volume }

// ── HELPERS ───────────────────────────────────────────
function isGamertagTaken(gamertag) {
  return gamertagIndex.has(gamertag);
}

function sendJSON(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

// Send to everyone except optional excludeWs
function broadcast(message, excludeWs = null) {
  const str = JSON.stringify(message);
  wss.clients.forEach(client => {
    if (client !== excludeWs && client.readyState === 1)
      client.send(str);
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
  const payload = buildMinecraftPayload();
  broadcast(payload);
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

app.get('/ptt-states', (req, res) => {
  res.json({ pttStates: Array.from(pttStates.entries()).map(([g, s]) => ({ gamertag: g, ...s })) });
});

app.get('/voice-states', (req, res) => {
  res.json({ voiceStates: Array.from(voiceDetectionStates.entries()).map(([g, s]) => ({ gamertag: g, ...s })) });
});

// ── REST: Gamertag validation (with timeout) ──────────
app.get('/gamertag/:tag', async (req, res) => {
  const tag = req.params.tag;
  try {
    const { data: html } = await axios.get(
      `https://xboxgamertag.com/search/${encodeURIComponent(tag)}`,
      { timeout: 5000 } // 5 second timeout — was missing before
    );
    res.json({ gamertag: tag, exists: html.includes('Gamerscore') });
  } catch (err) {
    res.status(500).json({ error: 'Verification failed', message: err.message });
  }
});

// ── WEBSOCKET ─────────────────────────────────────────
wss.on('connection', (ws) => {
  console.log('🔌 Client connected');

  // Rate limiting: max 60 messages per second per client
  let msgCount = 0;
  const rateLimitInterval = setInterval(() => { msgCount = 0; }, 1000);

  if (minecraftData) sendJSON(ws, buildMinecraftPayload());

  ws.on('message', (raw) => {
    // Rate limit check
    if (++msgCount > 60) return;

    let data;
    try { data = JSON.parse(raw.toString()); }
    catch { return; }

    // ─── JOIN ───────────────────────────────────────
    if (data.type === 'join') {
      if (!data.gamertag || typeof data.gamertag !== 'string') return;
      const gamertag = data.gamertag.trim().slice(0, 64);

      if (isGamertagTaken(gamertag)) {
        sendJSON(ws, { type: 'error', message: 'Gamertag already in use.' });
        ws.close();
        return;
      }

      clients.set(ws, { gamertag });
      gamertagIndex.set(gamertag, ws);
      pttStates.set(gamertag,            { isTalking: true,  isMuted: false });
      voiceDetectionStates.set(gamertag, { isTalking: false, volume: 0 });

      console.log(`👤 ${gamertag} joined (${clients.size} total)`);

      // Tell others someone joined
      broadcast({ type: 'join', gamertag }, ws);

      // Send the full participant list only to the new joiner
      sendJSON(ws, { type: 'participants-list', list: getParticipantsList() });
      return;
    }

    // ─── LEAVE ──────────────────────────────────────
    if (data.type === 'leave') {
      _handleLeave(ws);
      return;
    }

    // ─── VOICE DETECTION ────────────────────────────
    if (data.type === 'voice-detection') {
      const clientData = clients.get(ws);
      if (!clientData) return;
      voiceDetectionStates.set(clientData.gamertag, {
        isTalking: !!data.isTalking,
        volume:    typeof data.volume === 'number' ? data.volume : 0,
      });
      // No broadcast here — Minecraft plugin picks it up on next POST
      return;
    }

    // ─── PTT STATUS ─────────────────────────────────
    if (data.type === 'ptt-status') {
      const clientData = clients.get(ws);
      if (!clientData) return;
      const { gamertag } = clientData;
      pttStates.set(gamertag, { isTalking: !!data.isTalking, isMuted: !!data.isMuted });
      broadcast({ type: 'ptt-update', gamertag, isTalking: !!data.isTalking, isMuted: !!data.isMuted });
      return;
    }

    // ─── WEBRTC SIGNALING ───────────────────────────
    if (['offer', 'answer', 'ice-candidate'].includes(data.type)) {
      if (!data.to || !data.from) return;
      // O(1) lookup via index instead of O(n) loop
      const targetWs = gamertagIndex.get(data.to);
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
      // Only send to the requester — no need to broadcast to everyone
      sendJSON(ws, { type: 'participants-list', list: getParticipantsList() });
      return;
    }

    console.warn(`⚠️ Unknown message type: ${data.type}`);
  });

  ws.on('close', () => {
    clearInterval(rateLimitInterval);
    _handleLeave(ws);
  });

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
  gamertagIndex.delete(gamertag);
  pttStates.delete(gamertag);
  voiceDetectionStates.delete(gamertag);

  console.log(`👋 ${gamertag} left (${clients.size} remaining)`);

  // Tell everyone else, with updated list
  broadcast({ type: 'leave', gamertag });
}

// ── GRACEFUL SHUTDOWN ─────────────────────────────────
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down...');
  broadcast({ type: 'server-shutdown' });
  wss.clients.forEach(c => c.close());
  server.close(() => { console.log('✅ Server closed'); process.exit(0); });
});

// ── START ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 EnviroVoice Server v3.1`);
  console.log(`🌐 HTTP/WS  → http://localhost:${PORT}`);
  console.log(`🎮 Minecraft → POST /minecraft-data`);
  console.log(`💚 Health   → GET  /health`);
  console.log(`🎙️ PTT      → GET  /ptt-states`);
  console.log(`🎤 Voice    → GET  /voice-states`);
});
