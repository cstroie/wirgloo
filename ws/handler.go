package ws

import (
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/gorilla/websocket"
	"igloo/logger"
	"igloo/session"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

type inMsg struct {
	Type    string `json:"type"`
	Server  string `json:"server"`
	Port    int    `json:"port"`
	Nick    string `json:"nick"`
	TLS     bool   `json:"tls"`
	Channel string `json:"channel"`
	Target  string `json:"target"`
	Text    string `json:"text"`
	Line    string `json:"line"`
}

func Handler(reg *session.Registry) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			logger.L.Warn("websocket upgrade failed", "remote", r.RemoteAddr, "err", err)
			return
		}

		s := reg.New(conn)
		logger.L.Info("client connected", "session", s.ID, "remote", r.RemoteAddr)

		defer func() {
			s.Close()
			reg.Remove(s.ID)
			conn.Close()
			logger.L.Info("client disconnected", "session", s.ID, "nick", s.Nick)
		}()

		for {
			_, raw, err := conn.ReadMessage()
			if err != nil {
				break
			}
			var msg inMsg
			if err := json.Unmarshal(raw, &msg); err != nil {
				logger.L.Warn("invalid message", "session", s.ID, "err", err)
				continue
			}
			logger.L.Debug("ws message", "session", s.ID, "type", msg.Type)
			if err := dispatch(s, msg); err != nil {
				logger.L.Error("dispatch error", "session", s.ID, "type", msg.Type, "err", err)
			}
		}
	}
}

func dispatch(s *session.Session, msg inMsg) error {
	switch msg.Type {
	case "connect":
		if msg.Port == 0 {
			if msg.TLS {
				msg.Port = 6697
			} else {
				msg.Port = 6667
			}
		}
		return s.Connect(msg.Server, msg.Port, msg.Nick, msg.TLS)
	case "join":
		return s.SendIRC("JOIN " + msg.Channel)
	case "part":
		return s.SendIRC("PART " + msg.Channel)
	case "message":
		return s.SendIRC(fmt.Sprintf("PRIVMSG %s :%s", msg.Target, msg.Text))
	case "nick":
		return s.SendIRC("NICK " + msg.Nick)
	case "raw":
		return s.SendIRC(msg.Line)
	}
	return nil
}
