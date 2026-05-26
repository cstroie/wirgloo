PREFIX      ?= /usr/local
BINARY      := wirgloo
SYSTEMD_DIR ?= /etc/systemd/system
VERSION     := $(shell date +%y%m%d)

PLATFORMS := linux/amd64 linux/arm64 darwin/amd64 darwin/arm64 windows/amd64

.PHONY: all build dist $(PLATFORMS) install install-service uninstall uninstall-service clean

all: build

build:
	go build -ldflags "-X main.version=$(VERSION)" -o $(BINARY) ./cmd/wirgloo

# Build for all platforms: make dist
dist: $(PLATFORMS)

linux/amd64:
	CGO_ENABLED=0 GOOS=linux   GOARCH=amd64 go build -ldflags "-X main.version=$(VERSION)" -o $(BINARY)-linux-amd64   ./cmd/wirgloo

linux/arm64:
	CGO_ENABLED=0 GOOS=linux   GOARCH=arm64 go build -ldflags "-X main.version=$(VERSION)" -o $(BINARY)-linux-arm64   ./cmd/wirgloo

darwin/amd64:
	GOOS=darwin  GOARCH=amd64 go build -ldflags "-X main.version=$(VERSION)" -o $(BINARY)-darwin-amd64  ./cmd/wirgloo

darwin/arm64:
	GOOS=darwin  GOARCH=arm64 go build -ldflags "-X main.version=$(VERSION)" -o $(BINARY)-darwin-arm64  ./cmd/wirgloo

windows/amd64:
	GOOS=windows GOARCH=amd64 go build -ldflags "-X main.version=$(VERSION)" -o $(BINARY)-windows-amd64.exe ./cmd/wirgloo

install: build
	install -Dm755 $(BINARY) $(PREFIX)/bin/$(BINARY)
	install -Dm644 $(BINARY).1 $(PREFIX)/share/man/man1/$(BINARY).1

install-service: install
	sed 's|/usr/local/bin/igloo|$(PREFIX)/bin/$(BINARY)|' $(BINARY).service \
		| install -Dm644 /dev/stdin $(SYSTEMD_DIR)/$(BINARY).service
	systemctl daemon-reload
	@echo "Run 'systemctl enable --now $(BINARY)' to start the service"

uninstall-service:
	systemctl disable --now $(BINARY) 2>/dev/null || true
	rm -f $(SYSTEMD_DIR)/$(BINARY).service
	systemctl daemon-reload

uninstall: uninstall-service
	rm -f $(PREFIX)/bin/$(BINARY)
	rm -f $(PREFIX)/share/man/man1/$(BINARY).1

clean:
	rm -f $(BINARY) $(BINARY)-linux-amd64 $(BINARY)-linux-arm64 $(BINARY)-darwin-amd64 $(BINARY)-darwin-arm64 $(BINARY)-windows-amd64.exe
