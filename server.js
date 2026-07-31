require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const { WebSocketServer } = require('ws');
const { v4: uuid } = require('uuid');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/room' });

const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'tlds_secret_change_this';
const FRONTEND = process.env.FRONTEND_URL || '*';

// ── Storage ──
const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
[DATA_DIR, UPLOADS_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, {recursive:true}); });

const upload = multer({ dest: UPLOADS_DIR, limits: { fileSize: 500*1024*1024 } });

// ── Simple JSON DB ──
function dbPath(name) { return path.join(DATA_DIR, name+'.json'); }
function dbRead(name) {
  try { return JSON.parse(fs.readFileSync(dbPath(name),'utf8')); } catch { return []; }
}
function dbWrite(name, data) { fs.writeFileSync(dbPath(name), JSON.stringify(data, null, 2)); }

// ── Middleware ──
app.use(cors({ origin: FRONTEND, credentials: true }));
app.use(express.json({ limit: '50mb' }));
app.use('/uploads', express.static(UPLOADS_DIR));

// ── Auth middleware ──
function auth(req, res, next) {
  const token = (req.headers.authorization||'').replace('Bearer ','');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
}
function adminOnly(req, res, next) {
  auth(req, res, () => {
    if (req.user.role !== 'admin' && req.user.role !== 'host') return res.status(403).json({ error: 'Forbidden' });
    next();
  });
}

// ── Email ──
const mailer = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: 587, secure: false,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
});

async function sendEmail(to, subject, html) {
  if (!process.env.SMTP_USER) return; // skip if not configured
  try {
    await mailer.sendMail({ from: `TLDS LIVE <${process.env.SMTP_USER}>`, to, subject, html });
  } catch(e) { console.error('[Email]', e.message); }
}

async function sendMeetingReminder(meeting, hoursLeft) {
  const users = dbRead('users');
  const html = `
    <div style="font-family:Inter,sans-serif;max-width:500px;margin:0 auto">
      <div style="background:#1a4a2e;padding:20px;border-radius:12px 12px 0 0;text-align:center">
        <h2 style="color:#fff;margin:0;font-size:1.4rem">🌳 TLDS LIVE</h2>
      </div>
      <div style="background:#f8fdf9;padding:28px;border-radius:0 0 12px 12px;border:1px solid #c2dece">
        <h3 style="color:#1a4a2e">Meeting Reminder</h3>
        <p style="color:#5a7a65">Your meeting starts in <strong>${hoursLeft} hour${hoursLeft>1?'s':''}</strong>:</p>
        <div style="background:#fff;border:1.5px solid #c2dece;border-radius:10px;padding:16px;margin:16px 0">
          <strong style="color:#1a4a2e;font-size:1.1rem">${meeting.title}</strong><br/>
          <span style="color:#5a7a65;font-size:.9rem">${new Date(meeting.scheduledAt).toLocaleString('en-GB',{weekday:'long',day:'numeric',month:'long',hour:'2-digit',minute:'2-digit'})}</span>
        </div>
        <a href="${FRONTEND}" style="display:inline-block;background:#1a4a2e;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">Join Meeting</a>
        <p style="color:#5a7a65;font-size:.8rem;margin-top:20px">God bless you! — Tree of Life Discipleship School</p>
      </div>
    </div>`;
  for (const user of users) {
    await sendEmail(user.email, `Reminder: "${meeting.title}" starts in ${hoursLeft} hour${hoursLeft>1?'s':''}`, html);
  }
}

// ══════════════════════════════════════════
// AUTH ROUTES
// ══════════════════════════════════════════
app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/api/auth/register', async (req, res) => {
  const { name, email, password, phone, location } = req.body;
  if (!name||!email||!password) return res.status(400).json({ error: 'Name, email and password required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password too short' });
  const users = dbRead('users');
  if (users.find(u => u.email === email.toLowerCase())) return res.status(400).json({ error: 'Email already registered' });
  const hashed = await bcrypt.hash(password, 12);
  const isFirst = users.length === 0;
  const user = { id: uuid(), name, email: email.toLowerCase(), password: hashed, phone: phone||'', location: location||'', role: isFirst?'admin':'member', createdAt: new Date().toISOString() };
  users.push(user);
  dbWrite('users', users);
  const token = jwt.sign({ id: user.id, role: user.role, name: user.name }, JWT_SECRET, { expiresIn: '30d' });
  const { password: _, ...safeUser } = user;
  // Welcome email
  await sendEmail(user.email, 'Welcome to TLDS LIVE! 🌳', `<p>Hi ${name.split(' ')[0]},</p><p>Welcome to Tree of Life Discipleship School Live platform! You're all set to join our weekly meetings.</p><p>God bless you! 🙏</p>`);
  res.status(201).json({ user: safeUser, token });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const users = dbRead('users');
  const user = users.find(u => u.email === email?.toLowerCase());
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
  const token = jwt.sign({ id: user.id, role: user.role, name: user.name }, JWT_SECRET, { expiresIn: '30d' });
  const { password: _, ...safeUser } = user;
  res.json({ user: safeUser, token });
});

// ══════════════════════════════════════════
// MEETINGS
// ══════════════════════════════════════════
app.get('/api/meetings', (_req, res) => {
  const meetings = dbRead('meetings');
  res.json({ meetings: meetings.sort((a,b) => new Date(b.scheduledAt)-new Date(a.scheduledAt)) });
});

app.post('/api/meetings', adminOnly, async (req, res) => {
  const { title, description, scheduledAt, duration } = req.body;
  if (!title||!scheduledAt) return res.status(400).json({ error: 'Title and date required' });
  const meeting = { _id: uuid(), title, description: description||'', scheduledAt, duration: duration||'', status: 'upcoming', createdAt: new Date().toISOString(), canvas: '', chatHistory: [] };
  const meetings = dbRead('meetings');
  meetings.push(meeting);
  dbWrite('meetings', meetings);
  // Schedule reminders
  const meetingTime = new Date(scheduledAt).getTime();
  const oneDayBefore = meetingTime - 24*60*60*1000;
  const oneHourBefore = meetingTime - 60*60*1000;
  const now = Date.now();
  if (oneDayBefore > now) setTimeout(() => sendMeetingReminder(meeting, 24), oneDayBefore - now);
  if (oneHourBefore > now) setTimeout(() => sendMeetingReminder(meeting, 1), oneHourBefore - now);
  res.status(201).json({ meeting });
});

app.post('/api/meetings/:id/start', adminOnly, (req, res) => {
  const meetings = dbRead('meetings');
  const idx = meetings.findIndex(m => m._id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  meetings[idx].status = 'live';
  meetings[idx].startedAt = new Date().toISOString();
  dbWrite('meetings', meetings);
  // Notify all room participants via WS
  broadcastToRoom(req.params.id, { type: 'meeting_started', payload: {} });
  res.json({ meeting: meetings[idx] });
});

app.post('/api/meetings/:id/end', adminOnly, (req, res) => {
  const meetings = dbRead('meetings');
  const idx = meetings.findIndex(m => m._id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  meetings[idx].status = 'ended';
  meetings[idx].endedAt = new Date().toISOString();
  dbWrite('meetings', meetings);
  res.json({ meeting: meetings[idx] });
});

app.post('/api/meetings/:id/canvas', auth, (req, res) => {
  const meetings = dbRead('meetings');
  const idx = meetings.findIndex(m => m._id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  meetings[idx].canvas = req.body.content || '';
  dbWrite('meetings', meetings);
  res.json({ ok: true });
});

app.get('/api/meetings/:id/canvas', auth, (req, res) => {
  const meetings = dbRead('meetings');
  const meeting = meetings.find(m => m._id === req.params.id);
  if (!meeting) return res.status(404).json({ error: 'Not found' });
  res.json({ content: meeting.canvas || '' });
});

app.get('/api/meetings/:id/chat', auth, (req, res) => {
  const meetings = dbRead('meetings');
  const meeting = meetings.find(m => m._id === req.params.id);
  if (!meeting) return res.status(404).json({ error: 'Not found' });
  res.json({ messages: meeting.chatHistory || [] });
});

app.post('/api/meetings/:id/chat', auth, (req, res) => {
  const meetings = dbRead('meetings');
  const idx = meetings.findIndex(m => m._id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const msg = { ...req.body, id: uuid(), savedAt: new Date().toISOString() };
  if (!meetings[idx].chatHistory) meetings[idx].chatHistory = [];
  meetings[idx].chatHistory.push(msg);
  dbWrite('meetings', meetings);
  broadcastToRoom(req.params.id, { type: 'chat', payload: msg });
  res.status(201).json({ message: msg });
});

app.post('/api/meetings/:id/mute', adminOnly, (req, res) => {
  broadcastToRoom(req.params.id, { type: 'muted', payload: { userId: req.body.userId } });
  res.json({ ok: true });
});

// ══════════════════════════════════════════
// RECORDINGS
// ══════════════════════════════════════════
app.post('/api/recordings', auth, upload.single('audio'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const recordings = dbRead('recordings');
  const rec = {
    id: uuid(),
    meetingId: req.body.meetingId,
    title: req.body.title || 'Meeting Recording',
    recordedAt: req.body.recordedAt || new Date().toISOString(),
    url: '/uploads/'+req.file.filename,
    size: (req.file.size/1024/1024).toFixed(1)+' MB',
    uploadedBy: req.user.id,
  };
  recordings.push(rec);
  dbWrite('recordings', recordings);
  res.status(201).json({ recording: rec });
});

app.get('/api/recordings', auth, (req, res) => {
  const recordings = dbRead('recordings');
  const limit = req.query.limit ? parseInt(req.query.limit) : recordings.length;
  res.json({ recordings: recordings.slice(-limit).reverse() });
});

// ══════════════════════════════════════════
// ADMIN
// ══════════════════════════════════════════
app.get('/api/admin/stats', adminOnly, (req, res) => {
  const users = dbRead('users').map(u => { const {password,...safe}=u; return safe; });
  const meetings = dbRead('meetings');
  const recordings = dbRead('recordings');
  res.json({ users: users.length, meetings: meetings.length, recordings: recordings.length, userList: users });
});

// ══════════════════════════════════════════
// WEBSOCKET — Room signaling
// ══════════════════════════════════════════
const rooms = new Map(); // roomId → Map(socketId → {ws, user})

function broadcastToRoom(roomId, data) {
  const room = rooms.get(roomId);
  if (!room) return;
  const payload = JSON.stringify(data);
  room.forEach(({ ws }) => { if (ws.readyState === 1) ws.send(payload); });
}

function getRoomParticipants(roomId) {
  const room = rooms.get(roomId);
  if (!room) return [];
  return Array.from(room.values()).map(c => ({
    userId: c.user.userId, name: c.user.name, role: c.user.role,
    muted: c.muted || false, speaking: c.speaking || false
  }));
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const roomId = url.pathname.replace('/room/','');
  const socketId = uuid();

  if (!rooms.has(roomId)) rooms.set(roomId, new Map());
  const room = rooms.get(roomId);

  let clientData = { ws, user: null, muted: false, speaking: false };

  ws.on('message', (raw) => {
    try {
      const { type, payload } = JSON.parse(raw);
      if (type === 'join') {
        clientData.user = payload;
        room.set(socketId, clientData);
        // Load canvas and send to new joiner
        const meetings = dbRead('meetings');
        const meeting = meetings.find(m => m._id === roomId);
        if (meeting?.canvas) {
          ws.send(JSON.stringify({ type: 'canvas', payload: { content: meeting.canvas } }));
        }
        broadcastToRoom(roomId, { type: 'participants', payload: { participants: getRoomParticipants(roomId) } });
      } else if (type === 'mute_self') {
        clientData.muted = payload.muted;
        room.set(socketId, clientData);
        broadcastToRoom(roomId, { type: 'participants', payload: { participants: getRoomParticipants(roomId) } });
      } else if (type === 'canvas') {
        // Broadcast canvas update to all others in room
        room.forEach((client, id) => {
          if (id !== socketId && client.ws.readyState === 1) {
            client.ws.send(JSON.stringify({ type: 'canvas', payload: payload }));
          }
        });
      } else if (type === 'chat') {
        broadcastToRoom(roomId, { type: 'chat', payload });
      } else if (type === 'music') {
        // Broadcast music command to all OTHER participants in room
        room.forEach((client, id) => {
          if (id !== socketId && client.ws.readyState === 1) {
            client.ws.send(JSON.stringify({ type: 'music', payload }));
          }
        });
      } else if (type === 'speaking') {
        clientData.speaking = payload.speaking;
        room.set(socketId, clientData);
        broadcastToRoom(roomId, { type: 'participants', payload: { participants: getRoomParticipants(roomId) } });
      }
    } catch(e) {}
  });

  ws.on('close', () => {
    room.delete(socketId);
    if (room.size === 0) rooms.delete(roomId);
    else broadcastToRoom(roomId, { type: 'participants', payload: { participants: getRoomParticipants(roomId) } });
  });
});

server.listen(PORT, () => {
  console.log(`\n🌳 TLDS Platform Backend running on port ${PORT}`);
  console.log(`   REST: http://localhost:${PORT}/api`);
  console.log(`   WS:   ws://localhost:${PORT}/room/{meetingId}`);
  console.log(`   Email: ${process.env.SMTP_USER ? '✅ configured' : '⚠️  not configured'}\n`);
});
