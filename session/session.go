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

const wsReconnectWindow = 60 * time.Second
const bufferMax = 500

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
}

type Registry struct {
	mu       sync.RWMutex
	sessions map[string]*Session
}

func NewRegistry() *Registry {
	return &Registry{sessions: make(map[string]*Session)}
}

func (r *Registry) New(ws *websocket.Conn) *Session {
	id := newID()
	s := &Session{ID: id, ws: ws, done: make(chan struct{})}
	r.mu.Lock()
	r.sessions[id] = s
	r.mu.Unlock()
	return s
}

// Resume attaches ws to an existing session, cancelling any pending cleanup.
// Returns nil if the session doesn't exist.
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

// Detach marks the WebSocket as gone and schedules session cleanup after
// wsReconnectWindow unless the client reconnects first.
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

func (r *Registry) Remove(id string) {
	r.mu.Lock()
	delete(r.sessions, id)
	r.mu.Unlock()
}

func (s *Session) Connect(server string, port int, nick string, useTLS, selfSigned bool, pass, nspass string) error {
	logger.L.Info("connecting to IRC", "session", s.ID, "server", server, "port", port, "nick", nick, "tls", useTLS, "selfsigned", selfSigned)
	conn, err := irc.Dial(server, port, useTLS, selfSigned)
	if err != nil {
		logger.L.Error("IRC dial failed", "session", s.ID, "server", server, "err", err)
		return err
	}
	s.mu.Lock()
	s.conn = conn
	s.Nick = nick
	s.nspass = nspass
	s.mu.Unlock()

	if err := irc.Handshake(conn, nick, nick, "igloo user", pass); err != nil {
		conn.Close()
		logger.L.Error("IRC handshake failed", "session", s.ID, "err", err)
		return err
	}

	lines := make(chan string, 64)
	go irc.ReadLoop(conn, lines, s.done)
	go s.ircLoop(lines)
	go s.pingLoop()
	return nil
}

func (s *Session) SendResumed() {
	s.sendWS(map[string]any{"type": "resumed", "nick": s.Nick})
}

func (s *Session) ircLoop(lines <-chan string) {
	for line := range lines {
		msg := irc.ParseLine(line)
		switch msg.Command {
		case "PING":
			s.SendIRC("PONG :" + msg.Trailing)

		case "PONG":
			s.mu.Lock()
			s.lastPong = time.Now()
			s.mu.Unlock()

		case "001":
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

		case "305":
			s.sendWS(map[string]any{"type": "whois", "text": "You are no longer away"})

		case "306":
			s.sendWS(map[string]any{"type": "whois", "text": "You are now marked as away"})

		// WHOIS numerics
		case "311": // whois user
			if len(msg.Params) < 4 {
				continue
			}
			s.sendWS(map[string]any{"type": "whois", "text": fmt.Sprintf("%s (%s@%s): %s", msg.Params[1], msg.Params[2], msg.Params[3], msg.Trailing)})

		case "312": // whois server
			if len(msg.Params) < 3 {
				continue
			}
			s.sendWS(map[string]any{"type": "whois", "text": fmt.Sprintf("%s via %s (%s)", msg.Params[1], msg.Params[2], msg.Trailing)})

		case "313": // whois operator
			if len(msg.Params) < 2 {
				continue
			}
			s.sendWS(map[string]any{"type": "whois", "text": fmt.Sprintf("%s is an IRC operator", msg.Params[1])})

		case "317": // whois idle
			if len(msg.Params) < 3 {
				continue
			}
			idle := msg.Params[2]
			s.sendWS(map[string]any{"type": "whois", "text": fmt.Sprintf("%s idle: %ss", msg.Params[1], idle)})

		case "319": // whois channels
			if len(msg.Params) < 2 {
				continue
			}
			s.sendWS(map[string]any{"type": "whois", "text": fmt.Sprintf("%s in: %s", msg.Params[1], msg.Trailing)})

		case "330": // whois account
			if len(msg.Params) < 3 {
				continue
			}
			s.sendWS(map[string]any{"type": "whois", "text": fmt.Sprintf("%s logged in as %s", msg.Params[1], msg.Params[2])})

		case "318": // end of whois
			if len(msg.Params) < 2 {
				continue
			}
			s.sendWS(map[string]any{"type": "whois", "text": fmt.Sprintf("— end of whois for %s", msg.Params[1])})

		case "671": // whois TLS
			if len(msg.Params) < 2 {
				continue
			}
			s.sendWS(map[string]any{"type": "whois", "text": fmt.Sprintf("%s is using a secure connection", msg.Params[1])})

		case "375":
			s.sendWS(map[string]any{"type": "motd", "text": msg.Trailing})

		case "372":
			s.sendWS(map[string]any{"type": "motd", "text": msg.Trailing})

		case "376":
			// end of MOTD — no message needed

		case "321":
			s.sendWS(map[string]any{"type": "list_start"})

		case "322":
			if len(msg.Params) < 3 {
				continue
			}
			s.sendWS(map[string]any{
				"type": "list_item", "channel": msg.Params[1],
				"count": msg.Params[2], "topic": msg.Trailing,
			})

		case "323":
			s.sendWS(map[string]any{"type": "list_end"})

		case "332":
			if len(msg.Params) < 2 {
				continue
			}
			channel := msg.Params[1]
			logger.L.Debug("TOPIC", "session", s.ID, "channel", channel)
			s.sendWS(map[string]any{"type": "topic", "channel": channel, "text": msg.Trailing})

		case "353":
			if len(msg.Params) < 3 {
				continue
			}
			channel := msg.Params[len(msg.Params)-2]
			nicks := strings.Fields(msg.Trailing)
			logger.L.Debug("NAMES", "session", s.ID, "channel", channel, "count", len(nicks))
			s.sendWS(map[string]any{"type": "names", "channel": channel, "nicks": nicks})

		case "433":
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

func (s *Session) SendIRC(line string) error {
	s.mu.Lock()
	conn := s.conn
	s.mu.Unlock()
	if conn == nil {
		return fmt.Errorf("not connected")
	}
	return irc.WriteLine(conn, line)
}

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

const pingInterval = 90 * time.Second
const pingTimeout  = 60 * time.Second

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
			// if a ping is outstanding and the timeout has elapsed, kill the connection
			if !pingSent.IsZero() && lp.Before(pingSent) && time.Since(pingSent) > pingTimeout {
				logger.L.Warn("ping timeout", "session", s.ID)
				s.Close()
				return
			}
			if err := s.SendIRC("PING :igloo"); err != nil {
				return
			}
			pingSent = time.Now()
		}
	}
}

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

func newID() string {
	b := make([]byte, 8)
	rand.Read(b)
	return hex.EncodeToString(b)
}
