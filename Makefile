PREFIX      ?= /usr/local
BINARY      := wirgloo
SYSTEMD_DIR ?= /etc/systemd/system
VERSION     := $(shell date +%y%m%d)

.PHONY: all build install install-service uninstall uninstall-service clean

all: build

build:
	go build -ldflags "-X main.version=$(VERSION)" -o $(BINARY) ./cmd/wirgloo

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
	rm -f $(BINARY)
