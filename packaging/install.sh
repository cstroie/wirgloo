#!/bin/sh
# Install wirgloo from an unpacked release tarball: binary, man page, service
# user and the init integration for this system (systemd or OpenRC).
# Usage: sudo ./install.sh [--uninstall]      (PREFIX defaults to /opt/wirgloo)
set -e

PREFIX=${PREFIX:-/opt/wirgloo}
MANDIR=${MANDIR:-$PREFIX/man/man1}
here=$(cd "$(dirname "$0")" && pwd)

[ "$(id -u)" = 0 ] || { echo "install.sh: run as root" >&2; exit 1; }

if [ -d /run/systemd/system ]; then
	init=systemd
elif command -v rc-service >/dev/null 2>&1; then
	init=openrc
else
	init=none
fi

if [ "$1" = "--uninstall" ]; then
	case $init in
	systemd)
		systemctl disable --now wirgloo 2>/dev/null || true
		rm -f /etc/systemd/system/wirgloo.service
		systemctl daemon-reload ;;
	openrc)
		rc-service wirgloo stop 2>/dev/null || true
		rc-update del wirgloo default 2>/dev/null || true
		rm -f /etc/init.d/wirgloo ;;
	esac
	rm -f "$PREFIX/wirgloo" "$MANDIR/wirgloo.1"
	echo "Removed. $PREFIX/log and the wirgloo user were left in place."
	exit 0
fi

# Service user (needed by OpenRC; harmless under systemd's DynamicUser).
if ! getent passwd wirgloo >/dev/null 2>&1; then
	if command -v useradd >/dev/null 2>&1; then
		useradd -r -M -d "$PREFIX" -s /usr/sbin/nologin wirgloo
	else
		addgroup -S wirgloo 2>/dev/null || true
		adduser -S -D -H -h "$PREFIX" -s /sbin/nologin -G wirgloo wirgloo
	fi
fi

install -Dm755 "$here/wirgloo" "$PREFIX/wirgloo"
install -Dm644 "$here/wirgloo.1" "$MANDIR/wirgloo.1"
install -d -o wirgloo -g wirgloo "$PREFIX/log"

case $init in
systemd)
	install -Dm644 "$here/wirgloo.service" /etc/systemd/system/wirgloo.service
	sed -i "s|^ExecStart=/opt/wirgloo/wirgloo|ExecStart=$PREFIX/wirgloo|" /etc/systemd/system/wirgloo.service
	systemctl daemon-reload
	echo "Installed. Start with: systemctl enable --now wirgloo" ;;
openrc)
	install -Dm755 "$here/wirgloo.openrc" /etc/init.d/wirgloo
	[ "$PREFIX" = /opt/wirgloo ] || echo "wirgloo_home=\"$PREFIX\"" >> /etc/conf.d/wirgloo
	echo "Installed. Start with: rc-update add wirgloo default && rc-service wirgloo start" ;;
*)
	echo "Installed the binary. No systemd or OpenRC found; run $PREFIX/wirgloo directly." ;;
esac
echo "Listens on 127.0.0.1:6677 — put a TLS reverse proxy in front (see README)."
echo "Man page: man -M $PREFIX/man wirgloo"
