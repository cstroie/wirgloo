package irc

import (
	"bufio"
	"crypto/tls"
	"fmt"
	"net"
	"strings"
)

type Message struct {
	Prefix  string
	Nick    string // extracted from prefix
	Command string
	Params  []string
	Trailing string
}

func Dial(server string, port int, useTLS bool) (net.Conn, error) {
	addr := fmt.Sprintf("[%s]:%d", server, port)
	if server[0] != '[' && !containsColon(server) {
		addr = fmt.Sprintf("%s:%d", server, port)
	}
	if useTLS {
		return tls.Dial("tcp", addr, &tls.Config{ServerName: server})
	}
	return net.Dial("tcp", addr)
}

func Handshake(conn net.Conn, nick, user, realname, pass string) error {
	lines := []string{}
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

func WriteLine(conn net.Conn, line string) error {
	_, err := fmt.Fprintf(conn, "%s\r\n", line)
	return err
}

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
	close(out)
}

func ParseLine(line string) Message {
	msg := Message{}
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

func containsColon(s string) bool {
	for _, c := range s {
		if c == ':' {
			return true
		}
	}
	return false
}

func nickFromPrefix(prefix string) string {
	if idx := strings.Index(prefix, "!"); idx != -1 {
		return prefix[:idx]
	}
	return prefix
}
