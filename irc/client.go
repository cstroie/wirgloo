// Wirgloo — a self-hosted web IRC client.
// https://github.com/cstroie/wirgloo
//
// Copyright (C) 2025 Costin Stroie <costinstroie@eridu.eu.org>
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Package irc handles the low-level IRC protocol: dialing the server,
// performing the registration handshake, writing rate-limited lines,
// reading lines in a background goroutine, and parsing RFC 1459 messages
// with IRCv3 message-tag support.
package irc

import (
	"bufio"
	"crypto/tls"
	"fmt"
	"net"
	"strings"
	"time"

	"github.com/cstroie/wirgloo/logger"
)

// Message is a parsed IRC protocol line.
type Message struct {
	Tags     map[string]string // IRCv3 message tags, nil if none
	Prefix   string            // raw prefix, e.g. "nick!user@host" or "server"
	Nick     string            // nick extracted from Prefix; equals Prefix for server messages
	Command  string            // e.g. "PRIVMSG", "001", "PING"
	Params   []string          // all parameters including the trailing one
	Trailing string            // text after the " :" separator
}

// Dial opens a TCP connection to server:port. When useTLS is true the
// connection is wrapped in TLS; noVerify disables certificate verification
// (covers self-signed certs, hostname mismatches, expired certs, etc.).
// TCP keepalives are enabled on the underlying socket so silent connection
// drops are detected promptly.
func Dial(server string, port int, useTLS, noVerify bool) (net.Conn, error) {
	addr := fmt.Sprintf("[%s]:%d", server, port)
	if server[0] != '[' && !containsColon(server) {
		addr = fmt.Sprintf("%s:%d", server, port)
	}
	if useTLS {
		conn, err := tls.Dial("tcp", addr, &tls.Config{
			ServerName:         server,
			InsecureSkipVerify: noVerify,
		})
		if err != nil {
			return nil, err
		}
		setKeepalive(conn.NetConn())
		return conn, nil
	}
	conn, err := net.Dial("tcp", addr)
	if err != nil {
		return nil, err
	}
	setKeepalive(conn)
	return conn, nil
}

// setKeepalive enables TCP keepalives with a 30-second probe interval on conn
// if it is a *net.TCPConn (plain or the underlying socket of a TLS conn).
func setKeepalive(conn net.Conn) {
	if tc, ok := conn.(*net.TCPConn); ok {
		tc.SetKeepAlive(true)
		tc.SetKeepAlivePeriod(30 * time.Second)
	}
}

// Handshake sends the IRC registration sequence. capReq, if non-empty, is sent
// as "CAP REQ :<capReq>" before NICK/USER to start capability negotiation.
// pass is sent as a PASS command only when non-empty.
func Handshake(conn net.Conn, nick, user, realname, pass, capReq string) error {
	var lines []string
	if capReq != "" {
		lines = append(lines, "CAP REQ :"+capReq)
	}
	if pass != "" {
		lines = append(lines, fmt.Sprintf("PASS %s", pass))
	}
	lines = append(lines,
		fmt.Sprintf("NICK %s", nick),
		fmt.Sprintf("USER %s 0 * :%s", user, realname),
	)
	for _, l := range lines {
		if _, err := fmt.Fprintf(conn, "%s\r\n", l); err != nil {
			return err
		}
	}
	return nil
}

// WriteLine writes a single IRC line to conn, appending the required CR-LF.
func WriteLine(conn net.Conn, line string) error {
	_, err := fmt.Fprintf(conn, "%s\r\n", line)
	return err
}

// ReadLoop reads lines from conn and sends them on out. It returns when the
// connection is closed or when done is closed (the latter allows clean
// shutdown without waiting for the next read). The out channel is closed
// when ReadLoop returns so range-based consumers exit naturally.
func ReadLoop(conn net.Conn, out chan<- string, done <-chan struct{}) {
	scanner := bufio.NewScanner(conn)
	for scanner.Scan() {
		line := scanner.Text()
		select {
		case out <- line:
		case <-done:
			return
		}
	}
	if err := scanner.Err(); err != nil {
		logger.L.Warn("irc read error", "err", err)
	}
	close(out)
}

// ParseLine parses a raw IRC line into a Message following RFC 1459 syntax.
// The trailing parameter (after " :") is appended to Params so callers can
// always index Params without special-casing the trailing field.
func ParseLine(line string) Message {
	msg := Message{}
	// IRCv3 message tags: @key=value;key2=value2 ...
	if strings.HasPrefix(line, "@") {
		parts := strings.SplitN(line, " ", 2)
		msg.Tags = parseTags(parts[0][1:])
		if len(parts) > 1 {
			line = parts[1]
		} else {
			line = ""
		}
	}
	if strings.HasPrefix(line, ":") {
		parts := strings.SplitN(line, " ", 2)
		msg.Prefix = strings.TrimPrefix(parts[0], ":")
		msg.Nick = nickFromPrefix(msg.Prefix)
		if len(parts) > 1 {
			line = parts[1]
		} else {
			line = ""
		}
	}

	if idx := strings.Index(line, " :"); idx != -1 {
		msg.Trailing = line[idx+2:]
		line = line[:idx]
	}

	parts := strings.Fields(line)
	if len(parts) > 0 {
		msg.Command = parts[0]
		msg.Params = parts[1:]
	}
	if msg.Trailing != "" {
		msg.Params = append(msg.Params, msg.Trailing)
	}
	return msg
}

// parseTags splits an IRCv3 tag string ("key=val;key2=val2") into a map.
// Keys without a value are stored with an empty string.
func parseTags(s string) map[string]string {
	tags := make(map[string]string)
	for _, pair := range strings.Split(s, ";") {
		if pair == "" {
			continue
		}
		k, v, _ := strings.Cut(pair, "=")
		tags[k] = v
	}
	return tags
}

// containsColon reports whether s contains a colon, used to detect IPv6
// addresses that must be bracketed in the dial address.
func containsColon(s string) bool {
	for _, c := range s {
		if c == ':' {
			return true
		}
	}
	return false
}

// nickFromPrefix extracts the nick from a "nick!user@host" prefix string.
// If there is no "!" the whole prefix is returned (server message).
func nickFromPrefix(prefix string) string {
	if idx := strings.Index(prefix, "!"); idx != -1 {
		return prefix[:idx]
	}
	return prefix
}
