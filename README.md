# igloo

A web IRC client written in Go.

The server proxies IRC over a WebSocket so you can connect from any browser. A single binary serves both the static UI and the WebSocket endpoint.

## Features

- TLS and plain IRC connections
- Channels, private messages, `/me`, nick changes
- WebSocket reconnection with exponential backoff — the IRC session stays alive across brief network interruptions
- Graceful handling of server restarts

## Build & install

```sh
make          # build ./igloo
make install  # install to /usr/local/bin (override with PREFIX=...)
```

Requires Go 1.21+.

## Usage

```sh
igloo                    # listens on 0.0.0.0:6677
igloo -addr :8080        # custom address
igloo -dev               # serve static files from disk (no embed, for development)
```

Then open `http://localhost:6677` in your browser, fill in your IRC server and nick, and connect.

## Project layout

```
main.go          entry point, HTTP server
ws/              WebSocket handler and message dispatch
session/         session registry, IRC↔WS bridge
irc/             IRC dial, handshake, line reader, parser
static/          browser UI (HTML, CSS, JS — no build step)
```
