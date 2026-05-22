// Wirgloo — a self-hosted web IRC client.
// https://github.com/cstroie/wirgloo
//
// Copyright (C) 2025 Costin Stroie <costinstroie@eridu.eu.org>
// SPDX-License-Identifier: GPL-3.0-or-later
//
// main is the entry point. It starts an HTTP server that serves the embedded
// single-page UI and proxies IRC connections over WebSocket, so users can
// connect to any IRC network from a plain browser without installing anything.
package main

import (
	"flag"
	"fmt"
	"io/fs"
	"log/slog"
	"net/http"
	"os"

	"strings"

	wirgloo "github.com/cstroie/wirgloo"
)

// version is injected at build time via -ldflags "-X main.version=YYMMDD".
// Falls back to "dev" when built without the Makefile.
var version = "dev"

func main() {
	addr := flag.String("addr", "0.0.0.0:6677", "listen address")
	base := flag.String("base", "", "base path prefix for all routes, e.g. /wirgloo")
	dev := flag.Bool("dev", false, "serve static files from disk (dev mode)")
	logJSON := flag.Bool("log-json", false, "emit logs as JSON")
	logLevel := flag.String("log-level", "info", "log level: debug, info, warn, error")
	sessionTimeout := flag.Duration("session-timeout", WsReconnectWindow, "how long an IRC session survives a browser disconnect")
	bufferMax := flag.Int("buffer-max", BufferMax, "max messages buffered per session while browser is disconnected")
	listPreview := flag.Int("list-preview", ListPreviewSize, "max channels shown in /list before filtering")
	flag.Parse()

	// Normalise base: ensure it starts with "/" and has no trailing "/".
	if *base != "" {
		if (*base)[0] != '/' {
			*base = "/" + *base
		}
		*base = strings.TrimRight(*base, "/")
	}

	WsReconnectWindow = *sessionTimeout
	BufferMax = *bufferMax
	ListPreviewSize = *listPreview

	var level slog.Level
	if err := level.UnmarshalText([]byte(*logLevel)); err != nil {
		slog.Error("invalid log level", "value", *logLevel)
		os.Exit(1)
	}
	initLogger(level, *logJSON)

	AppVersion = version

	reg := NewRegistry()

	http.HandleFunc(*base+"/ws", wsHandler(reg))
	http.HandleFunc(*base+"/version", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"name":"wirgloo","version":%q}`, version)
	})

	staticPrefix := *base + "/"
	if *dev {
		// Serve directly from disk so edits are visible without restarting.
		L.Info("serving static files from disk")
		http.Handle(staticPrefix, http.StripPrefix(*base, withCacheHeaders(http.FileServer(http.Dir("static")))))
	} else {
		sub, err := fs.Sub(wirgloo.StaticFiles, "static")
		if err != nil {
			L.Error("embed fs error", "err", err)
			os.Exit(1)
		}
		http.Handle(staticPrefix, http.StripPrefix(*base, withCacheHeaders(http.FileServer(http.FS(sub)))))
	}

	L.Info("wirgloo starting", "version", version, "addr", *addr)
	if err := http.ListenAndServe(*addr, nil); err != nil {
		L.Error("server error", "err", err)
		os.Exit(1)
	}
}
