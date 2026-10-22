#!/bin/sh
# Package post-install: create the service user and log directory.
set -e
if ! getent passwd wirgloo >/dev/null 2>&1; then
	if command -v useradd >/dev/null 2>&1; then
		useradd -r -M -d /opt/wirgloo -s /usr/sbin/nologin wirgloo
	else
		addgroup -S wirgloo 2>/dev/null || true
		adduser -S -D -H -h /opt/wirgloo -s /sbin/nologin -G wirgloo wirgloo
	fi
fi
install -d -o wirgloo -g wirgloo /opt/wirgloo/log
if [ -d /run/systemd/system ]; then
	systemctl daemon-reload || true
	echo "wirgloo installed. Start with: systemctl enable --now wirgloo"
elif command -v rc-service >/dev/null 2>&1; then
	echo "wirgloo installed. Start with: rc-update add wirgloo default && rc-service wirgloo start"
fi
