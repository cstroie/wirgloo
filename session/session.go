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
)

type Session struct {
	ID   string
	Nick string
	mu   sync.Mutex
	ws   *websocket.Conn
	conn net.Conn
	done chan struct{}
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

func (r *Registry) Remove(id string) {
	r.mu.Lock()
	delete(r.sessions, id)
	r.mu.Unlock()
}

func (s *Session) Connect(server string, port int, nick string, useTLS bool) error {
	conn, err := irc.Dial(server, port, useTLS)
	if err != nil {
		return err
	}
	s.mu.Lock()
	s.conn = conn
	s.Nick = nick
	s.mu.Unlock()

	if err := irc.Handshake(conn, nick, nick, "wirc user"); err != nil {
		conn.Close()
		return err
	}

	lines := make(chan string, 64)
	go irc.ReadLoop(conn, lines, s.done)
	go s.ircLoop(lines)
	return nil
}

func (s *Session) ircLoop(lines <-chan string) {
	for line := range lines {
		msg := irc.ParseLine(line)
		switch msg.Command {
		case "PING":
			s.SendIRC("PONG :" + msg.Trailing)
		case "001":
			s.sendWS(map[string]any{"type": "connected", "nick": s.Nick})
		case "PRIVMSG":
			if len(msg.Params) < 2 {
				continue
			}
			target, text := msg.Params[0], msg.Params[1]
			if strings.HasPrefix(text, "\x01ACTION ") && strings.HasSuffix(text, "\x01") {
				text = "/me " + strings.TrimSuffix(strings.TrimPrefix(text, "\x01ACTION "), "\x01")
			}
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
			s.sendWS(map[string]any{"type": "join", "nick": msg.Nick, "channel": channel})
		case "PART":
			channel := ""
			if len(msg.Params) > 0 {
				channel = msg.Params[0]
			}
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
			s.sendWS(map[string]any{"type": "nick", "old": msg.Nick, "new": newNick})
		case "353": // RPL_NAMREPLY
			if len(msg.Params) < 3 {
				continue
			}
			channel := msg.Params[len(msg.Params)-2]
			nicks := strings.Fields(msg.Trailing)
			s.sendWS(map[string]any{"type": "names", "channel": channel, "nicks": nicks})
		case "433": // ERR_NICKNAMEINUSE
			s.sendWS(map[string]any{"type": "error", "text": "Nickname already in use"})
		case "ERROR":
			s.sendWS(map[string]any{"type": "error", "text": msg.Trailing})
		case "QUIT":
			s.sendWS(map[string]any{"type": "quit", "nick": msg.Nick, "text": msg.Trailing})
		case "NOTICE":
			if len(msg.Params) < 2 {
				continue
			}
			s.sendWS(map[string]any{
				"type": "notice", "from": msg.Nick,
				"target": msg.Params[0], "text": msg.Params[1],
				"ts": time.Now().Unix(),
			})
		}
	}
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
	s.ws.WriteMessage(websocket.TextMessage, data)
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
