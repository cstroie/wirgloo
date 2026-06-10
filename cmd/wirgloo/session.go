// Wirgloo — a self-hosted web IRC client.
// https://github.com/cstroie/wirgloo
//
// Copyright (C) 2025 Costin Stroie <costinstroie@eridu.eu.org>
// SPDX-License-Identifier: GPL-3.0-or-later
//
// session manages the lifecycle of connected clients. Each browser tab owns
// one Session that pairs a WebSocket connection with an IRC TCP connection.
// The Registry tracks all live sessions and supports transparent WebSocket
// reconnection: when the browser's socket drops the IRC connection stays alive
// for up to WsReconnectWindow so the client can reattach without losing
// channel membership or message history.
package main

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// AppVersion is set by main at startup to the build-time version string.
var AppVersion = "dev"

const pingInterval = 90 * time.Second // how often to send a client-initiated PING to the server
const pingTimeout = 60 * time.Second  // max time to wait for a PONG before declaring the link dead

// Tunable defaults — may be overridden by main before any session is created.
var WsReconnectWindow = 60 * time.Minute // idle WS window before the IRC connection is torn down
var BufferMax = 500                      // max IRC messages buffered while the WS is detached
var ListPreviewSize = 50                 // channels sent to the browser before any filter is applied

const (
	sendBurst    = 5                      // initial token allowance for the outbound rate limiter
	sendInterval = 333 * time.Millisecond // one new token every ~333 ms (≈ 3 lines/sec)
)

// wantedCaps are the IRCv3 capabilities requested when the server offers them
// (intersected with CAP LS). "sasl" is appended when that auth method is chosen.
var wantedCaps = []string{"multi-prefix", "away-notify", "server-time", "userhost-in-names", "echo-message", "batch", "draft/chathistory"}

// chatHistoryLimit is the number of messages requested per CHATHISTORY command.
const chatHistoryLimit = 100

// batchInfo describes an open IRCv3 batch (BATCH +ref <type> [params...]).
type batchInfo struct {
	typ    string
	target string
}

// listEntry is one row from an IRC LIST response.
type listEntry struct {
	channel string
	count   int
	topic   string
}

// Session represents one connected browser client and its associated IRC
// connection. All fields are protected by mu except ID and done, which are
// immutable after creation and safe to read without holding the lock.
type Session struct {
	ID         string               // unique session identifier, hex-encoded random bytes
	Nick       string               // current IRC nick; written under mu by ircLoop, read lock-free only within ircLoop — other goroutines use CurrentNick
	mu         sync.Mutex           // guards all mutable fields below
	wsMu       sync.Mutex           // serialises writes to ws; lock order: wsMu before mu, never mu before wsMu
	ws         *websocket.Conn      // current WebSocket; nil while detached
	buf        [][]byte             // JSON messages buffered while ws is nil
	conn       net.Conn             // underlying IRC TCP connection
	done       chan struct{}        // closed once to signal all goroutines to exit
	server     string               // original dial address, e.g. "irc.libera.chat"
	authMethod string               // "none" | "sasl" | "nickserv" | "nickserv_cmd" | "server"
	authPass   string               // password for the chosen auth method
	lastPong   time.Time            // wall time of the most recent PONG received
	sendQ      chan string          // rate-limited outbound IRC line queue
	channels   map[string]bool      // channels the client is currently joined to
	caps       map[string]bool      // IRCv3 capabilities ACKed by the server
	capsLS     []string             // capabilities advertised in CAP LS (may span several lines)
	batches    map[string]batchInfo // open IRCv3 batches keyed by reference tag
	network    string               // NETWORK= value from 005, e.g. "Libera.Chat"
	servername string               // server hostname from 004 RPL_MYINFO
	welcome    string               // trailing text of the 001 welcome numeric
	meta       map[string]any       // accumulated server metadata sent to the browser
	listBuf    []listEntry          // accumulated LIST rows, sorted and filtered on demand
}

// Registry is a thread-safe map of active sessions keyed by session ID.
type Registry struct {
	mu       sync.RWMutex
	sessions map[string]*Session
}

// NewRegistry creates an empty Registry.
func NewRegistry() *Registry {
	return &Registry{sessions: make(map[string]*Session)}
}

// New creates a fresh session with the given WebSocket connection, registers
// it, and returns it. The session has no IRC connection yet; Connect must be
// called to establish one.
func (r *Registry) New(ws *websocket.Conn) *Session {
	id := newID()
	s := &Session{ID: id, ws: ws, done: make(chan struct{}), channels: make(map[string]bool), caps: make(map[string]bool), batches: make(map[string]batchInfo), meta: make(map[string]any)}
	r.mu.Lock()
	r.sessions[id] = s
	r.mu.Unlock()
	return s
}

// Resume attaches a new WebSocket to an existing session after a reconnect.
// Any messages buffered during the disconnect window are flushed to the new
// connection before returning. Returns nil if no session with that ID exists.
func (r *Registry) Resume(id string, ws *websocket.Conn) *Session {
	r.mu.RLock()
	s := r.sessions[id]
	r.mu.RUnlock()
	if s == nil {
		return nil
	}
	// Hold wsMu across publishing the new socket and flushing the buffer so a
	// concurrent sendWS (which also takes wsMu to write) cannot interleave a
	// live message into the flush or write to ws at the same time.
	s.wsMu.Lock()
	s.mu.Lock()
	s.ws = ws
	pending := s.buf
	s.buf = nil
	channels := make([]string, 0, len(s.channels))
	for ch := range s.channels {
		channels = append(channels, ch)
	}
	s.mu.Unlock()
	for _, data := range pending {
		ws.WriteMessage(websocket.TextMessage, data)
	}
	s.wsMu.Unlock()
	for _, ch := range channels {
		s.SendIRC("NAMES " + ch)
		s.SendIRC("TOPIC " + ch)
	}
	return s
}

// Detach nulls out the WebSocket and starts a cleanup timer. If the client
// does not reconnect within WsReconnectWindow the IRC connection is closed
// and the session is removed from the registry.
func (r *Registry) Detach(s *Session) {
	s.mu.Lock()
	s.ws = nil
	s.mu.Unlock()

	time.AfterFunc(WsReconnectWindow, func() {
		s.mu.Lock()
		wsGone := s.ws == nil
		s.mu.Unlock()
		if wsGone {
			L.Info("session expired", "session", s.ID)
			s.mu.Lock()
			s.buf = nil
			s.mu.Unlock()
			s.Close()
			r.Remove(s.ID)
		}
	})
}

// Remove deletes a session from the registry. It does not close the session.
func (r *Registry) Remove(id string) {
	r.mu.Lock()
	delete(r.sessions, id)
	r.mu.Unlock()
}

// Connect dials the IRC server, runs the registration handshake, and starts
// the read and ping goroutines. authMethod controls how pass is used:
// "sasl" → SASL PLAIN CAP negotiation; "nickserv" → PRIVMSG NickServ :IDENTIFY;
// "nickserv_cmd" → NICKSERV IDENTIFY; "server" → PASS command in handshake;
// "none" or empty → no authentication. Connect returns once the TCP connection
// and handshake succeed; the 001 numeric arrives asynchronously via ircLoop.
func (s *Session) Connect(server string, port int, nick, realname string, useTLS, noVerify bool, pass, authMethod string) error {
	if realname == "" {
		realname = nick
	}
	// A session's done channel and goroutines are single-use: refuse a second
	// connect on the same session instead of leaking the first connection or
	// starting goroutines against an already-closed done channel.
	select {
	case <-s.done:
		s.sendWS(map[string]any{"type": "connect_error", "text": "session is closed — reload the page to start a new one"})
		return fmt.Errorf("session closed")
	default:
	}
	s.mu.Lock()
	alreadyConnected := s.conn != nil
	s.mu.Unlock()
	if alreadyConnected {
		s.sendWS(map[string]any{"type": "connect_error", "text": "already connected — disconnect first"})
		return fmt.Errorf("already connected")
	}
	L.Info("connecting to IRC", "session", s.ID, "server", server, "port", port, "nick", nick, "tls", useTLS, "noverify", noVerify)
	conn, err := ircDial(server, port, useTLS, noVerify)
	if err != nil {
		L.Error("IRC dial failed", "session", s.ID, "server", server, "err", err)
		s.sendWS(map[string]any{"type": "connect_error", "text": err.Error()})
		return err
	}
	s.mu.Lock()
	s.conn = conn
	s.Nick = nick
	s.server = server
	s.authMethod = authMethod
	s.authPass = pass
	s.mu.Unlock()

	serverPass := ""
	if authMethod == "server" {
		serverPass = pass
	}

	if err := ircHandshake(conn, nick, nick, realname, serverPass); err != nil {
		conn.Close()
		s.mu.Lock()
		s.conn = nil
		s.mu.Unlock()
		L.Error("IRC handshake failed", "session", s.ID, "err", err)
		s.sendWS(map[string]any{"type": "connect_error", "text": err.Error()})
		return err
	}

	s.mu.Lock()
	s.sendQ = make(chan string, 128)
	s.mu.Unlock()

	lines := make(chan string, 64)
	go ircReadLoop(conn, lines, s.done)
	go s.ircLoop(lines)
	go s.pingLoop()
	go s.sendLoop(conn)
	return nil
}

// sendLoop drains the sendQ with a token-bucket rate limiter so we never
// flood the server. Burst of sendBurst lines, then one new token every
// sendInterval. Bypassed for time-critical lines (PONG, PING) which are
// written directly via writeNow.
func (s *Session) sendLoop(conn net.Conn) {
	tokens := sendBurst
	refill := time.NewTicker(sendInterval)
	defer refill.Stop()
	pending := make([]string, 0, 16)

	flush := func() {
		for tokens > 0 && len(pending) > 0 {
			L.Debug("irc send", "session", s.ID, "line", redactIRC(pending[0]))
			ircWriteLine(conn, pending[0])
			pending = pending[1:]
			tokens--
		}
	}

	for {
		select {
		case <-s.done:
			return
		case line := <-s.sendQ:
			pending = append(pending, line)
			flush()
		case <-refill.C:
			if tokens < sendBurst {
				tokens++
			}
			flush()
		}
	}
}

// writeNow writes a line directly to conn, bypassing the rate limiter.
// Use only for protocol-level messages (PONG, internal PING, QUIT).
func (s *Session) writeNow(line string) {
	s.mu.Lock()
	conn := s.conn
	s.mu.Unlock()
	if conn != nil {
		L.Debug("irc send", "session", s.ID, "line", redactIRC(line))
		ircWriteLine(conn, line)
	}
}

// CurrentNick returns the session's nick under the lock, for goroutines other
// than ircLoop (which may read Nick directly, being its only writer).
func (s *Session) CurrentNick() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.Nick
}

// SendResumed notifies the browser that the WebSocket has been successfully
// reattached to an existing IRC session, including the current channel list so
// the client can restore any channels that are missing from its local state.
func (s *Session) SendResumed() {
	s.mu.Lock()
	nick := s.Nick
	channels := make([]string, 0, len(s.channels))
	for ch := range s.channels {
		channels = append(channels, ch)
	}
	network := s.network
	servername := s.servername
	welcome := s.welcome
	meta := s.meta
	server := s.server
	caps := make([]string, 0, len(s.caps))
	for c := range s.caps {
		caps = append(caps, c)
	}
	s.mu.Unlock()
	s.sendWS(map[string]any{"type": "resumed", "nick": nick, "server": server, "channels": channels, "network": network, "servername": servername, "welcome": welcome, "meta": meta, "caps": caps})
	s.mu.Lock()
	delete(s.meta, "admin")
	s.mu.Unlock()
	s.SendIRC("ADMIN")
	s.SendIRC("LUSERS")
}

// setMeta stores a server metadata key and broadcasts it to the browser.
func (s *Session) setMeta(key string, value any) {
	s.mu.Lock()
	s.meta[key] = value
	s.mu.Unlock()
	s.sendWS(map[string]any{"type": "server_meta", "key": key, "value": value})
}

// appendMeta appends a value to a []string meta key and broadcasts the full slice.
func (s *Session) appendMeta(key string, value string) {
	s.mu.Lock()
	existing, _ := s.meta[key].([]string)
	updated := append(existing, value)
	s.meta[key] = updated
	s.mu.Unlock()
	s.sendWS(map[string]any{"type": "server_meta", "key": key, "value": updated})
}

// ircLoop processes every line received from the IRC server and forwards
// relevant events to the browser as JSON WebSocket messages. It runs in its
// own goroutine and exits when the lines channel is closed — either because
// the TCP connection dropped or because done was closed. After the loop ends
// it sends a "disconnected" message so the browser can show a reconnect UI.
func (s *Session) ircLoop(lines <-chan string) {
	for line := range lines {
		L.Debug("irc recv", "session", s.ID, "line", redactIRC(line))
		msg := ircParseLine(line)
		switch msg.Command {
		case "CAP":
			// Params: [target, subcommand, ["*",] cap-list] — the "*" marks a
			// multi-line CAP LS reply with more lines to follow.
			if len(msg.Params) < 2 {
				continue
			}
			sub := msg.Params[1]
			capList := msg.Params[len(msg.Params)-1]
			switch sub {
			case "LS":
				s.mu.Lock()
				s.capsLS = append(s.capsLS, strings.Fields(capList)...)
				offered := s.capsLS
				am := s.authMethod
				s.mu.Unlock()
				if len(msg.Params) >= 4 && msg.Params[2] == "*" {
					continue // more LS lines coming
				}
				// Request the intersection of wanted and advertised caps.
				avail := make(map[string]bool, len(offered))
				for _, c := range offered {
					name, _, _ := strings.Cut(c, "=") // strip cap values, e.g. sasl=PLAIN
					avail[name] = true
				}
				want := wantedCaps
				if am == "sasl" {
					want = append(append([]string{}, wantedCaps...), "sasl")
				}
				var req []string
				for _, c := range want {
					if avail[c] {
						req = append(req, c)
					}
				}
				if len(req) == 0 {
					if am == "sasl" {
						s.warnNoSASL()
					}
					s.writeNow("CAP END")
					continue
				}
				s.writeNow("CAP REQ :" + strings.Join(req, " "))
				// If sasl is wanted but wasn't advertised, the ACK handler
				// falls through to CAP END and warns there.
			case "ACK":
				s.mu.Lock()
				am := s.authMethod
				for _, c := range strings.Fields(capList) {
					s.caps[c] = true
				}
				caps := make([]string, 0, len(s.caps))
				for c := range s.caps {
					caps = append(caps, c)
				}
				s.mu.Unlock()
				s.sendWS(map[string]any{"type": "caps", "caps": caps})
				if am == "sasl" && strings.Contains(" "+capList+" ", " sasl ") {
					s.writeNow("AUTHENTICATE PLAIN")
				} else {
					if am == "sasl" {
						s.warnNoSASL()
					}
					s.writeNow("CAP END")
				}
			case "NAK":
				s.mu.Lock()
				am := s.authMethod
				s.mu.Unlock()
				if am == "sasl" {
					s.warnNoSASL()
				}
				s.writeNow("CAP END")
			}

		case "BATCH":
			// BATCH +ref <type> [params...] opens a batch; BATCH -ref closes it.
			if len(msg.Params) == 0 || len(msg.Params[0]) < 2 {
				continue
			}
			ref := msg.Params[0][1:]
			if msg.Params[0][0] == '+' {
				b := batchInfo{}
				if len(msg.Params) > 1 {
					b.typ = msg.Params[1]
				}
				if len(msg.Params) > 2 {
					b.target = msg.Params[2]
				}
				s.mu.Lock()
				s.batches[ref] = b
				s.mu.Unlock()
				if isHistoryBatch(b.typ) {
					s.sendWS(map[string]any{"type": "history_start", "target": b.target})
				}
			} else if msg.Params[0][0] == '-' {
				s.mu.Lock()
				b := s.batches[ref]
				delete(s.batches, ref)
				s.mu.Unlock()
				if isHistoryBatch(b.typ) {
					s.sendWS(map[string]any{"type": "history_end", "target": b.target})
				}
			}

		case "AUTHENTICATE":
			// Server is ready for our SASL payload.
			if msg.Trailing == "+" || (len(msg.Params) > 0 && msg.Params[0] == "+") {
				s.mu.Lock()
				nick := s.Nick
				pass := s.authPass
				s.mu.Unlock()
				payload := base64.StdEncoding.EncodeToString([]byte("\x00" + nick + "\x00" + pass))
				s.writeNow("AUTHENTICATE " + payload)
			}

		case "903": // RPL_SASLSUCCESS
			s.writeNow("CAP END")

		case "904", "905": // ERR_SASLFAIL, ERR_SASLTOOLONG
			s.sendWS(map[string]any{"type": "error", "text": "SASL authentication failed: " + msg.Trailing})
			s.writeNow("CAP END")

		case "PING":
			s.writeNow("PONG :" + msg.Trailing)

		case "PONG":
			s.mu.Lock()
			s.lastPong = time.Now()
			s.mu.Unlock()
			// If the token is a millisecond timestamp it came from a user-initiated ping.
			var sentMs int64
			if _, err := fmt.Sscanf(msg.Trailing, "%d", &sentMs); err == nil {
				rtt := time.Now().UnixMilli() - sentMs
				s.sendWS(map[string]any{"type": "server_pong", "ms": rtt})
			}

		case "001": // welcome — IRC registration complete
			L.Info("IRC connected", "session", s.ID, "nick", s.Nick)
			s.mu.Lock()
			am := s.authMethod
			ap := s.authPass
			s.welcome = msg.Trailing
			s.mu.Unlock()
			switch am {
			case "nickserv":
				if ap != "" {
					s.SendIRC("PRIVMSG NickServ :IDENTIFY " + ap)
				}
			case "nickserv_cmd":
				if ap != "" {
					s.SendIRC("NICKSERV IDENTIFY " + ap)
				}
			}
			// A NickServ auth method with no password (e.g. connect form
			// prefilled from a saved profile, which never stores passwords)
			// would otherwise skip IDENTIFY silently.
			if (am == "nickserv" || am == "nickserv_cmd") && ap == "" {
				L.Warn("nickserv auth selected but no password given", "session", s.ID)
				s.sendWS(map[string]any{"type": "error", "text": "NickServ auth selected but no password was entered — not identified"})
			}
			s.sendWS(map[string]any{"type": "connected", "nick": s.Nick, "session": s.ID, "welcome": msg.Trailing})
			s.SendIRC("ADMIN")
			s.SendIRC("LUSERS")

		case "002": // RPL_YOURHOST — server software/version
			s.sendWS(map[string]any{"type": "motd", "text": msg.Trailing})
			s.setMeta("software", msg.Trailing)

		case "003": // RPL_CREATED — server creation time
			s.sendWS(map[string]any{"type": "motd", "text": msg.Trailing})
			s.setMeta("created", msg.Trailing)

		case "254": // RPL_LUSERCHANNELS
			if len(msg.Params) >= 2 {
				n, _ := strconv.Atoi(msg.Params[1])
				s.setMeta("channels", n)
			}

		case "265": // RPL_LOCALUSERS
			s.setMeta("local_users", msg.Trailing)

		case "266": // RPL_GLOBALUSERS
			s.setMeta("global_users", msg.Trailing)

		case "257", "258", "259": // RPL_ADMINLOC1, RPL_ADMINLOC2, RPL_ADMINEMAIL
			s.appendMeta("admin", msg.Trailing)

		case "004": // RPL_MYINFO — server hostname + preamble line
			if len(msg.Params) >= 2 {
				s.mu.Lock()
				s.servername = msg.Params[1]
				s.mu.Unlock()
				s.sendWS(map[string]any{"type": "servername", "value": msg.Params[1]})
			}
			// Display the full param list as a preamble line (trailing is usually empty for 004).
			if len(msg.Params) > 1 {
				s.sendWS(map[string]any{"type": "motd", "text": strings.Join(msg.Params[1:], " ")})
			}

		case "005": // RPL_ISUPPORT — server feature tokens
			for _, token := range msg.Params[1:] { // skip target nick at Params[0]
				if strings.HasPrefix(token, "PREFIX=") {
					s.sendWS(map[string]any{"type": "isupport_prefix", "value": token[7:]})
				} else if strings.HasPrefix(token, "NETWORK=") {
					s.mu.Lock()
					s.network = token[8:]
					s.mu.Unlock()
					s.sendWS(map[string]any{"type": "isupport_network", "value": token[8:]})
				}
			}
			// Display the full token list as a preamble line.
			if len(msg.Params) > 1 {
				s.sendWS(map[string]any{"type": "motd", "text": strings.Join(msg.Params[1:], " ")})
			}

		case "PRIVMSG":
			if len(msg.Params) < 2 {
				continue
			}
			target, text := msg.Params[0], msg.Params[1]
			// CTCP messages are wrapped in \x01 bytes.
			if strings.HasPrefix(text, "\x01ACTION ") && strings.HasSuffix(text, "\x01") {
				// Convert ACTION to the /me pseudo-command used by the UI.
				text = "/me " + strings.TrimSuffix(strings.TrimPrefix(text, "\x01ACTION "), "\x01")
			} else if msg.Nick == s.Nick && strings.HasPrefix(text, "\x01") && strings.HasSuffix(text, "\x01") {
				// echo-message: our own CTCP request echoed back — never auto-reply to ourselves.
				continue
			} else if strings.HasPrefix(text, "\x01PING") && strings.HasSuffix(text, "\x01") {
				// Echo the token back so the requester can measure round-trip time.
				token := strings.TrimSuffix(strings.TrimPrefix(text, "\x01"), "\x01")
				s.writeNow("NOTICE " + msg.Nick + " :\x01" + token + "\x01")
				continue
			} else if strings.HasPrefix(text, "\x01VERSION\x01") {
				s.writeNow("NOTICE " + msg.Nick + " :\x01VERSION wirgloo " + AppVersion + "\x01")
				continue
			} else if strings.HasPrefix(text, "\x01TIME\x01") {
				s.writeNow("NOTICE " + msg.Nick + " :\x01TIME " + time.Now().Format(time.RFC1123) + "\x01")
				continue
			} else if strings.HasPrefix(text, "\x01") && strings.HasSuffix(text, "\x01") {
				// Unrecognised CTCP request — ignore rather than forward to the UI.
				continue
			}
			// echo-message: never forward our own echoed messages to NickServ —
			// they may contain an IDENTIFY password and would otherwise be
			// displayed and persisted in the browser's chat history.
			if msg.Nick == s.Nick && strings.EqualFold(target, "NickServ") {
				continue
			}
			L.Debug("PRIVMSG", "session", s.ID, "from", msg.Nick, "target", target)
			s.sendWS(map[string]any{
				"type": "message", "from": msg.Nick,
				"target": target, "text": text,
				"ts": msgTime(msg), "history": s.inHistoryBatch(msg),
			})

		case "JOIN":
			channel := msg.Trailing
			if channel == "" && len(msg.Params) > 0 {
				channel = msg.Params[0]
			}
			L.Info("JOIN", "session", s.ID, "nick", msg.Nick, "channel", channel)
			if msg.Nick == s.Nick {
				s.mu.Lock()
				s.channels[channel] = true
				s.mu.Unlock()
			}
			s.sendWS(map[string]any{"type": "join", "nick": msg.Nick, "channel": channel, "ts": msgTime(msg)})

		case "PART":
			channel := ""
			if len(msg.Params) > 0 {
				channel = msg.Params[0]
			}
			L.Info("PART", "session", s.ID, "nick", msg.Nick, "channel", channel)
			if msg.Nick == s.Nick {
				s.mu.Lock()
				delete(s.channels, channel)
				s.mu.Unlock()
			}
			s.sendWS(map[string]any{"type": "part", "nick": msg.Nick, "channel": channel, "text": msg.Trailing, "ts": msgTime(msg)})

		case "TOPIC":
			if len(msg.Params) > 0 {
				channel := msg.Params[0]
				s.sendWS(map[string]any{"type": "topic", "channel": channel, "text": msg.Trailing, "nick": msg.Nick, "ts": msgTime(msg)})
			}

		case "NICK":
			newNick := msg.Trailing
			if newNick == "" && len(msg.Params) > 0 {
				newNick = msg.Params[0]
			}
			if msg.Nick == s.Nick {
				s.mu.Lock()
				s.Nick = newNick
				s.mu.Unlock()
			}
			L.Info("NICK", "session", s.ID, "old", msg.Nick, "new", newNick)
			s.sendWS(map[string]any{"type": "nick", "old": msg.Nick, "new": newNick, "ts": msgTime(msg)})

		case "AWAY": // away-notify CAP: nick set or cleared away status
			s.sendWS(map[string]any{"type": "away", "nick": msg.Nick, "away": msg.Trailing != "", "text": msg.Trailing})

		case "301": // RPL_AWAY — target is away (received during WHOIS or when messaging someone away)
			if len(msg.Params) >= 2 {
				s.sendWS(map[string]any{"type": "away_reply", "nick": msg.Params[1], "text": msg.Trailing})
			}

		case "305": // RPL_UNAWAY
			s.sendWS(map[string]any{"type": "away_status", "away": false, "text": "You are no longer away"})

		case "306": // RPL_NOWAWAY
			s.sendWS(map[string]any{"type": "away_status", "away": true, "text": "You are now marked as away"})

		case "311": // RPL_WHOISUSER
			if len(msg.Params) < 4 {
				continue
			}
			s.sendWS(map[string]any{"type": "whois_data", "nick": msg.Params[1], "field": "user", "ident": msg.Params[2], "host": msg.Params[3], "realname": msg.Trailing})

		case "312": // RPL_WHOISSERVER
			if len(msg.Params) < 3 {
				continue
			}
			s.sendWS(map[string]any{"type": "whois_data", "nick": msg.Params[1], "field": "server", "server": msg.Params[2], "location": msg.Trailing})

		case "313": // RPL_WHOISOPERATOR
			if len(msg.Params) < 2 {
				continue
			}
			s.sendWS(map[string]any{"type": "whois_data", "nick": msg.Params[1], "field": "ircop"})

		case "317": // RPL_WHOISIDLE
			if len(msg.Params) < 3 {
				continue
			}
			idleSecs, _ := strconv.Atoi(msg.Params[2])
			s.sendWS(map[string]any{"type": "whois_data", "nick": msg.Params[1], "field": "idle", "seconds": idleSecs})

		case "318": // RPL_ENDOFWHOIS
			if len(msg.Params) < 2 {
				continue
			}
			s.sendWS(map[string]any{"type": "whois_end", "nick": msg.Params[1]})

		case "319": // RPL_WHOISCHANNELS
			if len(msg.Params) < 2 {
				continue
			}
			s.sendWS(map[string]any{"type": "whois_data", "nick": msg.Params[1], "field": "channels", "channels": strings.Fields(msg.Trailing)})

		case "330": // RPL_WHOISACCOUNT
			if len(msg.Params) < 3 {
				continue
			}
			s.sendWS(map[string]any{"type": "whois_data", "nick": msg.Params[1], "field": "account", "account": msg.Params[2]})

		case "335": // RPL_WHOISBOT (UnrealIRCd and others)
			if len(msg.Params) < 2 {
				continue
			}
			s.sendWS(map[string]any{"type": "whois_data", "nick": msg.Params[1], "field": "bot"})

		case "671": // RPL_WHOISSECURE
			if len(msg.Params) < 2 {
				continue
			}
			s.sendWS(map[string]any{"type": "whois_data", "nick": msg.Params[1], "field": "secure"})

		case "375", "372": // RPL_MOTDSTART, RPL_MOTD
			text := strings.ReplaceAll(strings.TrimPrefix(msg.Trailing, "- "), `\\`, `\`)
			s.sendWS(map[string]any{"type": "motd", "text": text})

		case "376": // RPL_ENDOFMOTD — no message needed

		case "321": // RPL_LISTSTART
			s.mu.Lock()
			s.listBuf = s.listBuf[:0]
			s.mu.Unlock()
			s.sendWS(map[string]any{"type": "list_start"})

		case "322": // RPL_LIST
			if len(msg.Params) < 3 {
				continue
			}
			count, _ := strconv.Atoi(msg.Params[2])
			s.mu.Lock()
			s.listBuf = append(s.listBuf, listEntry{channel: msg.Params[1], count: count, topic: msg.Trailing})
			s.mu.Unlock()

		case "323": // RPL_LISTEND
			s.sendListResults("")

		case "332": // RPL_TOPIC
			if len(msg.Params) < 2 {
				continue
			}
			channel := msg.Params[1]
			L.Debug("TOPIC", "session", s.ID, "channel", channel)
			s.sendWS(map[string]any{"type": "topic", "channel": channel, "text": msg.Trailing, "nick": ""})

		case "333": // RPL_TOPICWHOTIME
			if len(msg.Params) < 4 {
				continue
			}
			channel := msg.Params[1]
			setter := msg.Params[2]
			tsStr := msg.Params[3]
			var timeStr string
			if ts, err := strconv.ParseInt(tsStr, 10, 64); err == nil {
				timeStr = time.Unix(ts, 0).Format("Mon Jan 02 15:04:05 2006")
			} else {
				timeStr = tsStr
			}
			s.sendWS(map[string]any{"type": "topic_meta", "channel": channel, "setter": setter, "time": timeStr})

		case "353": // RPL_NAMREPLY — nick list chunk for a channel
			if len(msg.Params) < 3 {
				continue
			}
			channel := msg.Params[len(msg.Params)-2]
			nicks := strings.Fields(msg.Trailing)
			L.Debug("NAMES chunk", "session", s.ID, "channel", channel, "count", len(nicks))
			s.sendWS(map[string]any{"type": "names_chunk", "channel": channel, "nicks": nicks})

		case "366": // RPL_ENDOFNAMES
			if len(msg.Params) < 2 {
				continue
			}
			s.sendWS(map[string]any{"type": "names_end", "channel": msg.Params[1]})

		case "211", "212", "213", "214", "215", "216", "217", "218", // RPL_STATS*
			"219",                                           // RPL_ENDOFSTATS
			"241", "242", "243", "244", "246", "247", "250": // RPL_STATS* continued
			text := msg.Trailing
			if text == "" {
				text = strings.Join(msg.Params[1:], " ")
			}
			s.sendWS(map[string]any{"type": "motd", "text": text})

		case "381": // RPL_YOUREOPER
			s.sendWS(map[string]any{"type": "youreoper", "text": msg.Trailing})

		case "403", "405", "471", "473", "474", "475", "476", "477", "479", "485": // join errors
			// Params: [clientNick, channel, reason-text]
			channel := ""
			if len(msg.Params) >= 2 {
				channel = msg.Params[1]
			}
			reason := msg.Trailing
			if reason == "" {
				reason = strings.Join(msg.Params[2:], " ")
			}
			L.Warn("cannot join", "session", s.ID, "channel", channel, "reason", reason)
			s.sendWS(map[string]any{"type": "join_error", "channel": channel, "text": reason})

		case "433": // ERR_NICKNAMEINUSE
			L.Warn("nick in use", "session", s.ID, "nick", s.Nick)
			s.sendWS(map[string]any{"type": "error", "text": "Nickname already in use"})

		default:
			// Forward unhandled 4xx/5xx numerics as errors so they are visible.
			if len(msg.Command) == 3 && msg.Command[0] >= '4' && msg.Command[0] <= '5' {
				text := msg.Trailing
				if text == "" {
					text = strings.Join(msg.Params[1:], " ")
				}
				L.Debug("IRC error numeric", "session", s.ID, "cmd", msg.Command, "text", text)
				s.sendWS(map[string]any{"type": "error", "text": text})
			}

		case "ERROR":
			L.Error("IRC ERROR", "session", s.ID, "text", msg.Trailing)
			s.sendWS(map[string]any{"type": "error", "text": msg.Trailing})

		case "MODE":
			if len(msg.Params) < 2 {
				continue
			}
			target := msg.Params[0]
			flags := msg.Params[1]
			params := msg.Params[2:]
			if len(params) == 0 {
				params = []string{}
			}
			modeStr := strings.Join(msg.Params[1:], " ")
			L.Debug("MODE", "session", s.ID, "target", target, "mode", modeStr)
			s.sendWS(map[string]any{"type": "mode", "target": target, "mode": modeStr, "flags": flags, "params": params, "nick": msg.Nick, "ts": msgTime(msg)})

		case "INVITE":
			if len(msg.Params) < 2 {
				continue
			}
			L.Info("INVITE", "session", s.ID, "nick", msg.Nick, "channel", msg.Params[1])
			s.sendWS(map[string]any{"type": "invite", "nick": msg.Nick, "channel": msg.Params[1], "ts": msgTime(msg)})

		case "KICK":
			if len(msg.Params) < 2 {
				continue
			}
			L.Info("KICK", "session", s.ID, "channel", msg.Params[0], "target", msg.Params[1], "by", msg.Nick)
			if msg.Params[1] == s.Nick {
				s.mu.Lock()
				delete(s.channels, msg.Params[0])
				s.mu.Unlock()
			}
			s.sendWS(map[string]any{
				"type": "kick", "channel": msg.Params[0],
				"nick": msg.Params[1], "by": msg.Nick, "text": msg.Trailing,
				"ts": msgTime(msg),
			})

		case "QUIT":
			L.Debug("QUIT", "session", s.ID, "nick", msg.Nick)
			s.sendWS(map[string]any{"type": "quit", "nick": msg.Nick, "text": msg.Trailing, "ts": msgTime(msg)})

		case "NOTICE":
			if len(msg.Params) < 2 {
				continue
			}
			text := msg.Params[1]
			L.Debug("NOTICE", "session", s.ID, "from", msg.Nick, "target", msg.Params[0])
			// echo-message: drop our own echoed CTCP replies (PING/VERSION/TIME responses).
			if msg.Nick == s.Nick && strings.HasPrefix(text, "\x01") && strings.HasSuffix(text, "\x01") {
				continue
			}
			// CTCP VERSION reply: \x01VERSION <string>\x01
			if strings.HasPrefix(text, "\x01VERSION ") && strings.HasSuffix(text, "\x01") {
				version := strings.TrimSuffix(strings.TrimPrefix(text, "\x01VERSION "), "\x01")
				s.sendWS(map[string]any{"type": "ctcp_version_reply", "from": msg.Nick, "version": version})
				continue
			}
			// CTCP PING reply: \x01PING <sent_ms>\x01
			if strings.HasPrefix(text, "\x01PING ") && strings.HasSuffix(text, "\x01") {
				token := strings.TrimSuffix(strings.TrimPrefix(text, "\x01PING "), "\x01")
				var sentMs int64
				if _, err := fmt.Sscanf(token, "%d", &sentMs); err == nil {
					rtt := time.Now().UnixMilli() - sentMs
					s.sendWS(map[string]any{"type": "ctcp_ping_reply", "from": msg.Nick, "ms": rtt})
				}
				continue
			}
			s.sendWS(map[string]any{
				"type": "notice", "from": msg.Nick,
				"target": msg.Params[0], "text": text,
				"ts": msgTime(msg), "history": s.inHistoryBatch(msg),
			})
		}
	}
	L.Info("IRC read loop ended", "session", s.ID)
	s.sendWS(map[string]any{"type": "disconnected", "text": "IRC connection closed"})
}

// SendIRC queues a raw IRC line through the rate limiter. Returns an error
// if the session has no active IRC connection.
func (s *Session) SendIRC(line string) error {
	s.mu.Lock()
	q := s.sendQ
	s.mu.Unlock()
	if q == nil {
		return fmt.Errorf("not connected")
	}
	select {
	case q <- line:
	default:
		L.Warn("send queue full, dropping line", "session", s.ID, "line", line)
	}
	return nil
}

// sendListResults filters and sorts listBuf then sends the results to the
// browser. An empty query sends the top ListPreviewSize channels by user count.
func (s *Session) sendListResults(query string) {
	s.mu.Lock()
	all := make([]listEntry, len(s.listBuf))
	copy(all, s.listBuf)
	s.mu.Unlock()

	q := strings.ToLower(query)
	var filtered []listEntry
	for _, e := range all {
		if q == "" || strings.Contains(strings.ToLower(e.channel), q) || strings.Contains(strings.ToLower(e.topic), q) {
			filtered = append(filtered, e)
		}
	}

	sort.Slice(filtered, func(i, j int) bool { return filtered[i].count > filtered[j].count })

	total := len(all)
	shown := len(filtered)
	capped := shown > ListPreviewSize && q == ""
	if capped {
		filtered = filtered[:ListPreviewSize]
	}

	s.sendWS(map[string]any{"type": "list_start", "filter": query})
	for _, e := range filtered {
		s.sendWS(map[string]any{"type": "list_item", "channel": e.channel, "count": e.count, "topic": e.topic})
	}
	s.sendWS(map[string]any{"type": "list_end", "total": total, "shown": shown, "capped": capped})
}

// FilterList re-filters the cached LIST results and sends them to the browser.
func (s *Session) FilterList(query string) {
	s.sendListResults(query)
}

// Quit sends a QUIT message immediately (bypassing the rate limiter) and
// closes the IRC connection after a short grace period so the QUIT can flush
// and the network records the quit reason instead of a connection reset.
func (s *Session) Quit(reason string) {
	s.writeNow("QUIT :" + reason)
	time.Sleep(200 * time.Millisecond)
	s.Close()
}

// sendWS serialises v as JSON and writes it to the WebSocket. If the
// WebSocket is currently detached the message is appended to the session
// buffer (up to BufferMax entries) so it can be flushed on reconnect.
// The write happens under wsMu, not mu, so a stalled browser connection
// never blocks goroutines that only need session state.
func (s *Session) sendWS(v any) {
	data, err := json.Marshal(v)
	if err != nil {
		return
	}
	s.mu.Lock()
	ws := s.ws
	if ws == nil {
		if len(s.buf) < BufferMax {
			s.buf = append(s.buf, data)
		}
		s.mu.Unlock()
		return
	}
	s.mu.Unlock()
	s.wsMu.Lock()
	ws.WriteMessage(websocket.TextMessage, data)
	s.wsMu.Unlock()
}

// pingLoop sends a PING to the server every pingInterval. If a PONG has not
// been received within pingTimeout of the most recent PING the connection is
// considered dead and Close is called. The ticker runs faster than the ping
// interval so a dead link is detected within ~pingTimeout, not at the next ping.
func (s *Session) pingLoop() {
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	var pingSent, lastPing time.Time
	for {
		select {
		case <-s.done:
			return
		case <-ticker.C:
			s.mu.Lock()
			lp := s.lastPong
			s.mu.Unlock()
			if !pingSent.IsZero() && lp.Before(pingSent) && time.Since(pingSent) > pingTimeout {
				L.Warn("ping timeout", "session", s.ID)
				s.Close()
				return
			}
			if time.Since(lastPing) >= pingInterval {
				s.writeNow("PING :wirgloo")
				lastPing = time.Now()
				pingSent = lastPing
			}
		}
	}
}

// warnNoSASL tells the user that SASL auth was selected but cannot happen,
// instead of silently connecting unauthenticated.
func (s *Session) warnNoSASL() {
	L.Warn("sasl auth selected but server does not support it", "session", s.ID)
	s.sendWS(map[string]any{"type": "error", "text": "SASL selected but the server does not support it — not authenticated"})
}

// isHistoryBatch reports whether a batch type carries chat history playback.
func isHistoryBatch(typ string) bool {
	return typ == "chathistory" || typ == "draft/chathistory"
}

// inHistoryBatch reports whether msg arrived inside an open chathistory batch.
func (s *Session) inHistoryBatch(msg ircMessage) bool {
	ref, ok := msg.Tags["batch"]
	if !ok {
		return false
	}
	s.mu.Lock()
	b := s.batches[ref]
	s.mu.Unlock()
	return isHistoryBatch(b.typ)
}

// ChatHistory requests message history for target from the server (IRCv3
// draft/chathistory). before, when non-empty, is an RFC3339 timestamp to page
// backwards from; otherwise the latest messages are requested. No-op when the
// server did not ACK the capability.
func (s *Session) ChatHistory(target, before string) {
	s.mu.Lock()
	ok := s.caps["draft/chathistory"] || s.caps["chathistory"]
	s.mu.Unlock()
	if !ok || target == "" {
		return
	}
	if before != "" {
		if _, err := time.Parse(time.RFC3339Nano, before); err != nil {
			L.Warn("invalid chathistory timestamp", "session", s.ID, "before", before)
			return
		}
		s.SendIRC(fmt.Sprintf("CHATHISTORY BEFORE %s timestamp=%s %d", target, before, chatHistoryLimit))
	} else {
		s.SendIRC(fmt.Sprintf("CHATHISTORY LATEST %s * %d", target, chatHistoryLimit))
	}
}

// msgTime returns the Unix timestamp from the server-time tag if present,
// falling back to the current time.
func msgTime(msg ircMessage) int64 {
	if t, ok := msg.Tags["time"]; ok {
		if parsed, err := time.Parse(time.RFC3339Nano, t); err == nil {
			return parsed.Unix()
		}
	}
	return time.Now().Unix()
}

// Close shuts down the IRC connection and signals all goroutines (ircLoop,
// pingLoop, ircReadLoop) to exit via the done channel. Safe to call more than once.
func (s *Session) Close() {
	select {
	case <-s.done:
	default:
		close(s.done)
	}
	s.mu.Lock()
	if s.conn != nil {
		s.conn.Close()
	}
	s.mu.Unlock()
}

// redactIRC replaces the payload of sensitive IRC commands with "***" so
// passwords never appear in debug logs. Patterns are matched anywhere in the
// line, not just at the start, so echoed/inbound lines with a tags+prefix
// preamble (e.g. "@time=... :nick!u@h PRIVMSG NickServ :IDENTIFY ...") are
// redacted too.
func redactIRC(line string) string {
	upper := strings.ToUpper(line)
	// Commands that only carry secrets at the start of an outbound line.
	for _, cmd := range []string{"PASS ", "AUTHENTICATE "} {
		if strings.HasPrefix(upper, cmd) {
			return line[:len(cmd)] + "***"
		}
	}
	// NickServ commands may appear mid-line on inbound/echoed messages with a
	// tags+prefix preamble (e.g. "@time=... :nick!u@h PRIVMSG NickServ :IDENTIFY ...").
	for _, cmd := range []string{"PRIVMSG NICKSERV :IDENTIFY ", "PRIVMSG NICKSERV :", "NICKSERV IDENTIFY "} {
		if idx := strings.Index(upper, cmd); idx != -1 {
			return line[:idx+len(cmd)] + "***"
		}
	}
	return line
}

// newID generates a random 8-byte hex session identifier.
func newID() string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		panic("crypto/rand unavailable: " + err.Error())
	}
	return hex.EncodeToString(b)
}
