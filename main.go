package main

import (
	"embed"
	"flag"
	"io/fs"
	"log"
	"net/http"

	"igloo/session"
	"igloo/ws"
)

//go:embed static/*
var staticFiles embed.FS

func main() {
	addr := flag.String("addr", "0.0.0.0:6677", "listen address")
	dev  := flag.Bool("dev", false, "serve static files from disk (dev mode)")
	flag.Parse()

	reg := session.NewRegistry()

	http.HandleFunc("/ws", ws.Handler(reg))

	if *dev {
		http.Handle("/", http.FileServer(http.Dir("static")))
	} else {
		sub, err := fs.Sub(staticFiles, "static")
		if err != nil {
			log.Fatal(err)
		}
		http.Handle("/", http.FileServer(http.FS(sub)))
	}

	log.Printf("igloo listening on %s", *addr)
	log.Fatal(http.ListenAndServe(*addr, nil))
}
