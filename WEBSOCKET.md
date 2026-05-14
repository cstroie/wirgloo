# WebSocket Protocol Reference

This document describes the JSON message protocol between the browser (client) and the wirgloo server over WebSocket. All messages are UTF-8 encoded JSON objects with a `"type"` string discriminator.

## Transport

- **Endpoint:** `/ws` (HTTP upgraded to WebSocket)
- **Message framing:** WebSocket text frames, one JSON object per frame
- **Session identity:** `?session=<id>` query parameter on the upgrade request triggers a resume attempt; omit it (or use a fresh URL) to start a new session

---

## Session lifecycle

```
Browser                                  Server
  |                                        |
  |-- GET /ws ---------------------------->|  new session created
  |<-- (no message, session is ready) -----|
  |                                        |
  |-- connect {type,server,port,...} ----->|
  |<-- connected {type,nick,session,...} --|
  |                                        |
  |  ... normal IRC interaction ...        |
  |                                        |
  |  [WebSocket drop]                      |  IRC conn stays alive 30 min
  |-- GET /ws?session=<id> --------------->|  resume attempt
  |<-- resumed {type,nick,channels,...} ---|  buffered msgs flushed first
  |   OR                                   |
  |<-- session_expired {type} -------------|  session gone (server restart etc.)
  |                                        |
  |-- disconnect {type,text?} ------------>|
  |<-- disconnected {type,text} -----------|
```

---

## Browser → Server messages

### `connect`

Initiate an IRC connection.

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `type` | string | yes | — | `"connect"` |
| `server` | string | yes | — | IRC server hostname |
| `port` | int | no | 6667 / 6697 | Port; defaults applied server-side |
| `nick` | string | yes | — | Desired IRC nickname |
| `realname` | string | no | same as `nick` | IRC real name |
| `tls` | bool | no | `false` | Use TLS |
| `selfsigned` | bool | no | `false` | Accept self-signed TLS certificates |
| `pass` | string | no | `""` | Password for the chosen auth method |
| `authmethod` | string | no | `"none"` | `"none"` \| `"sasl"` \| `"nickserv"` \| `"nickserv_cmd"` \| `"server"` |

Auth method semantics:
- `"none"` — no authentication
- `"sasl"` — SASL PLAIN via CAP negotiation (before registration)
- `"nickserv"` — `PRIVMSG NickServ :IDENTIFY <pass>` after 001
- `"nickserv_cmd"` — `NICKSERV IDENTIFY <pass>` after 001
- `"server"` — `PASS <pass>` during handshake

### `disconnect`

Gracefully quit IRC.

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | string | yes | `"disconnect"` |
| `text` | string | no | Quit reason; defaults to `"Leaving"` |

### `join`

Join a channel.

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | string | yes | `"join"` |
| `channel` | string | yes | Channel name (e.g. `"#example"`) |
| `key` | string | no | Channel key for +k channels |

### `part`

Leave a channel.

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | string | yes | `"part"` |
| `channel` | string | yes | Channel name |

### `message`

Send a PRIVMSG.

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | string | yes | `"message"` |
| `target` | string | yes | Channel name or nick |
| `text` | string | yes | Message body |

### `nick`

Change nickname.

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | string | yes | `"nick"` |
| `nick` | string | yes | New nickname |

### `raw`

Send a raw IRC line (used by `/raw` and other slash commands the browser handles directly).

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | string | yes | `"raw"` |
| `line` | string | yes | Full IRC line without trailing CRLF |

> **Note:** Unknown `type` values are silently ignored by the server.

---

## Server → Browser messages

### Connection & session

#### `connected`

Sent after a successful IRC `001` (registration complete).

```json
{
  "type": "connected",
  "nick": "mynick",
  "session": "a1b2c3d4e5f6a7b8",
  "welcome": "Welcome to the IRC network mynick!"
}
```

The browser must save `session` and append it as `?session=<id>` to future WebSocket URLs.

> **Note:** `network` and `servername` are intentionally absent here — they come from `004`/`005` numerics which arrive *after* `001`. The client receives them via the `servername` and `isupport_network` messages shortly after `connected`.

#### `resumed`

Sent after a successful WebSocket reconnect to an existing session. Buffered messages are flushed to the socket before this message.

```json
{
  "type": "resumed",
  "nick": "mynick",
  "channels": ["#foo", "#bar"],
  "network": "Libera.Chat",
  "servername": "irc.libera.chat",
  "welcome": "Welcome to ...",
  "meta": { "software": "...", "created": "...", ... }
}
```

#### `session_expired`

The session ID was not found (server restarted, 30-minute window elapsed).

```json
{ "type": "session_expired" }
```

#### `connect_error`

IRC dial or handshake failed before any IRC numerics were received.

```json
{ "type": "connect_error", "text": "dial tcp: connection refused" }
```

#### `disconnected`

IRC TCP connection closed (remote or local). Sent at the end of the IRC read loop.

```json
{ "type": "disconnected", "text": "IRC connection closed" }
```

---

### Server info

#### `motd`

One line of server banner text — covers `001` welcome, `002`/`003` preamble, `004`/`005` feature lines, and `375`/`372` MOTD body.

```json
{ "type": "motd", "text": "This is the server message of the day." }
```

#### `servername`

Server hostname extracted from `RPL_MYINFO` (004).

```json
{ "type": "servername", "value": "irc.libera.chat" }
```

#### `isupport_prefix`

`PREFIX=` token from `RPL_ISUPPORT` (005). Raw value after `PREFIX=`.

```json
{ "type": "isupport_prefix", "value": "(qaohv)~&@%+" }
```

#### `isupport_network`

`NETWORK=` token from `RPL_ISUPPORT` (005).

```json
{ "type": "isupport_network", "value": "Libera.Chat" }
```

#### `server_meta`

Incremental server metadata updates. The `key` and `value` types vary:

| `key` | `value` type | Source IRC numeric |
|---|---|---|
| `"software"` | string | 002 |
| `"created"` | string | 003 |
| `"channels"` | string | 254 |
| `"local_users"` | string | 265 |
| `"global_users"` | string | 266 |
| `"admin"` | `[]string` (appended) | 257, 258, 259 |

```json
{ "type": "server_meta", "key": "local_users", "value": "Current local users 42" }
```

#### `server_pong`

Round-trip time from a user-initiated `/ping` (PING with a millisecond timestamp token).

```json
{ "type": "server_pong", "ms": 47 }
```

---

### Chat events

#### `message`

Incoming PRIVMSG. `target` is the channel or the client's own nick (for DMs).

```json
{
  "type": "message",
  "from": "someone",
  "target": "#channel",
  "text": "hello world",
  "ts": 1715000000
}
```

`text` for `/me` actions is pre-converted to `/me <action>` by the server.
`ts` is a Unix timestamp (seconds). It comes from the `server-time` IRCv3 tag when present, otherwise `time.Now()`.

#### `notice`

Incoming NOTICE.

```json
{
  "type": "notice",
  "from": "NickServ",
  "target": "mynick",
  "text": "This nickname is registered.",
  "ts": 1715000000
}
```

#### `join`

A user (possibly the client itself) joined a channel.

```json
{ "type": "join", "nick": "someone", "channel": "#channel" }
```

#### `part`

A user left a channel.

```json
{ "type": "part", "nick": "someone", "channel": "#channel" }
```

#### `quit`

A user quit IRC.

```json
{ "type": "quit", "nick": "someone", "text": "Quit reason" }
```

#### `kick`

A user was kicked from a channel.

```json
{
  "type": "kick",
  "channel": "#channel",
  "nick": "victim",
  "by": "op",
  "text": "Kick reason"
}
```

#### `nick`

A user changed their nickname.

```json
{ "type": "nick", "old": "oldnick", "new": "newnick" }
```

#### `mode`

Channel or user mode change.

```json
{ "type": "mode", "target": "#channel", "mode": "+o someone", "nick": "op" }
```

`nick` is the user who set the mode (empty string for server-set modes).

#### `topic`

Topic set or changed. Sent for both `TOPIC` commands (with `nick`) and `RPL_TOPIC` (332, no `nick`).

```json
{ "type": "topic", "channel": "#channel", "text": "The topic text", "nick": "setter" }
```

`nick` is absent when the topic comes from `RPL_TOPIC` (332).

#### `topic_meta`

Metadata for the current topic — who set it and when. Sent after `RPL_TOPICWHOTIME` (333).

```json
{ "type": "topic_meta", "channel": "#channel", "setter": "someone!u@h", "time": "Thu Jan 01 00:00:00 2025" }
```

#### `invite`

The client was invited to a channel.

```json
{ "type": "invite", "nick": "inviter", "channel": "#channel" }
```

---

### Names list

The names list for a channel is delivered as one or more `names_chunk` messages followed by a single `names_end`.

#### `names_chunk`

```json
{ "type": "names_chunk", "channel": "#channel", "nicks": ["@op", "+voice", "user"] }
```

Nicks include mode prefixes as returned by the server (e.g. `@`, `+`). With `multi-prefix` CAP enabled, multiple prefixes may be present (e.g. `@+nick`).

#### `names_end`

```json
{ "type": "names_end", "channel": "#channel" }
```

---

### Away

#### `away`

A user's away status changed (via `away-notify` CAP) or the client messaged someone who is away (301).

```json
{ "type": "away", "nick": "someone", "text": "Gone for lunch" }
```

When `text` is empty (`""`), the user returned from away.

Additional field when sourced from numeric 301:
```json
{ "type": "away", "nick": "someone", "text": "brb", "source": "301" }
```

#### `away_status`

The client's own away status changed.

```json
{ "type": "away_status", "away": true, "text": "You are now marked as away" }
{ "type": "away_status", "away": false, "text": "You are no longer away" }
```

---

### WHOIS

WHOIS data arrives as a sequence of `whois_data` messages (one per field) followed by `whois_end`.

#### `whois_data`

The `field` discriminator determines which additional fields are present:

| `field` | Extra fields | IRC numeric |
|---|---|---|
| `"user"` | `nick`, `ident`, `host`, `realname` | 311 |
| `"server"` | `nick`, `server`, `location` | 312 |
| `"ircop"` | `nick` | 313 |
| `"idle"` | `nick`, `seconds` (string) | 317 |
| `"channels"` | `nick`, `channels` ([]string) | 319 |
| `"account"` | `nick`, `account` | 330 |
| `"secure"` | `nick` | 671 |

Examples:
```json
{ "type": "whois_data", "nick": "someone", "field": "user", "ident": "u", "host": "example.com", "realname": "Real Name" }
{ "type": "whois_data", "nick": "someone", "field": "idle", "seconds": "120" }
{ "type": "whois_data", "nick": "someone", "field": "channels", "channels": ["#foo", "@#bar"] }
```

#### `whois_end`

```json
{ "type": "whois_end", "nick": "someone" }
```

---

### Channel list

The channel list (`/list`) is delivered as `list_start`, zero or more `list_item` messages, then `list_end`.

#### `list_start`

```json
{ "type": "list_start" }
```

#### `list_item`

```json
{ "type": "list_item", "channel": "#channel", "count": "42", "topic": "Channel topic" }
```

`count` is a string (raw IRC parameter).

#### `list_end`

```json
{ "type": "list_end" }
```

---

### CTCP

#### `ctcp_version_reply`

Response to a CTCP VERSION request sent to another user.

```json
{ "type": "ctcp_version_reply", "from": "someone", "version": "irssi 1.4.3" }
```

#### `ctcp_ping_reply`

Response to a CTCP PING. RTT is computed server-side from the millisecond timestamp embedded in the PING token.

```json
{ "type": "ctcp_ping_reply", "from": "someone", "ms": 23 }
```

---

### Errors

#### `error`

Generic IRC error forwarded to the browser. Sources: `ERR_NICKNAMEINUSE` (433), IRC `ERROR` command, SASL failure (904/905).

```json
{ "type": "error", "text": "Nickname already in use" }
```

---

## Field type summary

| Field | JSON type | Notes |
|---|---|---|
| `type` | string | Always present, discriminates message kind |
| `nick` | string | IRC nickname |
| `channel` | string | `#channel` |
| `text` | string | Human-readable text or message body |
| `ts` | number | Unix timestamp in seconds |
| `ms` | number | Round-trip time in milliseconds |
| `away` | boolean | Only in `away_status` |
| `nicks` | array of strings | Only in `names_chunk` |
| `channels` | array of strings | In `resumed` and `whois_data` (field=channels) |
| `meta` | object | Only in `resumed`; mirrors accumulated `server_meta` keys |
| `seconds` | string | Idle seconds in `whois_data` (field=idle) — raw IRC string |
| `count` | string | User count in `list_item` — raw IRC string |
