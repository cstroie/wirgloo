'use strict';

// ── State ────────────────────────────────────────────────────────────────────
const state = {
  ws: null,
  nick: '',
  connected: false,
  sessionId: null,
  // Map<target, {messages: [], nicks: Set, unread: number, mention: boolean}>
  channels: new Map(),
  active: null,
};

let reconnectDelay = 1000;

// ── DOM refs ─────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const connectScreen = $('connect-screen');
const chatScreen    = $('chat-screen');
const connectForm   = $('connect-form');
const connectError  = $('connect-error');
const myNick        = $('my-nick');
const channelList   = $('channel-list');
const messages      = $('messages');
const targetName    = $('target-name');
const topicText     = $('topic-text');
const input         = $('input');
const userlist      = $('userlist');

// ── Connect form ─────────────────────────────────────────────────────────────
connectForm.addEventListener('submit', e => {
  e.preventDefault();
  const server = $('server').value.trim();
  const port   = parseInt($('port').value);
  const nick   = $('nick').value.trim();
  const tls    = $('tls').checked;
  if (!server || !nick) return;
  connectError.classList.add('hidden');
  connectScreen.classList.add('hidden');
  chatScreen.classList.remove('hidden');
  ensureChannel('*server*');
  setActive('*server*');
  myNick.textContent = nick;
  appendMsg('*server*', { type: 'connecting', nick: '--', text: `Connecting to ${server}:${port}…` });
  openWS(server, port, nick, tls);
});

$('tls').addEventListener('change', function() {
  $('port').value = this.checked ? 6697 : 6667;
});

function openWS(server, port, nick, tls) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  state.ws = ws;

  ws.onopen = () => {
    send({ type: 'connect', server, port, nick, tls });
  };

  ws.onmessage = e => {
    try { handle(JSON.parse(e.data)); } catch {}
  };

  ws.onerror = () => {};
  ws.onclose = () => {
    if (state.sessionId) scheduleReconnect();
    else if (state.connected) onDisconnect('Connection lost');
    else onConnectFailed('Connection closed');
  };
}

// ── Message handler ───────────────────────────────────────────────────────────
function handle(msg) {
  switch (msg.type) {
    case 'connected':
      state.connected = true;
      state.sessionId = msg.session;
      state.nick = msg.nick;
      reconnectDelay = 1000;
      myNick.textContent = msg.nick;
      appendMsg('*server*', { type: 'system', nick: '--', text: `Connected as ${msg.nick}` });
      break;

    case 'resumed':
      state.connected = true;
      reconnectDelay = 1000;
      appendMsg('*server*', { type: 'system', nick: '--', text: 'Reconnected' });
      break;

    case 'session_expired':
      state.sessionId = null;
      state.connected = false;
      state.ws?.close();
      state.channels.clear();
      state.active = null;
      chatScreen.classList.add('hidden');
      connectScreen.classList.remove('hidden');
      showConnectError('Disconnected — server was restarted');
      break;

    case 'message': {
      const target = msg.target.startsWith('#') ? msg.target : msg.from;
      ensureChannel(target);
      const isMe = msg.text.startsWith('/me ');
      const cls  = isMe ? 'me' : (msg.text.includes(state.nick) ? 'mention' : '');
      appendMsg(target, { type: cls || 'msg', nick: msg.from, text: msg.text, ts: msg.ts });
      if (target !== state.active) bumpUnread(target, cls === 'mention');
      break;
    }

    case 'notice':
      if (!state.connected) { appendMsg('*server*', { type: 'connecting', nick: msg.from || '--', text: msg.text, ts: msg.ts }); break; }
      appendMsg(state.active || '*server*', { type: 'notice', nick: msg.from, text: msg.text, ts: msg.ts });
      break;

    case 'join':
      if (msg.nick === state.nick) {
        ensureChannel(msg.channel);
        setActive(msg.channel);
      } else {
        ensureChannel(msg.channel);
        state.channels.get(msg.channel)?.nicks.add(msg.nick);
        renderUserlist();
        appendMsg(msg.channel, { type: 'join', nick: '', text: `→ ${msg.nick} joined ${msg.channel}` });
      }
      break;

    case 'part':
      if (msg.nick === state.nick) {
        removeChannel(msg.channel);
      } else {
        state.channels.get(msg.channel)?.nicks.delete(msg.nick);
        renderUserlist();
        appendMsg(msg.channel, { type: 'part', nick: '', text: `← ${msg.nick} left ${msg.channel}` });
      }
      break;

    case 'quit':
      state.channels.forEach((ch, target) => {
        if (ch.nicks.has(msg.nick)) {
          ch.nicks.delete(msg.nick);
          appendMsg(target, { type: 'quit', nick: '', text: `← ${msg.nick} quit (${msg.text})` });
        }
      });
      renderUserlist();
      break;

    case 'nick':
      if (msg.old === state.nick) {
        state.nick = msg.new;
        myNick.textContent = msg.new;
      }
      state.channels.forEach((ch, target) => {
        if (ch.nicks.has(msg.old)) {
          ch.nicks.delete(msg.old);
          ch.nicks.add(msg.new);
          appendMsg(target, { type: 'system', nick: '', text: `${msg.old} is now known as ${msg.new}` });
        }
      });
      renderUserlist();
      break;

    case 'names': {
      const ch = state.channels.get(msg.channel);
      if (ch) {
        ch.nicks = new Set(msg.nicks.map(n => n.replace(/^[@+]/, '')));
        renderUserlist();
      }
      break;
    }

    case 'error':
      if (!state.connected) { onConnectFailed(msg.text); break; }
      appendMsg(state.active || '*server*', { type: 'error', nick: '!', text: msg.text });
      break;

    case 'disconnected':
      onDisconnect(msg.text);
      break;
  }
}

// ── Channels ──────────────────────────────────────────────────────────────────
function ensureChannel(target) {
  if (!state.channels.has(target)) {
    state.channels.set(target, { messages: [], nicks: new Set(), unread: 0, mention: false });
    renderChannelList();
  }
}

function removeChannel(target) {
  state.channels.delete(target);
  if (state.active === target) {
    const next = state.channels.keys().next().value;
    setActive(next || null);
  }
  renderChannelList();
}

function setActive(target) {
  if (!target || !state.channels.has(target)) return;
  state.active = target;
  const ch = state.channels.get(target);
  ch.unread  = 0;
  ch.mention = false;
  renderChannelList();
  renderMessages(target);
  renderUserlist();
  targetName.textContent = target;
  input.focus();
}

function bumpUnread(target, mention) {
  const ch = state.channels.get(target);
  if (!ch) return;
  ch.unread++;
  if (mention) ch.mention = true;
  renderChannelList();
}

// ── Render ────────────────────────────────────────────────────────────────────
function renderChannelList() {
  channelList.innerHTML = '';
  state.channels.forEach((ch, target) => {
    const el = document.createElement('div');
    el.className = 'chan-item' +
      (target === state.active ? ' active' : '') +
      (ch.mention ? ' mention' : ch.unread > 0 ? ' unread' : '');
    el.innerHTML = `<span>${escHtml(target)}</span>`;
    if (ch.unread > 0) {
      el.innerHTML += `<span class="unread-badge">${ch.unread}</span>`;
    } else if (target !== '*server*') {
      el.innerHTML += `<button class="close-btn" data-target="${escHtml(target)}">×</button>`;
    }
    el.addEventListener('click', ev => {
      if (ev.target.classList.contains('close-btn')) {
        const t = ev.target.dataset.target;
        if (t.startsWith('#')) send({ type: 'part', channel: t });
        else removeChannel(t);
        return;
      }
      setActive(target);
    });
    channelList.appendChild(el);
  });
}

function renderMessages(target) {
  const ch = state.channels.get(target);
  messages.innerHTML = '';
  if (!ch) return;
  ch.messages.forEach(m => messages.appendChild(buildMsgEl(m, target)));
  messages.scrollTop = messages.scrollHeight;
}

function appendMsg(target, m) {
  const ch = state.channels.get(target);
  if (!ch) return;
  ch.messages.push(m);
  if (ch.messages.length > 2000) ch.messages.shift();
  if (target === state.active) {
    const atBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 60;
    messages.appendChild(buildMsgEl(m, target));
    if (atBottom) messages.scrollTop = messages.scrollHeight;
  }
}

function buildMsgEl(m, target) {
  const el  = document.createElement('div');
  const cls = m.type || 'msg';
  el.className = `msg ${cls}`;

  const ts   = m.ts ? fmtTime(m.ts) : fmtTime(Date.now() / 1000);
  const self = m.nick === state.nick;

  el.innerHTML = `
    <span class="ts">${ts}</span>
    <span class="body">
      <span class="nick-col ${self ? 'self' : ''}">${escHtml(m.nick || '')}</span>
      <span class="text">${linkify(escHtml(m.text))}</span>
    </span>`;
  return el;
}

function renderUserlist() {
  userlist.innerHTML = '';
  const ch = state.active && state.channels.get(state.active);
  if (!ch) return;
  const sorted = [...ch.nicks].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  sorted.forEach(nick => {
    const el = document.createElement('div');
    el.className = 'user-item';
    el.textContent = nick;
    userlist.appendChild(el);
  });
}

// ── Input / commands ──────────────────────────────────────────────────────────
$('send-btn').addEventListener('click', sendInput);
input.addEventListener('keydown', e => { if (e.key === 'Enter') sendInput(); });

function sendInput() {
  const val = input.value.trim();
  if (!val || !state.active) return;
  input.value = '';

  if (val.startsWith('/')) {
    handleCommand(val.slice(1));
    return;
  }

  send({ type: 'message', target: state.active, text: val });
  appendMsg(state.active, { type: 'msg', nick: state.nick, text: val, ts: Date.now() / 1000 });
}

function handleCommand(raw) {
  const [cmd, ...rest] = raw.split(' ');
  const arg = rest.join(' ');
  switch (cmd.toUpperCase()) {
    case 'JOIN':
      send({ type: 'join', channel: arg });
      break;
    case 'PART':
      send({ type: 'part', channel: arg || state.active });
      break;
    case 'NICK':
      send({ type: 'nick', nick: arg });
      break;
    case 'MSG':
    case 'QUERY': {
      const [target, ...txt] = arg.split(' ');
      ensureChannel(target);
      setActive(target);
      if (txt.length) {
        send({ type: 'message', target, text: txt.join(' ') });
        appendMsg(target, { type: 'msg', nick: state.nick, text: txt.join(' '), ts: Date.now() / 1000 });
      }
      break;
    }
    case 'ME':
      if (state.active) {
        send({ type: 'message', target: state.active, text: `\x01ACTION ${arg}\x01` });
        appendMsg(state.active, { type: 'me', nick: state.nick, text: `/me ${arg}`, ts: Date.now() / 1000 });
      }
      break;
    case 'QUOTE':
    case 'RAW':
      send({ type: 'raw', line: arg });
      break;
    default:
      appendMsg(state.active, { type: 'error', nick: '!', text: `Unknown command: /${cmd}` });
  }
}

// ── Sidebar buttons ───────────────────────────────────────────────────────────
$('join-btn').addEventListener('click', () => {
  const ch = prompt('Channel to join:');
  if (ch) send({ type: 'join', channel: ch.startsWith('#') ? ch : '#' + ch });
});

$('nick-btn').addEventListener('click', () => {
  const n = prompt('New nickname:', state.nick);
  if (n && n !== state.nick) send({ type: 'nick', nick: n });
});

$('disconnect-btn').addEventListener('click', () => {
  state.sessionId = null;
  send({ type: 'raw', line: 'QUIT :bye' });
  state.ws?.close();
  onDisconnect('Disconnected');
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function send(obj) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(obj));
  }
}

function scheduleReconnect() {
  const secs = Math.round(reconnectDelay / 1000);
  appendMsg('*server*', { type: 'connecting', nick: '--', text: `Connection lost — reconnecting in ${secs}s…` });
  setTimeout(() => {
    if (!state.sessionId) return;
    appendMsg('*server*', { type: 'connecting', nick: '--', text: 'Reconnecting…' });
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws?session=${state.sessionId}`);
    state.ws = ws;
    ws.onmessage = e => { try { handle(JSON.parse(e.data)); } catch {} };
    ws.onerror = () => {};
    ws.onclose = () => { if (state.sessionId) scheduleReconnect(); };
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 30000);
}

function onConnectFailed(reason) {
  appendMsg('*server*', { type: 'error', nick: '!', text: reason });
  state.channels.clear();
  state.active = null;
  chatScreen.classList.add('hidden');
  connectScreen.classList.remove('hidden');
  showConnectError(reason);
}

function onDisconnect(reason) {
  state.connected = false;
  state.sessionId = null;
  state.channels.clear();
  state.active = null;
  chatScreen.classList.add('hidden');
  connectScreen.classList.remove('hidden');
  showConnectError(reason);
}

function showConnectError(msg) {
  connectError.textContent = msg;
  connectError.classList.remove('hidden');
}

function fmtTime(unix) {
  const d = new Date(unix * 1000);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function linkify(s) {
  return s.replace(/(https?:\/\/[^\s<>"]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
}
