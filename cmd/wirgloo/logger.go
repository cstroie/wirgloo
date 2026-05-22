// Wirgloo — a self-hosted web IRC client.
// https://github.com/cstroie/wirgloo
//
// Copyright (C) 2025 Costin Stroie <costinstroie@eridu.eu.org>
// SPDX-License-Identifier: GPL-3.0-or-later
//
// logger provides a shared slog.Logger used throughout the package.
// Call initLogger once at startup to configure the output format and minimum
// log level. Before initLogger is called L falls back to slog.Default().
package main

import (
	"log/slog"
	"os"
)

// L is the shared logger. All files in this package use it directly.
var L *slog.Logger = slog.Default()

// initLogger configures the shared logger. jsonFmt selects JSON output
// (suitable for log aggregation pipelines); otherwise a human-readable text
// format is used. The logger is also set as the slog default so stdlib
// log/slog calls use the same handler.
func initLogger(level slog.Level, jsonFmt bool) {
	opts := &slog.HandlerOptions{Level: level}
	var h slog.Handler
	if jsonFmt {
		h = slog.NewJSONHandler(os.Stderr, opts)
	} else {
		h = slog.NewTextHandler(os.Stderr, opts)
	}
	L = slog.New(h)
	slog.SetDefault(L)
}
