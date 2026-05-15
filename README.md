# wirgloo

A self-hosted web IRC client written in Go.

The server proxies IRC over a WebSocket so you can connect from any browser. A single binary serves both the static UI and the WebSocket endpoint — no Node.js, no build step, no external dependencies beyond Go.

## Features

**Connectivity**
- TLS and plain IRC connections, optional TLS verification bypass (`-noverify`, for self-signed certs and hostname mismatches)
- Predefined network presets (Libera.Chat, OFTC, Rizon, EFnet, QuakeNet, DALnet, Undernet, IRCnet, GeekShed, RadioChat, SDF)
- Custom server profiles saved to browser localStorage
- WebSocket reconnection with exponential backoff — IRC session survives brief network drops
- Transparent reconnect after server restart: channels are re-joined, messages preserved
- Offline channel placeholders in the sidebar — click to rejoin, topic and info printed on entry

**Authentication**
- SASL PLAIN (full CAP negotiation)
- NickServ IDENTIFY (PRIVMSG and NICKSERV command variants)
- Server password (/PASS)

**Channels & messaging**
- Channels, private messages, `/me` actions
- IRC formatting codes (bold, italic, underline, colour, monospace)
- Markdown-lite rendering (headings, bold, italic, strikethrough, inline code)
- Nick mentions highlighted in their assigned colour
- Chat log persisted per server/channel in localStorage, replayed on reconnect with session-break marker
- Previously joined channels remembered and shown as offline placeholders on reconnect
- Join/part/quit/kick events shown with directional arrows (`→` / `←`) in the nick column

**User list**
- IRCv3 `multi-prefix` CAP — all privilege levels shown per nick
- Prefix symbols coloured by role: `~` owner · `&` admin · `@` op · `%` half-op · `+` voice
- Server `PREFIX` token (005) parsed at connect time — adapts to any IRCd
- User count in panel header

**WHOIS & DMs**
- WHOIS fetched automatically when opening a DM or when someone messages you first
- User info card: real name, host, server, idle time, channels with prefix badges
- Identity badges: 🔒 Secure · ✓ Identified · ⚡ IRCop · 🤖 Bot · ⏾ Away
- Away status tracked separately from WHOIS; `away_status` message clears the indicator on return

**Channel list (`/list`)**
- Top 50 channels by user count shown immediately; type to filter by name or topic (filtered server-side, no re-request needed)
- Sortable by name, user count, or topic
- Click any entry to join directly

**Commands**
`/join` `/part` `/msg` `/me` `/nick` `/topic` `/kick` `/ban` `/mode`
`/invite` `/notice` `/whois` `/ping` `/slap` `/ignore` `/unignore`
`/list` `/clear` `/help` and raw `/raw`

**UI**
- Auto light/dark theme via `prefers-color-scheme`
- JetBrains Mono font
- Nick colours derived from a hash (consistent across sessions)
- Emoji icons per entry type in sidebar (server, channel, DM, list)
- Rate-limited outbound IRC (token bucket, 3 lines/sec)

## Build & run

Requires Go 1.21+.

```sh
make                   # build ./wirgloo
make install           # install binary to /usr/local/bin
make install-service   # install binary + systemd unit, reload systemd
```

`PREFIX` and `SYSTEMD_DIR` can be overridden:

```sh
make install-service PREFIX=/opt/wirgloo SYSTEMD_DIR=/etc/systemd/system
```

After `install-service`, enable and start the service:

```sh
systemctl enable --now wirgloo
```

To remove:

```sh
make uninstall         # stop service, remove unit and binary
```

## Usage

```sh
wirgloo                              # listens on 0.0.0.0:6677
wirgloo -addr :8080                  # custom address
wirgloo -dev                         # serve static files from disk (no embed, for development)
wirgloo -log-level debug             # log level: debug, info, warn, error (default: info)
wirgloo -log-json                    # emit logs as JSON instead of text
wirgloo -session-timeout 1h          # how long an IRC session survives a browser disconnect (default: 30m)
wirgloo -buffer-max 1000             # max messages buffered per session while browser is disconnected (default: 500)
wirgloo -list-preview 100            # max channels shown in /list before filtering (default: 50)
```

Open `http://localhost:6677` in your browser, choose a network or enter a custom server, fill in your nick, and connect.

### URL parameters

The connect form can be pre-filled via query parameters — useful for bookmarks, shared links, or embedding:

```
http://localhost:6677/?server=irc.libera.chat&tls=1&nick=mynick&channel=%23linux
```

| Parameter  | Description                                      | Default            |
|------------|--------------------------------------------------|--------------------|
| `server`   | IRC server hostname (required to pre-fill)       | —                  |
| `port`     | IRC port                                         | 6697 (TLS) / 6667  |
| `tls`      | Use TLS — `1` or `true`                          | `false`            |
| `noverify` | Skip TLS cert verification — `1`                 | `false`            |
| `nick`     | Default nick                                     | —                  |
| `realname` | Real name / GECOS                                | same as nick       |
| `auth`     | Auth method: `none`, `sasl`, `nickserv`, `ns-msg`| `none`             |
| `pass`     | Password for the chosen auth method              | —                  |
| `channel`  | Channel to join after connecting                 | —                  |

The profile is saved to localStorage on page load. If a `?s=` session-restore parameter is also present, it takes priority and the URL parameters are ignored.

## Project layout

```
main.go          entry point, HTTP server
ws/              WebSocket handler and message dispatch
session/         session registry, IRC↔WS bridge, rate limiter, SASL
irc/             IRC dial, handshake, line reader/parser
logger/          structured logger setup
static/          browser UI (HTML, CSS, JS — no build step)
```

## License

GPL-3.0 — see [LICENSE](LICENSE).
