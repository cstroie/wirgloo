package logger

import (
	"log/slog"
	"os"
)

var L *slog.Logger = slog.Default()

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
