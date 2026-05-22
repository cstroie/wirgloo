'use strict';

// ── Nick suggestion ───────────────────────────────────────────────────────────
const NICK_ADJ  = ['Acid','Aero','Amber','Arc','Ash','Astro','Atomic','Azure',
  'Binary','Blaze','Bright','Brisk','Calm','Carbon','Chrome','Circuit','Cobalt',
  'Cold','Core','Crisp','Cyber','Dark','Deep','Delta','Dense','Drift','Echo',
  'Edge','Ember','Ether','Fast','Feral','Flash','Flux','Frozen','Ghost','Glitch',
  'Glow','Hyper','Ice','Infra','Jade','Jade','Kinetic','Laser','Lunar','Lyric',
  'Macro','Mach','Micro','Neon','Nimble','Nitro','Noble','Null','Obsidian',
  'Omega','Onyx','Orbital','Pale','Phantom','Pixel','Plasma','Proto','Pulse',
  'Quantum','Quartz','Rapid','Raw','Rogue','Ruby','Rust','Sigma','Silent',
  'Solar','Solid','Sonic','Static','Steel','Storm','Swift','Tidal','Turbo',
  'Ultra','Umbra','Vector','Velox','Void','Volt','Wave','Wild','Xenon','Zero'];

const NICK_NOUN = ['Badger','Bat','Bear','Beetle','Bison','Boar','Bolt','Byte',
  'Cat','Cipher','Claw','Cloud','Cobra','Comet','Core','Crane','Crow','Crystal',
  'Dagger','Data','Deer','Delta','Drone','Eagle','Elk','Falcon','Fang','Ferret',
  'Finch','Firefly','Flux','Foxtrot','Frog','Gate','Ghost','Grid','Hawk','Helix',
  'Hornet','Hydra','Jay','Jaguar','Kite','Kraken','Lance','Laser','Lemur','Link',
  'Lynx','Mantis','Marten','Matrix','Mink','Mole','Moth','Nexus','Node','Otter',
  'Owl','Panther','Pike','Pixel','Probe','Pulse','Rabbit','Raven','Rhino','Roach',
  'Robin','Router','Rune','Serpent','Shark','Shrew','Signal','Snail','Snake',
  'Spider','Squid','Stag','Storm','Swift','Tiger','Token','Viper','Warden',
  'Wasp','Weasel','Wire','Wolf','Wolverine','Wren','Yak','Zebra'];

// Simple non-crypto hash: djb2 variant
function _strHash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

function _browserSeed() {
  const fp = [navigator.userAgent, navigator.language,
    screen.width, screen.colorDepth,
    Intl.DateTimeFormat().resolvedOptions().timeZone].join('|');
  return _strHash(fp);
}

let _nickOffset = 0;

function suggestNick() {
  // Re-hash on each offset so both adj and noun scramble independently
  const h1 = _strHash((_browserSeed() + _nickOffset).toString());
  const h2 = _strHash(h1.toString());
  const adj  = NICK_ADJ [h1 % NICK_ADJ.length];
  const noun = NICK_NOUN[h2 % NICK_NOUN.length];
  return adj + noun;
}

function rotateSuggestion() {
  _nickOffset++;
  const nick = suggestNick();
  const real = nick.replace(/([a-z])([A-Z])/g, '$1 $2'); // "SwiftOtter" → "Swift Otter"
  $('nick').value = nick;
  $('realname').value = real;
  $('realname').dataset.suggested = '1';
  try { localStorage.setItem('wirgloo:nick', JSON.stringify({ nick, realname: real, offset: _nickOffset })); } catch {}
}

function loadDefaultNick() {
  try { return JSON.parse(localStorage.getItem('wirgloo:nick') || 'null'); } catch { return null; }
}

// ── State ────────────────────────────────────────────────────────────────────
const state = {
  ws: null,
  nick: '',
  server: '',
  connected: false,
  sessionId: null,
  connectParams: null, // saved to auto-reconnect after session_expired
  // Map<target, {messages: [], nicks: Set, unread: number, mention: boolean}>
  channels: new Map(),
  active: null,
  whoisUsers: new Map(), // nick → structured whois data
  pendingWhois: null,
  ignored: new Set(),    // client-side ignored nicks
  listItems: [],         // raw {channel, count, topic} from LIST
  away: false,           // true when marked as away
  network: '',           // NETWORK= value from 005, e.g. "Libera.Chat"
  servername: '',        // server hostname from 004 RPL_MYINFO
  serverMeta: {},        // accumulated server_meta key/value pairs
  listSort: 'users',     // 'name' | 'users' | 'topic'
  listFilter: '',        // current filter query sent to the backend
  listTotal: 0,          // total channels in the server's list
  listShown: 0,          // channels matching the current filter
  listCapped: false,     // true when showing only the top-N preview
  dmOriginChannel: null, // channel active when a DM was opened from the user list
  // prefix support — populated from server 005 PREFIX token
  prefixRank:  {'~':0,'&':1,'@':2,'%':3,'+':4}, // symbol → rank (lower = higher privilege)
  prefixClass: {'~':'owner','&':'admin','@':'op','%':'halfop','+':'voice'},
};

let reconnectDelay = 1000;
let lagPingPending = false;
let lagTimer       = null;

function scheduleLagPing(initialDelay) {
  clearTimeout(lagTimer);
  const delay = initialDelay ?? (60 + Math.random() * 240) * 1000; // 1–5 min random
  lagTimer = setTimeout(() => {
    if (state.connected && state.ws) {
      lagPingPending = true;
      send({ type: 'raw', line: `PING :${Date.now()}` });
    }
    scheduleLagPing();
  }, delay);
}

function updateLagDisplay(ms) {
  const el = $('lag-display');
  if (!el) return;
  if (ms == null) {
    el.textContent = 'ping: -- ms';
    el.style.color = '';
    return;
  }
  const color = ms < 100 ? 'var(--join)' : ms < 300 ? '#f59e0b' : 'var(--error)';
  el.textContent = `ping: ${ms} ms`;
  el.style.color = color;
}

// ── DOM refs ─────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const connectScreen  = $('connect-screen');
const restoreScreen  = $('restore-screen');
const chatScreen     = $('chat-screen');
const connectForm   = $('connect-form');
const connectError  = $('connect-error');
const myNick        = $('my-nick');
const channelList   = $('channel-list');
const messages      = $('messages');
const targetName    = $('target-name');
const topicText     = $('topic-text');
const input         = $('input');
const userlist      = $('userlist');

// ── Version ───────────────────────────────────────────────────────────────────
fetch('/version').then(r => r.json()).then(v => {
  const label = `${v.name} ${v.version}`;
  $('connect-version').textContent  = label;
  $('sidebar-version').textContent  = label;
}).catch(() => {});

// ── Session resume from URL ───────────────────────────────────────────────────
{
  const urlSession = new URLSearchParams(location.search).get('s');
  if (urlSession) {
    state.sessionId = urlSession;
    connectScreen.classList.add('hidden');
    restoreScreen.classList.remove('hidden');
    // Get the server from sessionStorage (set during the original connection)
    let tabSession = null;
    try { tabSession = JSON.parse(sessionStorage.getItem('wirgloo:session') || 'null'); } catch {}
    const server = tabSession?.server;
    // Load channels with their message history immediately
    if (server) {
      restoreChannelsWithHistory(server);
    }
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws?session=${urlSession}`);
    state.ws = ws;
    ws.onmessage = e => { try { handle(JSON.parse(e.data)); } catch(err) { console.warn('ws message error', err); } };
    ws.onerror = () => {};
    ws.onclose = () => {
      restoreScreen.classList.add('hidden');
      if (state.sessionId || state.connectParams) scheduleReconnect();
      else connectScreen.classList.remove('hidden');
    };
  }
}

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
  tildechat:{ server: 'irc.tilde.chat',   port: 6697, tls: true  },
  hackint:  { server: 'irc.hackint.org',  port: 6697, tls: true  },
  espernet: { server: 'irc.esper.net',    port: 6697, tls: true  },
};

// ── Saved profiles ────────────────────────────────────────────────────────────
function loadProfiles() {
  try { return JSON.parse(localStorage.getItem('wirgloo:profiles') || '[]'); }
  catch { return []; }
}

function saveProfile(profile) {
  const profiles = loadProfiles().filter(p => p.server !== profile.server || p.port !== profile.port);
  profiles.unshift(profile);
  localStorage.setItem('wirgloo:profiles', JSON.stringify(profiles));
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
    const srv = loadSrv(net.server);
    if (srv.nick)       $('nick').value = srv.nick;
    else if (net.nick)  $('nick').value = net.nick;
    if (srv.realname)   $('realname').value = srv.realname;
    if (srv.authMethod) { $('auth-method').value = srv.authMethod; $('pass-field').classList.toggle('hidden', srv.authMethod === 'none'); }
  }
}

$('network').addEventListener('change', function () { applyNetworkSelection(this.value); });

$('delete-profile-btn').addEventListener('click', () => {
  const val = $('network').value;
  if (!val.startsWith('saved:')) return;
  const profiles = loadProfiles();
  const idx = profiles.findIndex(p => profileKey(p) === val);
  if (idx !== -1) profiles.splice(idx, 1);
  localStorage.setItem('wirgloo:profiles', JSON.stringify(profiles));
  renderSavedProfiles();
  $('network').value = 'libera';
  applyNetworkSelection('libera');
});

// ── Per-server settings ───────────────────────────────────────────────────────
// Each server's settings are stored in one key: wirgloo:srv:<server>
// Global keys: wirgloo:profiles, wirgloo:ignored
// Per-tab keys (sessionStorage): wirgloo:session → {server, network}

function srvKey(server) { return `wirgloo:srv:${server}`; }

function loadSrv(server) {
  try { return JSON.parse(localStorage.getItem(srvKey(server)) || '{}'); }
  catch { return {}; }
}

function saveSrv(server, patch) {
  const data = loadSrv(server);
  Object.assign(data, patch);
  localStorage.setItem(srvKey(server), JSON.stringify(data));
}

function saveIgnored() {
  localStorage.setItem('wirgloo:ignored', JSON.stringify([...state.ignored]));
}

function saveChannels(server) {
  const channels = [...state.channels.keys()].filter(t => t.startsWith('#') && !state.channels.get(t).offline);
  saveSrv(server, { channels });
}

function saveDMs(server) {
  const dms = [...state.channels.keys()].filter(t => isDM(t));
  saveSrv(server, { dms });
}

function restoreSavedChannels(server) {
  const srv = loadSrv(server);
  (srv.channels || []).forEach(ch => {
    const k = chanKey(ch);
    if (!state.channels.has(k))
      state.channels.set(k, { messages: [], nicks: new Map(), unread: 0, mention: false, topic: '', modes: new Set(), key: '', offline: true });
  });
  (srv.dms || []).forEach(nick => { if (!state.channels.has(nick)) ensureChannel(nick); });
  renderChannelList();
}

// Restore channels with full message history from localStorage (on browser reload/resume)
function restoreChannelsWithHistory(server) {
  state.server = server;
  const srv = loadSrv(server);
  // Restore channels with their saved message history
  (srv.channels || []).forEach(ch => {
    const k = chanKey(ch);
    if (!state.channels.has(k)) {
      const history = loadLog(server, k);
      const messages = history.length
        ? [...history, { type: 'session-break', nick: '', text: '', ts: null }]
        : [];
      state.channels.set(k, { messages, nicks: new Map(), unread: 0, mention: false, topic: '', modes: new Set(), key: '', offline: true });
    }
  });
  // Restore DMs
  (srv.dms || []).forEach(nick => {
    if (!state.channels.has(nick)) {
      const history = loadLog(server, nick);
      const messages = history.length
        ? [...history, { type: 'session-break', nick: '', text: '', ts: null }]
        : [];
      state.channels.set(nick, { messages, nicks: new Map(), unread: 0, mention: false, topic: '', modes: new Set(), key: '', offline: true });
    }
  });
  // Create server tab
  ensureChannel('*server*');
  // Ensure *list* channel exists but is hidden by default
  if (!state.channels.has('*list*')) {
    state.channels.set('*list*', { messages: [], nicks: new Map(), unread: 0, mention: false, topic: '', modes: new Set(), key: '', hidden: true });
  }
  renderChannelList();
}

// Populate connect form from per-server settings (or fallback to last-used server).
(function init() {
  renderSavedProfiles();
  try {
    const ig = JSON.parse(localStorage.getItem('wirgloo:ignored') || '[]');
    ig.forEach(n => state.ignored.add(n.toLowerCase()));
  } catch {}
  // pre-fill form from this tab's last session (sessionStorage is per-tab)
  let tabSession = null;
  try { tabSession = JSON.parse(sessionStorage.getItem('wirgloo:session') || 'null'); } catch {}
  const lastServer = tabSession?.server || null;
  const lastNet    = tabSession?.network || null;
  if (lastServer) {
    const srv = loadSrv(lastServer);
    if (srv.nick)       $('nick').value = srv.nick;
    if (srv.realname)   $('realname').value = srv.realname;
    if (srv.authMethod) { $('auth-method').value = srv.authMethod; $('pass-field').classList.toggle('hidden', srv.authMethod === 'none'); }
    if (srv.noverify)   { $('tls').checked = true; $('tls').dispatchEvent(new Event('change')); $('noverify').checked = true; }
    if (srv.lastNetwork) {
      const sel = $('network');
      if ([...sel.options].some(o => o.value === srv.lastNetwork)) { sel.value = srv.lastNetwork; applyNetworkSelection(srv.lastNetwork); }
    }
  } else if (lastNet) {
    const sel = $('network');
    if ([...sel.options].some(o => o.value === lastNet)) { sel.value = lastNet; applyNetworkSelection(lastNet); }
  }

  // Pre-fill form from URL params (?server=…&port=…&tls=1&nick=…&channel=…).
  // Skipped when ?s= is present (session restore takes priority).
  const qp = new URLSearchParams(location.search);
  if (!qp.has('s') && qp.has('server')) {
    const srv      = qp.get('server');
    const tls      = qp.get('tls') === '1' || qp.get('tls') === 'true';
    const port     = parseInt(qp.get('port')) || (tls ? 6697 : 6667);
    const nick     = qp.get('nick') || '';
    const realname = qp.get('realname') || '';
    const auth     = qp.get('auth') || 'none';
    const pass     = qp.get('pass') || '';
    $('network').value = 'custom';
    applyNetworkSelection('custom');
    $('server').value   = srv;
    $('port').value     = port;
    $('tls').checked    = tls;
    $('tls').dispatchEvent(new Event('change'));
    if (qp.get('noverify') === '1') $('noverify').checked = true;
    if (nick)     $('nick').value = nick;
    if (realname) $('realname').value = realname;
    if (auth !== 'none') { $('auth-method').value = auth; $('pass-field').classList.remove('hidden'); }
    if (pass)     $('pass').value = pass;
    saveProfile({ server: srv, port, tls, nick });
    renderSavedProfiles();
    const ch = qp.get('channel');
    if (ch) state.pendingChannel = ch.startsWith('#') ? ch : '#' + ch;
  }

  // Suggest a nick+realname when neither has been pre-filled from saved state
  if (!$('nick').value) {
    const saved = loadDefaultNick();
    if (saved) {
      _nickOffset = saved.offset;
      $('nick').value = saved.nick;
      $('realname').value = saved.realname;
      $('realname').dataset.suggested = '1';
    } else {
      rotateSuggestion();
    }
  }

  $('nick-suggest-btn').addEventListener('click', rotateSuggestion);
})();

// ── Connect form ─────────────────────────────────────────────────────────────
connectForm.addEventListener('submit', e => {
  e.preventDefault();
  const server     = $('server').value.trim();
  const port       = parseInt($('port').value);
  const nick       = $('nick').value.trim();
  const tls        = $('tls').checked;
  const noverify = $('noverify').checked;
  const authMethod = $('auth-method').value;
  const pass       = $('pass').value;
  const realname   = $('realname').value.trim() || nick;
  if (!server || !nick) return;
  const netVal = $('network').value;
  saveSrv(server, { nick, realname: $('realname').value.trim() || nick, authMethod, noverify, lastNetwork: netVal });
  if (netVal === 'custom' || netVal.startsWith('saved:')) {
    saveProfile({ server, port, tls, nick });
    renderSavedProfiles();
  }
  state.server = server;
  try { sessionStorage.setItem('wirgloo:session', JSON.stringify({ server, network: netVal, tls })); } catch {}
  state.connectParams = { server, port, nick, realname, tls, noverify, authMethod, pass };
  connectError.classList.add('hidden');
  connectScreen.classList.add('hidden');
  chatScreen.classList.remove('hidden');
  ensureChannel('*server*');
  // Ensure *list* channel exists but is hidden by default
  if (!state.channels.has('*list*')) {
    state.channels.set('*list*', { messages: [], nicks: new Map(), unread: 0, mention: false, topic: '', modes: new Set(), key: '', hidden: true });
    renderChannelList();
  }
  setActive('*server*');
  myNick.textContent = nick;
  appendMsg('*server*', { type: 'connecting', nick: '--', text: `Connecting to ${server}:${port}…` });
  openWS(server, port, nick, realname, tls, noverify, authMethod, pass);
});

$('tls').addEventListener('change', function() {
  $('port').value = this.checked ? 6697 : 6667;
  $('noverify-field').classList.toggle('hidden', !this.checked);
  if (!this.checked) $('noverify').checked = false;
});

$('auth-method').addEventListener('change', function() {
  $('pass-field').classList.toggle('hidden', this.value === 'none');
});

function openWS(server, port, nick, realname, tls, noverify, authMethod, pass) {
  // close any existing socket before opening a new one
  if (state.ws) {
    state.ws.onclose = null; // prevent the close handler from firing
    state.ws.close();
    state.ws = null;
  }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  state.ws = ws;

  ws.onopen = () => {
    send({ type: 'connect', server, port, nick, realname, tls, noverify, pass, authmethod: authMethod });
  };

  ws.onmessage = e => {
    try { handle(JSON.parse(e.data)); } catch(err) { console.warn('ws message error', err); }
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
  // Normalise channel names to lowercase so #QuakeNet and #quakenet are the same key.
  if (msg.channel) msg.channel = chanKey(msg.channel);
  if (msg.target && msg.target.startsWith('#')) msg.target = chanKey(msg.target);
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

    case 'server_pong':
      updateLagDisplay(msg.ms);
      if (lagPingPending) {
        lagPingPending = false;
      } else {
        appendMsg('*server*', { type: 'notice', nick: state.servername || state.server, text: `PING reply: ${msg.ms} ms`, ts: Date.now() / 1000 });
        if (state.active !== '*server*') bumpUnread('*server*', false);
      }
      break;

    case 'ctcp_version_reply':
      appendMsg('*server*', { type: 'notice', nick: msg.from, text: `VERSION: ${msg.version}`, ts: Date.now() / 1000 });
      if (state.active !== '*server*') bumpUnread('*server*', false);
      break;

    case 'ctcp_ping_reply':
      appendMsg('*server*', { type: 'notice', nick: msg.from, text: `PING reply: ${msg.ms} ms`, ts: Date.now() / 1000 });
      if (state.active !== '*server*') bumpUnread('*server*', false);
      break;

    case 'server_meta':
      state.serverMeta[msg.key] = msg.value;
      if (state.active === '*server*') renderUserlist();
      break;

    case 'isupport_network':
      state.network = msg.value;
      applyServerMeta(state.network, state.servername, null);
      renderChannelList();
      updateTitle();
      break;

    case 'servername':
      state.servername = msg.value;
      applyServerMeta(state.network, state.servername, null);
      updateTitle();
      break;

    case 'connected': {
      const wasReconnect = state.connectParams && !state.connected;
      state.connected = true;
      resetAutoAway();
      state.sessionId = msg.session;
      state.nick = msg.nick;
      restoreScreen.classList.add('hidden');
      history.replaceState(null, '', '?s=' + msg.session);
      reconnectDelay = 1000;
      myNick.textContent = msg.nick;
      state.serverMeta = {};
      updateLagDisplay(null);
      scheduleLagPing(3000); // initial measurement ~3 s after connect
      applyServerMeta(null, null, msg.welcome);
      if (!wasReconnect) {
        // fresh connect — drop any channels left over from a previous server
        const serverMsg = state.channels.get('*server*');
        state.channels.clear();
        if (serverMsg) state.channels.set('*server*', serverMsg);
      }
      if (msg.welcome) appendMsg('*server*', { type: 'motd', nick: '-', text: msg.welcome });
      appendMsg('*server*', { type: 'system', nick: '--', text: `Connected to ${state.server} as ${msg.nick}` });
      requestNotifyPermission();
      restoreSavedChannels(state.server);
      // Ensure *list* channel exists but is hidden by default
      if (!state.channels.has('*list*')) {
        state.channels.set('*list*', { messages: [], nicks: new Map(), unread: 0, mention: false, topic: '', modes: new Set(), key: '', hidden: true });
      }
      if (state.pendingChannel) {
        send({ type: 'join', channel: state.pendingChannel });
        state.pendingChannel = null;
      }
      // re-join channels that were active before a session_expired reconnect
      if (wasReconnect) {
        state.channels.forEach((ch, target) => {
          if (target.startsWith('#') && !ch.offline) {
            ch.nicks = new Map(); // clear stale nick list
            send({ type: 'join', channel: target, ...(ch.key ? { key: ch.key } : {}) });
          }
        });
      }
      break;
    }

    case 'resumed': {
      state.connected = true;
      resetAutoAway();
      reconnectDelay = 1000;
      state.nick = msg.nick;
      state.server = msg.server || '';
      if (state.server) try {
        const prev = JSON.parse(sessionStorage.getItem('wirgloo:session') || 'null') || {};
        sessionStorage.setItem('wirgloo:session', JSON.stringify({ ...prev, server: state.server }));
      } catch {}
      myNick.textContent = msg.nick;
      ensureChannel('*server*');
      updateLagDisplay(null);
      scheduleLagPing(3000);
      if (msg.meta) state.serverMeta = msg.meta;
      applyServerMeta(msg.network, msg.servername, msg.welcome);
      restoreChannelsWithHistory(state.server);
      // ensure any channels the server knows about are present and marked live
      (msg.channels || []).forEach(ch => {
        const k = chanKey(ch);
        if (!state.channels.has(k))
          state.channels.set(k, { messages: [], nicks: new Map(), unread: 0, mention: false, topic: '', modes: new Set(), key: '', offline: false });
        else
          state.channels.get(k).offline = false;
      });
      renderChannelList();
      setActive('*server*');
      restoreScreen.classList.add('hidden');
      chatScreen.classList.remove('hidden');
      appendMsg('*server*', { type: 'system', nick: '--', text: 'Session restored' });
      break;
    }

    case 'connect_error':
      state.channels.clear();
      state.active = null;
      document.title = 'wirgloo';
      chatScreen.classList.add('hidden');
      connectScreen.classList.remove('hidden');
      showConnectError(msg.text);
      break;

    case 'session_expired':
      state.sessionId = null;
      state.connected = false;
      restoreScreen.classList.add('hidden');
      history.replaceState(null, '', location.pathname);
      if (state.connectParams) {
        // server was restarted — reconnect transparently using saved params
        const p = state.connectParams;
        appendMsg('*server*', { type: 'connecting', nick: '--', text: 'Session expired — reconnecting…' });
        reconnectDelay = 1000;
        openWS(p.server, p.port, p.nick, p.realname, p.tls, p.noverify, p.authMethod, p.pass);
      } else {
        state.ws?.close();
        state.channels.clear();
        state.active = null;
        chatScreen.classList.add('hidden');
        connectScreen.classList.remove('hidden');
      }
      showConnectError('Disconnected — server was restarted');
      break;

    case 'message': {
      const target = msg.target.startsWith('#') ? msg.target : msg.from;
      ensureChannel(target);
      // auto-fetch WHOIS when someone opens a DM with us
      if (target === msg.from && !state.whoisUsers.has(msg.from) && state.pendingWhois !== msg.from) {
        state.pendingWhois = msg.from;
        send({ type: 'raw', line: `WHOIS ${msg.from}` });
      }
      const isMe = msg.text.startsWith('/me ');
      const isMention = !isMe && msg.text.toLowerCase().includes(state.nick.toLowerCase());
      const cls  = isMe ? 'me' : (isMention ? 'mention' : '');
      appendMsg(target, { type: cls || 'msg', nick: msg.from, text: msg.text, ts: msg.ts });
      if (target !== state.active) bumpUnread(target, isMention, msg.from, msg.text);
      break;
    }

    case 'notice': {
      if (!state.connected) { appendMsg('*server*', { type: 'connecting', nick: msg.from || '--', text: msg.text, ts: msg.ts }); break; }
      const noticeDest = msg.target?.startsWith('#') && state.channels.has(msg.target)
        ? msg.target
        : (state.active || '*server*');
      appendMsg(noticeDest, { type: 'notice', nick: msg.from, text: msg.text, ts: msg.ts });
      break;
    }

    case 'join':
      if (msg.nick === state.nick) {
        const firstJoin = !state.channels.has(msg.channel);
        ensureChannel(msg.channel);
        const joiningCh = state.channels.get(msg.channel);
        const wasOffline = joiningCh?.offline ?? false;
        if (joiningCh) joiningCh.offline = false;
        if (firstJoin || wasOffline) {
          if (!state.joiningChannels) state.joiningChannels = new Set();
          state.joiningChannels.add(msg.channel);
          appendMsg(msg.channel, { type: 'system', nick: '*', text: `Now talking on ${msg.channel}` });
        }
        setActive(msg.channel);
        saveChannels(state.server); saveDMs(state.server);
      } else {
        ensureChannel(msg.channel);
        state.channels.get(msg.channel)?.nicks.set(msg.nick, '');
        renderUserlist();
        appendMsg(msg.channel, { type: 'join', nick: '→', text: `${msg.nick} joined ${msg.channel}`, ts: msg.ts });
      }
      break;

    case 'part':
      if (msg.nick === state.nick) {
        removeChannel(msg.channel);
        saveChannels(state.server); saveDMs(state.server);
      } else {
        state.channels.get(msg.channel)?.nicks.delete(msg.nick);
        renderUserlist();
        appendMsg(msg.channel, { type: 'part', nick: '←', text: `${msg.nick} left ${msg.channel}${msg.text ? ' (' + msg.text + ')' : ''}`, ts: msg.ts });
      }
      break;

    case 'mode': {
      const dest = msg.target.startsWith('#') ? msg.target : '*server*';
      const setter = msg.nick || msg.target;
      appendMsg(dest, { type: 'system', nick: '*', text: `${setter} sets mode ${msg.mode}`, ts: msg.ts });
      // track channel modes for +m/+R awareness and +k key memory
      const ch = state.channels.get(msg.target);
      if (ch) {
        const flags  = msg.flags || msg.mode.split(' ')[0] || '';
        const params = msg.params || msg.mode.split(' ').slice(1);
        let add = true, paramIdx = 0;
        for (const c of flags) {
          if (c === '+') { add = true; continue; }
          if (c === '-') { add = false; continue; }
          if (c === 'k') { ch.key = add ? (params[paramIdx] || '') : ''; paramIdx++; continue; }
          // modes with a parameter consume one entry from params
          if ('ovhaqbeIl'.includes(c)) paramIdx++;
          if (add) ch.modes.add(c); else ch.modes.delete(c);
        }
        if (dest === state.active) updateInputState();
      }
      break;
    }

    case 'invite':
      appendMsg('*server*', { type: 'notice', nick: msg.nick, text: `invites you to join ${msg.channel} — type /join ${msg.channel} to accept`, ts: msg.ts });
      if (state.active !== '*server*') bumpUnread('*server*', false);
      break;

    case 'kick': {
      const ch = state.channels.get(msg.channel);
      if (ch) {
        ch.nicks.delete(msg.nick);
        renderUserlist();
        const reason = msg.text ? ` (${msg.text})` : '';
        appendMsg(msg.channel, { type: 'part', nick: '←', text: `${msg.nick} was kicked by ${msg.by}${reason}`, ts: msg.ts });
      }
      if (msg.nick === state.nick) removeChannel(msg.channel);
      break;
    }

    case 'quit':
      state.channels.forEach((ch, target) => {
        if (ch.nicks.has(msg.nick)) {
          ch.nicks.delete(msg.nick);
          appendMsg(target, { type: 'quit', nick: '←', text: `${msg.nick} quit${msg.text ? ' (' + msg.text + ')' : ''}`, ts: msg.ts });
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
          appendMsg(target, { type: 'system', nick: '*', text: `${msg.old} is now known as ${msg.new}`, ts: msg.ts });
        }
      });
      renderUserlist();
      break;

    case 'whois_data': {
      const w = state.whoisUsers.get(msg.nick) || { realname:'', ident:'', host:'', server:'', location:'', idleSecs:0, account:'', channels:[], secure:false, ircop:false, bot:false, away:false, awayMsg:'' };
      switch (msg.field) {
        case 'user':     w.ident = msg.ident; w.host = msg.host; w.realname = msg.realname;
                         w.bot = /bot|serv/i.test(w.realname) || (w.ident.startsWith('~') && /bot|serv/i.test(w.host + w.account));
                         break;
        case 'server':   w.server = msg.server; w.location = msg.location; break;
        case 'ircop':    w.ircop = true; break;
        case 'idle':     w.idleSecs = parseInt(msg.seconds) || 0; break;
        case 'channels': w.channels = msg.channels; break;
        case 'account':  w.account = msg.account;
                         w.bot = /bot|serv/i.test(w.realname) || (w.ident.startsWith('~') && /bot|serv/i.test(w.host + w.account));
                         break;
        case 'secure':   w.secure = true; break;
      }
      state.whoisUsers.set(msg.nick, w);
      if (state.active === msg.nick) { updateDMTopic(msg.nick); renderUserlist(); }
      break;
    }

    case 'whois_end':
      if (state.pendingWhois === msg.nick) state.pendingWhois = null;
      if (state.active === msg.nick) renderUserlist();
      break;

    case 'away': {
      const w = state.whoisUsers.get(msg.nick) || {};
      w.away = msg.away; w.awayMsg = msg.away ? msg.text : '';
      state.whoisUsers.set(msg.nick, w);
      renderUserlist();
      break;
    }

    case 'away_reply': {
      const w = state.whoisUsers.get(msg.nick) || {};
      w.away = true; w.awayMsg = msg.text;
      state.whoisUsers.set(msg.nick, w);
      appendMsg(state.active || '*server*', { type: 'system', nick: '--', text: `${msg.nick} is away: ${msg.text}` });
      renderUserlist();
      break;
    }

    case 'away_status':
      state.away = msg.away;
      $('away-btn').textContent = state.away ? '● Back' : '⏾ Away';
      appendMsg(state.active || '*server*', { type: 'system', nick: '--', text: msg.text });
      break;

    case 'motd':
      appendMsg('*server*', { type: 'motd', nick: '-', text: msg.text });
      break;

    case 'list_start':
      state.listItems = [];
      state.listTotal = 0;
      state.listShown = 0;
      state.listCapped = false;
      if (msg.filter == null) {
        state.listFilter = '';
        $('list-filter').value = '';
      }
      ensureChannel('*list*');
      state.channels.get('*list*').messages = [];
      state.channels.get('*list*').hidden = false; // Unhide list when user requests it
      if (state.active !== '*list*') setActive('*list*');
      renderChannelList();
      renderListBar();
      break;

    case 'list_item':
      state.listItems.push({ channel: msg.channel, count: parseInt(msg.count) || 0, topic: msg.topic || '' });
      break;

    case 'list_end':
      state.listTotal = msg.total || state.listItems.length;
      state.listShown = msg.shown || state.listItems.length;
      state.listCapped = !!msg.capped;
      if (state.active === '*list*') { renderListMessages(); updateTargetName('*list*'); }
      break;

    case 'topic': {
      const ch = state.channels.get(msg.channel);
      if (ch) {
        ch.topic = msg.text;
        if (msg.channel === state.active) topicText.innerHTML = renderText(msg.text);
        if (state.joiningChannels?.has(msg.channel) && msg.text) {
          appendMsg(msg.channel, { type: 'system', nick: '*', text: `Topic for ${msg.channel} is: ${msg.text}`, ts: msg.ts });
        } else if (msg.nick) {
          appendMsg(msg.channel, { type: 'system', nick: '*', text: `${msg.nick} changed the topic to: ${msg.text}`, ts: msg.ts });
        }
      }
      break;
    }

    case 'topic_meta': {
      if (state.joiningChannels?.has(msg.channel)) {
        appendMsg(msg.channel, { type: 'system', nick: '*', text: `Topic set by ${msg.setter} (${msg.time})` });
        state.joiningChannels.delete(msg.channel);
      }
      break;
    }

    case 'names_chunk': {
      const ch = state.channels.get(msg.channel);
      if (ch) {
        if (!ch._namesAccum) ch._namesAccum = new Map();
        const escaped = Object.keys(state.prefixRank).map(s => s.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')).join('');
        const allPrefixSyms = new RegExp(`^[${escaped}]+`);
        msg.nicks.forEach(n => {
          const pm = n.match(allPrefixSyms);
          const prefix = pm ? pm[0] : '';
          const full = n.slice(prefix.length); // nick or nick!user@host
          const bangIdx = full.indexOf('!');
          const nick = bangIdx !== -1 ? full.slice(0, bangIdx) : full;
          ch._namesAccum.set(nick, prefix);
          if (bangIdx !== -1) {
            const hostStr = full.slice(bangIdx + 1); // ident@host
            if (!state.whoisUsers.has(nick)) {
              const [ident, host] = hostStr.split('@');
              state.whoisUsers.set(nick, { realname:'', ident: ident||'', host: host||hostStr, server:'', location:'', idleSecs:0, account:'', channels:[], secure:false, ircop:false, bot:false, away:false, awayMsg:'' });
            }
          }
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
      // ignore if we're already reconnecting transparently
      if (!state.connected && state.connectParams) break;
      onDisconnect(msg.text);
      break;
  }
}

// ── Chat log persistence ──────────────────────────────────────────────────────
const LOG_MAX   = 100;
const LOG_TYPES = new Set(['msg', 'me', 'notice', 'join', 'part', 'quit', 'system']);

function logKey(server, target) {
  return `wirgloo:log:${server}:${target}`;
}

function persistMsg(target, m) {
  if (!LOG_TYPES.has(m.type)) return;
  const key = logKey(state.server, target);
  let log;
  try { log = JSON.parse(localStorage.getItem(key) || '[]'); } catch { log = []; }
  log.push(m);
  if (log.length > LOG_MAX) log.splice(0, log.length - LOG_MAX);
  try { localStorage.setItem(key, JSON.stringify(log)); } catch { console.warn('localStorage quota exceeded — chat log not saved'); }
}

function loadLog(server, target) {
  try { return JSON.parse(localStorage.getItem(logKey(server, target)) || '[]'); } catch { return []; }
}

// ── Channels ──────────────────────────────────────────────────────────────────
// IRC channel names are case-insensitive; normalise to lowercase so that
// #QuakeNet and #quakenet always refer to the same entry in state.channels.
function chanKey(target) {
  return target.startsWith('#') ? target.toLowerCase() : target;
}

function ensureChannel(target) {
  target = chanKey(target);
  if (!state.channels.has(target)) {
    const history = loadLog(state.server, target);
    const messages = history.length
      ? [...history, { type: 'session-break', nick: '', text: '', ts: null }]
      : [];
    state.channels.set(target, { messages, nicks: new Map(), unread: 0, mention: false, topic: '', modes: new Set(), key: '' });
    renderChannelList();
  }
}

function removeChannel(target) {
  state.channels.delete(target);
  if (state.active === target) {
    const next = state.channels.keys().next().value;
    setActive(next || null);
  }
  if (isDM(target)) saveDMs(state.server);
  renderChannelList();
}

function updateTargetName(target) {
  const label = target === '*server*' ? (state.servername || state.server)
              : target === '*list*'   ? `Channels${state.listTotal ? ' (' + state.listTotal + ')' : ''}`
              : target;
  let tls = state.connectParams?.tls;
  if (tls === undefined) { try { tls = JSON.parse(sessionStorage.getItem('wirgloo:session') || 'null')?.tls; } catch {} }
  const lock = target === '*server*' ? (tls ? '🔒 ' : '🔓 ') : '';
  targetName.textContent = lock + label;
}

function setActive(target) {
  if (!target || !state.channels.has(target)) return;
  openPanel((isDM(target) || target === '*server*') ? 'userlist' : null);
  state.active = target;
  state.dmOriginChannel = null;
  const ch = state.channels.get(target);
  ch.unread  = 0;
  ch.mention = false;
  renderChannelList();
  renderMessages(target);
  document.getElementById('userlist-panel').classList.toggle('wide', target === '*server*');
  renderUserlist();
  updateTargetName(target);
  if (isDM(target)) updateDMTopic(target);
  else topicText.innerHTML = renderText(ch.topic || '');
  updateTitle();
  renderListBar();
  updateInputState();
  input.focus();
}

function updateInputState() {
  const ch = state.active && state.channels.get(state.active);
  const identified = !!state.whoisUsers.get(state.nick)?.account;
  const muted = ch && (
    (ch.modes.has('m') && !isVoicedOrOp(state.active, state.nick)) ||
    (ch.modes.has('R') && !identified)
  );
  input.disabled = !!muted;
  input.placeholder = muted
    ? (ch.modes.has('m') ? 'Channel is moderated (+m)' : 'Registered users only (+R)')
    : 'Message…';
}

function isVoicedOrOp(channel, nick) {
  const ch = state.channels.get(channel);
  if (!ch) return false;
  const prefix = ch.nicks.get(nick) || '';
  return prefix.length > 0; // any prefix (voice or above) grants speak rights in +m
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
  const frag = document.createDocumentFragment();
  state.listItems.forEach(item => {
    const el = document.createElement('div');
    el.className = 'msg list';
    el.innerHTML = `
      <span class="ts list-count">${item.count}</span>
      <span class="body">
        <span class="nick-col chan list-join" data-channel="${escHtml(item.channel)}">${escHtml(item.channel)}</span>
        <span class="text ltopic">${renderText(item.topic)}</span>
      </span>`;
    el.querySelector('.list-join').addEventListener('click', () => {
      send({ type: 'join', channel: item.channel });
    });
    frag.appendChild(el);
  });
  const summary = document.createElement('div');
  summary.className = 'msg system';
  let statusText = state.listFilter
    ? `${state.listShown} of ${state.listTotal} channels`
    : `${state.listTotal} channels`;
  if (state.listCapped) statusText += ` — showing top 50, type to filter`;
  summary.innerHTML = `<span class="ts"></span><span class="body"><span class="nick-col"></span><span class="text">${statusText}</span></span>`;
  frag.appendChild(summary);
  messages.innerHTML = '';
  messages.appendChild(frag);
}

function updateTitle() {
  const net = state.network || state.servername || state.server;
  let label;
  if (!state.active) {
    label = null;
  } else if (state.active === '*server*') {
    label = net || null;
  } else if (state.active === '*list*') {
    label = net ? `${net} — Channel list` : 'Channel list';
  } else {
    label = net ? `${net} — ${state.active}` : state.active;
  }
  document.title = label ? `${label} — wirgloo` : 'wirgloo';
}

function bumpUnread(target, mention, fromNick, text) {
  const ch = state.channels.get(target);
  if (!ch) return;
  ch.unread++;
  if (mention) ch.mention = true;
  renderChannelList();
  if (mention && fromNick && text) notify(target, fromNick, text);
}

// ── Browser notifications ─────────────────────────────────────────────────────
function requestNotifyPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

function notify(target, fromNick, text) {
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;
  if (document.visibilityState === 'visible') return; // tab is focused
  const label = target === fromNick ? fromNick : `${fromNick} in ${target}`;
  const n = new Notification(`wirgloo — ${label}`, {
    body: text.replace(/\x02|\x1D|\x1F|\x0F|\x16|\x11/g, '').replace(/\x03\d{0,2}(,\d{0,2})?/g, '').slice(0, 120),
    tag:  target, // collapse multiple notifications per target
    icon: '/favicon.ico',
  });
  n.onclick = () => { window.focus(); setActive(target); n.close(); };
}

// ── Render ────────────────────────────────────────────────────────────────────
function applyServerMeta(network, servername, welcome) {
  if (network)    state.network    = network;
  if (servername) state.servername = servername;
  const srv = state.channels.get('*server*');
  if (srv && welcome) srv.topic = welcome;
  if (state.active === '*server*') {
    updateTargetName('*server*');
    if (welcome !== null) topicText.innerHTML = renderText(welcome || '');
  }
}

function renderChannelList() {
  channelList.innerHTML = '';
  // Render in fixed order: *server*, *list*, then other channels
  const order = ['*server*', '*list*'];
  const other = [];
  state.channels.forEach((ch, target) => {
    if (!order.includes(target)) other.push(target);
  });
  const allTargets = [...order.filter(t => state.channels.has(t)), ...other];
  
  allTargets.forEach(target => {
    const ch = state.channels.get(target);
    const el = document.createElement('div');
    el.className = 'chan-item' +
      (target === state.active ? ' active' : '') +
      (ch.hidden ? ' hidden' : '') +
      (ch.offline ? ' offline' : '') +
      (ch.mention ? ' mention' : ch.unread > 0 ? ' unread' : '');
    let icon, label;
    if (target === '*server*') { icon = '🖧'; label = state.network || state.servername || state.server; }
    else if (target === '*list*') { icon = '☰'; label = 'Channel list'; }
    else if (target.startsWith('#')) { icon = '＃'; label = target.slice(1); }
    else { icon = '◉'; label = target; } // DM
    el.innerHTML = `<span class="chan-icon">${icon}</span><span class="chan-label">${escHtml(label)}</span>`;
    if (!ch.offline && ch.unread > 0) {
      el.innerHTML += `<span class="unread-badge">${ch.unread}</span>`;
    } else if (!ch.offline && target !== '*server*' && target !== '*list*') {
      el.innerHTML += `<button class="close-btn" data-target="${escHtml(target)}">×</button>`;
    } else if (ch.offline) {
      el.innerHTML += `<button class="close-btn" data-target="${escHtml(target)}">×</button>`;
    }
    el.addEventListener('click', ev => {
      if (ev.target.classList.contains('close-btn')) {
        const t = ev.target.dataset.target;
        if (ch.offline) {
          removeChannel(t);
          saveChannels(state.server); saveDMs(state.server);
        } else if (t.startsWith('#')) {
          send({ type: 'part', channel: t });
        } else {
          removeChannel(t);
        }
        return;
      }
      if (ch.offline) {
        openPanel(null);
        send({ type: 'join', channel: target });
      } else {
        // Unhide *list* when it's clicked
        if (target === '*list*') ch.hidden = false;
        setActive(target);
        renderChannelList();
      }
    });
    channelList.appendChild(el);
  });
}

const SYSTEM_TYPES = new Set(['system', 'join', 'part', 'quit', 'error', 'connecting', 'motd', 'notice', 'whois']);

function renderMessages(target) {
  if (target === '*list*') { renderListMessages(); return; }
  const ch = state.channels.get(target);
  userScrolledUp = false;
  messages.innerHTML = '';
  if (!ch) return;
  let prevNick = null, prevTs = 0, prevType = null;
  ch.messages.forEach(m => {
    const grouped = canGroup(m, prevNick, prevTs, prevType);
    messages.appendChild(buildMsgEl(m, target, grouped));
    prevNick = m.nick || null; prevTs = m.ts || 0; prevType = m.type || 'msg';
  });
  requestAnimationFrame(() => { messages.scrollTop = messages.scrollHeight; });
}

function appendMsg(target, m) {
  if (m.nick && state.ignored.has(m.nick.toLowerCase())) return;
  const ch = state.channels.get(target);
  if (!ch) return;
  ch.messages.push(m);
  if (ch.messages.length > 2000) ch.messages.shift();
  persistMsg(target, m);
  if (target === state.active) {
    const last = messages.lastElementChild;
    const grouped = canGroup(m, last?.dataset.nick, parseFloat(last?.dataset.ts || 0), last?.dataset.msgtype);
    messages.appendChild(buildMsgEl(m, target, grouped));
    if (!userScrolledUp) messages.scrollTop = messages.scrollHeight;
  }
}

function canGroup(m, prevNick, prevTs, prevType) {
  const cls = m.type || 'msg';
  // consecutive system-type messages always collapse (different nicks each time)
  if (SYSTEM_TYPES.has(cls) && SYSTEM_TYPES.has(prevType)) return true;
  // motd lines have no ts — group them whenever they arrive back-to-back
  if (cls === 'motd' && prevType === 'motd') return true;
  // chat messages group when same nick within 2 minutes
  const chatGroupable = new Set(['msg', 'me', 'mention', 'notice', 'motd', 'whois', 'connecting']);
  return chatGroupable.has(cls) && m.nick && m.nick === prevNick && (m.ts - prevTs) < 120;
}

function buildMsgEl(m, target, grouped = false) {
  const el  = document.createElement('div');
  const cls = m.type || 'msg';
  el.className = `msg ${cls}`;
  const ts = m.ts ? fmtTime(m.ts) : fmtTime(Date.now() / 1000);
  if (m.nick) { el.dataset.nick = m.nick; el.dataset.ts = m.ts || 0; }
  el.dataset.msgtype = cls;
  if (grouped) el.classList.add('grouped');

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
  const nc   = nickColor(m.nick);
  const hue  = nickHue(m.nick);
  if (hue !== null) el.style.setProperty('--nc-hue', hue);

  if (m.text && m.text.startsWith('/me ') && m.type !== 'system') {
    const action = m.text.slice(4);
    el.className += ' action' + (self ? ' self' : '');
    el.innerHTML = `
      <span class="ts">${ts}</span>
      <span class="body">
        <span class="nick-col action-star" style="${nc ? `color:${nc}` : ''}">*</span>
        <span class="action-text" style="${nc ? `color:${nc}` : ''}"><b class="nick-link" data-nick="${escHtml(m.nick || '')}">${escHtml(m.nick || '')}</b> ${highlightNicks(renderText(action), state.channels.get(state.active)?.nicks)}</span>
      </span>`;
    return el;
  }

  if (self) el.classList.add('self');

  const isSentinel = !m.nick || m.nick === '*' || m.nick === '-' || m.nick === '--' || m.nick === '!' || m.nick === '→' || m.nick === '←';
  el.innerHTML = `
    <span class="ts">${ts}</span>
    <span class="body">
      <span class="msg-header${isSentinel ? '' : ' nick-link'}" data-nick="${escHtml(m.nick || '')}">${escHtml(m.nick || '')} · ${ts}</span>
      <span class="nick-col ${self ? 'self' : ''}${isSentinel ? '' : ' nick-link'}" data-nick="${escHtml(m.nick || '')}" style="${nc ? `color:${nc}` : ''}">${escHtml(m.nick || '')}</span>
      <span class="text">${highlightNicks(renderText(m.text, cls !== 'msg' && cls !== 'me'), state.channels.get(state.active)?.nicks)}</span>
    </span>`;
  return el;
}

function isDM(target) {
  return !!target && !target.startsWith('#') && target !== '*server*' && target !== '*list*';
}

function updateDMTopic(nick) {
  const u = state.whoisUsers?.get(nick);
  const host = u ? (u.ident ? `${u.ident}@${u.host}` : u.host) : '';
  topicText.textContent = u?.realname ? `${u.realname}  ${host}` : (host || '');
}

function openDM(nick, fromChannel) {
  ensureChannel(nick);
  setActive(nick);
  if (fromChannel) { state.dmOriginChannel = fromChannel; renderUserlist(); }
  saveDMs(state.server);
  // auto-fetch WHOIS so the DM card shows badges immediately
  if (!state.whoisUsers.has(nick) || !state.whoisUsers.get(nick).realname) {
    state.pendingWhois = nick;
    send({ type: 'raw', line: `WHOIS ${nick}` });
  }
}

function fmtIdle(secs) {
  if (secs < 60)   return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs/60)}m ${secs%60}s`;
  return `${Math.floor(secs/3600)}h ${Math.floor((secs%3600)/60)}m`;
}

function renderUserlist() {
  const header = $('userlist-header');
  const footer = $('userlist-footer');
  userlist.innerHTML = '';
  footer.innerHTML = '';
  footer.classList.add('hidden');

  if (state.active === '*server*') {
    header.textContent = 'Server';
    const m = state.serverMeta;
    const rows = [];
    const row = (k, v) => `<div class="wi-row"><span class="wi-key">${k}</span><span class="wi-val">${escHtml(String(v))}</span></div>`;
    const displayName = state.network || state.servername || state.server;
    const card = document.createElement('div');
    card.className = 'dm-card';
    card.innerHTML =
      `<div class="dm-avatar" style="background:var(--accent)">🖧</div>` +
      `<div class="dm-nick">${escHtml(displayName)}</div>`;
    userlist.appendChild(card);

    if (state.network)    rows.push(row('Network',  state.network));
    if (state.servername) rows.push(row('Host',     state.servername));
    if (m.software)       rows.push(row('Software', m.software));
    if (m.created)        rows.push(row('Created',  m.created));
    if (m.channels)       rows.push(row('Channels', m.channels));
    if (m.local_users)    rows.push(row('Local',    m.local_users));
    if (m.global_users)   rows.push(row('Global',   m.global_users));
    if (m.admin?.length) {
      const labels = ['Admin', 'Location', 'Email'];
      m.admin.forEach((l, i) => rows.push(row(labels[i] ?? 'Admin', l)));
    }
    if (rows.length) {
      const info = document.createElement('div');
      info.className = 'dm-whois';
      info.innerHTML = rows.join('');
      userlist.appendChild(info);
    }

    footer.innerHTML =
      `<button id="srv-ping">↔ Ping</button>` +
      `<button id="srv-help">? Help</button>`;
    footer.classList.remove('hidden');
    footer.querySelector('#srv-ping').addEventListener('click', () => {
      send({ type: 'raw', line: `PING :${Date.now()}` });
    });
    footer.querySelector('#srv-help').addEventListener('click', () => {
      send({ type: 'raw', line: 'HELP' });
    });
    return;
  }

  if (isDM(state.active)) {
    const nick = state.active;
    const nc   = nickColor(nick);
    header.textContent = 'User';

    const card = document.createElement('div');
    card.className = 'dm-card';

    const w = state.whoisUsers.get(nick) || null;

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
      ${badges.length ? `<div class="dm-badges">${badges.join('')}</div>` : ''}`;

    if (w && (w.realname || w.host || w.server || w.idleSecs || w.channels.length)) {
      const info = document.createElement('div');
      info.className = 'dm-whois';
      const rows = [];
      if (w.away && w.awayMsg) rows.push(`<div class="wi-row"><span class="wi-key">Away</span><span class="wi-val wi-away">${escHtml(w.awayMsg)}</span></div>`);
      if (w.realname) rows.push(`<div class="wi-row"><span class="wi-key">Name</span><span class="wi-val">${escHtml(w.realname)}</span></div>`);
      if (w.account)  rows.push(`<div class="wi-row"><span class="wi-key">Account</span><span class="wi-val">${escHtml(w.account)}</span></div>`);
      if (w.host)     rows.push(`<div class="wi-row"><span class="wi-key">Host</span><span class="wi-val">${escHtml((w.ident ? w.ident+'@' : '')+w.host)}</span></div>`);
      if (w.server)   rows.push(`<div class="wi-row"><span class="wi-key">Server</span><span class="wi-val">${escHtml(w.server)}${w.location ? ' · '+escHtml(w.location) : ''}</span></div>`);
      if (w.idleSecs) rows.push(`<div class="wi-row"><span class="wi-key">Idle</span><span class="wi-val">${escHtml(fmtIdle(w.idleSecs))}</span></div>`);
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
          return `<span class="wi-chan">${prefixHtml}<a class="wi-chan-name" href="#" data-chan="${escHtml(chan)}">${escHtml(chan)}</a></span>`;
        }).join('');
        rows.push(`<div class="wi-row"><span class="wi-key">In</span><span class="wi-val wi-chans">${chips}</span></div>`);
      }
      info.innerHTML = rows.join('');
      info.querySelectorAll('a.wi-chan-name').forEach(a => {
        a.addEventListener('click', e => {
          e.preventDefault();
          const ch = a.dataset.chan;
          if (state.channels.has(ch))
            setActive(ch);
          else
            send({ type: 'join', channel: ch });
          openPanel(null);
        });
      });
      card.appendChild(info);
    }

    const chan = state.dmOriginChannel;
    footer.innerHTML =
      (chan ? `<button id="uf-op">● Op</button>` +
              `<button id="uf-deop">○ DeOp</button>` +
              `<button id="uf-voice">+ Voice</button>` +
              `<button id="uf-devoice">− DeVoice</button>` +
              `<button id="uf-ban" class="danger">⊘ Ban</button>` +
              `<button id="uf-kick" class="danger">✕ Kick</button>` +
              `<div class="userlist-footer-sep"></div>` : '') +
      (state.ignored.has(nick.toLowerCase()) ? `<button id="uf-ignore">⊕ UnIgnore</button>` : `<button id="uf-ignore">⊖ Ignore</button>`) +
      `<div class="userlist-footer-sep"></div>` +
      `<button id="whois-btn">⊕ Info</button>` +
      `<button id="ping-btn">↔ Ping</button>` +
      `<button id="version-btn">© Version</button>` +
      `<button id="close-dm-btn" class="danger">✕ Close</button>`;
    footer.classList.remove('hidden');
    footer.querySelector('#whois-btn').addEventListener('click', () => {
      state.whoisUsers.delete(nick);
      state.pendingWhois = nick;
      send({ type: 'raw', line: `WHOIS ${nick}` });
    });
    footer.querySelector('#ping-btn').addEventListener('click', () => {
      send({ type: 'raw', line: `PRIVMSG ${nick} :\x01PING ${Date.now()}\x01` });
    });
    footer.querySelector('#version-btn').addEventListener('click', () => {
      send({ type: 'raw', line: `PRIVMSG ${nick} :\x01VERSION\x01` });
    });
    footer.querySelector('#close-dm-btn').addEventListener('click', () => removeChannel(nick));
    footer.querySelector('#uf-ignore').addEventListener('click', () => {
      const key = nick.toLowerCase();
      if (state.ignored.has(key)) state.ignored.delete(key);
      else state.ignored.add(key);
      saveIgnored();
      renderUserlist();
    });
    if (chan) {
      footer.querySelector('#uf-op').addEventListener('click',      () => send({ type: 'raw', line: `MODE ${chan} +o ${nick}` }));
      footer.querySelector('#uf-deop').addEventListener('click',    () => send({ type: 'raw', line: `MODE ${chan} -o ${nick}` }));
      footer.querySelector('#uf-voice').addEventListener('click',   () => send({ type: 'raw', line: `MODE ${chan} +v ${nick}` }));
      footer.querySelector('#uf-devoice').addEventListener('click', () => send({ type: 'raw', line: `MODE ${chan} -v ${nick}` }));
      footer.querySelector('#uf-ban').addEventListener('click',     () => send({ type: 'raw', line: `MODE ${chan} +b ${nick}!*@*` }));
      footer.querySelector('#uf-kick').addEventListener('click',    () => send({ type: 'raw', line: `KICK ${chan} ${nick} :Kicked` }));
    }

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
  const originChannel = state.active;
  sorted.forEach(([nick, prefix]) => {
    const topChar = [...prefix].sort((a, b) => (state.prefixRank[a]??99) - (state.prefixRank[b]??99))[0];
    const cls = topChar ? (state.prefixClass[topChar] || '') : '';
    const el = document.createElement('div');
    el.className = 'user-item' + (cls ? ' ' + cls : '');
    const nc = nickColor(nick);
    const prefixHtml = topChar
      ? `<span class="user-prefix">${escHtml(topChar)}</span>`
      : `<span class="user-prefix-none"> </span>`;
    const isAway = state.whoisUsers.get(nick)?.away || false;
    const badge = isAway ? `<span class="user-status away" title="Away">⏾</span>`
                         : `<span class="user-status"></span>`;
    el.innerHTML = `<span class="user-nick">${prefixHtml}<span style="${nc ? `color:${nc}` : ''}">${escHtml(nick)}</span></span>${badge}`;
    if (nick !== state.nick) {
      el.style.cursor = 'pointer';
      el.addEventListener('click', () => openDM(nick, originChannel));
    }
    userlist.appendChild(el);
  });
}

// ── Input / commands ──────────────────────────────────────────────────────────
// ── Mobile panel toggles ─────────────────────────────────────────────────────
function openPanel(panel) {
  document.getElementById('sidebar').classList.toggle('open', panel === 'sidebar');
  document.getElementById('userlist-panel').classList.toggle('open', panel === 'userlist');
  const backdrop = $('panel-backdrop');
  backdrop.classList.toggle('visible', !!panel);
}
$('panel-backdrop').addEventListener('click', () => openPanel(null));
messages.addEventListener('click', e => {
  openPanel(null);
  const nl = e.target.closest('.nick-link');
  if (nl) {
    const nick = nl.dataset.nick;
    if (nick && nick !== state.nick) openDM(nick);
  }
});

let userScrolledUp = false;
const scrollBottomBtn = $('scroll-bottom');
messages.addEventListener('scroll', () => {
  const dist = messages.scrollHeight - messages.scrollTop - messages.clientHeight;
  scrollBottomBtn.classList.toggle('visible', dist > 200);
  userScrolledUp = dist > 60;
}, { passive: true });
scrollBottomBtn.addEventListener('click', () => {
  userScrolledUp = false;
  messages.scrollTo({ top: messages.scrollHeight, behavior: 'smooth' });
});
$('sidebar-toggle').addEventListener('click', () => {
  const isOpen = document.getElementById('sidebar').classList.contains('open');
  openPanel(isOpen ? null : 'sidebar');
});
$('userlist-toggle').addEventListener('click', () => {
  const isOpen = document.getElementById('userlist-panel').classList.contains('open');
  openPanel(isOpen ? null : 'userlist');
});
// Swipe gestures for slide-in panels (mobile only)
{
  const SWIPE_MIN = 40;   // px horizontal travel required
  const SWIPE_MAX = 80;   // px vertical travel allowed before we bail
  const EDGE     = 30;    // px from screen edge to start a new-panel swipe
  let t0x = 0, t0y = 0, startedFromEdge = false;

  document.addEventListener('touchstart', e => {
    const t = e.touches[0];
    t0x = t.clientX; t0y = t.clientY;
    startedFromEdge = t0x < EDGE || t0x > window.innerWidth - EDGE;
  }, { passive: true });

  document.addEventListener('touchend', e => {
    const t = e.changedTouches[0];
    const dx = t.clientX - t0x, dy = t.clientY - t0y;
    if (Math.abs(dy) > SWIPE_MAX || Math.abs(dx) < SWIPE_MIN) return;

    const sidebarOpen = document.getElementById('sidebar').classList.contains('open');
    const userlistOpen = document.getElementById('userlist-panel').classList.contains('open');

    if (dx > 0) {
      // swipe right: open sidebar (from left edge or anywhere if nothing open)
      if (startedFromEdge || (!sidebarOpen && !userlistOpen))
        openPanel(sidebarOpen ? null : 'sidebar');
      else if (userlistOpen)
        openPanel(null);
    } else {
      // swipe left: open userlist (from right edge or anywhere if nothing open)
      if (startedFromEdge || (!sidebarOpen && !userlistOpen))
        openPanel(userlistOpen ? null : 'userlist');
      else if (sidebarOpen)
        openPanel(null);
    }
  }, { passive: true });
}

$('send-btn').addEventListener('click', sendInput);
input.addEventListener('keydown', e => {
  if (e.key === 'Enter') { sendInput(); tabComplete.reset(); inputHistory.reset(); }
  else if (e.key === 'Tab') { e.preventDefault(); tabComplete.next(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); inputHistory.prev(); tabComplete.reset(); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); inputHistory.next(); tabComplete.reset(); }
  else if (e.key !== 'Shift') tabComplete.reset();
});

const inputHistory = (() => {
  const hist = [];   // oldest-first list of sent lines
  let pos = -1;      // -1 = not browsing; 0..hist.length-1 = browsing
  let draft = '';    // saved current input while browsing

  return {
    push(val) { if (val && hist[hist.length - 1] !== val) hist.push(val); },
    prev() {
      if (hist.length === 0) return;
      if (pos === -1) { draft = input.value; pos = hist.length; }
      if (pos > 0) { pos--; input.value = hist[pos]; }
    },
    next() {
      if (pos === -1) return;
      pos++;
      if (pos >= hist.length) { pos = -1; input.value = draft; }
      else { input.value = hist[pos]; }
    },
    reset() { pos = -1; draft = ''; },
  };
})();

const tabComplete = (() => {
  let candidates = [], idx = -1, prefix = '', stub = '';

  const COMMANDS = [
    'away','ban','clear','help','ignore','invite','join','kick','list',
    'me','mode','msg','nick','notice','part','ping','query','quit',
    'raw','slap','topic','unban','unignore','whois',
  ];

  return {
    next() {
      if (candidates.length === 0) {
        const val   = input.value;
        const space = val.lastIndexOf(' ');
        stub        = val.slice(space + 1);
        prefix      = val.slice(0, space + 1);
        if (!stub) return;

        const low = stub.toLowerCase();

        if (space === -1 && val.startsWith('/')) {
          // complete command name
          const cmdStub = low.slice(1);
          candidates = COMMANDS.filter(c => c.startsWith(cmdStub)).map(c => '/' + c);
        } else if (stub.startsWith('#')) {
          // complete channel name from open channels
          candidates = [...state.channels.keys()]
            .filter(k => k.startsWith('#') && k.startsWith(low))
            .sort();
        } else {
          // complete nick from current channel
          const ch = state.active && state.channels.get(state.active);
          if (!ch) return;
          candidates = [...ch.nicks.keys()]
            .filter(n => n.toLowerCase().startsWith(low))
            .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
        }
        idx = -1;
      }
      if (candidates.length === 0) return;
      idx = (idx + 1) % candidates.length;
      const isNick = !candidates[0].startsWith('/') && !candidates[0].startsWith('#');
      const suffix = (isNick && prefix === '') ? ': ' : ' ';
      input.value  = prefix + candidates[idx] + suffix;
    },
    reset() { candidates = []; idx = -1; stub = ''; prefix = ''; },
  };
})();

function sendInput() {
  const val = input.value.trim();
  if (!val || !state.active) return;
  inputHistory.push(val);
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
    case 'J':
    case 'JOIN': {
      const [jchan, jkey] = arg.split(/\s+/, 2);
      const jchanKey = chanKey(jchan);
      send({ type: 'join', channel: jchan, ...(jkey ? { key: jkey } : {}) });
      // pre-seed key so auto-rejoin can use it before MODE arrives
      if (jkey) { ensureChannel(jchanKey); state.channels.get(jchanKey).key = jkey; }
      break;
    }
    case 'P':
    case 'PART':
      send({ type: 'part', channel: arg || state.active });
      break;
    case 'NICK':
      send({ type: 'nick', nick: arg });
      break;
    case 'M':
    case 'MSG':
    case 'QUERY': {
      const [target, ...txt] = arg.split(' ');
      if (!target) break;
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
    case 'WI':
    case 'WHOIS':
      if (arg) send({ type: 'raw', line: `WHOIS ${arg}` });
      break;
    case 'AWAY':
      send({ type: 'raw', line: arg ? `AWAY :${arg}` : 'AWAY' });
      break;
    case 'Q':
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
        '/join <#channel> [key]  — join a channel  (/j)',
        '/part [reason]          — leave current channel  (/p)',
        '/nick <newnick>         — change nickname',
        '/msg <nick> [text]      — open DM / send message  (/m)',
        '/me <action>            — send action (/me waves)',
        '/notice <target> <text> — send a NOTICE',
        '/topic [new topic]      — show or set topic',
        '/kick <nick> [reason]   — kick from channel',
        '/ban <nick>             — ban nick!*@* from channel',
        '/unban <nick>           — remove ban',
        '/mode [target] <modes>  — set modes',
        '/invite <nick> [#chan]  — invite user to channel',
        '/whois <nick>           — show user info  (/wi)',
        '/ping <nick>            — CTCP ping a user',
        '/away [message]         — set or clear away status',
        '/list [filter]          — list channels',
        '/ignore [nick]          — ignore nick (no arg = list)',
        '/unignore <nick>        — stop ignoring nick',
        '/slap <nick>            — the classics never die',
        '/clear                  — clear message buffer',
        '/raw <line>             — send raw IRC line  (/q, /quote)',
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

let listFilterTimer = null;
$('list-filter').addEventListener('input', e => {
  state.listFilter = e.target.value.trim();
  clearTimeout(listFilterTimer);
  listFilterTimer = setTimeout(() => {
    send({ type: 'list_filter', text: state.listFilter });
  }, 300);
});

// ── Sidebar buttons ───────────────────────────────────────────────────────────
$('list-btn').addEventListener('click', () => {
  openPanel(null);
  send({ type: 'raw', line: 'LIST' });
});

$('join-btn').addEventListener('click', () => {
  openPanel(null);
  const ch = prompt('Channel to join:');
  if (ch) send({ type: 'join', channel: chanKey(ch.startsWith('#') ? ch : '#' + ch) });
});

$('nick-btn').addEventListener('click', () => {
  openPanel(null);
  const n = prompt('New nickname:', state.nick);
  if (n && n !== state.nick) send({ type: 'nick', nick: n });
});

$('restore-cancel-btn').addEventListener('click', () => {
  state.sessionId = null;
  history.replaceState(null, '', location.pathname);
  state.ws?.close();
  state.ws = null;
  restoreScreen.classList.add('hidden');
  connectScreen.classList.remove('hidden');
});

$('away-btn').addEventListener('click', () => {
  if (state.away) send({ type: 'raw', line: 'AWAY' });
  else send({ type: 'raw', line: 'AWAY :Away' });
});

$('disconnect-btn').addEventListener('click', () => {
  state.sessionId = null;
  history.replaceState(null, '', location.pathname);
  send({ type: 'disconnect', text: 'Leaving' });
  setTimeout(() => { state.ws?.close(); onDisconnect('Disconnected'); }, 300);
});

// ── Auto-away ─────────────────────────────────────────────────────────────────
const AUTO_AWAY_MS = 5 * 60 * 1000;
const AUTO_AWAY_MSG = 'Auto-away';
let autoAwayTimer = null;
let autoAwayActive = false;

function resetAutoAway() {
  if (autoAwayActive) {
    autoAwayActive = false;
    send({ type: 'raw', line: 'AWAY' });
  }
  clearTimeout(autoAwayTimer);
  if (state.connected) {
    autoAwayTimer = setTimeout(() => {
      const inIdleChannel = [...state.channels.keys()].some(t => t.includes('idle'));
      if (!state.away && !inIdleChannel) {
        autoAwayActive = true;
        send({ type: 'raw', line: `AWAY :${AUTO_AWAY_MSG}` });
      }
    }, AUTO_AWAY_MS);
  }
}

document.addEventListener('keydown', resetAutoAway);
document.addEventListener('mousedown', resetAutoAway);

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
    appendMsg('*server*', { type: 'connecting', nick: '--', text: 'Reconnecting…' });
    if (state.sessionId) {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/ws?session=${state.sessionId}`);
      state.ws = ws;
      ws.onmessage = e => { try { handle(JSON.parse(e.data)); } catch(err) { console.warn('ws message error', err); } };
      ws.onerror = () => {};
      ws.onclose = () => { if (state.sessionId || state.connectParams) scheduleReconnect(); };
    } else if (state.connectParams) {
      // session was lost (server restart during reconnect window) — do a full reconnect
      const p = state.connectParams;
      openWS(p.server, p.port, p.nick, p.realname, p.tls, p.noverify, p.authMethod, p.pass);
    }
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
  clearTimeout(lagTimer);
  clearTimeout(listFilterTimer);
  clearTimeout(autoAwayTimer);
  autoAwayActive = false;
  updateLagDisplay(null);
  state.connected = false;
  state.sessionId = null;
  history.replaceState(null, '', location.pathname);
  state.channels.clear();
  state.active = null;
  document.title = 'wirgloo';
  chatScreen.classList.add('hidden');
  connectScreen.classList.remove('hidden');
  showConnectError(reason);
}

function showConnectError(msg) {
  connectError.textContent = msg;
  connectError.classList.remove('hidden');
}

function nickHue(nick) {
  if (!nick || nick === '--') return null;
  let h = 0;
  for (let i = 0; i < nick.length; i++) h = (Math.imul(31, h) + nick.charCodeAt(i)) | 0;
  return (h >>> 0) % 360;
}

function nickColor(nick) {
  const hue = nickHue(nick);
  if (hue === null) return '';
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
  '#ffffff','#000000','#00007f','#009300','#cc3333','#7f0000',
  '#9c009c','#cc6a10','#b8b820','#20b820','#009393','#20b8b8',
  '#3333cc','#cc33cc','#7f7f7f','#d2d2d2',
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

function renderText(raw, noMarkdown=false) {
  const hasIRC = /[\x02\x03\x0f\x11\x1d\x1e\x1f]/.test(raw);
  let bold=false, italic=false, under=false, strike=false, mono=false;
  let fg=null, bg=null;
  let out='', buf='', i=0;

  const flush = () => {
    if (!buf) return;
    let s = linkify((hasIRC || noMarkdown) ? escHtml(buf) : applyMarkdown(escHtml(buf)));
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
