/**
 * TLDS LIVE — Simple JSON-file database
 * Persists users, sessions, messages, and meeting state
 * In production swap this for Supabase (see README)
 */
const fs   = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'db.json');

// Ensure data directory exists
if (!fs.existsSync(path.dirname(DB_PATH))) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
}

// Default schema
const DEFAULT = {
  users:    [],   // registered web users
  online:   [],   // currently connected users
  messages: [],   // chat messages
  meeting: {
    isLive:    false,
    startedAt: null,
    streamUrl: '',
    title:     'Weekly Community Meeting',
    schedule:  'Every Sunday • 8:00 PM',
  },
};

// Load or create
function load() {
  try {
    const raw = fs.readFileSync(DB_PATH, 'utf8');
    return { ...DEFAULT, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT };
  }
}

function save(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

// ─── User helpers ────────────────────────────
function getUsers()       { return load().users; }
function getUserByEmail(email) {
  return load().users.find(u => u.email === email.toLowerCase().trim());
}
function getUserById(id)  { return load().users.find(u => u.id === id); }

function createUser({ name, email, phone, location }) {
  const db   = load();
  const user = {
    id:        `u_${Date.now()}`,
    name,
    email:     email.toLowerCase().trim(),
    phone:     phone || '',
    location:  location || '',
    joinedAt:  new Date().toISOString(),
  };
  db.users.push(user);
  save(db);
  return user;
}

// ─── Online presence ─────────────────────────
function getOnline()       { return load().online; }
function setOnline(list)   { const db = load(); db.online = list; save(db); }

function addOnline(user) {
  const db = load();
  if (!db.online.find(u => u.id === user.id)) {
    db.online.push({ ...user, onlineSince: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) });
  }
  save(db);
}

function removeOnline(userId) {
  const db = load();
  db.online = db.online.filter(u => u.id !== userId);
  save(db);
}

// ─── Chat messages ───────────────────────────
function getMessages(limit = 100) {
  const db = load();
  return db.messages.slice(-limit);
}

function addMessage({ name, text, isHost = false, isSystem = false }) {
  const db  = load();
  const msg = {
    id:       `m_${Date.now()}`,
    name,
    text,
    isHost,
    isSystem,
    time:     new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    ts:       Date.now(),
  };
  db.messages.push(msg);
  if (db.messages.length > 500) db.messages = db.messages.slice(-500); // keep last 500
  save(db);
  return msg;
}

// ─── Meeting state ───────────────────────────
function getMeeting()    { return load().meeting; }

function setMeeting(updates) {
  const db = load();
  db.meeting = { ...db.meeting, ...updates };
  save(db);
  return db.meeting;
}

module.exports = {
  getUsers, getUserByEmail, getUserById, createUser,
  getOnline, setOnline, addOnline, removeOnline,
  getMessages, addMessage,
  getMeeting, setMeeting,
};
