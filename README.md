# igloo

A web IRC client written in Go.

The server proxies IRC over a WebSocket so you can connect from any browser. A single binary serves both the static UI and the WebSocket endpoint.

## Features

- TLS and plain IRC connections
- Channels, private messages, `/me`, nick changes
- WebSocket reconnection with exponential backoff — the IRC session stays alive across brief network interruptions
- Graceful handling of server restarts

## Build & install

Requires Go 1.21+.

```sh
make                   # build ./igloo
make install           # install binary to /usr/local/bin
make install-service   # install binary + systemd unit, reload systemd
```

`PREFIX` and `SYSTEMD_DIR` can be overridden:

```sh
make install-service PREFIX=/opt/igloo SYSTEMD_DIR=/etc/systemd/system
```

After `install-service`, enable and start the service:

```sh
systemctl enable --now igloo
```

To remove:

```sh
make uninstall         # stop service, remove unit and binary
```

## Usage

```sh
igloo                          # listens on 0.0.0.0:6677
igloo -addr :8080              # custom address
igloo -dev                     # serve static files from disk (no embed, for development)
igloo -log-level debug         # log level: debug, info, warn, error (default: info)
igloo -log-json                # emit logs as JSON instead of text
```

Then open `http://localhost:6677` in your browser, fill in your IRC server and nick, and connect.

## License

GPL-3.0 — see [LICENSE](LICENSE).

## Project layout

```
main.go          entry point, HTTP server
ws/              WebSocket handler and message dispatch
session/         session registry, IRC↔WS bridge
irc/             IRC dial, handshake, line reader, parser
static/          browser UI (HTML, CSS, JS — no build step)
```
