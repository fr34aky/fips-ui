#!/usr/bin/env bash
# One-shot local setup, run with sudo from the repo checkout:
#   sudo ./deploy/setup-local.sh [ui-user] [node-binary]
# 1. installs the privileged upgrade helper + its single sudoers rule for <ui-user>
# 2. installs a systemd unit that runs the UI from this checkout as <ui-user>
# 3. enables and starts it, then checks /api/health
set -euo pipefail
[[ $(id -u) -eq 0 ]] || { echo "run with sudo" >&2; exit 1; }
here=$(cd "$(dirname "$0")/.." && pwd)
user=${1:-${SUDO_USER:-}}
[[ -n "$user" ]] && id "$user" >/dev/null 2>&1 || { echo "usage: $0 <ui-user> [node-binary]" >&2; exit 1; }
home=$(getent passwd "$user" | cut -d: -f6)
node=${2:-}
if [[ -z "$node" ]]; then
  for c in /usr/bin/node /usr/local/bin/node "$home/.local/share/mise/shims/node"; do [[ -x "$c" ]] && { node=$c; break; }; done
fi
[[ -n "$node" && -x "$node" ]] || { echo "node binary not found; pass it as the second argument" >&2; exit 1; }
port=${FIPS_UI_PORT:-8321}

echo "== helper"
"$here/deploy/install-upgrade-helper.sh" "$user"

echo "== unit"
id -nG "$user" | tr ' ' '\n' | grep -qx fips || { echo "adding $user to the fips group"; usermod -aG fips "$user"; }
[[ -d "$here/web/dist" ]] || { echo "web/dist missing: run 'npm run build' first" >&2; exit 1; }
cat > /etc/systemd/system/fips-ui.service <<UNIT
[Unit]
Description=FIPS mesh node web UI
After=network.target fips.service
Wants=fips.service

[Service]
Type=simple
User=$user
Group=fips
WorkingDirectory=$here
Environment=HOME=$home
Environment=NODE_ENV=production
Environment=FIPS_UI_HOST=127.0.0.1
Environment=FIPS_UI_PORT=$port
EnvironmentFile=-/etc/default/fips-ui
ExecStart=$node server/index.ts
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
[[ -f /etc/default/fips-ui ]] || cat > /etc/default/fips-ui <<'ENV'
# Extra environment for fips-ui.service (see README). Examples:
#FIPS_UI_TOKEN=change-me
#FIPS_UI_READ_ONLY=1
#FIPS_UI_ALLOW_SERVICE_CONTROL=1
#FIPS_UI_GITHUB_TOKEN=
ENV
systemctl daemon-reload
systemctl enable --now fips-ui.service
systemctl restart fips-ui.service

echo "== verify"
for i in $(seq 1 20); do curl -fsS "http://127.0.0.1:$port/api/health" >/dev/null 2>&1 && break; sleep 0.5; done
curl -fsS "http://127.0.0.1:$port/api/health"; echo
systemctl --no-pager --lines=0 status fips-ui.service | head -5
echo "helper check as $user:"; sudo -n -u "$user" sudo -n /usr/local/libexec/fips-ui-helper check
echo; echo "done: http://127.0.0.1:$port"
