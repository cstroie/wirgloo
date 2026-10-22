#!/bin/sh
# Package post-remove: reload systemd; keep the user and logs.
[ -d /run/systemd/system ] && systemctl daemon-reload || true
exit 0
