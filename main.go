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
	"embed"
	"flag"
	"fmt"
	"io/fs"
	"log/slog"
	"net/http"
	"os"

	"wirgloo/logger"
	"wirgloo/session"
	"wirgloo/ws"
)

//go:embed static/*
var staticFiles embed.FS // embedded copy of the static/ directory, baked in at build time

// version is injected at build time via -ldflags "-X main.version=YYMMDD".
// Falls back to "dev" when built without the Makefile.
var version = "dev"

func main() {
	addr     := flag.String("addr", "0.0.0.0:6677", "listen address")
	dev      := flag.Bool("dev", false, "serve static files from disk (dev mode)")
	logJSON  := flag.Bool("log-json", false, "emit logs as JSON")
	logLevel := flag.String("log-level", "info", "log level: debug, info, warn, error")
	flag.Parse()

	var level slog.Level
	if err := level.UnmarshalText([]byte(*logLevel)); err != nil {
		slog.Error("invalid log level", "value", *logLevel)
		os.Exit(1)
	}
	logger.Init(level, *logJSON)

	session.AppVersion = version

	reg := session.NewRegistry()

	http.HandleFunc("/ws", ws.Handler(reg))
	http.HandleFunc("/version", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"name":"wirgloo","version":%q}`, version)
	})

	if *dev {
		// Serve directly from disk so edits are visible without restarting.
		logger.L.Info("serving static files from disk")
		http.Handle("/", http.FileServer(http.Dir("static")))
	} else {
		sub, err := fs.Sub(staticFiles, "static")
		if err != nil {
			logger.L.Error("embed fs error", "err", err)
			os.Exit(1)
		}
		http.Handle("/", http.FileServer(http.FS(sub)))
	}

	logger.L.Info("wirgloo starting", "version", version, "addr", *addr)
	if err := http.ListenAndServe(*addr, nil); err != nil {
		logger.L.Error("server error", "err", err)
		os.Exit(1)
	}
}
