package main

import (
	"net/http"
	"net/netip"
	"testing"
)

func TestHostAllowed(t *testing.T) {
	old := AllowedHosts
	defer func() { AllowedHosts = old }()
	AllowedHosts = nil
	if !hostAllowed("anything.example") {
		t.Error("empty allowlist should permit all")
	}
	AllowedHosts = parseAllowedHosts("irc.libera.chat, *.undernet.org")
	for host, want := range map[string]bool{
		"irc.libera.chat":      true,
		"IRC.Libera.Chat.":     true,
		"chicago.undernet.org": true,
		"undernet.org":         false,
		"evil.example":         false,
		"xundernet.org":        false,
	} {
		if got := hostAllowed(host); got != want {
			t.Errorf("hostAllowed(%q) = %v, want %v", host, got, want)
		}
	}
}

func TestPublicAddr(t *testing.T) {
	for addr, want := range map[string]bool{
		"8.8.8.8":          true,
		"2606:4700::1111":  true,
		"127.0.0.1":        false,
		"::1":              false,
		"10.1.2.3":         false,
		"192.168.0.1":      false,
		"172.16.5.5":       false,
		"169.254.169.254":  false,
		"100.64.0.1":       false,
		"0.0.0.0":          false,
		"fe80::1":          false,
		"fd00::1":          false,
		"::ffff:127.0.0.1": false,
	} {
		if got := publicAddr(netip.MustParseAddr(addr)); got != want {
			t.Errorf("publicAddr(%s) = %v, want %v", addr, got, want)
		}
	}
}

func TestDialControl(t *testing.T) {
	old := AllowPrivate
	defer func() { AllowPrivate = old }()
	AllowPrivate = false
	if err := dialControl("tcp", "127.0.0.1:6667", nil); err == nil {
		t.Error("loopback should be blocked")
	}
	if err := dialControl("tcp", "8.8.8.8:6667", nil); err != nil {
		t.Errorf("public address blocked: %v", err)
	}
	AllowPrivate = true
	if err := dialControl("tcp", "127.0.0.1:6667", nil); err != nil {
		t.Errorf("loopback should pass with AllowPrivate: %v", err)
	}
}

func TestIRCDialRejects(t *testing.T) {
	if _, err := ircDial("", 6667, false, false); err == nil {
		t.Error("empty server accepted")
	}
	if _, err := ircDial("127.0.0.1", 99999, false, false); err == nil {
		t.Error("bad port accepted")
	}
	if _, err := ircDial("127.0.0.1", 6667, false, false); err == nil {
		t.Error("loopback dial accepted")
	}
}

func TestCheckOrigin(t *testing.T) {
	for _, c := range []struct {
		origin string
		want   bool
	}{
		{"", true},
		{"https://chat.example", true},
		{"http://chat.example", true},
		{"https://evil.example", false},
	} {
		r := &http.Request{Host: "chat.example", Header: http.Header{}}
		if c.origin != "" {
			r.Header.Set("Origin", c.origin)
		}
		if got := upgrader.CheckOrigin(r); got != c.want {
			t.Errorf("origin %q = %v, want %v", c.origin, got, c.want)
		}
	}
}

func TestSanitize(t *testing.T) {
	if got := sanitize("a\r\nQUIT\n"); got != "aQUIT" {
		t.Errorf("sanitize = %q", got)
	}
}

func TestParseLine(t *testing.T) {
	m := ircParseLine("@time=2026-01-01T00:00:00Z :nick!u@h PRIVMSG #chan :hello world")
	if m.Command != "PRIVMSG" || m.Nick != "nick" || m.Tags["time"] == "" {
		t.Fatalf("bad parse: %+v", m)
	}
	if len(m.Params) != 2 || m.Params[0] != "#chan" || m.Params[1] != "hello world" {
		t.Errorf("params = %v", m.Params)
	}
	if m := ircParseLine("PING :srv"); m.Command != "PING" || len(m.Params) != 1 || m.Params[0] != "srv" {
		t.Errorf("PING parse: %+v", m)
	}
}
