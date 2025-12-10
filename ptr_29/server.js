const path = require('path');
const fs = require('fs');
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const {
  ensureRoom,
  getRooms,
  getRoomsFor,
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
  getRoomMeta,
  canManageRoom,
  canAccessRoom,
  addRoomAdmins,
  addRoomMembers,
  setRoomAdmins,
  setRoomMembers,
  setRoomPasskey,
  verifyRoomPasskey,
  findRoomByPasskey,
  recordUser,
  getAllUsers,
  pruneAdminsToUsernames,
} = require('./data/store');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = process.env.PORT || 3000;
const DEFAULT_ROOM = 'general';
ensureRoom(DEFAULT_ROOM, {});
// One-time cleanup: keep only admins whose username is 'gg_games'
try { pruneAdminsToUsernames(['gg_games']); } catch {}

const app = express();
app.use(cors());
app.use(express.json({ limit: '12mb' }));
app.use(express.static(path.join(__dirname, 'public')));
// Static uploads dir
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.use('/uploads', express.static(UPLOAD_DIR));

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// REST API for rooms and messages
app.get('/api/rooms', (req, res) => {
  const clientId = String(req.query.clientId || '').trim();
  const rooms = clientId ? getRoomsFor(clientId) : getRooms();
  return res.json({ rooms });
});

app.post('/api/rooms', (req, res) => {
  const nameRaw = (req.body && req.body.name) || '';
  const name = String(nameRaw).trim().toLowerCase().replace(/[^a-z0-9_-]/gi, '-').slice(0, 50);
  if (!name) return res.status(400).json({ error: 'Invalid room name' });
  const isPrivate = !!(req.body && req.body.isPrivate);
  const ownerId = (req.body && req.body.ownerId) ? String(req.body.ownerId).trim().slice(0, 64) : null;
  const admins = Array.isArray(req.body && req.body.admins) ? (req.body.admins || []).map(x => String(x).trim().slice(0, 64)).filter(Boolean) : [];
  const members = Array.isArray(req.body && req.body.members) ? (req.body.members || []).map(x => String(x).trim().slice(0, 64)).filter(Boolean) : [];
  const result = createRoom(name, { isPrivate, ownerId, admins, members });
  if (!result.ok) return res.status(400).json({ error: result.error || 'failed' });
  return res.status(201).json({ ok: true, name: result.name, created: result.created });
});

app.get('/api/rooms/:room/messages', (req, res) => {
  const roomRaw = req.params.room || DEFAULT_ROOM;
  const room = String(roomRaw).trim().toLowerCase().replace(/[^a-z0-9_-]/gi, '-').slice(0, 50) || DEFAULT_ROOM;
  const limit = Math.max(1, Math.min(1000, parseInt(req.query.limit || '100', 10)));
  ensureRoom(room);
  const clientId = String(req.query.clientId || '').trim();
  if (!canAccessRoom(room, clientId)) return res.status(403).json({ error: 'forbidden' });
  const messages = getMessages(room, limit);
  return res.json({ room, messages });
});

// Upload an image to a room via Data URL
app.post('/api/rooms/:room/images', async (req, res) => {
  try {
    const roomRaw = req.params.room || DEFAULT_ROOM;
    const room = String(roomRaw).trim().toLowerCase().replace(/[^a-z0-9_-]/gi, '-').slice(0, 50) || DEFAULT_ROOM;
    ensureRoom(room);
    const { dataUrl, clientId, filename } = req.body || {};
    const cid = (clientId || '').trim();
    if (!canAccessRoom(room, cid)) return res.status(403).json({ error: 'forbidden' });
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
      return res.status(400).json({ error: 'invalid_image' });
    }
    const m = dataUrl.match(/^data:(image\/(png|jpeg|jpg|gif|webp));base64,(.+)$/i);
    if (!m) return res.status(400).json({ error: 'unsupported_type' });
    let ext = m[2].toLowerCase();
    if (ext === 'jpeg') ext = 'jpg';
    const base64 = m[3];
    const buf = Buffer.from(base64, 'base64');
    if (!Number.isFinite(buf.length) || buf.length <= 0) return res.status(400).json({ error: 'empty_image' });
    if (buf.length > 10 * 1024 * 1024) return res.status(413).json({ error: 'too_large' }); // 10MB
    const safeBase = String(filename || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24) || 'img';
    const idPart = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const fileName = `${safeBase}-${idPart}.${ext}`;
    const filePath = path.join(UPLOAD_DIR, fileName);
    fs.writeFileSync(filePath, buf);
    const imageUrl = `/uploads/${fileName}`;

    // Derive username and avatar for this clientId if known
    let username = 'Anonymous';
    let avatar = '';
    try {
      const users = getAllUsers();
      const u = Array.isArray(users) ? users.find(x => x.clientId === cid) : null;
      if (u) { username = u.username || 'Anonymous'; avatar = u.avatar || ''; }
    } catch {}
    if (!avatar) {
      const seed = encodeURIComponent(String(username || 'Anonymous'));
      avatar = `https://api.dicebear.com/7.x/thumbs/svg?seed=${seed}`;
    }

    const payload = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      room,
      userId: null,
      clientId: cid || null,
      username,
      avatar,
      message: '',
      type: 'image',
      imageUrl,
      timestamp: Date.now(),
      readBy: [],
    };
    addMessage(room, payload);
    io.to(room).emit('chat-message', payload);
    return res.status(201).json({ ok: true, message: payload });
  } catch (e) {
    return res.status(500).json({ error: 'upload_failed' });
  }
});

// Edit a message
app.post('/api/rooms/:room/messages/:id/edit', (req, res) => {
  const roomRaw = req.params.room || DEFAULT_ROOM;
  const room = String(roomRaw).trim().toLowerCase().replace(/[^a-z0-9_-]/gi, '-').slice(0, 50) || DEFAULT_ROOM;
  const id = String(req.params.id || '').trim();
  const text = (req.body && req.body.text) || '';
  const userId = (req.body && req.body.userId) || '';
  const clientId = (req.body && req.body.clientId) || '';
  ensureRoom(room);
  if (!canAccessRoom(room, clientId)) return res.status(403).json({ error: 'forbidden' });
  const result = editMessage(room, id, userId, text, Date.now(), clientId);
  if (!result.ok) return res.status(400).json({ error: result.error });
  io.to(room).emit('message-updated', result.message);
  return res.json({ ok: true, message: result.message });
});

// Delete a message
app.post('/api/rooms/:room/messages/:id/delete', (req, res) => {
  const roomRaw = req.params.room || DEFAULT_ROOM;
  const room = String(roomRaw).trim().toLowerCase().replace(/[^a-z0-9_-]/gi, '-').slice(0, 50) || DEFAULT_ROOM;
  const id = String(req.params.id || '').trim();
  const userId = (req.body && req.body.userId) || '';
  const clientId = (req.body && req.body.clientId) || '';
  ensureRoom(room);
  if (!canAccessRoom(room, clientId)) return res.status(403).json({ error: 'forbidden' });
  const result = deleteMessage(room, id, userId, clientId);
  if (!result.ok) return res.status(400).json({ error: result.error });
  io.to(room).emit('message-deleted', { messageId: id, room });
  return res.json({ ok: true });
});

// Clear messages in a specific room
app.post('/api/rooms/:room/clear', (req, res) => {
  const roomRaw = req.params.room || DEFAULT_ROOM;
  const room = String(roomRaw).trim().toLowerCase().replace(/[^a-z0-9_-]/gi, '-').slice(0, 50) || DEFAULT_ROOM;
  ensureRoom(room);
  const clientId = (req.body && req.body.clientId) ? String(req.body.clientId).trim() : '';
  if (!canManageRoom(room, clientId)) return res.status(403).json({ error: 'forbidden' });
  clearRoom(room);
  io.to(room).emit('history', { room, messages: [] });
  broadcastRooms();
  return res.json({ ok: true, room });
});

// Clear messages in all rooms
app.post('/api/clear-all', (req, res) => {
  clearAll();
  broadcastRooms();
  return res.json({ ok: true });
});

// Delete a room (not allowed for default room)
app.post('/api/rooms/:room/delete', (req, res) => {
  const roomRaw = req.params.room || DEFAULT_ROOM;
  const room = String(roomRaw).trim().toLowerCase().replace(/[^a-z0-9_-]/gi, '-').slice(0, 50) || DEFAULT_ROOM;
  if (room === DEFAULT_ROOM) return res.status(400).json({ error: 'Cannot delete default room' });
  const clientId = (req.body && req.body.clientId) ? String(req.body.clientId).trim() : '';
  if (!canManageRoom(room, clientId)) return res.status(403).json({ error: 'forbidden' });
  const ok = deleteRoom(room);
  if (!ok) return res.status(404).json({ error: 'Room not found' });
  // Kick everyone out of the room
  io.in(room).emit('room-deleted', { room });
  io.socketsLeave(room);
  // clear presence for deleted room
  presence.delete(room);
  broadcastRooms();
  return res.json({ ok: true, room });
});

// Users listing
app.get('/api/users', (req, res) => {
  res.json({ users: getAllUsers() });
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

let broadcastRooms = () => {
  io.sockets.sockets.forEach((s) => {
    const cid = s.data && s.data.clientId;
    s.emit('rooms', getRoomsFor(cid));
  });
};

/**
 * Notify all eligible clients about a new message in a room
 * @param {string} room - The room identifier
 * @param {string} fromUsername - Username of the message sender
 * @param {string} [preview] - Optional message preview text
 */
function notifyNewMessage(room, fromUsername, preview) {
  // Input validation
  if (!room || typeof room !== 'string') {
    console.warn('notifyNewMessage: Invalid room parameter');
    return;
  }
  
  const r = room.trim();
  if (!r) {
    console.warn('notifyNewMessage: Empty room name after trimming');
    return;
  }

  const from = (typeof fromUsername === 'string' && fromUsername.trim()) || 'Someone';
  const snippet = (typeof preview === 'string' && preview.trim()) 
    ? preview.trim().slice(0, 60) 
    : '';

  try {
    if (!io?.sockets?.sockets) {
      throw new Error('Socket.io instance not properly initialized');
    }

    // Get sockets as an array to avoid potential issues with forEach on Socket map
    const sockets = Array.from(io.sockets.sockets.values());
    
    // Process notifications
    for (const socket of sockets) {
      try {
        const cid = socket.data?.clientId;
        
        // Skip if client can't access the room or is currently in the room
        if (!canAccessRoom(r, cid) || socket.data?.currentRoom === r) {
          continue;
        }

        const notificationText = `🔔 New in #${r} from ${from}${snippet ? `: ${snippet}` : ''}`;
        socket.emit('system', { 
          type: 'notify', 
          message: notificationText,
          room: r,
          from,
          timestamp: new Date().toISOString()
        });
      } catch (socketError) {
        console.error('Error notifying socket:', socketError);
        // Continue with other sockets if one fails
      }
    }
  } catch (error) {
    console.error('Error in notifyNewMessage:', error);
  }
}

// Admins prune endpoint (optional manual trigger)
app.post('/api/admins/prune', (req, res) => {
  const body = req.body || {};
  const names = Array.isArray(body.usernames) ? body.usernames : ['gg_games'];
  const result = pruneAdminsToUsernames(names);
  broadcastRooms();
  return res.json({ ok: true, ...result, usernames: names });
});

// ---- Presence tracking ----
// room => Map(socketId, { username, avatar, clientId, userId, since })
const presence = new Map();

function getPresence(room) {
  const r = String(room || '').trim();
  const map = presence.get(r);
  if (!map) return [];
  return Array.from(map.values());
}

function presenceJoin(room, socket) {
  const r = String(room || '').trim();
  let map = presence.get(r);
  if (!map) { map = new Map(); presence.set(r, map); }
  map.set(socket.id, {
    username: socket.data.username || 'Anonymous',
    avatar: socket.data.avatar || '',
    clientId: socket.data.clientId || null,
    userId: socket.data.userId,
    since: Date.now(),
  });
  io.to(r).emit('presence', { room: r, users: getPresence(r) });
}

function presenceLeave(room, socket) {
  const r = String(room || '').trim();
  const map = presence.get(r);
  if (!map) return;
  map.delete(socket.id);
  if (map.size === 0) presence.delete(r);
  io.to(r).emit('presence', { room: r, users: getPresence(r) });
}

io.on('connection', (socket) => {
  socket.data.userId = socket.id;
  socket.data.passkeyAccess = new Set();

  function defaultAvatar(name) {
    const seed = encodeURIComponent(String(name || 'Anonymous'));
    // Dicebear Thumbs SVG avatar
    return `https://api.dicebear.com/7.x/thumbs/svg?seed=${seed}`;
  }

  function sanitizeRoom(input) {
    return String(input || DEFAULT_ROOM).trim().toLowerCase().replace(/[^a-z0-9_-]/gi, '-').slice(0, 50) || DEFAULT_ROOM;
  }

  socket.on('join', (payload) => {
    let p = payload;
    if (typeof p === 'string') {
      p = { username: p, room: DEFAULT_ROOM };
    }
    const usernameRaw = p && p.username;
    const roomRaw = p && p.room;
    const avatarRaw = p && p.avatar;
    const clientIdRaw = p && p.clientId;
    const passkeyRaw = p && p.passkey;
    const username = (typeof usernameRaw === 'string' && usernameRaw.trim()) ? usernameRaw.trim().slice(0, 50) : 'Anonymous';
    const room = sanitizeRoom(roomRaw);
    const avatar = (typeof avatarRaw === 'string' && avatarRaw.trim()) ? avatarRaw.trim() : defaultAvatar(username);
    const clientId = (typeof clientIdRaw === 'string' && clientIdRaw.trim()) ? clientIdRaw.trim().slice(0, 64) : null;
    const passkey = (typeof passkeyRaw === 'string' && passkeyRaw.trim()) ? passkeyRaw.trim() : '';

    // Switch room if already in one
    if (socket.data.currentRoom && socket.data.currentRoom !== room) {
      const prev = socket.data.currentRoom;
      presenceLeave(prev, socket);
      socket.leave(prev);
      socket.to(prev).emit('system', { type: 'leave', message: `${socket.data.username || 'Someone'} left #${prev}` });
      // Clear ephemeral passkey access when switching rooms
      socket.data.passkeyAccess = new Set();
    }

    ensureRoom(room);
    if (!canAccessRoom(room, clientId)) {
      const meta = getRoomMeta(room);
      if (meta && meta.isPrivate) {
        if (passkey && verifyRoomPasskey(room, passkey)) {
          // Auto-add as member (NOT admin)
          if (clientId) addRoomMembers(room, [clientId]);
        } else {
          socket.emit('system', { type: 'error', message: `#${room} is private. Enter its passkey in the sidebar to join.` });
          return;
        }
      } else {
        socket.emit('system', { type: 'error', message: `Access denied to #${room}` });
        socket.emit('rooms', getRoomsFor(clientId));
        return;
      }
    }
    socket.data.username = username;
    socket.data.avatar = avatar;
    socket.data.clientId = clientId;
    socket.data.currentRoom = room;
    socket.join(room);

    // record/update user profile
    if (clientId) recordUser(clientId, { username, avatar });

    socket.emit('system', { type: 'welcome', message: `Welcome, ${username}! You joined #${room}` });
    socket.to(room).emit('system', { type: 'join', message: `${username} joined #${room}` });
    socket.emit('rooms', getRoomsFor(clientId));
    socket.emit('history', { room, messages: getMessages(room, 100) });
    // presence for this room
    presenceJoin(room, socket);
  });

  socket.on('list-rooms', () => {
    socket.emit('rooms', getRoomsFor(socket.data.clientId));
  });

  socket.on('create-room', (payload) => {
    let name = '';
    let isPrivate = false;
    let admins = [];
    let members = [];
    if (typeof payload === 'string') {
      name = sanitizeRoom(payload);
    } else if (payload && typeof payload === 'object') {
      name = sanitizeRoom(payload.name);
      isPrivate = !!payload.isPrivate;
      admins = Array.isArray(payload.admins) ? payload.admins.map(x => String(x).trim().slice(0, 64)).filter(Boolean) : [];
      members = Array.isArray(payload.members) ? payload.members.map(x => String(x).trim().slice(0, 64)).filter(Boolean) : [];
    }
    if (!name) return;
    const ownerId = socket.data.clientId || null;
    const result = createRoom(name, { isPrivate, ownerId, admins, members });
    if (!result.ok) return;
    broadcastRooms();
  });

  socket.on('leave-room', () => {
    const room = socket.data.currentRoom;
    if (!room) return;
    presenceLeave(room, socket);
    socket.leave(room);
    socket.to(room).emit('system', { type: 'leave', message: `${socket.data.username || 'Someone'} left #${room}` });
    socket.data.currentRoom = null;
  });

  socket.on('chat-message', (text) => {
    // Accept either a simple string or an object { text, replyTo }
    let msg = '';
    let replyToId = '';
    if (typeof text === 'string') {
      msg = text.trim();
    } else if (text && typeof text === 'object') {
      msg = typeof text.text === 'string' ? text.text.trim() : '';
      replyToId = typeof text.replyTo === 'string' ? text.replyTo.trim() : '';
    }
    const room = socket.data.currentRoom;
    if (!msg || !room) return;
    if (!canAccessRoom(room, socket.data.clientId)) return;
    // Build optional reply snapshot if provided
    let replySnapshot = null;
    if (replyToId) {
      try {
        const orig = getMessageById(room, replyToId);
        if (orig) {
          replySnapshot = {
            id: orig.id,
            username: orig.username || 'Anonymous',
            message: (orig.type === 'image') ? '' : (orig.message || ''),
            type: orig.type || 'text',
            imageUrl: orig.imageUrl || '',
          };
        }
      } catch {}
    }
    const payload = {
      id: `${Date.now()}-${socket.id}`,
      room,
      userId: socket.data.userId,
      clientId: socket.data.clientId || null,
      username: socket.data.username || 'Anonymous',
      avatar: socket.data.avatar || defaultAvatar(socket.data.username),
      message: msg.slice(0, 2000),
      timestamp: Date.now(),
      readBy: [{ userId: socket.data.userId, username: socket.data.username, at: Date.now() }],
      ...(replySnapshot ? { replyTo: replySnapshot } : {}),
    };
    addMessage(room, payload);
    io.to(room).emit('chat-message', payload);
  });

  socket.on('typing', ({ isTyping } = {}) => {
    const room = socket.data.currentRoom;
    if (!room) return;
    socket.to(room).emit('typing', { userId: socket.data.userId, username: socket.data.username || 'Anonymous', isTyping: !!isTyping });
  });

  socket.on('read-receipt', ({ messageId } = {}) => {
    const room = socket.data.currentRoom;
    if (!room || !messageId) return;
    const ok = addReceipt(room, messageId, socket.data.userId, socket.data.username || 'Anonymous');
    if (ok) io.to(room).emit('read-receipt', { messageId, userId: socket.data.userId, username: socket.data.username || 'Anonymous' });
  });

  socket.on('edit-message', ({ messageId, text } = {}) => {
    const room = socket.data.currentRoom;
    if (!room || !messageId || typeof text !== 'string') return;
    const result = editMessage(room, messageId, socket.data.userId, text, Date.now(), socket.data.clientId);
    if (result.ok) {
      io.to(room).emit('message-updated', result.message);
    } else {
      socket.emit('error', { action: 'edit-message', error: result.error });
    }
  });

  socket.on('delete-message', ({ messageId } = {}) => {
    const room = socket.data.currentRoom;
    if (!room || !messageId) return;
    const result = deleteMessage(room, messageId, socket.data.userId, socket.data.clientId);
    if (result.ok) {
      io.to(room).emit('message-deleted', { messageId, room });
    } else {
      socket.emit('error', { action: 'delete-message', error: result.error });
    }
  });

  socket.on('clear-room', () => {
    const room = socket.data.currentRoom;
    if (!room) return;
    if (!canManageRoom(room, socket.data.clientId)) return;
    clearRoom(room);
    io.to(room).emit('history', { room, messages: [] });
    broadcastRooms();
  });

  socket.on('delete-room', () => {
    const room = socket.data.currentRoom;
    if (!room || room === DEFAULT_ROOM) return;
    if (!canManageRoom(room, socket.data.clientId)) return;
    const ok = deleteRoom(room);
    if (!ok) return;
    io.in(room).emit('room-deleted', { room });
    io.socketsLeave(room);
    // clear presence for deleted room
    presence.delete(room);
    broadcastRooms();
  });

  socket.on('list-users', () => {
    socket.emit('users', getAllUsers());
  });

  socket.on('add-room-admins', ({ room, admins } = {}) => {
    const r = sanitizeRoom(room);
    if (!r) return;
    if (!canManageRoom(r, socket.data.clientId)) return;
    addRoomAdmins(r, Array.isArray(admins) ? admins : []);
    const meta = getRoomMeta(r);
    const out = canManageRoom(r, socket.data.clientId) ? meta : { ...meta, passkey: '' };
    socket.emit('room-meta', { room: r, meta: out });
    broadcastRooms();
  });

  socket.on('add-room-members', ({ room, members } = {}) => {
    const r = sanitizeRoom(room);
    if (!r) return;
    if (!canManageRoom(r, socket.data.clientId)) return;
    addRoomMembers(r, Array.isArray(members) ? members : []);
    const meta = getRoomMeta(r);
    const out = canManageRoom(r, socket.data.clientId) ? meta : { ...meta, passkey: '' };
    socket.emit('room-meta', { room: r, meta: out });
    broadcastRooms();
  });

  socket.on('set-room-admins', ({ room, admins } = {}) => {
    const r = sanitizeRoom(room);
    if (!r) return;
    if (!canManageRoom(r, socket.data.clientId)) return;
    const current = getRoomMeta(r);
    const owner = current.ownerId || null;
    const list = Array.isArray(admins) ? admins.map(x => String(x || '').trim().slice(0, 64)).filter(Boolean) : [];
    const ensured = Array.from(new Set([...(list || []), owner].filter(Boolean)));
    setRoomAdmins(r, ensured);
    const meta = getRoomMeta(r);
    const out = canManageRoom(r, socket.data.clientId) ? meta : { ...meta, passkey: '' };
    socket.emit('room-meta', { room: r, meta: out });
    broadcastRooms();
  });

  socket.on('set-room-members', ({ room, members } = {}) => {
    const r = sanitizeRoom(room);
    if (!r) return;
    if (!canManageRoom(r, socket.data.clientId)) return;
    const list = Array.isArray(members) ? members.map(x => String(x || '').trim().slice(0, 64)).filter(Boolean) : [];
    setRoomMembers(r, list);
    const meta = getRoomMeta(r);
    const out = canManageRoom(r, socket.data.clientId) ? meta : { ...meta, passkey: '' };
    socket.emit('room-meta', { room: r, meta: out });
    broadcastRooms();
  });

  socket.on('get-room-meta', (payload = {}) => {
    const target = payload && payload.room ? sanitizeRoom(payload.room) : (socket.data.currentRoom || DEFAULT_ROOM);
    if (!target) return;
    if (!canAccessRoom(target, socket.data.clientId)) return;
    const meta = getRoomMeta(target);
    const out = canManageRoom(target, socket.data.clientId) ? meta : { ...meta, passkey: '' };
    socket.emit('room-meta', { room: target, meta: out });
  });

  // Find a room by passkey (for clients to discover which room to join)
  socket.on('find-room-by-passkey', (payload = {}, ack) => {
    const passkey = (payload && typeof payload.passkey === 'string') ? payload.passkey.trim() : '';
    const room = passkey ? findRoomByPasskey(passkey) : null;
    const resp = room ? { ok: true, room } : { ok: false, error: 'not_found' };
    if (typeof ack === 'function') return ack(resp);
    socket.emit('find-room-by-passkey-result', resp);
  });

  // Passkey management (admins only)
  function randomPasskey(len = 8) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let out = '';
    for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
    return out;
  }

  socket.on('generate-room-passkey', ({ room } = {}, ack) => {
    const r = sanitizeRoom(room || socket.data.currentRoom || DEFAULT_ROOM);
    if (!r) { if (typeof ack === 'function') return ack({ ok: false, error: 'invalid_room' }); return; }
    if (!canManageRoom(r, socket.data.clientId)) { if (typeof ack === 'function') return ack({ ok: false, error: 'forbidden' }); return; }
    if (r === DEFAULT_ROOM) { if (typeof ack === 'function') return ack({ ok: false, error: 'default_room_public' }); return; }
    let key = randomPasskey(8);
    let tries = 0;
    while (tries < 20) {
      const other = findRoomByPasskey(key);
      if (!other || other === r) break;
      key = randomPasskey(8);
      tries++;
    }
    setRoomPasskey(r, key);
    socket.emit('room-meta', { room: r, meta: { ...getRoomMeta(r) } });
    if (typeof ack === 'function') return ack({ ok: true, room: r, passkey: key });
  });

  socket.on('set-room-passkey', ({ room, passkey } = {}, ack) => {
    const r = sanitizeRoom(room || socket.data.currentRoom || DEFAULT_ROOM);
    if (!r) { if (typeof ack === 'function') return ack({ ok: false, error: 'invalid_room' }); return; }
    if (!canManageRoom(r, socket.data.clientId)) { if (typeof ack === 'function') return ack({ ok: false, error: 'forbidden' }); return; }
    if (r === DEFAULT_ROOM) { if (typeof ack === 'function') return ack({ ok: false, error: 'default_room_public' }); return; }
    const key = (typeof passkey === 'string') ? passkey.trim() : '';
    if (key) {
      const other = findRoomByPasskey(key);
      if (other && other !== r) {
        if (typeof ack === 'function') return ack({ ok: false, error: 'in_use' });
        return;
      }
    }
    setRoomPasskey(r, key);
    socket.emit('room-meta', { room: r, meta: { ...getRoomMeta(r) } });
    if (typeof ack === 'function') return ack({ ok: true, room: r, passkey: key });
  });

  socket.on('disconnect', () => {
    const room = socket.data.currentRoom;
    if (room) {
      presenceLeave(room, socket);
      socket.to(room).emit('system', { type: 'leave', message: `${socket.data.username || 'Someone'} left #${room}` });
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Chat server running on http://${HOST}:${PORT}`);
});
