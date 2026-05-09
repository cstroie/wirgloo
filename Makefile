PREFIX      ?= /usr/local
BINARY      := igloo
SYSTEMD_DIR ?= /etc/systemd/system

.PHONY: all build install install-service uninstall uninstall-service clean

all: build

build:
	go build -o $(BINARY) .

install: build
	install -Dm755 $(BINARY) $(PREFIX)/bin/$(BINARY)

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

clean:
	rm -f $(BINARY)
