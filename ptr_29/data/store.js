const fs = require('fs');
const path = require('path');

const DB_DIR = __dirname;
const DB_PATH = path.join(DB_DIR, 'db.json');
const MAX_MESSAGES_PER_ROOM = 1000;
const EDIT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_ROOM = 'general';

function defaultMeta() {
  return { isPrivate: false, ownerId: null, admins: [], members: [], passkey: '' };
}

function ensureDir() {
  if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
  }
}

function read() {
  ensureDir();
  if (!fs.existsSync(DB_PATH)) {
    const seed = { rooms: { [DEFAULT_ROOM]: { messages: [], meta: defaultMeta() } }, users: {} };
    fs.writeFileSync(DB_PATH, JSON.stringify(seed, null, 2));
    return seed;
  }
  try {
    const raw = fs.readFileSync(DB_PATH, 'utf8') || '{}';
    const data = JSON.parse(raw);
    if (!data.rooms) data.rooms = { [DEFAULT_ROOM]: { messages: [], meta: defaultMeta() } };
    if (!data.rooms[DEFAULT_ROOM]) data.rooms[DEFAULT_ROOM] = { messages: [], meta: defaultMeta() };
    if (!data.users) data.users = {};
    // normalize all rooms
    for (const [name, r] of Object.entries(data.rooms)) {
      if (!r.messages) r.messages = [];
      if (!r.meta) r.meta = defaultMeta();
      if (typeof r.meta.isPrivate !== 'boolean') r.meta.isPrivate = !!r.meta.isPrivate;
      if (!Array.isArray(r.meta.admins)) r.meta.admins = [];
      if (!Array.isArray(r.meta.members)) r.meta.members = [];
      if (typeof r.meta.passkey !== 'string') r.meta.passkey = '';
    }
    return data;
  } catch (e) {
    // Reset corrupt file
    const seed = { rooms: { [DEFAULT_ROOM]: { messages: [], meta: defaultMeta() } }, users: {} };
    fs.writeFileSync(DB_PATH, JSON.stringify(seed, null, 2));
    return seed;
  }
}

function write(data) {
  ensureDir();
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

function ensureRoom(name, meta) {
  const db = read();
  if (!db.rooms[name]) {
    db.rooms[name] = { messages: [], meta: defaultMeta() };
    if (meta && typeof meta === 'object') {
      const m = db.rooms[name].meta;
      // Enforce DEFAULT_ROOM always public and no passkey
      if (name === DEFAULT_ROOM) {
        m.isPrivate = false;
        m.ownerId = null;
        m.passkey = '';
      } else {
        m.isPrivate = !!meta.isPrivate;
        m.ownerId = meta.ownerId || null;
      }
      m.admins = Array.isArray(meta.admins) ? Array.from(new Set(meta.admins.filter(Boolean))) : [];
      m.members = Array.isArray(meta.members) ? Array.from(new Set(meta.members.filter(Boolean))) : [];
    }
    write(db);
  } else if (meta && typeof meta === 'object') {
    // update meta if provided
    const r = db.rooms[name];
    if (!r.meta) r.meta = defaultMeta();
    if (name === DEFAULT_ROOM) {
      // Ignore attempts to set general private or change owner; also clear passkey
      r.meta.isPrivate = false;
      r.meta.ownerId = null;
      r.meta.passkey = '';
    } else {
      if (typeof meta.isPrivate === 'boolean') r.meta.isPrivate = !!meta.isPrivate;
      if (meta.ownerId !== undefined) r.meta.ownerId = meta.ownerId || null;
      if (typeof meta.passkey === 'string') r.meta.passkey = meta.passkey;
    }
    if (Array.isArray(meta.admins)) r.meta.admins = Array.from(new Set(meta.admins.filter(Boolean)));
    if (Array.isArray(meta.members)) r.meta.members = Array.from(new Set(meta.members.filter(Boolean)));
    write(db);
  }
}

function getRoomNames() {
  const db = read();
  return Object.keys(db.rooms);
}

function getRooms() {
  const db = read();
  return Object.entries(db.rooms).map(([name, r]) => ({ name, messagesCount: (r.messages || []).length, isPrivate: !!(r.meta && r.meta.isPrivate) }));
}

function getRoomMeta(room) {
  const db = read();
  const r = db.rooms[room];
  if (!r) return defaultMeta();
  if (!r.meta) return defaultMeta();
  return { isPrivate: !!r.meta.isPrivate, ownerId: r.meta.ownerId || null, admins: Array.isArray(r.meta.admins) ? r.meta.admins : [], members: Array.isArray(r.meta.members) ? r.meta.members : [], passkey: typeof r.meta.passkey === 'string' ? r.meta.passkey : '' };
}

function createRoom(name, { isPrivate = false, ownerId = null, admins = [], members = [] } = {}) {
  const nm = String(name || '').trim().toLowerCase();
  if (!nm) return { ok: false, error: 'invalid_name' };
  const db = read();
  if (db.rooms[nm]) {
    // update meta if exists
    ensureRoom(nm, { isPrivate, ownerId, admins, members });
    return { ok: true, name: nm, created: false };
  }
  db.rooms[nm] = { messages: [], meta: defaultMeta() };
  // Enforce DEFAULT_ROOM is always public and ownerless
  if (nm === DEFAULT_ROOM) {
    db.rooms[nm].meta.isPrivate = false;
    db.rooms[nm].meta.ownerId = null;
  } else {
    db.rooms[nm].meta.isPrivate = !!isPrivate;
    db.rooms[nm].meta.ownerId = ownerId || null;
  }
  db.rooms[nm].meta.admins = Array.from(new Set([...(admins || []), ownerId].filter(Boolean)));
  db.rooms[nm].meta.members = Array.from(new Set((members || []).filter(Boolean)));
  db.rooms[nm].meta.passkey = '';
  write(db);
  return { ok: true, name: nm, created: true };
}

function canManageRoom(room, clientId) {
  const meta = getRoomMeta(room);
  const id = (clientId || '').trim();
  if (!id) return false;
  if (meta.ownerId && meta.ownerId === id) return true;
  if (Array.isArray(meta.admins) && meta.admins.includes(id)) return true;
  return false;
}

function canAccessRoom(room, clientId) {
  const meta = getRoomMeta(room);
  if (!meta.isPrivate) return true;
  const id = (clientId || '').trim();
  if (!id) return false;
  if (canManageRoom(room, id)) return true;
  if (Array.isArray(meta.members) && meta.members.includes(id)) return true;
  return false;
}

function getRoomsFor(clientId) {
  const db = read();
  const id = (clientId || '').trim();
  const rooms = Object.entries(db.rooms).map(([name, r]) => ({ name, messagesCount: (r.messages || []).length, isPrivate: !!(r.meta && r.meta.isPrivate) }));
  if (!id) return rooms.filter(r => !r.isPrivate);
  return rooms.filter(r => {
    if (!r.isPrivate) return true;
    const meta = getRoomMeta(r.name);
    if (meta.ownerId && meta.ownerId === id) return true;
    if (Array.isArray(meta.admins) && meta.admins.includes(id)) return true;
    if (Array.isArray(meta.members) && meta.members.includes(id)) return true;
    return false;
  });
}

function getMessages(room, limit = 100) {
  ensureRoom(room);
  const db = read();
  const msgs = (db.rooms[room].messages || []);
  if (limit && Number.isFinite(limit)) return msgs.slice(-limit);
  return msgs;
}

function getMessageById(room, id) {
  ensureRoom(room);
  const db = read();
  const list = (db.rooms[room].messages || []);
  const mid = String(id || '').trim();
  if (!mid) return null;
  return list.find(m => m && m.id === mid) || null;
}

function addMessage(room, message) {
  ensureRoom(room);
  const db = read();
  const list = db.rooms[room].messages || (db.rooms[room].messages = []);
  list.push(message);
  if (list.length > MAX_MESSAGES_PER_ROOM) {
    list.splice(0, list.length - MAX_MESSAGES_PER_ROOM);
  }
  write(db);
}

function setRoomPasskey(room, passkey) {
  ensureRoom(room);
  const db = read();
  const r = db.rooms[room];
  if (!r.meta) r.meta = defaultMeta();
  // Do not allow passkey on DEFAULT_ROOM
  if (room === DEFAULT_ROOM) {
    r.meta.passkey = '';
  } else {
    r.meta.passkey = typeof passkey === 'string' ? passkey : '';
  }
  write(db);
}

function getRoomPasskey(room) {
  const meta = getRoomMeta(room);
  return typeof meta.passkey === 'string' ? meta.passkey : '';
}

function verifyRoomPasskey(room, passkey) {
  const key = getRoomPasskey(room);
  const provided = String(passkey || '').trim();
  if (!key) return false;
  return key === provided;
}

function findRoomByPasskey(passkey) {
  const key = String(passkey || '').trim();
  if (!key) return null;
  const db = read();
  const rooms = db.rooms || {};
  for (const [name, r] of Object.entries(rooms)) {
    const m = (r && r.meta) || {};
    if (typeof m.passkey === 'string' && m.passkey && m.passkey === key) {
      return name;
    }
  }
  return null;
}

function addReceipt(room, messageId, userId, username) {
  ensureRoom(room);
  const db = read();
  const list = db.rooms[room].messages || [];
  const msg = list.find(m => m.id === messageId);
  if (!msg) return false;
  if (!msg.readBy) msg.readBy = [];
  if (!msg.readBy.find(r => r.userId === userId)) {
    msg.readBy.push({ userId, username, at: Date.now() });
    write(db);
  }
  return true;
}

function owns(msg, userId, clientId) {
  if (!msg) return false;
  if (userId && msg.userId && msg.userId === userId) return true;
  if (clientId && msg.clientId && msg.clientId === clientId) return true;
  return false;
}

function editMessage(room, messageId, userId, newText, nowTs = Date.now(), clientId) {
  ensureRoom(room);
  const db = read();
  const list = db.rooms[room].messages || [];
  const idx = list.findIndex(m => m.id === messageId);
  if (idx === -1) return { ok: false, error: 'not_found' };
  const msg = list[idx];
  if (!owns(msg, userId, clientId)) return { ok: false, error: 'forbidden' };
  const text = (typeof newText === 'string' ? newText : '').trim();
  if (!text) return { ok: false, error: 'invalid_text' };
  if (text.length > 2000) return { ok: false, error: 'too_long' };
  if (typeof msg.timestamp === 'number' && nowTs - msg.timestamp > EDIT_WINDOW_MS) {
    return { ok: false, error: 'edit_window_expired' };
  }
  msg.message = text;
  msg.edited = true;
  msg.editedAt = nowTs;
  list[idx] = msg;
  write(db);
  return { ok: true, message: msg };
}

function deleteMessage(room, messageId, userId, clientId) {
  ensureRoom(room);
  const db = read();
  const list = db.rooms[room].messages || [];
  const idx = list.findIndex(m => m.id === messageId);
  if (idx === -1) return { ok: false, error: 'not_found' };
  const msg = list[idx];
  if (!owns(msg, userId, clientId)) return { ok: false, error: 'forbidden' };
  list.splice(idx, 1);
  write(db);
  return { ok: true };
}

function clearRoom(room) {
  ensureRoom(room);
  const db = read();
  db.rooms[room].messages = [];
  write(db);
}

function clearAll() {
  const db = read();
  if (!db.rooms) return;
  for (const r of Object.keys(db.rooms)) {
    db.rooms[r].messages = [];
  }
  write(db);
}

function deleteRoom(room) {
  const name = String(room || '').trim().toLowerCase();
  if (!name || name === 'general') return false;
  const db = read();
  if (!db.rooms || !db.rooms[name]) return false;
  // Remove all traces of the room, including metadata
  delete db.rooms[name];
  write(db);
  return true;
}

function addAdmin(room, adminId) {
  ensureRoom(room);
  const db = read();
  const r = db.rooms[room];
  if (!r.meta) r.meta = defaultMeta();
  if (!r.meta.admins.includes(adminId)) {
    r.meta.admins.push(adminId);
    write(db);
    return { ok: true, message: `Admin ${adminId} added to room ${room}.` };
  }
  return { ok: false, message: `Admin ${adminId} is already in room ${room}.` };
}

function removeAdmin(room, adminId) {
  ensureRoom(room);
  const db = read();
  const r = db.rooms[room];
  if (!r.meta) r.meta = defaultMeta();
  const index = r.meta.admins.indexOf(adminId);
  if (index !== -1) {
    r.meta.admins.splice(index, 1);
    write(db);
    return { ok: true, message: `Admin ${adminId} removed from room ${room}.` };
  }
  return { ok: false, message: `Admin ${adminId} not found in room ${room}.` };
}

function listAdmins(room) {
  ensureRoom(room);
  const db = read();
  const r = db.rooms[room];
  if (!r.meta) r.meta = defaultMeta();
  return { ok: true, admins: r.meta.admins };
}

function addRoomAdmins(room, adminIds = []) {
  ensureRoom(room);
  const db = read();
  const r = db.rooms[room];
  if (!r.meta) r.meta = defaultMeta();
  const set = new Set([...(r.meta.admins || []), ...adminIds.filter(Boolean)]);
  r.meta.admins = Array.from(set);
  write(db);
}

function addRoomMembers(room, memberIds = []) {
  ensureRoom(room);
  const db = read();
  const r = db.rooms[room];
  if (!r.meta) r.meta = defaultMeta();
  const set = new Set([...(r.meta.members || []), ...memberIds.filter(Boolean)]);
  r.meta.members = Array.from(set);
  write(db);
}

function setRoomAdmins(room, adminIds = []) {
  ensureRoom(room);
  const db = read();
  const r = db.rooms[room];
  if (!r.meta) r.meta = defaultMeta();
  r.meta.admins = Array.from(new Set((adminIds || []).filter(Boolean)));
  write(db);
}

function setRoomMembers(room, memberIds = []) {
  ensureRoom(room);
  const db = read();
  const r = db.rooms[room];
  if (!r.meta) r.meta = defaultMeta();
  r.meta.members = Array.from(new Set((memberIds || []).filter(Boolean)));
  write(db);
}

// Prune admins in all rooms to only those whose username is in the allowed list
function pruneAdminsToUsernames(usernames = []) {
  const db = read();
  const allowedNames = new Set((usernames || []).map(u => String(u || '').trim().toLowerCase()).filter(Boolean));
  const users = db.users || {};
  const allowedIds = new Set(
    Object.values(users)
      .filter(u => allowedNames.has(String(u && u.username || '').trim().toLowerCase()))
      .map(u => u && u.clientId)
      .filter(Boolean)
  );
  let changed = 0;
  for (const [name, r] of Object.entries(db.rooms || {})) {
    if (!r.meta) r.meta = defaultMeta();
    const prev = Array.isArray(r.meta.admins) ? r.meta.admins : [];
    const next = prev.filter(id => allowedIds.has(id));
    if (prev.length !== next.length || prev.some((v, i) => v !== next[i])) {
      r.meta.admins = next;
      changed++;
    }
  }
  write(db);
  return { ok: true, changed };
}

function recordUser(clientId, { username, avatar } = {}) {
  const id = (clientId || '').trim();
  if (!id) return;
  const db = read();
  if (!db.users) db.users = {};
  const prev = db.users[id] || {};
  db.users[id] = {
    clientId: id,
    username: typeof username === 'string' && username.trim() ? username.trim() : (prev.username || 'Anonymous'),
    avatar: typeof avatar === 'string' && avatar.trim() ? avatar.trim() : (prev.avatar || ''),
    lastSeen: Date.now(),
  };
  write(db);
}

function getAllUsers() {
  const db = read();
  const users = db.users || {};
  return Object.values(users).map(u => ({ clientId: u.clientId, username: u.username || 'Anonymous', avatar: u.avatar || '', lastSeen: u.lastSeen || 0 }));
}

function isUsernameAvailable(username) {
  const db = read();
  const users = db.users || {};
  return !Object.values(users).some(user => user.username === username);
}

function saveUsername(clientId, username) {
  if (!isUsernameAvailable(username)) {
    return { ok: false, message: `Username ${username} is already taken.` };
  }
  const db = read();
  if (!db.users) db.users = {};
  db.users[clientId] = {
    clientId,
    username,
    avatar: db.users[clientId]?.avatar || '',
    lastSeen: Date.now(),
  };
  write(db);
  return { ok: true, message: `Username ${username} saved successfully.` };
}

module.exports = {
  MAX_MESSAGES_PER_ROOM,
  EDIT_WINDOW_MS,
  ensureRoom,
  getRoomNames,
  getRooms,
  getRoomsFor,
  getRoomMeta,
  getMessages,
  getMessageById,
  addMessage,
  addReceipt,
  clearRoom,
  clearAll,
  deleteRoom,
  editMessage,
  deleteMessage,
  createRoom,
  canManageRoom,
  canAccessRoom,
  addRoomAdmins,
  addRoomMembers,
  setRoomPasskey,
  getRoomPasskey,
  verifyRoomPasskey,
  findRoomByPasskey,
  setRoomAdmins,
  setRoomMembers,
  recordUser,
  getAllUsers,
  addAdmin,
  removeAdmin,
  listAdmins,
  isUsernameAvailable,
  saveUsername,
  pruneAdminsToUsernames,
};
