// Wirgloo — a self-hosted web IRC client.
// https://github.com/cstroie/wirgloo
//
// Copyright (C) 2025 Costin Stroie <costinstroie@eridu.eu.org>
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Package ws implements the WebSocket layer between the browser and the server.
// Each HTTP upgrade becomes a Session; inbound JSON messages from the browser
// are dispatched to IRC commands via the session package, and all IRC events
// flow back over the same WebSocket as JSON.
package ws

import (
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/gorilla/websocket"
	"wirgloo/logger"
	"wirgloo/session"
)

// upgrader promotes HTTP connections to WebSocket. CheckOrigin is permissive
// because wirgloo is a self-hosted tool where the operator controls the origin.
var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

// inMsg is the JSON envelope sent by the browser over the WebSocket.
// Not all fields are used by every message type.
type inMsg struct {
	Type       string `json:"type"`
	Server     string `json:"server"`
	Port       int    `json:"port"`
	Nick       string `json:"nick"`
	RealName   string `json:"realname"`
	TLS        bool   `json:"tls"`
	SelfSigned bool   `json:"selfsigned"`
	Pass       string `json:"pass"`
	AuthMethod string `json:"authmethod"`
	Channel    string `json:"channel"`
	Key        string `json:"key"`
	Target     string `json:"target"`
	Text       string `json:"text"`
	Line       string `json:"line"`
}

// Handler returns an http.HandlerFunc that upgrades the connection to
// WebSocket and drives the read loop for one browser session.
//
// If the request carries a "session" query parameter the handler tries to
// resume an existing session (WebSocket reconnect after a network hiccup).
// On success it flushes buffered IRC messages and sends a "resumed" message.
// If the session ID is unknown (e.g. server was restarted) it sends
// "session_expired" so the browser falls back to the connect form.
//
// On disconnect the session is detached rather than destroyed: the IRC
// connection stays alive for up to 60 seconds while the browser reconnects.
func Handler(reg *session.Registry) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			logger.L.Warn("websocket upgrade failed", "remote", r.RemoteAddr, "err", err)
			return
		}

		var s *session.Session
		if id := r.URL.Query().Get("session"); id != "" {
			s = reg.Resume(id, conn)
			if s != nil {
				logger.L.Info("client resumed", "session", s.ID, "remote", r.RemoteAddr)
				s.SendResumed()
			} else {
				logger.L.Info("session not found, notifying client", "id", id, "remote", r.RemoteAddr)
				data, _ := json.Marshal(map[string]any{"type": "session_expired"})
				conn.WriteMessage(websocket.TextMessage, data)
			}
		}
		if s == nil {
			s = reg.New(conn)
			logger.L.Info("client connected", "session", s.ID, "remote", r.RemoteAddr)
		}

		defer func() {
			reg.Detach(s)
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

// dispatch routes an inbound browser message to the appropriate Session method
// or raw IRC command. Unknown message types are silently ignored so future
// client-only messages don't require server changes.
func dispatch(s *session.Session, msg inMsg) error {
	switch msg.Type {
	case "connect":
		// Apply IRC default ports when the browser omits them.
		if msg.Port == 0 {
			if msg.TLS {
				msg.Port = 6697
			} else {
				msg.Port = 6667
			}
		}
		return s.Connect(msg.Server, msg.Port, msg.Nick, msg.RealName, msg.TLS, msg.SelfSigned, msg.Pass, msg.AuthMethod)
	case "disconnect":
		reason := msg.Text
		if reason == "" {
			reason = "Leaving"
		}
		s.Quit(reason)
	case "join":
		// Pass the channel key when joining a +k channel.
		if msg.Key != "" {
			return s.SendIRC("JOIN " + msg.Channel + " " + msg.Key)
		}
		return s.SendIRC("JOIN " + msg.Channel)
	case "part":
		return s.SendIRC("PART " + msg.Channel)
	case "message":
		return s.SendIRC(fmt.Sprintf("PRIVMSG %s :%s", msg.Target, msg.Text))
	case "nick":
		return s.SendIRC("NICK " + msg.Nick)
	case "raw":
		// Allows the browser to send arbitrary IRC lines (e.g. /raw).
		return s.SendIRC(msg.Line)
	}
	return nil
}
