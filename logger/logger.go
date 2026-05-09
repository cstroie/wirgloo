// Package logger provides a package-level slog.Logger instance shared across
// all packages. Call Init once at startup to configure the output format and
// minimum log level; the default before Init is called is slog.Default().
package logger

import (
	"log/slog"
	"os"
)

// L is the shared logger. All packages import and use this directly.
var L *slog.Logger = slog.Default()

// Init configures the shared logger. jsonFmt selects JSON output (suitable
// for log aggregation pipelines); otherwise a human-readable text format is
// used. The logger is also set as the slog default so stdlib log/slog calls
// use the same handler.
func Init(level slog.Level, jsonFmt bool) {
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
