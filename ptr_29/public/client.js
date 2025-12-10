(() => {
  const socket = io();

  const messagesEl = document.getElementById('messages');
  const form = document.getElementById('chat-form');
  const usernameInput = document.getElementById('username');
  const avatarInput = document.getElementById('avatar');
  const textInput = document.getElementById('text');
  const sendBtn = document.getElementById('send');
  const imageBtn = document.getElementById('image-btn');
  const imageFile = document.getElementById('image-file');
  const typingEl = document.getElementById('typing');
  const roomNameEl = document.getElementById('room-name');
  const roomListEl = document.getElementById('room-list');
  const newRoomForm = document.getElementById('new-room-form');
  const newRoomName = document.getElementById('new-room-name');
  const newRoomPrivate = document.getElementById('new-room-private');
  const newRoomAdmins = document.getElementById('new-room-admins');
  const newRoomMembers = document.getElementById('new-room-members');
  const loadUsersBtn = document.getElementById('load-users');
  const availableUsersEl = document.getElementById('available-users');
  const refreshRoomsBtn = document.getElementById('refresh-rooms');
  const leaveBtn = document.getElementById('leave');
  const clearBtn = document.getElementById('clear');
  const deleteRoomBtn = document.getElementById('delete-room');
  const roomSettingsBtn = document.getElementById('room-settings-btn');
  const roomSettingsPanel = document.getElementById('room-settings-panel');
  const roomSettingsClose = document.getElementById('room-settings-close');
  const roomOwnerEl = document.getElementById('room-owner');
  const roomAdminsView = document.getElementById('room-admins-view');
  const roomMembersView = document.getElementById('room-members-view');
  const settingsAdmins = document.getElementById('settings-admins');
  const settingsMembers = document.getElementById('settings-members');
  const loadUsersSettingsBtn = document.getElementById('load-users-settings');
  const updateAdminsBtn = document.getElementById('update-admins');
  const updateMembersBtn = document.getElementById('update-members');
  const openCreateRoomBtn = document.getElementById('open-create-room');
  const presenceBarEl = document.getElementById('presence-bar');
  const lightboxEl = document.getElementById('lightbox');
  const lightboxImg = document.getElementById('lightbox-img');
  const passkeyInput = document.getElementById('settings-passkey');
  const copyPasskeyBtn = document.getElementById('copy-passkey');
  const generatePasskeyBtn = document.getElementById('generate-passkey');
  const setPasskeyBtn = document.getElementById('set-passkey');
  const clearPasskeyBtn = document.getElementById('clear-passkey');
  const passkeyJoinInput = document.getElementById('passkey-join-input');
  const passkeyJoinBtn = document.getElementById('passkey-join-btn');
  const contextMenu = document.getElementById('context-menu');
  const cmEditBtn = contextMenu ? contextMenu.querySelector('[data-action="edit"]') : null;
  const cmDeleteBtn = contextMenu ? contextMenu.querySelector('[data-action="delete"]') : null;
  const cmReplyBtn = contextMenu ? contextMenu.querySelector('[data-action="reply"]') : null;
  let cmTarget = null;

  // Admin context menu (room settings)
  const adminMenu = document.getElementById('admin-menu');
  const adminRemoveBtn = adminMenu ? adminMenu.querySelector('[data-action="remove-admin"]') : null;
  let adminMenuTargetId = null;

  const replyPreview = document.getElementById('reply-preview');
  const replyWho = replyPreview ? replyPreview.querySelector('.who') : null;
  const replyExcerpt = replyPreview ? replyPreview.querySelector('.preview') : null;
  const replyClose = replyPreview ? replyPreview.querySelector('.close') : null;
  let replyTarget = null; // { id, username, excerpt, type }

  let joined = false;
  let currentRoom = 'general';
  let myId = null;
  const readSent = new Set();
  const typers = new Map();
  let typingTimer = null;
  let currentRoomMeta = null;
  let canManageCurrentRoom = false;

  const EDIT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

  const STORAGE_KEY = 'ptr29_profile_v1';
  const CLIENT_ID_KEY = 'ptr29_client_id_v1';
  const PASSKEYS_KEY = 'ptr29_room_keys_v1';
  function getOrCreateClientId() {
    try {
      let id = localStorage.getItem(CLIENT_ID_KEY);
      if (id && id.length) return id;
      if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        id = crypto.randomUUID();
      } else {
        id = 'c_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      }
      localStorage.setItem(CLIENT_ID_KEY, id);
      return id;
    } catch {
      return 'c_' + Date.now().toString(36);
    }
  }

  function loadPasskeys() {
    try { return JSON.parse(localStorage.getItem(PASSKEYS_KEY) || '{}') || {}; } catch { return {}; }
  }
  function savePasskeys(map) {
    try { localStorage.setItem(PASSKEYS_KEY, JSON.stringify(map || {})); } catch {}
  }
  function getSavedPasskey(room) {
    const m = loadPasskeys();
    const r = String(room || '').trim().toLowerCase();
    return m[r] || '';
  }
  function setSavedPasskey(room, key) {
    const r = String(room || '').trim().toLowerCase();
    const m = loadPasskeys();
    if (!key) delete m[r]; else m[r] = String(key);
    savePasskeys(m);
  }

  function joinByPasskey() {
    if (!passkeyJoinInput) return;
    const raw = (passkeyJoinInput.value || '').trim();
    if (!raw) return;
    socket.emit('find-room-by-passkey', { passkey: raw }, (resp) => {
      if (resp && resp.ok && resp.room) {
        setSavedPasskey(resp.room, raw);
        joinRoom(resp.room);
        passkeyJoinInput.value = '';
      } else {
        addSystem('No room found for that passkey.');
      }
    });
  }

  function clearReplyTarget() {
    replyTarget = null;
    if (replyPreview) replyPreview.style.display = 'none';
  }

  function setReplyTargetFromEl(el) {
    if (!el) return;
    const id = (el.dataset.id || '').trim();
    if (!id) return;
    const user = (el.querySelector('.meta span:nth-of-type(1)')?.textContent || 'Anonymous');
    const type = (el.dataset.type || '').toLowerCase();
    const text = type === 'image' ? '[image]' : (el.querySelector('.body')?.textContent || '');
    const excerpt = (text || '').slice(0, 80);
    replyTarget = { id, username: user, excerpt, type };
    if (replyPreview) {
      replyWho && (replyWho.textContent = user);
      replyExcerpt && (replyExcerpt.textContent = (excerpt ? ` — ${excerpt}` : ''));
      replyPreview.style.display = 'flex';
    }
  }

  if (replyClose) replyClose.addEventListener('click', clearReplyTarget);

  if (cmReplyBtn) cmReplyBtn.addEventListener('click', () => {
    if (!cmTarget) return;
    setReplyTargetFromEl(cmTarget);
    hideContextMenu();
  });
  // ---------- Lightbox (image viewer) ----------
  function openLightbox(src, alt) {
    if (!lightboxEl || !lightboxImg) return;
    lightboxImg.src = src;
    lightboxImg.alt = alt || 'image';
    lightboxEl.classList.add('open');
  }
  function closeLightbox() {
    if (!lightboxEl) return;
    lightboxEl.classList.remove('open');
  }
  messagesEl.addEventListener('click', (e) => {
    const img = e.target.closest('img.msg-image');
    if (!img) return;
    openLightbox(img.src, img.alt);
  });
  if (lightboxEl) {
    lightboxEl.addEventListener('click', closeLightbox);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeLightbox(); });
  }

  function chip(text) {
    const span = document.createElement('span');
    span.textContent = text;
    span.style.background = '#111827';
    span.style.border = '1px solid #1f2937';
    span.style.borderRadius = '9999px';
    span.style.padding = '2px 8px';
    span.style.fontSize = '12px';
    return span;
  }

  function renderRoomMeta(meta = {}) {
    currentRoomMeta = meta;
    const ownerId = meta.ownerId || '';
    const admins = Array.isArray(meta.admins) ? meta.admins : [];
    const members = Array.isArray(meta.members) ? meta.members : [];
    // Determine manage permission early for rendering controls
    const canManage = !!(myClientId && (ownerId === myClientId || admins.includes(myClientId)));
    if (roomOwnerEl) roomOwnerEl.textContent = ownerId || '-';
    if (roomAdminsView) {
      roomAdminsView.innerHTML = '';
      admins.forEach(id => {
        const c = chip(id);
        c.dataset.adminId = id;
        // Right-click handled via delegated listener below
        roomAdminsView.appendChild(c);
      });
    }
    if (roomMembersView) {
      roomMembersView.innerHTML = '';
      members.forEach(id => roomMembersView.appendChild(chip(id)));
    }
    canManageCurrentRoom = canManage;
    if (settingsAdmins) settingsAdmins.disabled = !canManageCurrentRoom;
    if (settingsMembers) settingsMembers.disabled = !canManageCurrentRoom;
    if (updateAdminsBtn) updateAdminsBtn.disabled = !canManageCurrentRoom;
    if (updateMembersBtn) updateMembersBtn.disabled = !canManageCurrentRoom;
    if (passkeyInput) passkeyInput.disabled = !canManageCurrentRoom;
    if (copyPasskeyBtn) copyPasskeyBtn.disabled = !canManageCurrentRoom;
    if (generatePasskeyBtn) generatePasskeyBtn.disabled = !canManageCurrentRoom;
    if (setPasskeyBtn) setPasskeyBtn.disabled = !canManageCurrentRoom;
    if (clearPasskeyBtn) clearPasskeyBtn.disabled = !canManageCurrentRoom;
    if (passkeyInput) passkeyInput.value = typeof meta.passkey === 'string' ? meta.passkey : '';
    if (typeof meta.passkey === 'string' && meta.passkey && currentRoom) setSavedPasskey(currentRoom, meta.passkey);
    // #general is always public: fully disable passkey UI
    if (currentRoom === 'general') {
      if (passkeyInput) { passkeyInput.disabled = true; passkeyInput.value = ''; }
      if (copyPasskeyBtn) copyPasskeyBtn.disabled = true;
      if (generatePasskeyBtn) generatePasskeyBtn.disabled = true;
      if (setPasskeyBtn) setPasskeyBtn.disabled = true;
      if (clearPasskeyBtn) clearPasskeyBtn.disabled = true;
    }
    if (clearBtn) clearBtn.disabled = !canManageCurrentRoom;
    if (deleteRoomBtn) deleteRoomBtn.disabled = !canManageCurrentRoom || (currentRoom === 'general');
  }

  function renderPresence(users = []) {
    if (!presenceBarEl) return;
    const list = Array.isArray(users) ? users : [];
    const count = list.length;
    presenceBarEl.innerHTML = '';
    const label = document.createElement('span');
    label.textContent = `Online (${count}):`;
    presenceBarEl.appendChild(label);
    list.forEach(u => {
      const s = chip(u.username || 'Anonymous');
      s.title = `${u.username || 'Anonymous'} (${u.clientId || ''})`;
      presenceBarEl.appendChild(s);
    });
  }

  // ---------- Image upload ----------
  function readAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  if (imageBtn && imageFile) {
    imageBtn.addEventListener('click', () => {
      imageFile.click();
    });
    imageFile.addEventListener('change', async () => {
      try {
        const file = imageFile.files && imageFile.files[0];
        imageFile.value = '';
        if (!file || !currentRoom) return;
        if (!file.type || !file.type.startsWith('image/')) { alert('Please select an image file.'); return; }
        if (file.size > 10 * 1024 * 1024) { alert('Image too large (max 10MB).'); return; }
        const dataUrl = await readAsDataURL(file);
        const filename = (file.name || 'image').toLowerCase();
        const res = await fetch(`/api/rooms/${encodeURIComponent(currentRoom)}/images`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dataUrl, clientId: myClientId, filename })
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          alert('Image upload failed: ' + (err.error || res.statusText));
        }
      } catch (e) {
        alert('Image upload failed.');
      }
    });
  }
  function loadProfile() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return {};
      const p = JSON.parse(raw) || {};
      return {
        username: typeof p.username === 'string' ? p.username : '',
        avatar: typeof p.avatar === 'string' ? p.avatar : '',
      };
    } catch { return {}; }
  }

  const myClientId = getOrCreateClientId();

  // Ask server for rooms via socket and REST fallback
  async function requestRooms() {
    try { socket.emit('list-rooms'); } catch {}
    try {
      const res = await fetch(`/api/rooms?clientId=${encodeURIComponent(myClientId || '')}`);
      const data = await res.json().catch(() => ({ rooms: [] }));
      if (data && Array.isArray(data.rooms)) renderRooms(data.rooms);
    } catch {}
  }
  function saveProfile({ username, avatar }) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        username: (username || '').trim(),
        avatar: (avatar || '').trim(),
      }));
    } catch {}
  }

  function sanitizeRoom(input) {
    return String(input || 'general').trim().toLowerCase().replace(/[^a-z0-9_-]/gi, '-').slice(0, 50) || 'general';
  }

  function defaultAvatar(name) {
    const seed = encodeURIComponent(String(name || 'Anonymous'));
    return `https://api.dicebear.com/7.x/thumbs/svg?seed=${seed}`;
  }

  function setComposerEnabled(on) {
    textInput.disabled = !on;
    sendBtn.disabled = !on;
  }

  // Prefill from saved profile
  (function prefillProfile(){
    const p = loadProfile();
    usernameInput.value = p.username ? p.username : 'Anonymous';
    if (p.avatar) avatarInput.value = p.avatar;
  })();

  function addSystem(text) {
    const p = document.createElement('div');
    p.className = 'sys';
    p.textContent = text;
    messagesEl.appendChild(p);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function receiptsText(readBy = []) {
    if (!Array.isArray(readBy) || readBy.length === 0) return '';
    const names = [...new Set(readBy.map(r => r.username).filter(Boolean))];
    if (names.length === 1) return `Read by ${names[0]}`;
    if (names.length === 2) return `Read by ${names[0]} and ${names[1]}`;
    return `Read by ${names[0]}, ${names[1]} and ${names.length - 2} others`;
  }

  function addMessage({ id, userId, clientId, username, avatar, message, timestamp, readBy, edited, type, imageUrl, replyTo }) {
    const wrap = document.createElement('div');
    const isMe = (clientId && myClientId && clientId === myClientId) || (userId && myId && userId === myId);
    wrap.className = 'msg' + (isMe ? ' me' : '');
    if (id) wrap.id = `msg-${id}`;
    wrap.dataset.id = id || '';
    wrap.dataset.userId = userId || '';
    wrap.dataset.clientId = clientId || '';
    wrap.dataset.timestamp = String(timestamp || 0);
    if (type) wrap.dataset.type = String(type);
    const meta = document.createElement('div');
    meta.className = 'meta';
    const img = document.createElement('img');
    img.className = 'avatar';
    img.src = avatar || defaultAvatar(username);
    img.alt = username || 'user';
    const time = new Date(timestamp).toLocaleTimeString();
    const nameSpan = document.createElement('span');
    nameSpan.textContent = username || 'Anonymous';
    const timeSpan = document.createElement('span');
    timeSpan.textContent = `• ${time}${edited ? ' (edited)' : ''}`;
    meta.appendChild(img);
    meta.appendChild(nameSpan);
    meta.appendChild(timeSpan);
    const body = document.createElement('div');
    body.className = 'body';
    if (replyTo && (replyTo.id || replyTo.username)) {
      const rb = document.createElement('div');
      rb.className = 'reply';
      rb.dataset.refId = replyTo.id || '';
      const u = document.createElement('span');
      u.className = 'user';
      u.textContent = replyTo.username || 'Anonymous';
      const ex = document.createElement('span');
      ex.className = 'excerpt';
      ex.textContent = (replyTo.type === 'image') ? '[image]' : (replyTo.message || '').slice(0, 80);
      rb.appendChild(u);
      rb.appendChild(ex);
      rb.title = 'Click to jump to original';
      rb.addEventListener('click', () => {
        const t = rb.dataset.refId ? document.getElementById(`msg-${rb.dataset.refId}`) : null;
        if (t) { t.scrollIntoView({ behavior: 'smooth', block: 'center' }); t.style.outline = '1px solid #2563eb'; setTimeout(() => { t.style.outline = ''; }, 900); }
      });
      wrap.appendChild(rb);
    }
    if (type === 'image' && imageUrl) {
      const img = document.createElement('img');
      img.className = 'msg-image';
      img.src = imageUrl;
      img.alt = username ? `${username}'s image` : 'image';
      img.loading = 'lazy';
      body.appendChild(img);
    } else {
      body.textContent = message || '';
    }
    const receipts = document.createElement('div');
    receipts.className = 'receipts';
    receipts.textContent = receiptsText(readBy);
    receipts.dataset.readBy = JSON.stringify(readBy || []);
    wrap.appendChild(meta);
    wrap.appendChild(body);
    wrap.appendChild(receipts);

    if (isMe && id) {
      const actions = document.createElement('div');
      actions.className = 'actions';

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.textContent = 'Edit';
      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.textContent = 'Delete';

      const disableIfExpired = () => {
        const remaining = (timestamp || 0) + EDIT_WINDOW_MS - Date.now();
        editBtn.disabled = (type === 'image') || remaining <= 0;
      };
      // initial and schedule disable after window
      disableIfExpired();
      const remainingMs = (timestamp || 0) + EDIT_WINDOW_MS - Date.now();
      if (remainingMs > 0) setTimeout(disableIfExpired, remainingMs + 50);

      editBtn.addEventListener('click', async () => {
        const currentText = body.textContent || '';
        const next = prompt('Edit message:', currentText);
        if (next == null) return;
        const text = String(next).trim();
        if (!text || text === currentText) return;
        try {
          const res = await fetch(`/api/rooms/${encodeURIComponent(currentRoom)}/messages/${encodeURIComponent(id)}/edit`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, userId: myId, clientId: myClientId }),
          });
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            alert('Edit failed: ' + (err.error || res.statusText));
          }
        } catch (e) {
          alert('Edit failed.');
        }
      });

  // ----- Admin context menu -----
  function hideAdminMenu() {
    if (!adminMenu) return;
    adminMenu.style.display = 'none';
    adminMenuTargetId = null;
  }

  function showAdminContextMenu(clientX, clientY, adminId) {
    if (!adminMenu) return;
    const owner = (currentRoomMeta && currentRoomMeta.ownerId) || '';
    const allowed = canManageCurrentRoom && adminId && adminId !== owner;
    if (!allowed) { hideAdminMenu(); return; }
    adminMenuTargetId = adminId;
    if (adminRemoveBtn) adminRemoveBtn.disabled = !allowed;
    adminMenu.style.display = 'block';
    const rect = adminMenu.getBoundingClientRect();
    const x = clamp(clientX, 8, window.innerWidth - rect.width - 8);
    const y = clamp(clientY, 8, window.innerHeight - rect.height - 8);
    adminMenu.style.left = `${x}px`;
    adminMenu.style.top = `${y}px`;
  }

  if (roomAdminsView) {
    roomAdminsView.addEventListener('contextmenu', (e) => {
      const chipEl = e.target.closest('[data-admin-id]');
      if (!chipEl) return;
      e.preventDefault();
      const id = chipEl.dataset.adminId || '';
      showAdminContextMenu(e.clientX, e.clientY, id);
    });
  }

  if (adminRemoveBtn) adminRemoveBtn.addEventListener('click', () => {
    if (!adminMenuTargetId) { hideAdminMenu(); return; }
    const nextAdmins = (Array.isArray(currentRoomMeta && currentRoomMeta.admins) ? currentRoomMeta.admins : []).filter(a => a !== adminMenuTargetId);
    const sure = confirm(`Remove admin:\n${adminMenuTargetId}?`);
    if (sure) socket.emit('set-room-admins', { room: currentRoom, admins: nextAdmins });
    hideAdminMenu();
  });

  document.addEventListener('click', (e) => {
    if (!adminMenu || adminMenu.style.display !== 'block') return;
    if (!e.target.closest('#admin-menu')) hideAdminMenu();
  });
  window.addEventListener('resize', hideAdminMenu);
  document.addEventListener('scroll', hideAdminMenu, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideAdminMenu(); });

      deleteBtn.addEventListener('click', async () => {
        const sure = confirm('Delete this message?');
        if (!sure) return;
        try {
          const res = await fetch(`/api/rooms/${encodeURIComponent(currentRoom)}/messages/${encodeURIComponent(id)}/delete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: myId, clientId: myClientId }),
          });
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            alert('Delete failed: ' + (err.error || res.statusText));
          }
        } catch (e) {
          alert('Delete failed.');
        }
      });

      if (type !== 'image') actions.appendChild(editBtn);
      actions.appendChild(deleteBtn);
      wrap.appendChild(actions);
    }
    messagesEl.appendChild(wrap);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function renderTyping() {
    const active = [...typers.values()].filter(t => t.isTyping && Date.now() - t.last < 2500).map(t => t.username);
    if (!active.length) { typingEl.textContent = ''; return; }
    const unique = [...new Set(active)];
    const text = unique.length === 1 ? `${unique[0]} is typing...` : `${unique.slice(0, 2).join(', ')}${unique.length > 2 ? ' and others' : ''} are typing...`;
    typingEl.textContent = text;
  }

  function renderRooms(rooms = []) {
    roomListEl.innerHTML = rooms.map(r => {
      const active = r.name === currentRoom ? ' active' : '';
      const lock = r.isPrivate ? '🔒 ' : '';
      return `<div class="room${active}" data-room="${r.name}"><span>${lock}#${r.name}</span><span style="margin-left:auto;color:#6b7280;font-size:12px">${r.messagesCount || 0}</span></div>`;
    }).join('');
  }

  function updateReceipt(messageId, { userId, username }) {
    const el = document.getElementById(`msg-${messageId}`);
    if (!el) return;
    const receipts = el.querySelector('.receipts');
    if (!receipts) return;
    let list = [];
    try { list = JSON.parse(receipts.dataset.readBy || '[]'); } catch {}
    if (!list.find(r => r.userId === userId)) {
      list.push({ userId, username });
      receipts.dataset.readBy = JSON.stringify(list);
      receipts.textContent = receiptsText(list);
    }
  }

  function joinRoom(room) {
    const name = usernameInput.value.trim() || 'Anonymous';
    const avatar = (avatarInput && avatarInput.value || '').trim();
    currentRoom = sanitizeRoom(room || currentRoom || 'general');
    roomNameEl.textContent = currentRoom;
    if (!joined) joined = true;
    const passkey = getSavedPasskey(currentRoom);
    socket.emit('join', { username: name, avatar, room: currentRoom, clientId: myClientId, passkey });
    setComposerEnabled(true);
    requestRooms();
    socket.emit('get-room-meta', { room: currentRoom });
    if (presenceBarEl) presenceBarEl.innerHTML = '';
    if (deleteRoomBtn) deleteRoomBtn.disabled = (currentRoom === 'general');
  }

  socket.on('connect', () => { myId = socket.id; });
  socket.on('connect', () => { requestRooms(); });
  socket.on('system', (evt) => addSystem(evt.message));
  socket.on('rooms', (rooms) => renderRooms(rooms));
  socket.on('room-deleted', ({ room }) => {
    addSystem(`#${room} was deleted`);
    try { if (room) setSavedPasskey(room, ''); } catch {}
    if (currentRoom === room) {
      currentRoom = 'general';
      roomNameEl.textContent = 'general';
      messagesEl.innerHTML = '';
      if (presenceBarEl) presenceBarEl.innerHTML = '';
      if (roomSettingsPanel) roomSettingsPanel.style.display = 'none';
      if (deleteRoomBtn) deleteRoomBtn.disabled = true;
      joinRoom('general');
    }
  });
  socket.on('history', ({ room, messages }) => {
    if (room !== currentRoom) return;
    messagesEl.innerHTML = '';
    (messages || []).forEach(addMessage);
    (messages || []).forEach(m => {
      if (m.id && m.userId !== myId && !readSent.has(m.id)) {
        socket.emit('read-receipt', { messageId: m.id });
        readSent.add(m.id);
      }
    });
  });
  socket.on('typing', (evt) => {
    if (!evt || typeof evt !== 'object') return;
    typers.set(evt.userId, { username: evt.username || 'Someone', last: Date.now(), isTyping: !!evt.isTyping });
    renderTyping();
    setTimeout(renderTyping, 2600);
  });
  socket.on('read-receipt', ({ messageId, userId, username }) => updateReceipt(messageId, { userId, username }));
  socket.on('chat-message', (payload) => {
    addMessage(payload);
    if (payload.userId && payload.userId !== myId && !readSent.has(payload.id)) {
      socket.emit('read-receipt', { messageId: payload.id });
      readSent.add(payload.id);
    }
  });
  socket.on('message-updated', (msg) => {
    const el = document.getElementById(`msg-${msg.id}`);
    if (!el) return;
    const body = el.querySelector('.body');
    if (body) {
      body.innerHTML = '';
      if (msg.replyTo && (msg.replyTo.id || msg.replyTo.username)) {
        const rb = document.createElement('div');
        rb.className = 'reply';
        rb.dataset.refId = msg.replyTo.id || '';
        const u = document.createElement('span');
        u.className = 'user';
        u.textContent = msg.replyTo.username || 'Anonymous';
        const ex = document.createElement('span');
        ex.className = 'excerpt';
        ex.textContent = (msg.replyTo.type === 'image') ? '[image]' : (msg.replyTo.message || '').slice(0, 80);
        rb.appendChild(u);
        rb.appendChild(ex);
        rb.title = 'Click to jump to original';
        rb.addEventListener('click', () => {
          const t = rb.dataset.refId ? document.getElementById(`msg-${rb.dataset.refId}`) : null;
          if (t) { t.scrollIntoView({ behavior: 'smooth', block: 'center' }); t.style.outline = '1px solid #2563eb'; setTimeout(() => { t.style.outline = ''; }, 900); }
        });
        body.appendChild(rb);
      }
      // Only text messages are editable; keep rendering text
      const textNode = document.createElement('div');
      textNode.textContent = msg.message || '';
      body.appendChild(textNode);
    }
    const metaSpans = el.querySelectorAll('.meta span');
    if (metaSpans && metaSpans[2]) {
      const time = new Date(msg.timestamp).toLocaleTimeString();
      metaSpans[2].textContent = `• ${time}${msg.edited ? ' (edited)' : ''}`;
    }
  });
  socket.on('message-deleted', ({ messageId }) => {
    const el = document.getElementById(`msg-${messageId}`);
    if (el && el.parentNode) el.parentNode.removeChild(el);
  });

  socket.on('presence', ({ room, users }) => {
    if (room !== currentRoom) return;
    renderPresence(users);
  });

  socket.on('room-meta', ({ room, meta }) => {
    if (room !== currentRoom) return;
    renderRoomMeta(meta || {});
  });

  socket.on('passkey-required', ({ room }) => {
    const target = sanitizeRoom(room);
    if (!target) return;
    const key = prompt(`Enter passkey for #${target}`);
    if (!key) { addSystem(`Join to #${target} cancelled.`); return; }
    setSavedPasskey(target, key.trim());
    joinRoom(target);
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = usernameInput.value.trim() || 'Anonymous';
    const avatar = (avatarInput && avatarInput.value || '').trim();
    const text = textInput.value.trim();
    saveProfile({ username: name, avatar });
    if (!joined) {
      joined = true;
      const passkey = getSavedPasskey(currentRoom);
      socket.emit('join', { username: name, avatar, room: currentRoom, clientId: myClientId, passkey });
    }
    if (!text) return;
    const payload = (replyTarget && replyTarget.id) ? { text, replyTo: replyTarget.id } : { text };
    socket.emit('chat-message', payload);
    textInput.value = '';
    textInput.focus();
    clearReplyTarget();
  });

  usernameInput.addEventListener('change', () => {
    const name = usernameInput.value.trim();
    if (!name) return;
    saveProfile({ username: name, avatar: (avatarInput && avatarInput.value || '').trim() });
    joinRoom(currentRoom);
  });

  avatarInput.addEventListener('change', () => {
    const name = usernameInput.value.trim() || 'Anonymous';
    const avatar = (avatarInput && avatarInput.value || '').trim();
    saveProfile({ username: name, avatar });
    if (joined) joinRoom(currentRoom);
  });
  textInput.addEventListener('input', () => {
    if (!joined) return;
    socket.emit('typing', { isTyping: true });
    if (typingTimer) clearTimeout(typingTimer);
    typingTimer = setTimeout(() => socket.emit('typing', { isTyping: false }), 2000);
  });

  if (newRoomForm) {
    newRoomForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const nm = sanitizeRoom(newRoomName.value);
      if (!nm) return;
      const isPrivate = !!(newRoomPrivate && newRoomPrivate.checked);
      const admins = Array.from((newRoomAdmins && newRoomAdmins.options) || []).filter(o => o.selected).map(o => o.value).filter(Boolean);
      const members = Array.from((newRoomMembers && newRoomMembers.options) || []).filter(o => o.selected).map(o => o.value).filter(Boolean);
      socket.emit('create-room', { name: nm, isPrivate, admins, members });
      joinRoom(nm);
      newRoomName.value = '';
    });
  }

  if (refreshRoomsBtn) refreshRoomsBtn.addEventListener('click', () => { requestRooms(); });

  roomListEl.addEventListener('click', (e) => {
    const item = e.target.closest('.room');
    if (!item) return;
    const nm = item.dataset.room;
    joinRoom(nm);
  });

  if (leaveBtn) leaveBtn.addEventListener('click', () => {
    socket.emit('leave-room');
    currentRoom = '';
    roomNameEl.textContent = '-';
    messagesEl.innerHTML = '';
    setComposerEnabled(false);
  });

  clearBtn.addEventListener('click', (e) => {
    e.preventDefault();
    if (!currentRoom) return;
    const sure = confirm(`Clear all messages in #${currentRoom}?`);
    if (!sure) return;
    socket.emit('clear-room');
  });

  deleteRoomBtn.addEventListener('click', (e) => {
    e.preventDefault();
    if (!currentRoom || currentRoom === 'general') {
      alert('Cannot delete the default room.');
      return;
    }
    const sure = confirm(`Delete room #${currentRoom} for everyone? This cannot be undone.`);
    if (!sure) return;
    // Prefer REST to ensure persistence, fallback to socket
    fetch(`/api/rooms/${encodeURIComponent(currentRoom)}/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId: myClientId }) })
      .then(async (res) => {
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || 'Failed to delete room');
        }
        addSystem(`#${currentRoom} deleted`);
        // Switch to general and refresh rooms
        currentRoom = 'general';
        roomNameEl.textContent = 'general';
        messagesEl.innerHTML = '';
        if (deleteRoomBtn) deleteRoomBtn.disabled = true;
        requestRooms();
        joinRoom('general');
      })
      .catch(() => {
        socket.emit('delete-room');
      });
  });

  // ---------- Room settings panel ----------
  if (roomSettingsBtn) roomSettingsBtn.addEventListener('click', async () => {
    if (roomSettingsPanel) roomSettingsPanel.style.display = 'block';
    socket.emit('get-room-meta', { room: currentRoom });
    // Optionally load users
    if (loadUsersSettingsBtn) loadUsersSettingsBtn.click();
  });
  if (roomSettingsClose) roomSettingsClose.addEventListener('click', () => {
    if (roomSettingsPanel) roomSettingsPanel.style.display = 'none';
  });

  function fillSettingsSelectors(users = []) {
    const opts = users.map(u => `<option value="${u.clientId}">${u.username || 'Anonymous'} — ${u.clientId}</option>`).join('');
    if (settingsAdmins) settingsAdmins.innerHTML = opts;
    if (settingsMembers) settingsMembers.innerHTML = opts;
    // preselect based on current meta
    if (currentRoomMeta) {
      const adminsSet = new Set(Array.isArray(currentRoomMeta.admins) ? currentRoomMeta.admins : []);
      const membersSet = new Set(Array.isArray(currentRoomMeta.members) ? currentRoomMeta.members : []);
      Array.from((settingsAdmins && settingsAdmins.options) || []).forEach(o => { o.selected = adminsSet.has(o.value); });
      Array.from((settingsMembers && settingsMembers.options) || []).forEach(o => { o.selected = membersSet.has(o.value); });
    }
    renderSettingsSelectedAdmins();
  }

  function renderSettingsSelectedAdmins() {
    const wrap = document.getElementById('settings-admins-selected');
    if (!wrap || !settingsAdmins) return;
    const selected = Array.from(settingsAdmins.options || []).filter(o => o.selected);
    wrap.innerHTML = '';
    selected
      .filter(o => o && o.value && o.value !== myClientId)
      .forEach(o => {
        const chip = document.createElement('span');
        chip.textContent = o.textContent || o.value;
        chip.style.background = '#111827';
        chip.style.border = '1px solid #1f2937';
        chip.style.borderRadius = '9999px';
        chip.style.padding = '2px 6px';
        chip.style.fontSize = '12px';
        chip.style.display = 'inline-flex';
        chip.style.alignItems = 'center';
        chip.style.gap = '6px';
        const x = document.createElement('button');
        x.type = 'button';
        x.textContent = '×';
        x.style.background = 'transparent';
        x.style.color = '#e2e8f0';
        x.style.border = '0';
        x.style.cursor = 'pointer';
        x.addEventListener('click', () => {
          o.selected = false;
          renderSettingsSelectedAdmins();
        });
        chip.appendChild(x);
        wrap.appendChild(chip);
      });
  }

  if (settingsAdmins) settingsAdmins.addEventListener('change', renderSettingsSelectedAdmins);

  if (loadUsersSettingsBtn) loadUsersSettingsBtn.addEventListener('click', async () => {
    try {
      const res = await fetch('/api/users');
      const data = await res.json().catch(() => ({ users: [] }));
      fillSettingsSelectors(Array.isArray(data.users) ? data.users : []);
    } catch {}
  });

  if (updateAdminsBtn) updateAdminsBtn.addEventListener('click', () => {
    const admins = Array.from((settingsAdmins && settingsAdmins.options) || []).filter(o => o.selected).map(o => o.value).filter(Boolean);
    socket.emit('set-room-admins', { room: currentRoom, admins });
  });
  if (updateMembersBtn) updateMembersBtn.addEventListener('click', () => {
    const members = Array.from((settingsMembers && settingsMembers.options) || []).filter(o => o.selected).map(o => o.value).filter(Boolean);
    socket.emit('set-room-members', { room: currentRoom, members });
  });

  if (copyPasskeyBtn) copyPasskeyBtn.addEventListener('click', async () => {
    if (!passkeyInput) return;
    const v = (passkeyInput.value || '').trim();
    if (!v) return;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(v);
      else {
        const ta = document.createElement('textarea');
        ta.value = v; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
      }
    } catch {}
  });
  if (generatePasskeyBtn) generatePasskeyBtn.addEventListener('click', () => {
    socket.emit('generate-room-passkey', { room: currentRoom }, (resp) => {
      if (resp && resp.ok) {
        if (passkeyInput) passkeyInput.value = resp.passkey || '';
        setSavedPasskey(currentRoom, resp.passkey || '');
        addSystem('New passkey generated.');
      } else {
        addSystem(`Failed to generate passkey${resp && resp.error ? `: ${resp.error}` : ''}`);
      }
    });
  });
  if (setPasskeyBtn) setPasskeyBtn.addEventListener('click', () => {
    const v = (passkeyInput && passkeyInput.value || '').trim();
    socket.emit('set-room-passkey', { room: currentRoom, passkey: v }, (resp) => {
      if (resp && resp.ok) {
        setSavedPasskey(currentRoom, resp.passkey || '');
        addSystem('Passkey saved.');
      } else {
        const reason = (resp && resp.error === 'in_use') ? 'Passkey already in use by another room.' : (resp && resp.error) || 'failed';
        addSystem(`Failed to save passkey: ${reason}`);
      }
    });
  });
  if (clearPasskeyBtn) clearPasskeyBtn.addEventListener('click', () => {
    socket.emit('set-room-passkey', { room: currentRoom, passkey: '' }, (resp) => {
      if (resp && resp.ok) {
        setSavedPasskey(currentRoom, '');
        if (passkeyInput) passkeyInput.value = '';
        addSystem('Passkey cleared.');
      } else {
        addSystem(`Failed to clear passkey${resp && resp.error ? `: ${resp.error}` : ''}`);
      }
    });
  });

  if (passkeyJoinBtn) passkeyJoinBtn.addEventListener('click', () => {
    joinByPasskey();
  });
  if (passkeyJoinInput) passkeyJoinInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); joinByPasskey(); }
  });

  // --------- Users loading for admins/members selection ---------
  function renderUsersLists(users = []) {
    const opts = users.map(u => `<option value="${u.clientId}">${u.username || 'Anonymous'} — ${u.clientId}</option>`).join('');
    if (newRoomAdmins) newRoomAdmins.innerHTML = opts;
    if (newRoomMembers) newRoomMembers.innerHTML = opts;
    if (availableUsersEl) {
      availableUsersEl.innerHTML = users.map(u => {
        const name = (u.username || 'Anonymous').replace(/</g, '&lt;');
        const id = (u.clientId || '').replace(/</g, '&lt;');
        return `<span data-id="${id}" title="${id}" style="background:#111827;border:1px solid #1f2937;border-radius:9999px;padding:4px 8px;font-size:12px">${name}</span>`;
      }).join('');
    }
  }

  if (loadUsersBtn) {
    loadUsersBtn.addEventListener('click', async () => {
      try {
        const res = await fetch('/api/users');
        const data = await res.json().catch(() => ({ users: [] }));
        renderUsersLists(Array.isArray(data.users) ? data.users : []);
      } catch {}
    });
  }

  // Create-room helpers
  function fillCreateAdmins(users = []) {
    const el = document.getElementById('room-admins');
    if (!el) return;
    el.innerHTML = users.map(u => {
      const id = (u.clientId || '');
      const name = (u.username || 'Anonymous').replace(/</g,'&lt;');
      const value = id.replace(/</g,'&lt;');
      const dis = (id === myClientId) ? ' disabled' : '';
      return `<option value="${value}"${dis}>${name} — ${value}</option>`;
    }).join('');
    renderCreateSelectedAdmins();
  }

  if (openCreateRoomBtn) {
    openCreateRoomBtn.addEventListener('click', async () => {
      // Reset fields
      const nameEl = document.getElementById('create-room-name');
      const privEl = document.getElementById('room-private');
      const adminsEl = document.getElementById('room-admins');
      if (nameEl) nameEl.value = '';
      if (privEl) privEl.checked = false;
      if (adminsEl) adminsEl.disabled = true;
      // Load users into admin list
      try {
        const res = await fetch('/api/users');
        const data = await res.json().catch(() => ({ users: [] }));
        fillCreateAdmins(Array.isArray(data.users) ? data.users : []);
      } catch {}
      // Clear selected chips area and render empty state
      const sel = document.getElementById('create-admins-selected');
      if (sel) sel.innerHTML = '';
      renderCreateSelectedAdmins();
      openRoomPanel();
    });
  }

  function renderCreateSelectedAdmins() {
    const wrap = document.getElementById('create-admins-selected');
    const select = document.getElementById('room-admins');
    if (!wrap || !select) return;
    const selected = Array.from(select.selectedOptions || []);
    wrap.innerHTML = '';
    selected
      .filter(o => o && o.value && o.value !== myClientId)
      .forEach(o => {
        const chip = document.createElement('span');
        chip.textContent = o.textContent || o.value;
        chip.style.background = '#111827';
        chip.style.border = '1px solid #1f2937';
        chip.style.borderRadius = '9999px';
        chip.style.padding = '2px 6px';
        chip.style.fontSize = '12px';
        chip.style.display = 'inline-flex';
        chip.style.alignItems = 'center';
        chip.style.gap = '6px';
        const x = document.createElement('button');
        x.type = 'button';
        x.textContent = '×';
        x.style.background = 'transparent';
        x.style.color = '#e2e8f0';
        x.style.border = '0';
        x.style.cursor = 'pointer';
        x.addEventListener('click', () => {
          // Unselect this option
          o.selected = false;
          renderCreateSelectedAdmins();
        });
        chip.appendChild(x);
        wrap.appendChild(chip);
      });
  }

  // Update chips when selection changes
  document.addEventListener('change', (e) => {
    if ((e.target && e.target.id) === 'room-admins') renderCreateSelectedAdmins();
  }, true);

  // ---------- Context menu for message actions ----------
  function hideContextMenu() {
    if (!contextMenu) return;
    contextMenu.style.display = 'none';
    cmTarget = null;
  }

  function clamp(val, min, max) { return Math.max(min, Math.min(max, val)); }

  function showContextMenuFor(targetEl, clientX, clientY) {
    if (!contextMenu) return;
    const userId = targetEl.dataset.userId || '';
    const cId = targetEl.dataset.clientId || '';
    const isMine = (myClientId && cId && cId === myClientId) || (userId && myId && userId === myId);
    cmTarget = targetEl;
    const ts = parseInt(targetEl.dataset.timestamp || '0', 10) || 0;
    const remaining = ts + EDIT_WINDOW_MS - Date.now();
    const msgType = (targetEl.dataset.type || '').toLowerCase();
    if (cmEditBtn) cmEditBtn.disabled = (!isMine) || (msgType === 'image') || remaining <= 0;
    if (cmDeleteBtn) cmDeleteBtn.disabled = (!isMine);
    if (cmReplyBtn) cmReplyBtn.disabled = !(targetEl.dataset.id);

    contextMenu.style.display = 'block';
    const rect = contextMenu.getBoundingClientRect();
    const x = clamp(clientX, 8, window.innerWidth - rect.width - 8);
    const y = clamp(clientY, 8, window.innerHeight - rect.height - 8);
    contextMenu.style.left = `${x}px`;
    contextMenu.style.top = `${y}px`;
  }

  messagesEl.addEventListener('contextmenu', (e) => {
    const msgEl = e.target.closest('.msg');
    if (!msgEl) return;
    e.preventDefault();
    showContextMenuFor(msgEl, e.clientX, e.clientY);
  });

  document.addEventListener('click', (e) => {
    if (!contextMenu || contextMenu.style.display !== 'block') return;
    if (!e.target.closest('#context-menu')) hideContextMenu();
  });
  window.addEventListener('resize', hideContextMenu);
  document.addEventListener('scroll', hideContextMenu, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideContextMenu(); });

  if (cmEditBtn) cmEditBtn.addEventListener('click', async () => {
    if (!cmTarget) return;
    const id = (cmTarget.dataset.id || '').trim();
    const currentText = (cmTarget.querySelector('.body')?.textContent || '').trim();
    const next = prompt('Edit message:', currentText);
    if (next == null) return; // cancelled
    const text = String(next).trim();
    if (!text || text === currentText) { hideContextMenu(); return; }
    try {
      const res = await fetch(`/api/rooms/${encodeURIComponent(currentRoom)}/messages/${encodeURIComponent(id)}/edit`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, userId: myId, clientId: myClientId })
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert('Edit failed: ' + (err.error || res.statusText));
      }
    } catch {}
    hideContextMenu();
  });

  if (cmDeleteBtn) cmDeleteBtn.addEventListener('click', async () => {
    if (!cmTarget) return;
    const id = (cmTarget.dataset.id || '').trim();
    const sure = confirm('Delete this message?');
    if (!sure) { hideContextMenu(); return; }
    try {
      const res = await fetch(`/api/rooms/${encodeURIComponent(currentRoom)}/messages/${encodeURIComponent(id)}/delete`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: myId, clientId: myClientId })
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert('Delete failed: ' + (err.error || res.statusText));
      }
    } catch {}
    hideContextMenu();
  });

  // Auto-join default room
  joinRoom('general');

  function removeAdmin(adminId) {
    if (!adminId || !currentRoom) return;
    const nextAdmins = (Array.isArray(currentRoomMeta && currentRoomMeta.admins) ? currentRoomMeta.admins : []).filter(a => a !== adminId);
    socket.emit('set-room-admins', { room: currentRoom, admins: nextAdmins });
  }

  function removeMember(memberId) {
    if (!memberId || !currentRoom) return;
    const nextMembers = (Array.isArray(currentRoomMeta && currentRoomMeta.members) ? currentRoomMeta.members : []).filter(m => m !== memberId);
    socket.emit('set-room-members', { room: currentRoom, members: nextMembers });
  }

  socket.on('remove-admin', ({ adminId }) => {
    removeAdmin(adminId);
  });

  socket.on('remove-member', ({ memberId }) => {
    removeMember(memberId);
  });

  function openRoomPanel() {
    document.getElementById('create-room-panel').style.display = 'block';
  }

  function closeRoomPanel() {
    document.getElementById('create-room-panel').style.display = 'none';
  }

  const createRoomForm = document.getElementById('create-room-form');
  if (createRoomForm) {
    createRoomForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const raw = (document.getElementById('create-room-name').value || '').trim();
      // Sanitize without defaulting to 'general'
      const cleaned = raw.toLowerCase().replace(/[^a-z0-9_-]/gi, '-').slice(0, 50).replace(/^-+|-+$/g, '');
      if (!cleaned) { alert('Please enter a valid room name.'); return; }
      if (cleaned === 'general') { alert('Cannot create the default room name. Choose another.'); return; }
      const name = cleaned;
      const isPrivate = !!(document.getElementById('room-private') && document.getElementById('room-private').checked);
      const admins = isPrivate ? Array.from((document.getElementById('room-admins') && document.getElementById('room-admins').selectedOptions) || []).map(o => o.value) : [];

      try {
        const res = await fetch('/api/rooms', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, isPrivate, ownerId: myClientId, admins })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data || data.error) throw new Error(data && data.error || res.statusText || 'failed');
        // join the created (or existing) room immediately
        joinRoom(name);
        requestRooms();
        closeRoomPanel();
      } catch (err) {
        // Fallback to socket emit
        try {
          socket.emit('create-room', { name, isPrivate, admins });
          joinRoom(name);
          requestRooms();
          closeRoomPanel();
        } catch {
          alert('Create room failed.');
        }
      }
    });
  }

  const roomPrivateCheckbox = document.getElementById('room-private');
  const roomAdminsSelect = document.getElementById('room-admins');

  if (roomPrivateCheckbox && roomAdminsSelect) {
    roomPrivateCheckbox.addEventListener('change', () => {
      roomAdminsSelect.disabled = !roomPrivateCheckbox.checked;
    });

    // Initialize state
    roomAdminsSelect.disabled = !roomPrivateCheckbox.checked;
  }
})();
