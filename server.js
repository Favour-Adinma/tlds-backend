/**
 * TLDS LIVE — Backend API Server
 * Express + WebSocket for real-time updates
 * Deploy to: Render (free tier) or Railway
 */
require('dotenv').config();

const express   = require('express');
const cors      = require('cors');
const http      = require('http');
const { WebSocketServer } = require('ws');
const { v4: uuid } = require('uuid');
const db        = require('./db');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

const PORT         = process.env.PORT || 3001;
const FRONTEND_URL = process.env.FRONTEND_URL || '*';

// ─── Middleware ──────────────────────────────
app.use(cors({ origin: FRONTEND_URL, credentials: true }));
app.use(express.json());

app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ════════════════════════════════════════════
//  WebSocket — real-time broadcast
// ════════════════════════════════════════════
const clients = new Map();

wss.on('connection', (ws) => {
  const socketId = uuid();
  clients.set(socketId, { ws, userId: null });

  ws.on('message', (raw) => {
    try {
      const { type, payload } = JSON.parse(raw);
      if (type === 'identify') {
        const entry = clients.get(socketId);
        if (entry) { entry.userId = payload.userId; clients.set(socketId, entry); }
      }
    } catch (e) {}
  });

  ws.on('close', () => {
    const entry = clients.get(socketId);
    if (entry && entry.userId) {
      db.removeOnline(entry.userId);
      broadcast({ type: 'presence', payload: { online: db.getOnline() } });
    }
    clients.delete(socketId);
  });

  ws.send(JSON.stringify({
    type: 'init',
    payload: { meeting: db.getMeeting(), online: db.getOnline(), messages: db.getMessages() },
  }));
});

function broadcast(data) {
  const payload = JSON.stringify(data);
  clients.forEach(({ ws }) => { if (ws.readyState === 1) ws.send(payload); });
}

app.locals.broadcast = broadcast;

// ════════════════════════════════════════════
//  REST API Routes
// ════════════════════════════════════════════

app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));
app.get('/api/meeting', (_req, res) => res.json(db.getMeeting()));
app.get('/api/presence', (_req, res) => res.json({ online: db.getOnline(), count: db.getOnline().length }));
app.get('/api/messages', (_req, res) => res.json({ messages: db.getMessages() }));
app.get('/api/stats', (_req, res) => res.json({
  registeredUsers: db.getUsers().length,
  onlineNow: db.getOnline().length,
  totalMessages: db.getMessages().length,
  meeting: db.getMeeting(),
}));

app.post('/api/users/register', (req, res) => {
  const { name, email, phone, location } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'name and email required' });
  if (!email.includes('@')) return res.status(400).json({ error: 'invalid email' });
  const existing = db.getUserByEmail(email);
  if (existing) return res.json({ user: existing, isNew: false });
  const user = db.createUser({ name, email, phone, location });
  notifyBotNewUser(user);
  res.status(201).json({ user, isNew: true });
});

app.post('/api/users/login', (req, res) => {
  const user = db.getUserByEmail(req.body.email || '');
  if (!user) return res.status(404).json({ error: 'user not found' });
  res.json({ user });
});

app.post('/api/presence/join', (req, res) => {
  const user = db.getUserById(req.body.userId);
  if (!user) return res.status(404).json({ error: 'user not found' });
  db.addOnline(user);
  const online = db.getOnline();
  broadcast({ type: 'presence', payload: { online } });
  notifyBotUserJoined(user, online.length);
  res.json({ online });
});

app.post('/api/presence/leave', (req, res) => {
  db.removeOnline(req.body.userId);
  const online = db.getOnline();
  broadcast({ type: 'presence', payload: { online } });
  res.json({ online });
});

app.get('/api/users', (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.JWT_SECRET) return res.status(401).json({ error: 'unauthorized' });
  res.json({ users: db.getUsers(), count: db.getUsers().length });
});

app.post('/api/messages', (req, res) => {
  const { userId, text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'text required' });
  const user = db.getUserById(userId);
  if (!user) return res.status(404).json({ error: 'user not found' });
  const msg = db.addMessage({ name: user.name, text: text.trim() });
  broadcast({ type: 'message', payload: msg });
  notifyBotChatMessage(user, text.trim());
  res.status(201).json({ message: msg });
});

app.post('/api/admin/meeting', (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.JWT_SECRET) return res.status(401).json({ error: 'unauthorized' });
  const { isLive, streamUrl, title } = req.body;
  const meeting = db.setMeeting({ isLive: !!isLive, streamUrl: streamUrl || '', title: title || db.getMeeting().title, startedAt: isLive ? new Date().toISOString() : null });
  broadcast({ type: 'meeting', payload: meeting });
  res.json({ meeting });
});

app.post('/api/admin/broadcast', (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.JWT_SECRET) return res.status(401).json({ error: 'unauthorized' });
  const { text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'text required' });
  const msg = db.addMessage({ name: 'TLDS Host', text: text.trim(), isHost: true });
  broadcast({ type: 'message', payload: msg });
  res.status(201).json({ message: msg });
});

// ════════════════════════════════════════════
//  Telegram Bot notifications
// ════════════════════════════════════════════
const TelegramBot = (() => {
  try {
    const Bot = require('node-telegram-bot-api');
    if (!process.env.TELEGRAM_BOT_TOKEN) return null;
    return new Bot(process.env.TELEGRAM_BOT_TOKEN, { polling: false });
  } catch { return null; }
})();

const ADMIN_ID = process.env.ADMIN_TELEGRAM_ID;

async function sendAdmin(text) {
  if (!TelegramBot || !ADMIN_ID) return;
  try { await TelegramBot.sendMessage(ADMIN_ID, text, { parse_mode: 'HTML' }); }
  catch (e) { console.error('[Bot notify]', e.message); }
}

function notifyBotNewUser(user) {
  sendAdmin(
    `🌱 <b>New registration!</b>\n` +
    `👤 <b>${user.name}</b>\n` +
    `📧 ${user.email}\n` +
    `📱 ${user.phone || '—'}\n` +
    `📍 ${user.location || '—'}\n` +
    `📊 Total registered: <b>${db.getUsers().length}</b>`
  );
}

function notifyBotUserJoined(user, onlineCount) {
  sendAdmin(
    `🟢 <b>${user.name}</b> joined the live stream\n` +
    `👥 Now online: <b>${onlineCount}</b>`
  );
}

function notifyBotChatMessage(user, text) {
  sendAdmin(
    `💬 <b>${user.name}</b>:\n"${text}"\n\n` +
    `<i>Reply to this message in the TLDS bot to respond on the website</i>`
  );
}

// ─── Start ───────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🌳 TLDS LIVE Backend running on port ${PORT}`);
  console.log(`   WebSocket: ws://localhost:${PORT}`);
  console.log(`   REST API:  http://localhost:${PORT}/api`);
  console.log(`   Telegram:  ${TelegramBot ? '✅ connected' : '⚠️  not configured'}`);
  console.log(`   Admin ID:  ${ADMIN_ID || '⚠️  not configured'}\n`);
});

module.exports = { app, broadcast };
