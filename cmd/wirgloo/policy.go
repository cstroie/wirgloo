// Wirgloo — a self-hosted web IRC client.
// https://github.com/cstroie/wirgloo
//
// Copyright (C) 2025 Costin Stroie <costinstroie@eridu.eu.org>
// SPDX-License-Identifier: GPL-3.0-or-later
//
// policy restricts which hosts the server may dial on behalf of a browser.
// Without it wirgloo is an open TCP proxy that can reach the server's own
// loopback and internal network (SSRF).
package main

import (
	"fmt"
	"net"
	"net/netip"
	"strings"
	"syscall"
)

// Dial policy, set from flags in main before serving.
var (
	AllowedHosts []string // if non-empty, only these hosts (or "*.suffix" patterns) may be dialed
	AllowPrivate bool     // permit loopback, private, link-local and other non-public addresses
	MaxSessions  = 100    // max concurrent sessions; 0 = unlimited
)

// parseAllowedHosts splits a comma-separated list into lower-case patterns.
func parseAllowedHosts(s string) []string {
	var out []string
	for _, h := range strings.Split(s, ",") {
		if h = strings.ToLower(strings.TrimSpace(h)); h != "" {
			out = append(out, h)
		}
	}
	return out
}

// hostAllowed reports whether host passes the allowlist. An empty allowlist
// permits everything; "*.example.org" matches any subdomain of example.org.
func hostAllowed(host string) bool {
	if len(AllowedHosts) == 0 {
		return true
	}
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	for _, p := range AllowedHosts {
		if p == host || (strings.HasPrefix(p, "*.") && strings.HasSuffix(host, p[1:])) {
			return true
		}
	}
	return false
}

// publicAddr reports whether ip is a globally routable unicast address.
func publicAddr(ip netip.Addr) bool {
	ip = ip.Unmap()
	return ip.IsValid() && ip.IsGlobalUnicast() && !ip.IsPrivate() &&
		!ip.IsLoopback() && !ip.IsLinkLocalUnicast() && !ip.IsMulticast() &&
		!ip.IsUnspecified() && !netip.MustParsePrefix("100.64.0.0/10").Contains(ip)
}

// dialControl runs after DNS resolution, immediately before connect(2), so a
// hostname that resolves to (or rebinds to) an internal address is still
// rejected.
func dialControl(network, address string, _ syscall.RawConn) error {
	if AllowPrivate {
		return nil
	}
	ap, err := netip.ParseAddrPort(address)
	if err != nil {
		return fmt.Errorf("blocked: bad address %q", address)
	}
	if !publicAddr(ap.Addr()) {
		return fmt.Errorf("blocked: %s is not a public address", ap.Addr())
	}
	return nil
}

// newDialer returns a net.Dialer that enforces the address policy.
func newDialer() *net.Dialer {
	return &net.Dialer{Timeout: dialTimeout, Control: dialControl}
}
