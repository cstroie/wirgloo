// Wirgloo — a self-hosted web IRC client.
// https://github.com/cstroie/wirgloo
//
// Copyright (C) 2025 Costin Stroie <costinstroie@eridu.eu.org>
// SPDX-License-Identifier: GPL-3.0-or-later
//
// handler implements the WebSocket layer between the browser and the server.
// Each HTTP upgrade becomes a Session; inbound JSON messages from the browser
// are dispatched to IRC commands, and all IRC events flow back over the same
// WebSocket as JSON.
package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/gorilla/websocket"
)

// upgrader promotes HTTP connections to WebSocket. CheckOrigin validates that
// the request origin matches the server host to prevent cross-site WebSocket
// hijacking. Requests with no Origin header (e.g. native clients, curl) are
// allowed because they cannot be forged by a browser.
var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		origin := r.Header.Get("Origin")
		if origin == "" {
			return true // non-browser client
		}
		return origin == "http://"+r.Host || origin == "https://"+r.Host
	},
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
	NoVerify   bool   `json:"noverify"`
	Pass       string `json:"pass"`
	AuthMethod string `json:"authmethod"`
	Channel    string `json:"channel"`
	Key        string `json:"key"`
	Target     string `json:"target"`
	Text       string `json:"text"`
	Line       string `json:"line"`
}

// wsHandler returns an http.HandlerFunc that upgrades the connection to
// WebSocket and drives the read loop for one browser session.
//
// If the request carries a "session" query parameter the handler tries to
// resume an existing session (WebSocket reconnect after a network hiccup).
// On success it flushes buffered IRC messages and sends a "resumed" message.
// If the session ID is unknown (e.g. server was restarted) it sends
// "session_expired" so the browser falls back to the connect form.
//
// On disconnect the session is detached rather than destroyed: the IRC
// connection stays alive for up to WsReconnectWindow while the browser reconnects.
func wsHandler(reg *Registry) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			L.Warn("websocket upgrade failed", "remote", r.RemoteAddr, "err", err)
			return
		}

		var s *Session
		if id := r.URL.Query().Get("session"); id != "" {
			s = reg.Resume(id, conn)
			if s != nil {
				L.Info("client resumed", "session", s.ID, "remote", r.RemoteAddr)
				s.SendResumed()
			} else {
				L.Info("session not found, notifying client", "id", id, "remote", r.RemoteAddr)
				if data, err := json.Marshal(map[string]any{"type": "session_expired"}); err == nil {
					conn.WriteMessage(websocket.TextMessage, data)
				}
			}
		}
		if s == nil {
			s = reg.New(conn)
			L.Info("client connected", "session", s.ID, "remote", r.RemoteAddr)
		}

		defer func() {
			reg.Detach(s)
			conn.Close()
			L.Info("client disconnected", "session", s.ID, "nick", s.Nick)
		}()

		for {
			_, raw, err := conn.ReadMessage()
			if err != nil {
				break
			}
			var msg inMsg
			if err := json.Unmarshal(raw, &msg); err != nil {
				L.Warn("invalid message", "session", s.ID, "err", err)
				continue
			}
			L.Debug("ws message", "session", s.ID, "type", msg.Type)
			if err := dispatch(s, msg); err != nil {
				L.Error("dispatch error", "session", s.ID, "type", msg.Type, "err", err)
			}
		}
	}
}

// sanitize strips CR and LF from a string to prevent IRC command injection.
func sanitize(s string) string {
	return strings.NewReplacer("\r", "", "\n", "").Replace(s)
}

// dispatch routes an inbound browser message to the appropriate Session method
// or raw IRC command. Unknown message types are silently ignored so future
// client-only messages don't require server changes.
func dispatch(s *Session, msg inMsg) error {
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
		return s.Connect(msg.Server, msg.Port, msg.Nick, msg.RealName, msg.TLS, msg.NoVerify, msg.Pass, msg.AuthMethod)
	case "disconnect":
		reason := msg.Text
		if reason == "" {
			reason = "Leaving"
		}
		s.Quit(reason)
	case "join":
		// Pass the channel key when joining a +k channel.
		if msg.Key != "" {
			return s.SendIRC("JOIN " + sanitize(msg.Channel) + " " + sanitize(msg.Key))
		}
		return s.SendIRC("JOIN " + sanitize(msg.Channel))
	case "part":
		if msg.Text != "" {
			return s.SendIRC("PART " + sanitize(msg.Channel) + " :" + sanitize(msg.Text))
		}
		return s.SendIRC("PART " + sanitize(msg.Channel))
	case "message":
		return s.SendIRC(fmt.Sprintf("PRIVMSG %s :%s", sanitize(msg.Target), sanitize(msg.Text)))
	case "nick":
		return s.SendIRC("NICK " + sanitize(msg.Nick))
	case "raw":
		// Allows the browser to send arbitrary IRC lines (e.g. /raw).
		return s.SendIRC(msg.Line)
	case "list_filter":
		s.FilterList(msg.Text)
	}
	return nil
}
