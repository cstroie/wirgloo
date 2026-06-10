# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & run

```sh
make                        # build ./wirgloo (injects VERSION=YYMMDD via -ldflags)
go build ./...              # quick build without version injection (version = "dev")
go vet ./...                # static analysis
```

There are no tests and no linter config files. `go vet` is the only automated check.

Run in development mode so static files are served from disk (no rebuild needed after JS/CSS/HTML edits):

```sh
./wirgloo -dev -log-level debug
```

Production binary embeds `static/` at compile time via `//go:embed static/*` in `embed.go` (root package).

## Architecture

The server is a single Go binary with no external runtime dependencies. It has two jobs: serve the static single-page UI and proxy IRC over WebSocket.

### Request flow

```
Browser ──WebSocket──► wsHandler  ──dispatch──► Session.SendIRC
                                 ◄──sendWS────  Session.ircLoop ◄── ircReadLoop
```

All server-side Go lives in `cmd/wirgloo/` as `package main`:

**`handler.go`** — upgrades HTTP to WebSocket, reads JSON `inMsg` frames from the browser, calls `dispatch()` which maps `msg.Type` strings to `Session` methods or raw IRC commands. Unknown message types are silently ignored.

**`session.go`** — the core. One `Session` per browser tab. Owns the IRC `net.Conn`, the WebSocket `*websocket.Conn`, and four goroutines:
- `ircLoop` — reads lines from the IRC server, parses them, emits JSON to the browser via `sendWS`
- `sendLoop` — token-bucket rate limiter (burst 5, 3 lines/sec) draining `sendQ`; bypassed by `writeNow` for PONG/PING/QUIT
- `pingLoop` — client-initiated PING every 90 s; kills the session if no PONG within 60 s
- `ircReadLoop` — reads raw lines into a channel, closed on disconnect

**`client.go`** — pure IRC protocol: `ircDial`, `ircHandshake`, `ircReadLoop`, `ircParseLine`. No state. `ircParseLine` always appends the trailing parameter into `Params`, so callers can index `msg.Params` uniformly.

**`logger.go`** — package-level `L *slog.Logger` and `initLogger()`.

**`main.go`** — entry point. Parses flags, wires up HTTP routes, starts the server.

**`embed.go`** (root package `wirgloo`) — exports `StaticFiles embed.FS` so `cmd/wirgloo` can embed `static/` at the repo root without needing the assets alongside the command source.

**`static/app.js`** — single-file vanilla JS SPA, no framework. State lives in the `state` object at the top. All incoming WebSocket messages are routed through `handle(msg)`. User slash-commands are parsed in `handleCommand()`. Chat history is persisted to IndexedDB and replayed on reconnect or fresh connect to a known server. No build step.

### WebSocket message protocol

JSON objects with a `"type"` field. Server → browser types: `caps`, `connected`, `resumed`, `session_expired`, `connect_error`, `disconnected`, `message`, `notice`, `join`, `part`, `nick`, `quit`, `kick`, `mode`, `topic`, `invite`, `names_chunk`, `names_end`, `whois`, `away`, `away_status`, `motd`, `isupport_prefix`, `list_start`, `list_item`, `list_end`, `history_start`, `history_end`, `error`.

Browser → server types (dispatched in `handler.go`): `connect`, `disconnect`, `join`, `part`, `message`, `nick`, `raw`, `list_filter`, `chathistory`.

### Session lifecycle & reconnection

`Registry` tracks all live sessions by ID. On WebSocket disconnect, `Detach` nulls the WS pointer and starts a timer (`WsReconnectWindow`, default 60 minutes, `-session-timeout` flag) — the IRC connection stays alive. If the browser reconnects within that window (same `?s=<id>` URL param), `Resume` reattaches and flushes the message buffer (capped at 500 entries). After the window elapses, the session is torn down.

`done` is a channel closed once to signal all goroutines for a session to exit. `Close()` closes `done` and the TCP connection.

### Browser storage

| Key | Store | Contents |
|---|---|---|
| `wirgloo:profiles` | localStorage | saved connection profiles |
| `wirgloo:srv:<server>` | localStorage | per-server state: nick, channels, DMs, ignored nicks, auth prefs |
| `wirgloo:srv:last` | localStorage | last-used server/network/TLS (connect form pre-fill only) |
| `wirgloo` (IndexedDB) | IndexedDB | chat log messages, object store `messages`, index `by_target` on `[server, target]` |

Chat logs use IndexedDB (`getDB()` / `persistMsg()` / `preloadLogs(server)`). On session resume or fresh connect, `preloadLogs(server)` loads up to 500 messages per channel into `msgCache` (in-memory Map) so `loadLog()` stays synchronous. `persistMsg()` writes to IndexedDB asynchronously (fire and forget) and updates `msgCache` immediately.

The `resumed` message from the server provides the server hostname; `restoreChannelsWithHistory(server)` uses it to preload history before rendering channels. No server identity is stored client-side between sessions.

### IRCv3 capabilities

Capability negotiation uses `CAP LS 302`: the handshake sends `CAP LS 302`, the CAP handler intersects the advertised list with `wantedCaps` (`multi-prefix away-notify server-time userhost-in-names echo-message batch draft/chathistory`, plus `sasl` when that auth method is chosen) and REQs only what the server offers — never REQ blindly, since servers NAK the whole request if any cap is unsupported. ACKed caps are tracked in `Session.caps` and sent to the browser via the `caps` WS message (also included in `resumed`).

`draft/chathistory`: on self-join the browser sends a `chathistory` WS message; `Session.ChatHistory` issues `CHATHISTORY LATEST <target> * 100` (or `BEFORE timestamp=<RFC3339>` when paging). History arrives in an IRCv3 batch — `Session.batches` tracks open batches, playback PRIVMSG/NOTICE are forwarded with `"history": true` plus `history_start`/`history_end` markers, and the browser dedups them against the local log via `isDuplicateMsg()` (same nick+text+second-resolution ts) and skips unread/notification side effects. With `echo-message`, the server echoes our own PRIVMSG/NOTICE back: the browser suppresses local echo when `state.caps` has `echo-message` (`hasEcho()` in app.js), and `ircLoop` drops echoed CTCP requests/replies so we never auto-reply to ourselves. `server-time` timestamps are parsed by `msgTime()` and sent as `ts`.

### Auth flow

Auth method is chosen at connect time and held in `Session.authMethod`/`authPass`. SASL PLAIN uses full CAP negotiation (`CAP REQ` → `CAP ACK` → `AUTHENTICATE PLAIN` → base64 payload → `903` → `CAP END`). NickServ variants fire after `001`. Server password goes in the `PASS` command during handshake.

### Version

`main.version` is injected at build time via `-ldflags`; falls back to `"dev"`. It is exposed at `GET /version` as `{"name":"wirgloo","version":"..."}` and via `session.AppVersion` (set from `main`) for CTCP VERSION replies and the browser UI.

### Saved profiles

`wirgloo:profiles` is an array of objects `{ server, port, tls, nick, networkName? }`. `saveProfile()` upserts by `server+port`. When the server sends `NETWORK=` via 005 (`isupport_network` WS message), `updateProfileNetworkName()` patches the matching profile in-place. The Saved dropdown shows `NetworkName (server)` when `networkName` is present, otherwise `server:port (TLS)`.

### UI styling conventions

- Version text uses `.app-version` (color: `--text-dim`). The connect-window instance (`#connect-version`) is additionally dimmed with `opacity: 0.45` so it recedes further than the sidebar version.
- CSS variables: `--text` (normal), `--text-dim` (secondary/muted), `--text-head` (labels/headings), `--accent` (highlights).
- Message list: no padding/gap on `#messages`; reduced per-message padding for tight spacing.
- `logMax` (default 500) caps both IndexedDB writes (trimmed per channel on each write) and the DOM message list (trimmed on append). Setting changes apply immediately via `enforceLogMax()`.

### Releases & cross-platform builds

Tag format: `vYYMMDD` (e.g. `v260526`). `make dist` builds for all five platforms; Linux targets use `CGO_ENABLED=0` for static linking (works on Alpine/musl and any glibc). GitHub Actions (`.github/workflows/release.yml`) runs on each tag push and uploads all binaries to the GitHub release automatically.

Binary name: `wirgloo-<os>-<arch>[.exe]`.

## Code conventions

- **No framework, no ORM, no generated code.** Keep dependencies minimal — currently only `gorilla/websocket`.
- **Locking discipline:** `Session.mu` guards all mutable fields. Acquire, copy needed values, release before any I/O or channel send. Never hold `mu` while calling `sendWS` or `writeNow`. `Session.wsMu` serialises WebSocket writes (gorilla/websocket forbids concurrent writers); lock order is `wsMu` before `mu`, never acquire `wsMu` while holding `mu`. `Session.Nick` may be read lock-free only inside `ircLoop` (its sole writer); other goroutines use `CurrentNick()`.
- **`writeNow` vs `SendIRC`:** Use `writeNow` only for protocol-level messages that must bypass the rate limiter (PONG, internal PING, QUIT, SASL). Everything else goes through `SendIRC` → `sendQ`.
- **`sendWS`** buffers messages (up to 500) while the WebSocket is detached; it never blocks.
- Static files in `static/` are plain HTML/CSS/JS — no bundler, no transpiler. Keep it that way.
- JS state mutations all go through the `state` object. DOM is manipulated directly; no virtual DOM.
- Go style: `gofmt`, short variable names in short scopes, descriptive names elsewhere. Comments explain *why*, not *what*.
