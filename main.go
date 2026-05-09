// igloo is a web IRC client. It serves a single-page browser UI and proxies
// IRC connections over WebSocket, so users can connect to any IRC network
// from a plain browser without installing anything.
package main

import (
	"embed"
	"flag"
	"io/fs"
	"log/slog"
	"net/http"
	"os"

	"igloo/logger"
	"igloo/session"
	"igloo/ws"
)

//go:embed static/*
var staticFiles embed.FS

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

	reg := session.NewRegistry()

	http.HandleFunc("/ws", ws.Handler(reg))

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

	logger.L.Info("igloo starting", "addr", *addr)
	if err := http.ListenAndServe(*addr, nil); err != nil {
		logger.L.Error("server error", "err", err)
		os.Exit(1)
	}
}
