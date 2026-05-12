'use strict';

// ── State ────────────────────────────────────────────────────────────────────
const state = {
  ws: null,
  nick: '',
  server: '',
  connected: false,
  sessionId: null,
  // Map<target, {messages: [], nicks: Set, unread: number, mention: boolean}>
  channels: new Map(),
  active: null,
  whoisCache: new Map(), // nick → string[]
  pendingWhois: null,
  ignored: new Set(),    // client-side ignored nicks
  listItems: [],         // raw {channel, count, topic} from LIST
  listSort: 'users',     // 'name' | 'users' | 'topic'
  // prefix support — populated from server 005 PREFIX token
  prefixRank:  {'~':0,'&':1,'@':2,'%':3,'+':4}, // symbol → rank (lower = higher privilege)
  prefixClass: {'~':'owner','&':'admin','@':'op','%':'halfop','+':'voice'},
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

// ── Network presets ───────────────────────────────────────────────────────────
const NETWORKS = {
  libera:   { server: 'irc.libera.chat',    port: 6697, tls: true  },
  oftc:     { server: 'irc.oftc.net',       port: 6697, tls: true  },
  rizon:    { server: 'irc.rizon.net',      port: 6697, tls: true  },
  efnet:    { server: 'irc.efnet.org',      port: 6667, tls: false },
  quakenet: { server: 'irc.quakenet.org',   port: 6667, tls: false },
  dalnet:   { server: 'irc.dal.net',        port: 6697, tls: true  },
  undernet: { server: 'irc.undernet.org',   port: 6667, tls: false },
  ircnet:   { server: 'open.ircnet.net',    port: 6667, tls: false },
  geekshed: { server: 'irc.geekshed.net',  port: 6697, tls: true  },
  radiochat:{ server: 'irc.radiochat.org', port: 6697, tls: true  },
  sdf:      { server: 'irc.sdf.org',       port: 6697, tls: true  },
};

// ── Saved profiles ────────────────────────────────────────────────────────────
function loadProfiles() {
  try { return JSON.parse(localStorage.getItem('igloo_profiles') || '[]'); }
  catch { return []; }
}

function saveProfile(profile) {
  const profiles = loadProfiles().filter(p => p.server !== profile.server || p.port !== profile.port);
  profiles.unshift(profile);
  localStorage.setItem('igloo_profiles', JSON.stringify(profiles));
}

function profileKey(p) { return `saved:${p.server}:${p.port}`; }

function renderSavedProfiles() {
  const sel = $('network');
  const existing = sel.querySelector('optgroup[label="Saved"]');
  if (existing) existing.remove();
  const profiles = loadProfiles();
  if (!profiles.length) return;
  const group = document.createElement('optgroup');
  group.label = 'Saved';
  profiles.forEach(p => {
    const opt = document.createElement('option');
    opt.value = profileKey(p);
    opt.textContent = `${p.server}:${p.port}${p.tls ? ' (TLS)' : ''}`;
    group.appendChild(opt);
  });
  sel.insertBefore(group, sel.querySelector('option[value="custom"]'));
}

function applyNetworkSelection(value) {
  const net = NETWORKS[value] ?? loadProfiles().find(p => profileKey(p) === value);
  const isCustom = !net;
  const isSaved  = value.startsWith('saved:');
  $('server-field').classList.toggle('hidden', !isCustom);
  $('server').required = isCustom;
  $('delete-profile-btn').classList.toggle('hidden', !isSaved);
  if (net) {
    $('server').value = net.server;
    $('port').value   = net.port;
    $('tls').checked  = net.tls;
    $('tls').dispatchEvent(new Event('change'));
    if (net.nick) $('nick').value = net.nick;
  }
}

$('network').addEventListener('change', function () { applyNetworkSelection(this.value); });

$('delete-profile-btn').addEventListener('click', () => {
  const val = $('network').value;
  if (!val.startsWith('saved:')) return;
  const profiles = loadProfiles();
  const idx = profiles.findIndex(p => profileKey(p) === val);
  if (idx !== -1) profiles.splice(idx, 1);
  localStorage.setItem('igloo_profiles', JSON.stringify(profiles));
  renderSavedProfiles();
  $('network').value = 'libera';
  applyNetworkSelection('libera');
});

// Restore last nick, saved profiles, and ignore list on page load.
(function init() {
  const nick = localStorage.getItem('igloo_nick');
  if (nick) $('nick').value = nick;
  const rn = localStorage.getItem('igloo_realname');
  if (rn) $('realname').value = rn;
  renderSavedProfiles();
  const lastNet = localStorage.getItem('igloo_last_network');
  if (lastNet) {
    const sel = $('network');
    if ([...sel.options].some(o => o.value === lastNet)) {
      sel.value = lastNet;
      applyNetworkSelection(lastNet);
    }
  }
  const lastAuth = localStorage.getItem('igloo_auth_method');
  if (lastAuth) {
    $('auth-method').value = lastAuth;
    $('pass-field').classList.toggle('hidden', lastAuth === 'none');
  }
  try {
    const ig = JSON.parse(localStorage.getItem('igloo_ignored') || '[]');
    ig.forEach(n => state.ignored.add(n.toLowerCase()));
  } catch {}
})();

function saveIgnored() {
  localStorage.setItem('igloo_ignored', JSON.stringify([...state.ignored]));
}

// ── Saved channel list ────────────────────────────────────────────────────────
function channelsKey(server) { return `igloo_channels_${server}`; }

function loadSavedChannels(server) {
  try { return JSON.parse(localStorage.getItem(channelsKey(server)) || '[]'); }
  catch { return []; }
}

function saveChannels(server) {
  const active = [...state.channels.keys()].filter(t => t.startsWith('#') && !state.channels.get(t).offline);
  localStorage.setItem(channelsKey(server), JSON.stringify(active));
}

function restoreSavedChannels(server) {
  loadSavedChannels(server).forEach(ch => {
    if (!state.channels.has(ch)) {
      state.channels.set(ch, { messages: [], nicks: new Map(), unread: 0, mention: false, topic: '', offline: true });
    }
  });
  renderChannelList();
}

// ── Connect form ─────────────────────────────────────────────────────────────
connectForm.addEventListener('submit', e => {
  e.preventDefault();
  const server     = $('server').value.trim();
  const port       = parseInt($('port').value);
  const nick       = $('nick').value.trim();
  const tls        = $('tls').checked;
  const selfsigned = $('selfsigned').checked;
  const authMethod = $('auth-method').value;
  const pass       = $('pass').value;
  const realname   = $('realname').value.trim() || nick;
  if (!server || !nick) return;
  localStorage.setItem('igloo_nick', nick);
  if ($('realname').value.trim()) localStorage.setItem('igloo_realname', $('realname').value.trim());
  const netVal = $('network').value;
  localStorage.setItem('igloo_last_network', netVal);
  localStorage.setItem('igloo_auth_method', authMethod);
  if (netVal === 'custom' || netVal.startsWith('saved:')) {
    saveProfile({ server, port, tls, nick });
    renderSavedProfiles();
  }
  state.server = server;
  connectError.classList.add('hidden');
  connectScreen.classList.add('hidden');
  chatScreen.classList.remove('hidden');
  ensureChannel('*server*');
  setActive('*server*');
  myNick.textContent = nick;
  appendMsg('*server*', { type: 'connecting', nick: '--', text: `Connecting to ${server}:${port}…` });
  openWS(server, port, nick, realname, tls, selfsigned, authMethod, pass);
});

$('tls').addEventListener('change', function() {
  $('port').value = this.checked ? 6697 : 6667;
  $('selfsigned-field').classList.toggle('hidden', !this.checked);
  if (!this.checked) $('selfsigned').checked = false;
});

$('auth-method').addEventListener('change', function() {
  $('pass-field').classList.toggle('hidden', this.value === 'none');
});

function openWS(server, port, nick, realname, tls, selfsigned, authMethod, pass) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  state.ws = ws;

  ws.onopen = () => {
    send({ type: 'connect', server, port, nick, realname, tls, selfsigned, pass, authmethod: authMethod });
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
    case 'isupport_prefix': {
      // Parse PREFIX=(modes)symbols, e.g. "(qaohv)~&@%+"
      const m = msg.value.match(/^\(([^)]+)\)(.+)$/);
      if (m) {
        const syms = m[2];
        state.prefixRank  = {};
        state.prefixClass = {};
        const names = ['owner','admin','op','halfop','voice'];
        [...syms].forEach((sym, i) => {
          state.prefixRank[sym]  = i;
          // map to a CSS class name: use known names for common positions, else "priv{i}"
          state.prefixClass[sym] = names[i] ?? `priv${i}`;
        });
      }
      break;
    }

    case 'connected':
      state.connected = true;
      state.sessionId = msg.session;
      state.nick = msg.nick;
      reconnectDelay = 1000;
      myNick.textContent = msg.nick;
      appendMsg('*server*', { type: 'system', nick: '--', text: `Connected as ${msg.nick}` });
      restoreSavedChannels(state.server);
      break;

    case 'resumed':
      state.connected = true;
      reconnectDelay = 1000;
      appendMsg('*server*', { type: 'system', nick: '--', text: 'Reconnected' });
      state.channels.forEach((_, target) => {
        if (target.startsWith('#')) send({ type: 'join', channel: target });
      });
      break;

    case 'connect_error':
      state.channels.clear();
      state.active = null;
      document.title = 'igloo';
      chatScreen.classList.add('hidden');
      connectScreen.classList.remove('hidden');
      showConnectError(msg.text);
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
        const joiningCh = state.channels.get(msg.channel);
        if (joiningCh) joiningCh.offline = false;
        setActive(msg.channel);
        saveChannels(state.server);
      } else {
        ensureChannel(msg.channel);
        state.channels.get(msg.channel)?.nicks.set(msg.nick, '');
        renderUserlist();
        appendMsg(msg.channel, { type: 'join', nick: '', text: `→ ${msg.nick} joined ${msg.channel}` });
      }
      break;

    case 'part':
      if (msg.nick === state.nick) {
        removeChannel(msg.channel);
        saveChannels(state.server);
      } else {
        state.channels.get(msg.channel)?.nicks.delete(msg.nick);        renderUserlist();
        appendMsg(msg.channel, { type: 'part', nick: '', text: `← ${msg.nick} left ${msg.channel}` });
      }
      break;

    case 'mode': {
      const dest = msg.target.startsWith('#') ? msg.target : '*server*';
      const setter = msg.nick || msg.target;
      appendMsg(dest, { type: 'system', nick: '', text: `${setter} sets mode ${msg.mode}` });
      break;
    }

    case 'invite':
      appendMsg('*server*', { type: 'notice', nick: msg.nick, text: `invites you to join ${msg.channel} — type /join ${msg.channel} to accept` });
      if (state.active !== '*server*') bumpUnread('*server*', false);
      break;

    case 'kick': {
      const ch = state.channels.get(msg.channel);
      if (ch) {
        ch.nicks.delete(msg.nick);
        renderUserlist();
        const reason = msg.text ? ` (${msg.text})` : '';
        appendMsg(msg.channel, { type: 'part', nick: '', text: `← ${msg.nick} was kicked by ${msg.by}${reason}` });
      }
      if (msg.nick === state.nick) removeChannel(msg.channel);
      break;
    }

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
          const prefix = ch.nicks.get(msg.old);
          ch.nicks.delete(msg.old);
          ch.nicks.set(msg.new, prefix);
          appendMsg(target, { type: 'system', nick: '', text: `${msg.old} is now known as ${msg.new}` });
        }
      });
      renderUserlist();
      break;

    case 'whois': {
      appendMsg('*server*', { type: 'whois', nick: '', text: msg.text });
      if (state.active !== '*server*') bumpUnread('*server*', false);
      // feed whois cache for any pending nick
      if (state.pendingWhois) {
        const lines = state.whoisCache.get(state.pendingWhois) || [];
        lines.push(msg.text);
        state.whoisCache.set(state.pendingWhois, lines);
        if (isDM(state.active) && state.active === state.pendingWhois) renderUserlist();
        if (msg.text.startsWith('— end of whois')) state.pendingWhois = null;
      }
      break;
    }

    case 'motd':
      appendMsg('*server*', { type: 'motd', nick: '', text: msg.text });
      break;

    case 'list_start':
      state.listItems = [];
      ensureChannel('*list*');
      state.channels.get('*list*').messages = [];
      if (state.active !== '*list*') setActive('*list*');
      renderListBar();
      break;

    case 'list_item':
      state.listItems.push({ channel: msg.channel, count: parseInt(msg.count) || 0, topic: msg.topic || '' });
      if (state.active === '*list*') renderListMessages();
      break;

    case 'list_end':
      if (state.active === '*list*') renderListMessages();
      break;

    case 'topic': {
      const ch = state.channels.get(msg.channel);
      if (ch) {
        ch.topic = msg.text;
        if (msg.channel === state.active) topicText.textContent = msg.text;
      }
      break;
    }

    case 'names_chunk': {
      const ch = state.channels.get(msg.channel);
      if (ch) {
        if (!ch._namesAccum) ch._namesAccum = new Map();
        const allPrefixSyms = new RegExp(`^[${Object.keys(state.prefixRank).map(s => s.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')).join('')}]+`);
        msg.nicks.forEach(n => {
          const pm = n.match(allPrefixSyms);
          const prefix = pm ? pm[0] : ''; // keep all prefix chars (multi-prefix)
          ch._namesAccum.set(n.slice(prefix.length), prefix);
        });
      }
      break;
    }

    case 'names_end': {
      const ch = state.channels.get(msg.channel);
      if (ch && ch._namesAccum) {
        ch.nicks = ch._namesAccum;
        ch._namesAccum = null;
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

// ── Chat log persistence ──────────────────────────────────────────────────────
const LOG_MAX   = 200;
const LOG_TYPES = new Set(['msg', 'me', 'notice', 'join', 'part', 'quit', 'system']);

function logKey(server, target) {
  return `igloo_log:${server}:${target}`;
}

function persistMsg(target, m) {
  if (!LOG_TYPES.has(m.type)) return;
  const key = logKey(state.server, target);
  let log;
  try { log = JSON.parse(localStorage.getItem(key) || '[]'); } catch { log = []; }
  log.push(m);
  if (log.length > LOG_MAX) log.splice(0, log.length - LOG_MAX);
  try { localStorage.setItem(key, JSON.stringify(log)); } catch {}
}

function loadLog(server, target) {
  try { return JSON.parse(localStorage.getItem(logKey(server, target)) || '[]'); } catch { return []; }
}

// ── Channels ──────────────────────────────────────────────────────────────────
function ensureChannel(target) {
  if (!state.channels.has(target)) {
    const history = loadLog(state.server, target);
    const messages = history.length
      ? [...history, { type: 'session-break', nick: '', text: '', ts: null }]
      : [];
    state.channels.set(target, { messages, nicks: new Map(), unread: 0, mention: false, topic: '' });
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
  targetName.textContent = target === '*server*' ? state.server : target;
  topicText.textContent = ch.topic || '';
  updateTitle();
  renderListBar();
  input.focus();
}

function renderListBar() {
  const bar = $('list-sort-bar');
  if (state.active !== '*list*') { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  bar.querySelectorAll('.sort-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.sort === state.listSort);
  });
}

function renderListMessages() {
  const sorters = {
    name:  (a, b) => a.channel.localeCompare(b.channel),
    users: (a, b) => b.count - a.count,
    topic: (a, b) => a.topic.localeCompare(b.topic),
  };
  const sorted = [...state.listItems].sort(sorters[state.listSort] || sorters.users);
  messages.innerHTML = '';
  sorted.forEach(item => {
    const el = document.createElement('div');
    el.className = 'msg list';
    el.innerHTML = `
      <span class="ts"></span>
      <span class="body">
        <span class="nick-col list-count">${item.count}</span>
        <span class="text">
          <span class="chan list-join" data-channel="${escHtml(item.channel)}">${escHtml(item.channel)}</span>
          <span class="ltopic">${linkify(escHtml(item.topic))}</span>
        </span>
      </span>`;
    el.querySelector('.list-join').addEventListener('click', () => {
      send({ type: 'join', channel: item.channel });
    });
    messages.appendChild(el);
  });
  const summary = document.createElement('div');
  summary.className = 'msg system';
  summary.innerHTML = `<span class="ts"></span><span class="body"><span class="nick-col"></span><span class="text">${sorted.length} channels</span></span>`;
  messages.appendChild(summary);
}

function updateTitle() {
  const label = state.active === '*server*' ? state.server : state.active;
  document.title = label ? `${label} — igloo` : 'igloo';
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
      (ch.offline ? ' offline' : '') +
      (ch.mention ? ' mention' : ch.unread > 0 ? ' unread' : '');
    const label = target === '*server*' ? state.server : target;
    el.innerHTML = `<span>${escHtml(label)}</span>`;
    if (!ch.offline && ch.unread > 0) {
      el.innerHTML += `<span class="unread-badge">${ch.unread}</span>`;
    } else if (!ch.offline && target !== '*server*') {
      el.innerHTML += `<button class="close-btn" data-target="${escHtml(target)}">×</button>`;
    } else if (ch.offline) {
      el.innerHTML += `<button class="close-btn" data-target="${escHtml(target)}">×</button>`;
    }
    el.addEventListener('click', ev => {
      if (ev.target.classList.contains('close-btn')) {
        const t = ev.target.dataset.target;
        if (ch.offline) {
          removeChannel(t);
          saveChannels(state.server);
        } else if (t.startsWith('#')) {
          send({ type: 'part', channel: t });
        } else {
          removeChannel(t);
        }
        return;
      }
      if (ch.offline) {
        send({ type: 'join', channel: target });
      } else {
        setActive(target);
      }
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
  if (m.nick && state.ignored.has(m.nick.toLowerCase())) return;
  const ch = state.channels.get(target);
  if (!ch) return;
  ch.messages.push(m);
  if (ch.messages.length > 2000) ch.messages.shift();
  persistMsg(target, m);
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
  const ts = m.ts ? fmtTime(m.ts) : fmtTime(Date.now() / 1000);

  if (cls === 'session-break') {
    el.className = 'session-break';
    el.textContent = '── previous session ──';
    return el;
  }

  if (cls === 'list') {
    const [chan, ...rest] = m.text.split('  ');
    el.innerHTML = `
      <span class="ts">${ts}</span>
      <span class="body">
        <span class="nick-col">${escHtml(m.nick)}</span>
        <span class="text"><span class="chan">${escHtml(chan)}</span><span class="ltopic">${linkify(escHtml(rest.join('  ')))}</span></span>
      </span>`;
    return el;
  }

  const self = m.nick === state.nick;
  const nc = nickColor(m.nick);

  if (m.text && m.text.startsWith('/me ')) {
    const action = m.text.slice(4);
    el.className += ' action';
    el.innerHTML = `
      <span class="ts">${ts}</span>
      <span class="body">
        <span class="action-text" style="${nc ? `color:${nc}` : ''}">* <b>${escHtml(m.nick || '')}</b> ${highlightNicks(renderText(action), state.channels.get(state.active)?.nicks)}</span>
      </span>`;
    return el;
  }

  el.innerHTML = `
    <span class="ts">${ts}</span>
    <span class="body">
      <span class="nick-col ${self ? 'self' : ''}" style="${nc ? `color:${nc}` : ''}">${escHtml(m.nick || '')}</span>
      <span class="text">${highlightNicks(renderText(m.text), state.channels.get(state.active)?.nicks)}</span>
    </span>`;
  return el;
}

function isDM(target) {
  return !!target && !target.startsWith('#') && target !== '*server*' && target !== '*list*';
}

function openDM(nick) {
  ensureChannel(nick);
  setActive(nick);
  // auto-fetch WHOIS so the DM card shows badges immediately
  if (!state.whoisCache.has(nick)) {
    state.pendingWhois = nick;
    send({ type: 'raw', line: `WHOIS ${nick}` });
  }
}

function parseWhois(lines) {
  const w = { realname:'', host:'', ident:'', server:'', location:'', idle:'',
               account:'', channels:[], secure:false, ircop:false, bot:false,
               away:false, awayMsg:'' };
  for (const l of lines) {
    let m;
    if ((m = l.match(/^\S+ \((.+?)@(.+?)\): (.+)/)))
      { w.ident = m[1]; w.host = m[2]; w.realname = m[3]; }
    else if ((m = l.match(/in: (.+)/)))
      w.channels = m[1].trim().split(/\s+/);
    else if ((m = l.match(/via (\S+) \((.+)\)/)))
      { w.server = m[1]; w.location = m[2]; }
    else if ((m = l.match(/idle ([^,]+)/)))
      w.idle = m[1];
    else if ((m = l.match(/logged in as (\S+)/)))
      w.account = m[1];
    else if ((m = l.match(/^away: (.+)/)))
      { w.away = true; w.awayMsg = m[1]; }
    else if (l.includes('secure connection'))  w.secure = true;
    else if (l.includes('IRC operator'))       w.ircop  = true;
  }
  w.bot = /bot|serv/i.test(w.realname) || (w.ident.startsWith('~') && /bot|serv/i.test(w.host + w.account));
  return w;
}

function renderUserlist() {
  const header = $('userlist-header');
  userlist.innerHTML = '';

  if (isDM(state.active)) {
    const nick = state.active;
    const nc   = nickColor(nick);
    header.textContent = 'User';

    const card = document.createElement('div');
    card.className = 'dm-card';

    const lines = state.whoisCache.get(nick) || [];
    const w = lines.length ? parseWhois(lines) : null;

    // badges
    const badges = [];
    if (w?.away)    badges.push(`<span class="user-badge badge-away" title="${escHtml(w.awayMsg || 'Away')}">⏾ Away</span>`);
    if (w?.secure)  badges.push('<span class="user-badge badge-secure" title="Secure connection">🔒 Secure</span>');
    if (w?.ircop)   badges.push('<span class="user-badge badge-ircop"  title="IRC Operator">⚡ IRCop</span>');
    if (w?.account) badges.push(`<span class="user-badge badge-identified" title="Identified as ${escHtml(w.account)}">✓ ${escHtml(w.account)}</span>`);
    if (w?.bot)     badges.push('<span class="user-badge badge-bot"    title="Likely a bot">🤖 Bot</span>');

    card.innerHTML = `
      <div class="dm-avatar" style="background:${nc || 'var(--accent)'}">
        ${w?.bot ? '🤖' : escHtml(nick[0].toUpperCase())}
      </div>
      <div class="dm-nick" style="${nc ? `color:${nc}` : ''}">${escHtml(nick)}</div>
      ${badges.length ? `<div class="dm-badges">${badges.join('')}</div>` : ''}
      <div class="dm-actions">
        <button class="dm-action-btn" id="whois-btn">⊕ Info</button>
        <button class="dm-action-btn danger" id="close-dm-btn">✕ Close</button>
      </div>`;

    if (w && (w.realname || w.host || w.server || w.idle || w.channels.length)) {
      const info = document.createElement('div');
      info.className = 'dm-whois';
      const rows = [];
      if (w.away && w.awayMsg) rows.push(`<div class="wi-row"><span class="wi-key">Away</span><span class="wi-val wi-away">${escHtml(w.awayMsg)}</span></div>`);
      if (w.realname) rows.push(`<div class="wi-row"><span class="wi-key">Name</span><span class="wi-val">${escHtml(w.realname)}</span></div>`);
      if (w.host)     rows.push(`<div class="wi-row"><span class="wi-key">Host</span><span class="wi-val">${escHtml(w.ident+'@'+w.host)}</span></div>`);
      if (w.server)   rows.push(`<div class="wi-row"><span class="wi-key">Server</span><span class="wi-val">${escHtml(w.server)}${w.location ? ' · '+escHtml(w.location) : ''}</span></div>`);
      if (w.idle)     rows.push(`<div class="wi-row"><span class="wi-key">Idle</span><span class="wi-val">${escHtml(w.idle)}</span></div>`);
      if (w.channels.length) {
        const PREFIX_LABEL = { '~': ['owner','~'], '&': ['admin','&'], '@': ['op','@'], '%': ['half-op','%'], '+': ['voice','+'] };
        const chips = w.channels.map(c => {
          const m = c.match(/^([~&@%+]+)(.*)/);
          const prefix = m ? m[1] : '';
          const chan   = m ? m[2] : c;
          const prefixHtml = [...prefix].map(p => {
            const [label, sym] = PREFIX_LABEL[p] || [p, p];
            return `<span class="chan-prefix chan-prefix-${label}" title="${label}">${sym}</span>`;
          }).join('');
          return `<span class="wi-chan">${prefixHtml}<span class="wi-chan-name">${escHtml(chan)}</span></span>`;
        }).join('');
        rows.push(`<div class="wi-row"><span class="wi-key">In</span><span class="wi-val wi-chans">${chips}</span></div>`);
      }
      info.innerHTML = rows.join('');
      card.appendChild(info);
    }

    card.querySelector('#whois-btn').addEventListener('click', () => {
      state.whoisCache.delete(nick);
      state.pendingWhois = nick;
      send({ type: 'raw', line: `WHOIS ${nick}` });
    });
    card.querySelector('#close-dm-btn').addEventListener('click', () => removeChannel(nick));

    userlist.appendChild(card);
    return;
  }

  // normal channel — nick list
  const ch = state.active && state.channels.get(state.active);
  if (!ch) return;
  const count = ch.nicks.size;
  header.textContent = count ? `${count} Users` : 'Users';
  const sorted = [...ch.nicks.entries()].sort(([a, pa], [b, pb]) => {
    // rank by highest-privilege prefix char in the string
    const bestRank = p => Math.min(...([...p].map(c => state.prefixRank[c] ?? 99)), 99);
    return bestRank(pa) - bestRank(pb) || a.toLowerCase().localeCompare(b.toLowerCase());
  });
  sorted.forEach(([nick, prefix]) => {
    // highest-privilege char determines the CSS class
    const topChar = [...prefix].sort((a, b) => (state.prefixRank[a]??99) - (state.prefixRank[b]??99))[0];
    const cls = topChar ? (state.prefixClass[topChar] || '') : '';
    const el = document.createElement('div');
    el.className = 'user-item' + (cls ? ' ' + cls : '');
    const nc = nickColor(nick);
    const prefixHtml = topChar
      ? `<span class="user-prefix">${escHtml(topChar)}</span>`
      : `<span class="user-prefix-none"> </span>`;
    el.innerHTML = `<span class="user-nick">${prefixHtml}<span style="${nc ? `color:${nc}` : ''}">${escHtml(nick)}</span></span>` +
      (nick !== state.nick ? `<button class="dm-btn" title="Message ${escHtml(nick)}">✉</button>` : '');
    el.querySelector('.dm-btn')?.addEventListener('click', e => {
      e.stopPropagation();
      openDM(nick);
    });
    userlist.appendChild(el);
  });
}

// ── Input / commands ──────────────────────────────────────────────────────────
$('send-btn').addEventListener('click', sendInput);
input.addEventListener('keydown', e => {
  if (e.key === 'Enter') { sendInput(); tabComplete.reset(); }
  else if (e.key === 'Tab') { e.preventDefault(); tabComplete.next(); }
  else if (e.key !== 'Shift') tabComplete.reset();
});

const tabComplete = (() => {
  let candidates = [], idx = -1, prefix = '', stub = '';

  return {
    next() {
      const ch = state.active && state.channels.get(state.active);
      if (!ch) return;

      if (candidates.length === 0) {
        const val   = input.value;
        const space = val.lastIndexOf(' ');
        stub        = val.slice(space + 1);
        prefix      = val.slice(0, space + 1);
        if (!stub) return;
        candidates = [...ch.nicks.keys()]
          .filter(n => n.toLowerCase().startsWith(stub.toLowerCase()))
          .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
        idx = -1;
      }
      if (candidates.length === 0) return;
      idx = (idx + 1) % candidates.length;
      const suffix = prefix === '' ? ': ' : ' ';
      input.value  = prefix + candidates[idx] + suffix;
    },
    reset() { candidates = []; idx = -1; stub = ''; prefix = ''; },
  };
})();

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
      openDM(target);
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
    case 'TOPIC':
      send({ type: 'raw', line: `TOPIC ${state.active}${arg ? ' :' + arg : ''}` });
      break;
    case 'LIST':
      send({ type: 'raw', line: arg ? `LIST ${arg}` : 'LIST' });
      break;
    case 'WHOIS':
      if (arg) send({ type: 'raw', line: `WHOIS ${arg}` });
      break;
    case 'AWAY':
      send({ type: 'raw', line: arg ? `AWAY :${arg}` : 'AWAY' });
      break;
    case 'QUOTE':
    case 'RAW':
      send({ type: 'raw', line: arg });
      break;

    case 'KICK': {
      const [knick, ...kreason] = arg.split(' ');
      if (state.active?.startsWith('#') && knick)
        send({ type: 'raw', line: `KICK ${state.active} ${knick} :${kreason.join(' ') || 'Kicked'}` });
      break;
    }
    case 'BAN': {
      if (state.active?.startsWith('#') && arg)
        send({ type: 'raw', line: `MODE ${state.active} +b ${arg}!*@*` });
      break;
    }
    case 'UNBAN': {
      if (state.active?.startsWith('#') && arg)
        send({ type: 'raw', line: `MODE ${state.active} -b ${arg}!*@*` });
      break;
    }
    case 'MODE':
      send({ type: 'raw', line: `MODE ${arg || state.active}` });
      break;
    case 'INVITE': {
      const [inick, ichan] = arg.split(' ');
      if (inick) send({ type: 'raw', line: `INVITE ${inick} ${ichan || state.active}` });
      break;
    }
    case 'NOTICE': {
      const [ntarget, ...ntxt] = arg.split(' ');
      if (ntarget && ntxt.length) {
        send({ type: 'raw', line: `NOTICE ${ntarget} :${ntxt.join(' ')}` });
        appendMsg(state.active, { type: 'notice', nick: state.nick, text: `→ ${ntarget}: ${ntxt.join(' ')}`, ts: Date.now() / 1000 });
      }
      break;
    }
    case 'PING': {
      const ptarget = arg || state.active;
      send({ type: 'raw', line: `PRIVMSG ${ptarget} :\x01PING ${Date.now()}\x01` });
      appendMsg(state.active, { type: 'notice', nick: '--', text: `CTCP PING sent to ${ptarget}`, ts: Date.now() / 1000 });
      break;
    }
    case 'SLAP': {
      const starget = arg || 'everyone';
      const line = `/me slaps ${starget} around a bit with a large trout`;
      send({ type: 'message', target: state.active, text: `\x01ACTION slaps ${starget} around a bit with a large trout\x01` });
      appendMsg(state.active, { type: 'me', nick: state.nick, text: line, ts: Date.now() / 1000 });
      break;
    }
    case 'CLEAR':
      if (state.active) {
        const ch = state.channels.get(state.active);
        if (ch) { ch.messages = []; renderMessages(state.active); }
      }
      break;
    case 'IGNORE':
      if (arg) {
        state.ignored.add(arg.toLowerCase());
        saveIgnored();
        appendMsg(state.active, { type: 'system', nick: '--', text: `Now ignoring ${arg}` });
      } else {
        const list = [...state.ignored].join(', ');
        appendMsg(state.active, { type: 'system', nick: '--', text: list ? `Ignored: ${list}` : 'Ignore list is empty' });
      }
      break;
    case 'UNIGNORE':
      if (arg) {
        state.ignored.delete(arg.toLowerCase());
        saveIgnored();
        appendMsg(state.active, { type: 'system', nick: '--', text: `No longer ignoring ${arg}` });
      }
      break;
    case 'HELP': {
      const cmds = [
        '/join <#channel>        — join a channel',
        '/part [reason]          — leave current channel',
        '/nick <newnick>         — change nickname',
        '/msg <nick> [text]      — open DM / send message',
        '/me <action>            — send action (/me waves)',
        '/notice <target> <text> — send a NOTICE',
        '/topic [new topic]      — show or set topic',
        '/kick <nick> [reason]   — kick from channel',
        '/ban <nick>             — ban nick!*@* from channel',
        '/unban <nick>           — remove ban',
        '/mode [target] <modes>  — set modes',
        '/invite <nick> [#chan]  — invite user to channel',
        '/whois <nick>           — show user info',
        '/ping <nick>            — CTCP ping a user',
        '/away [message]         — set or clear away status',
        '/list [filter]          — list channels',
        '/ignore [nick]          — ignore nick (no arg = list)',
        '/unignore <nick>        — stop ignoring nick',
        '/slap <nick>            — the classics never die',
        '/clear                  — clear message buffer',
        '/raw <line>             — send raw IRC line',
        '/help                   — show this list',
      ];
      cmds.forEach(t => appendMsg(state.active, { type: 'system', nick: '--', text: t }));
      break;
    }

    default:
      appendMsg(state.active, { type: 'error', nick: '!', text: `Unknown command: /${cmd}  (try /help)` });
  }
}

// ── List sort bar ─────────────────────────────────────────────────────────────
$('list-sort-bar').addEventListener('click', e => {
  const btn = e.target.closest('.sort-btn');
  if (!btn) return;
  state.listSort = btn.dataset.sort;
  renderListBar();
  renderListMessages();
});

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
  send({ type: 'disconnect', text: 'Leaving' });
  setTimeout(() => { state.ws?.close(); onDisconnect('Disconnected'); }, 300);
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
  document.title = 'igloo';
  chatScreen.classList.add('hidden');
  connectScreen.classList.remove('hidden');
  showConnectError(reason);
}

function showConnectError(msg) {
  connectError.textContent = msg;
  connectError.classList.remove('hidden');
}

function nickColor(nick) {
  if (!nick || nick === '--') return '';
  let h = 0;
  for (let i = 0; i < nick.length; i++) h = (Math.imul(31, h) + nick.charCodeAt(i)) | 0;
  const hue = ((h >>> 0) % 360);
  const light = window.matchMedia('(prefers-color-scheme: light)').matches ? '38%' : '68%';
  return `hsl(${hue},65%,${light})`;
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

// Replace nick mentions in an HTML string with colored spans.
// Skips content inside HTML tags to avoid corrupting attributes.
function highlightNicks(html, nicks) {
  if (!nicks || !nicks.size) return html;
  // build alternation of escaped nick names, longest first to avoid partial matches
  const escaped = [...nicks.keys()]
    .filter(n => n !== state.nick)
    .sort((a, b) => b.length - a.length)
    .map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!escaped.length) return html;
  const re = new RegExp(`(?<=^|[\\s,;:!?])(?:${escaped.join('|')})(?=[\\s,;:!?]|$|:)`, 'g');
  // walk the html splitting on tags, only transform text nodes
  return html.replace(/(<[^>]+>)|([^<]+)/g, (_, tag, text) => {
    if (tag) return tag;
    return text.replace(re, m => {
      const c = nickColor(m);
      return `<span class="nick-mention" style="${c ? `color:${c}` : ''}">${m}</span>`;
    });
  });
}

// IRC mIRC color palette (indices 0-15)
const MIRC_COLORS = [
  '#ffffff','#000000','#00007f','#009300','#ff0000','#7f0000',
  '#9c009c','#fc7f00','#ffff00','#00fc00','#009393','#00ffff',
  '#0000fc','#ff00ff','#7f7f7f','#d2d2d2',
];

function applyMarkdown(s) {
  return s
    .replace(/^(#{1,3}) (.+)$/gm, (_, hashes, text) => {
      const lvl = hashes.length;
      const size = lvl === 1 ? '1.2em' : lvl === 2 ? '1.05em' : '0.95em';
      return `<span class="md-h md-h${lvl}" style="font-size:${size}">${text}</span>`;
    })
    .replace(/~~(.+?)~~/g,               '<s>$1</s>')
    .replace(/\*\*(.+?)\*\*/g,           '<b>$1</b>')
    .replace(/__(.+?)__/g,               '<b>$1</b>')
    .replace(/\*([^*\s][^*\n]*?)\*/g,    '<i>$1</i>')
    .replace(/_([^_\s][^_\n]*?)_/g,      '<i>$1</i>')
    .replace(/`([^`\n]+)`/g,             '<code>$1</code>');
}

function renderText(raw) {
  let bold=false, italic=false, under=false, strike=false, mono=false;
  let fg=null, bg=null;
  let out='', buf='', i=0;

  const flush = () => {
    if (!buf) return;
    let s = linkify(applyMarkdown(escHtml(buf)));
    const st = [];
    if (bold)   st.push('font-weight:bold');
    if (italic) st.push('font-style:italic');
    if (under)  st.push('text-decoration:underline');
    if (strike) st.push('text-decoration:line-through');
    if (fg)     st.push(`color:${fg}`);
    if (bg)     st.push(`background:${bg};padding:0 2px;border-radius:2px`);
    if (mono)   s = `<code>${escHtml(buf)}</code>`;
    else if (st.length) s = `<span style="${st.join(';')}">${s}</span>`;
    out += s;
    buf = '';
  };

  while (i < raw.length) {
    const c = raw[i];
    if (c === '\x02') { flush(); bold   = !bold;   i++; }
    else if (c === '\x1D') { flush(); italic = !italic; i++; }
    else if (c === '\x1F') { flush(); under  = !under;  i++; }
    else if (c === '\x1E') { flush(); strike = !strike; i++; }
    else if (c === '\x11') { flush(); mono   = !mono;   i++; }
    else if (c === '\x0F') { flush(); bold=italic=under=strike=mono=false; fg=bg=null; i++; }
    else if (c === '\x03') {
      flush(); i++;
      let fgS='', bgS='';
      while (i < raw.length && /\d/.test(raw[i]) && fgS.length < 2) fgS += raw[i++];
      if (raw[i] === ',') {
        i++;
        while (i < raw.length && /\d/.test(raw[i]) && bgS.length < 2) bgS += raw[i++];
      }
      fg = fgS !== '' ? (MIRC_COLORS[+fgS] ?? null) : null;
      bg = bgS !== '' ? (MIRC_COLORS[+bgS] ?? null) : null;
      if (fgS === '') { fg = null; bg = null; }
    } else { buf += c; i++; }
  }
  flush();
  return out;
}
