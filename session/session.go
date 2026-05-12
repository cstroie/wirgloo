// Package session manages the lifecycle of connected clients. Each browser
// tab gets a Session that owns one WebSocket connection and one IRC TCP
// connection. The Registry keeps track of all live sessions and supports
// WebSocket reconnection: when a browser's WebSocket drops the IRC connection
// stays alive for up to wsReconnectWindow so the client can reattach.
package session

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"igloo/irc"
	"igloo/logger"
)

const wsReconnectWindow = 60 * time.Second // how long to keep an IRC session alive without a WS
const bufferMax         = 500              // maximum IRC messages buffered while WS is detached
const pingInterval      = 90 * time.Second // how often to send a client-initiated PING
const pingTimeout       = 60 * time.Second // how long to wait for a PONG before closing

const (
	sendBurst    = 5                      // initial token allowance
	sendInterval = 333 * time.Millisecond // one new token every ~333 ms (≈ 3/s)
)

// Session represents one connected browser client and its associated IRC
// connection. All fields are protected by mu except ID and done (immutable
// after creation).
type Session struct {
	ID       string
	Nick     string
	mu       sync.Mutex
	ws       *websocket.Conn
	buf      [][]byte // messages buffered while WS is detached
	conn     net.Conn
	done     chan struct{}
	nspass   string
	lastPong time.Time
	sendQ    chan string // rate-limited outbound line queue
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
	s := &Session{ID: id, ws: ws, done: make(chan struct{})}
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
	s.mu.Lock()
	s.ws = ws
	pending := s.buf
	s.buf = nil
	s.mu.Unlock()
	for _, data := range pending {
		ws.WriteMessage(websocket.TextMessage, data)
	}
	return s
}

// Detach nulls out the WebSocket and starts a cleanup timer. If the client
// does not reconnect within wsReconnectWindow the IRC connection is closed
// and the session is removed from the registry.
func (r *Registry) Detach(s *Session) {
	s.mu.Lock()
	s.ws = nil
	s.mu.Unlock()

	time.AfterFunc(wsReconnectWindow, func() {
		s.mu.Lock()
		wsGone := s.ws == nil
		s.mu.Unlock()
		if wsGone {
			logger.L.Info("session expired", "session", s.ID)
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
// the read and ping goroutines. nspass is used to identify with NickServ
// after receiving the welcome numeric (001); pass is the server PASS sent
// during the handshake. Connect returns once the TCP connection and handshake
// succeed; the 001 numeric arrives asynchronously via ircLoop.
func (s *Session) Connect(server string, port int, nick, realname string, useTLS, selfSigned bool, pass, nspass string) error {
	if realname == "" {
		realname = nick
	}
	logger.L.Info("connecting to IRC", "session", s.ID, "server", server, "port", port, "nick", nick, "tls", useTLS, "selfsigned", selfSigned)
	conn, err := irc.Dial(server, port, useTLS, selfSigned)
	if err != nil {
		logger.L.Error("IRC dial failed", "session", s.ID, "server", server, "err", err)
		s.sendWS(map[string]any{"type": "connect_error", "text": err.Error()})
		return err
	}
	s.mu.Lock()
	s.conn = conn
	s.Nick = nick
	s.nspass = nspass
	s.mu.Unlock()

	if err := irc.Handshake(conn, nick, nick, realname, pass); err != nil {
		conn.Close()
		logger.L.Error("IRC handshake failed", "session", s.ID, "err", err)
		s.sendWS(map[string]any{"type": "connect_error", "text": err.Error()})
		return err
	}

	s.mu.Lock()
	s.sendQ = make(chan string, 128)
	s.mu.Unlock()

	lines := make(chan string, 64)
	go irc.ReadLoop(conn, lines, s.done)
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
			irc.WriteLine(conn, pending[0])
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
		irc.WriteLine(conn, line)
	}
}

// SendResumed notifies the browser that the WebSocket has been successfully
// reattached to an existing IRC session.
func (s *Session) SendResumed() {
	s.sendWS(map[string]any{"type": "resumed", "nick": s.Nick})
}

// ircLoop processes every line received from the IRC server and forwards
// relevant events to the browser as JSON WebSocket messages. It runs in its
// own goroutine and exits when the lines channel is closed (i.e. when
// ReadLoop returns after a connection drop or done is closed).
func (s *Session) ircLoop(lines <-chan string) {
	for line := range lines {
		msg := irc.ParseLine(line)
		switch msg.Command {
		case "CAP":
			// Acknowledge and end capability negotiation immediately.
			s.writeNow("CAP END")

		case "PING":
			s.writeNow("PONG :" + msg.Trailing)

		case "PONG":
			s.mu.Lock()
			s.lastPong = time.Now()
			s.mu.Unlock()

		case "001": // welcome — IRC registration complete
			logger.L.Info("IRC connected", "session", s.ID, "nick", s.Nick)
			s.mu.Lock()
			nspass := s.nspass
			s.mu.Unlock()
			if nspass != "" {
				s.SendIRC("PRIVMSG NickServ :IDENTIFY " + nspass)
			}
			s.sendWS(map[string]any{"type": "connected", "nick": s.Nick, "session": s.ID})

		case "PRIVMSG":
			if len(msg.Params) < 2 {
				continue
			}
			target, text := msg.Params[0], msg.Params[1]
			if strings.HasPrefix(text, "\x01ACTION ") && strings.HasSuffix(text, "\x01") {
				text = "/me " + strings.TrimSuffix(strings.TrimPrefix(text, "\x01ACTION "), "\x01")
			}
			logger.L.Debug("PRIVMSG", "session", s.ID, "from", msg.Nick, "target", target)
			s.sendWS(map[string]any{
				"type": "message", "from": msg.Nick,
				"target": target, "text": text,
				"ts": time.Now().Unix(),
			})

		case "JOIN":
			channel := msg.Trailing
			if channel == "" && len(msg.Params) > 0 {
				channel = msg.Params[0]
			}
			logger.L.Info("JOIN", "session", s.ID, "nick", msg.Nick, "channel", channel)
			s.sendWS(map[string]any{"type": "join", "nick": msg.Nick, "channel": channel})

		case "PART":
			channel := ""
			if len(msg.Params) > 0 {
				channel = msg.Params[0]
			}
			logger.L.Info("PART", "session", s.ID, "nick", msg.Nick, "channel", channel)
			s.sendWS(map[string]any{"type": "part", "nick": msg.Nick, "channel": channel})

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
			logger.L.Info("NICK", "session", s.ID, "old", msg.Nick, "new", newNick)
			s.sendWS(map[string]any{"type": "nick", "old": msg.Nick, "new": newNick})

		case "301": // RPL_AWAY — received during WHOIS if target is away
			if len(msg.Params) >= 2 {
				s.sendWS(map[string]any{"type": "whois", "text": "away: " + msg.Trailing})
			}

		case "305": // RPL_UNAWAY
			s.sendWS(map[string]any{"type": "whois", "text": "You are no longer away"})

		case "306": // RPL_NOWAWAY
			s.sendWS(map[string]any{"type": "whois", "text": "You are now marked as away"})

		case "311": // RPL_WHOISUSER
			if len(msg.Params) < 4 {
				continue
			}
			s.sendWS(map[string]any{"type": "whois", "text": fmt.Sprintf("%s (%s@%s): %s", msg.Params[1], msg.Params[2], msg.Params[3], msg.Trailing)})

		case "312": // RPL_WHOISSERVER
			if len(msg.Params) < 3 {
				continue
			}
			s.sendWS(map[string]any{"type": "whois", "text": fmt.Sprintf("%s via %s (%s)", msg.Params[1], msg.Params[2], msg.Trailing)})

		case "313": // RPL_WHOISOPERATOR
			if len(msg.Params) < 2 {
				continue
			}
			s.sendWS(map[string]any{"type": "whois", "text": fmt.Sprintf("%s is an IRC operator", msg.Params[1])})

		case "317": // RPL_WHOISIDLE
			if len(msg.Params) < 3 {
				continue
			}
			s.sendWS(map[string]any{"type": "whois", "text": fmt.Sprintf("%s idle: %ss", msg.Params[1], msg.Params[2])})

		case "318": // RPL_ENDOFWHOIS
			if len(msg.Params) < 2 {
				continue
			}
			s.sendWS(map[string]any{"type": "whois", "text": fmt.Sprintf("— end of whois for %s", msg.Params[1])})

		case "319": // RPL_WHOISCHANNELS
			if len(msg.Params) < 2 {
				continue
			}
			s.sendWS(map[string]any{"type": "whois", "text": fmt.Sprintf("%s in: %s", msg.Params[1], msg.Trailing)})

		case "330": // RPL_WHOISACCOUNT
			if len(msg.Params) < 3 {
				continue
			}
			s.sendWS(map[string]any{"type": "whois", "text": fmt.Sprintf("%s logged in as %s", msg.Params[1], msg.Params[2])})

		case "671": // RPL_WHOISSECURE
			if len(msg.Params) < 2 {
				continue
			}
			s.sendWS(map[string]any{"type": "whois", "text": fmt.Sprintf("%s is using a secure connection", msg.Params[1])})

		case "375", "372": // RPL_MOTDSTART, RPL_MOTD
			s.sendWS(map[string]any{"type": "motd", "text": msg.Trailing})

		case "376": // RPL_ENDOFMOTD — no message needed

		case "321": // RPL_LISTSTART
			s.sendWS(map[string]any{"type": "list_start"})

		case "322": // RPL_LIST
			if len(msg.Params) < 3 {
				continue
			}
			s.sendWS(map[string]any{
				"type": "list_item", "channel": msg.Params[1],
				"count": msg.Params[2], "topic": msg.Trailing,
			})

		case "323": // RPL_LISTEND
			s.sendWS(map[string]any{"type": "list_end"})

		case "332": // RPL_TOPIC
			if len(msg.Params) < 2 {
				continue
			}
			channel := msg.Params[1]
			logger.L.Debug("TOPIC", "session", s.ID, "channel", channel)
			s.sendWS(map[string]any{"type": "topic", "channel": channel, "text": msg.Trailing})

		case "353": // RPL_NAMREPLY — nick list for a channel
			if len(msg.Params) < 3 {
				continue
			}
			channel := msg.Params[len(msg.Params)-2]
			nicks := strings.Fields(msg.Trailing)
			logger.L.Debug("NAMES", "session", s.ID, "channel", channel, "count", len(nicks))
			s.sendWS(map[string]any{"type": "names", "channel": channel, "nicks": nicks})

		case "433": // ERR_NICKNAMEINUSE
			logger.L.Warn("nick in use", "session", s.ID, "nick", s.Nick)
			s.sendWS(map[string]any{"type": "error", "text": "Nickname already in use"})

		case "ERROR":
			logger.L.Error("IRC ERROR", "session", s.ID, "text", msg.Trailing)
			s.sendWS(map[string]any{"type": "error", "text": msg.Trailing})

		case "MODE":
			if len(msg.Params) < 2 {
				continue
			}
			target := msg.Params[0]
			modeStr := strings.Join(msg.Params[1:], " ")
			logger.L.Debug("MODE", "session", s.ID, "target", target, "mode", modeStr)
			s.sendWS(map[string]any{"type": "mode", "target": target, "mode": modeStr, "nick": msg.Nick})

		case "INVITE":
			if len(msg.Params) < 2 {
				continue
			}
			logger.L.Info("INVITE", "session", s.ID, "nick", msg.Nick, "channel", msg.Params[1])
			s.sendWS(map[string]any{"type": "invite", "nick": msg.Nick, "channel": msg.Params[1]})

		case "KICK":
			if len(msg.Params) < 2 {
				continue
			}
			logger.L.Info("KICK", "session", s.ID, "channel", msg.Params[0], "target", msg.Params[1], "by", msg.Nick)
			s.sendWS(map[string]any{
				"type": "kick", "channel": msg.Params[0],
				"nick": msg.Params[1], "by": msg.Nick, "text": msg.Trailing,
			})

		case "QUIT":
			logger.L.Debug("QUIT", "session", s.ID, "nick", msg.Nick)
			s.sendWS(map[string]any{"type": "quit", "nick": msg.Nick, "text": msg.Trailing})

		case "NOTICE":
			if len(msg.Params) < 2 {
				continue
			}
			logger.L.Debug("NOTICE", "session", s.ID, "from", msg.Nick, "target", msg.Params[0])
			s.sendWS(map[string]any{
				"type": "notice", "from": msg.Nick,
				"target": msg.Params[0], "text": msg.Params[1],
				"ts": time.Now().Unix(),
			})
		}
	}
	logger.L.Info("IRC read loop ended", "session", s.ID)
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
		logger.L.Warn("send queue full, dropping line", "session", s.ID, "line", line)
	}
	return nil
}

// Quit sends a QUIT message immediately (bypassing the rate limiter) and
// closes the IRC connection.
func (s *Session) Quit(reason string) {
	s.writeNow("QUIT :" + reason)
	s.Close()
}

// sendWS serialises v as JSON and writes it to the WebSocket. If the
// WebSocket is currently detached the message is appended to the session
// buffer (up to bufferMax entries) so it can be flushed on reconnect.
func (s *Session) sendWS(v any) {
	data, err := json.Marshal(v)
	if err != nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ws == nil {
		if len(s.buf) < bufferMax {
			s.buf = append(s.buf, data)
		}
		return
	}
	s.ws.WriteMessage(websocket.TextMessage, data)
}

// pingLoop sends a PING to the server every pingInterval. If a PONG has not
// been received within pingTimeout of the most recent PING the connection is
// considered dead and Close is called. This catches silent TCP drops that OS
// keepalives do not detect quickly enough.
func (s *Session) pingLoop() {
	ticker := time.NewTicker(pingInterval)
	defer ticker.Stop()
	pingSent := time.Time{}
	for {
		select {
		case <-s.done:
			return
		case <-ticker.C:
			s.mu.Lock()
			lp := s.lastPong
			s.mu.Unlock()
			if !pingSent.IsZero() && lp.Before(pingSent) && time.Since(pingSent) > pingTimeout {
				logger.L.Warn("ping timeout", "session", s.ID)
				s.Close()
				return
			}
			s.writeNow("PING :igloo")
			pingSent = time.Now()
		}
	}
}

// Close shuts down the IRC connection and signals all goroutines (ircLoop,
// pingLoop, ReadLoop) to exit via the done channel. Safe to call more than
// once.
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

// newID generates a random 8-byte hex session identifier.
func newID() string {
	b := make([]byte, 8)
	rand.Read(b)
	return hex.EncodeToString(b)
}
