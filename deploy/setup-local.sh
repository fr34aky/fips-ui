#!/usr/bin/env bash
# One-shot local setup, run with sudo from the repo checkout:
#   sudo ./deploy/setup-local.sh [--install-fips|--no-install-fips] [--fips-test-peer] [--fips-peer <peer>]... [ui-user] [node-binary]
# 1. checks preconditions (built frontend, Node 22.18+/23.6+/24+)
# 2. installs the privileged helper + its single sudoers rule for <ui-user>; without the fips daemon it offers to
#    install the newest fips release (deploy/install-fips.sh): asks on a terminal, --install-fips installs without
#    asking, --no-install-fips skips it (the Upgrade page can install it later). The new node keeps its identity and
#    gets bootstrap peers: asked on a terminal, or --fips-test-peer / --fips-peer npub1...@udp/host:port
# 3. installs a service that runs fips-ui from this checkout as <ui-user>, restarted when it exits (so the
#    Upgrade page can update fips-ui itself):
#      Linux with systemd  deploy/fips-ui.service + a drop-in           settings: /etc/default/fips-ui
#      FreeBSD             /usr/local/etc/rc.d/fips_ui (daemon(8))       settings: /usr/local/etc/fips-ui.env
#      pfSense             /usr/local/etc/rc.d/fips-ui.sh (daemon(8))    settings: /usr/local/etc/fips-ui.env
#      macOS               /Library/LaunchDaemons/network.fips-ui.plist  settings: in that plist
# 4. (re)starts it, then checks /api/health
set -euo pipefail
[[ $(id -u) -eq 0 ]] || { echo "run with sudo" >&2; exit 1; }
here=$(cd "$(dirname "$0")/.." && pwd)
fail() { echo "error: $*" >&2; exit 1; }
install_fips=ask
fips_args=()   # passed to install-fips.sh: --test-peer, --peer <npub@udp/host:port>
peer_asked=false
args=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --install-fips) install_fips=yes ;;
    --no-install-fips) install_fips=no ;;
    --fips-test-peer) fips_args+=(--test-peer); peer_asked=true ;;
    --fips-peer) [[ $# -ge 2 ]] || fail "--fips-peer needs npub1...@udp/host:port"; fips_args+=(--peer "$2"); peer_asked=true; shift ;;
    -*) fail "unknown option $1 (usage: $0 [--install-fips|--no-install-fips] [--fips-test-peer] [--fips-peer npub@udp/host:port]... [ui-user] [node-binary])" ;;
    *) args+=("$1") ;;
  esac
  shift
done
set -- ${args[@]+"${args[@]}"}
user=${1:-${SUDO_USER:-}}
[[ -n "$user" ]] && id "$user" >/dev/null 2>&1 || { echo "usage: $0 [--install-fips|--no-install-fips] <ui-user> [node-binary]" >&2; exit 1; }

# ---- which system ----
os=$(uname -s)
if [[ "$os" == Linux ]] && command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then kind=systemd
elif [[ "$os" == FreeBSD ]] && grep -qi pfsense /etc/platform 2>/dev/null; then kind=pfsense
elif [[ "$os" == FreeBSD ]]; then kind=freebsd
elif [[ "$os" == Darwin ]]; then kind=macos
else fail "no service setup for this system ($os without systemd); see docs/install.md to run fips-ui by hand"; fi

# Portable lookups (no getent on macOS, no readlink -f on older BSDs).
home_of() { if command -v getent >/dev/null 2>&1; then getent passwd "$1" | cut -d: -f6; else eval echo "~$1"; fi; }
group_exists() { if command -v getent >/dev/null 2>&1; then getent group "$1" >/dev/null; elif [[ "$os" == Darwin ]]; then dscl . -read "/Groups/$1" >/dev/null 2>&1; else pw groupshow "$1" >/dev/null 2>&1; fi; }
realpath_of() { realpath "$1" 2>/dev/null || readlink -f "$1" 2>/dev/null || python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$1"; }
add_to_group() { # <user> <group>
  id -nG "$1" | tr ' ' '\n' | grep -qx "$2" && return 0
  echo "adding $1 to the $2 group"
  case "$os" in
    Linux)   usermod -aG "$2" "$1" ;;
    FreeBSD) pw groupmod "$2" -m "$1" ;;
    Darwin)  dseditgroup -o edit -a "$1" -t user "$2" ;;
  esac
}
home=$(home_of "$user")

# ---- preconditions (nothing is changed until these pass) ----
for p in "$here" "$home"; do [[ "$p" =~ [[:space:]%] ]] && fail "path '$p' contains whitespace or '%', which this script does not escape"; done
[[ -d "$here/web/dist" ]] || fail "$here/web/dist missing: run 'npm run build' first"
node=${2:-}
if [[ -z "$node" ]]; then
  # Resolve node the way the user's login shell would (covers mise/nvm/volta), then pin the real binary
  # so the service does not depend on shims or PATH.
  # A login shell may print greetings first (FreeBSD's fortune tips): only the last line counts.
  node=$(sudo -u "$user" -H bash -lc 'command -v node' 2>/dev/null | tail -n 1 || true)
  [[ "$node" == /* && -x "$node" ]] || node=""
  [[ -n "$node" ]] || for c in /usr/bin/node /usr/local/bin/node /opt/homebrew/bin/node; do [[ -x "$c" ]] && { node=$c; break; }; done
fi
[[ -n "$node" && -x "$node" ]] || fail "node not found; pass the binary as the second argument"
if [[ "$node" == */mise/shims/* ]]; then node=$(sudo -u "$user" -H bash -lc 'mise which node' 2>/dev/null | tail -n 1 || realpath_of "$node"); fi
node=$(realpath_of "$node")
ver=$("$node" -v 2>/dev/null | sed 's/^v//') || fail "$node -v failed"
IFS=. read -r maj min _ <<<"$ver"
# Node strips TypeScript without a flag from 22.18 and 23.6 (and every 24+); earlier 22.x/23.x need --experimental-strip-types.
(( maj >= 24 || (maj == 23 && min >= 6) || (maj == 22 && min >= 18) )) || fail "node $ver at $node is too old; 22.18+, 23.6+ or 24+ is required (unflagged TypeScript type stripping)"
[[ "$node" =~ [[:space:]%] ]] && fail "node path '$node' contains whitespace or '%'"
# node's own directory first on PATH: npm (self-update) lives next to it when node comes from nvm, mise or a tarball.
svc_path="$(dirname "$node"):/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
echo "== $kind: node $ver at $node, UI user $user, checkout $here"

# ---- helper + sudoers rule (prints its own self-test) ----
echo "== helper"
"$here/deploy/install-upgrade-helper.sh" "$user"

# ---- the fips daemon (installed now if missing and wanted; else later from the Upgrade page) ----
if ! "$here/deploy/install-fips.sh" --check >/dev/null; then
  if [[ "$install_fips" == ask ]]; then
    if [[ -t 0 ]]; then
      read -r -p "The fips daemon is not installed. Install the newest fips release now? [y/N] " answer
      [[ "$answer" =~ ^[Yy] ]] && install_fips=yes || install_fips=no
    else install_fips=no; fi
  fi
  if [[ "$install_fips" == yes ]]; then
    # The release's fips.yaml has no peers: without any the node stays alone until someone dials it.
    if ! $peer_asked && [[ -t 0 ]]; then
      read -r -p "Connect to the public FIPS test node test-us01.fips.network? [Y/n] " answer
      [[ "$answer" =~ ^[Nn] ]] || fips_args+=(--test-peer)
      while read -r -p "Another peer as npub1...@udp/host:port (empty to finish): " answer && [[ -n "$answer" ]]; do fips_args+=(--peer "$answer"); done
    fi
    echo "== fips daemon"
    "$here/deploy/install-fips.sh" ${fips_args[@]+"${fips_args[@]}"}
  else
    echo "note: the fips daemon is not installed; install it later from fips-ui's Upgrade page (or run again with --install-fips)"
  fi
fi
# The daemon's control socket belongs to group fips on Linux and FreeBSD; on macOS the package may not create it.
fips_group=true; group_exists fips || fips_group=false

# ---- service ----
echo "== service"
if $fips_group; then add_to_group "$user" fips; fi
env_example='# Extra environment for fips-ui (see README). Keep this file mode 0600: it may hold tokens.
#FIPS_UI_TOKEN=change-me
#FIPS_UI_READ_ONLY=1
#FIPS_UI_GITHUB_TOKEN='
host=127.0.0.1; port=8321
load_env() { # <file>: pick up FIPS_UI_HOST/PORT for the health check; read, not sourced (a bad line must not abort)
  local v
  v=$(sed -n 's/^[[:space:]]*\(export[[:space:]]\{1,\}\)\{0,1\}FIPS_UI_HOST=["'\'']\{0,1\}\([^"'\'' ]*\).*/\2/p' "$1" | tail -n 1); host=${v:-$host}
  v=$(sed -n 's/^[[:space:]]*\(export[[:space:]]\{1,\}\)\{0,1\}FIPS_UI_PORT=["'\'']\{0,1\}\([0-9]*\).*/\2/p' "$1" | tail -n 1); port=${v:-$port}
}

case "$kind" in
systemd)
  if getent group systemd-journal >/dev/null; then add_to_group "$user" systemd-journal; fi
  install -m 0644 -o 0 -g 0 "$here/deploy/fips-ui.service" /etc/systemd/system/fips-ui.service
  mkdir -p /etc/systemd/system/fips-ui.service.d
  extra_groups=""; getent group systemd-journal >/dev/null && extra_groups="systemd-journal"
  # The base unit runs as group fips; without fips yet the user's own group (the user's group list, which gains
  # fips once the Upgrade page installs it, applies either way).
  group_line=""; $fips_group || group_line="Group="
  cat > /etc/systemd/system/fips-ui.service.d/local.conf <<UNIT
# Generated by deploy/setup-local.sh; the base unit is deploy/fips-ui.service.
[Service]
User=$user
$group_line
SupplementaryGroups=$extra_groups
WorkingDirectory=$here
Environment=HOME=$home
Environment=PATH=$svc_path
ExecStart=
ExecStart=$node server/index.ts
UNIT
  [[ -f /etc/default/fips-ui ]] || { install -m 0600 -o 0 -g 0 /dev/null /etc/default/fips-ui; printf '%s\n' "$env_example" > /etc/default/fips-ui; }
  chmod 0600 /etc/default/fips-ui
  load_env /etc/default/fips-ui
  systemctl daemon-reload
  systemctl enable fips-ui.service >/dev/null
  systemctl restart fips-ui.service
  ;;

freebsd|pfsense)
  envfile=/usr/local/etc/fips-ui.env
  [[ -f "$envfile" ]] || { install -m 0600 -o 0 -g 0 /dev/null "$envfile"; printf '%s\n' "$env_example" > "$envfile"; }
  chmod 0600 "$envfile"
  load_env "$envfile"
  touch /var/log/fips-ui.log; chown "$user" /var/log/fips-ui.log; chmod 0640 /var/log/fips-ui.log
  # daemon(8) runs node as the UI user, restarts it after it exits (-r: how a self-update restarts) and writes
  # its output to the log. FIPS_UI_SUPERVISED tells fips-ui that exiting restarts it.
  run_env="HOME=$home PATH=$svc_path NODE_ENV=production FIPS_UI_SUPERVISED=1"
  if [[ "$kind" == freebsd ]]; then
    cat > /usr/local/etc/rc.d/fips_ui <<RC
#!/bin/sh
# Generated by fips-ui's deploy/setup-local.sh.
# PROVIDE: fips_ui
# REQUIRE: LOGIN
# KEYWORD: shutdown
. /etc/rc.subr
name=fips_ui
rcvar=fips_ui_enable
load_rc_config \$name
: \${fips_ui_enable:="NO"}
pidfile=/var/run/fips_ui.pid
fips_ui_chdir="$here"
fips_ui_env="$run_env"
fips_ui_env_file="$envfile"
command=/usr/sbin/daemon
# daemon(8) keeps the caller's stdout open; detach it so "service fips_ui restart" over ssh returns.
command_args="-r -R 3 -P \${pidfile} -u $user -o /var/log/fips-ui.log -t fips-ui $node $here/server/index.ts </dev/null >/dev/null 2>&1"
run_rc_command "\$1"
RC
    chmod 0555 /usr/local/etc/rc.d/fips_ui
    sysrc -q fips_ui_enable=YES >/dev/null
    service fips_ui restart </dev/null >/dev/null 2>&1 || service fips_ui start </dev/null >/dev/null 2>&1
  else
    # pfSense runs every /usr/local/etc/rc.d/*.sh with "start" at boot (and again on a WAN change): starting
    # must be a no-op while it runs.
    cat > /usr/local/etc/rc.d/fips-ui.sh <<RC
#!/bin/sh
# Generated by fips-ui's deploy/setup-local.sh (pfSense boot script).
pidfile=/var/run/fips_ui.pid
running() { [ -f \$pidfile ] && kill -0 "\$(cat \$pidfile)" 2>/dev/null; }
start() {
  running && return 0
  ( set -a; [ -f $envfile ] && . $envfile; set +a
    export $run_env
    cd $here && /usr/sbin/daemon -r -R 3 -P \$pidfile -u $user -o /var/log/fips-ui.log -t fips-ui $node $here/server/index.ts ) </dev/null >/dev/null 2>&1
}
stop() {
  running || return 0
  kill "\$(cat \$pidfile)"
  i=0; while running && [ \$i -lt 30 ]; do sleep 1; i=\$((i + 1)); done
}
case "\$1" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  status) if running; then echo "fips-ui is running as pid \$(cat \$pidfile)."; else echo "fips-ui is not running."; exit 1; fi ;;
esac
RC
    chmod 0755 /usr/local/etc/rc.d/fips-ui.sh
    /usr/local/etc/rc.d/fips-ui.sh restart
  fi
  ;;

macos)
  plist=/Library/LaunchDaemons/network.fips-ui.plist
  mkdir -p /usr/local/var/log
  touch /usr/local/var/log/fips-ui.log; chown "$user" /usr/local/var/log/fips-ui.log
  # Settings go into EnvironmentVariables below; the plist is root-only (0600) because it may hold tokens.
  cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Generated by fips-ui's deploy/setup-local.sh. Add FIPS_UI_* settings under EnvironmentVariables. -->
<plist version="1.0">
<dict>
  <key>Label</key><string>network.fips-ui</string>
  <key>UserName</key><string>$user</string>
  <key>WorkingDirectory</key><string>$here</string>
  <key>ProgramArguments</key><array><string>$node</string><string>server/index.ts</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>HOME</key><string>$home</string>
    <key>PATH</key><string>$svc_path</string>
    <key>NODE_ENV</key><string>production</string>
    <key>FIPS_UI_SUPERVISED</key><string>1</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <!-- Restart after a non-zero exit (how a self-update restarts), not after a clean stop. -->
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>/usr/local/var/log/fips-ui.log</string>
  <key>StandardErrorPath</key><string>/usr/local/var/log/fips-ui.log</string>
</dict>
</plist>
PLIST
  chown root:wheel "$plist"; chmod 0600 "$plist"
  launchctl bootout system/network.fips-ui 2>/dev/null || true
  # bootout returns before the job is gone; bootstrap fails with "5: Input/output error" until then.
  for _ in $(seq 1 20); do launchctl print system/network.fips-ui >/dev/null 2>&1 || break; sleep 0.5; done
  launchctl bootstrap system "$plist"
  ;;
esac

# ---- verify ----
echo "== verify"
[[ "$host" == *:* ]] && host="[$host]"
ok=false
for _ in $(seq 1 40); do
  if out=$("$node" -e "fetch('http://$host:$port/api/health').then(r=>r.text()).then(t=>{console.log(t);process.exit(0)},()=>process.exit(1))" 2>/dev/null); then echo "$out"; ok=true; break; fi
  sleep 0.5
done
if ! $ok; then
  echo "fips-ui did not become healthy; recent log:" >&2
  case "$kind" in
    systemd) journalctl -u fips-ui.service -n 20 --no-pager >&2 || true ;;
    freebsd|pfsense) tail -n 20 /var/log/fips-ui.log >&2 || true ;;
    macos) tail -n 20 /usr/local/var/log/fips-ui.log >&2 || true ;;
  esac
  exit 1
fi
if [[ "$kind" == systemd ]]; then systemctl --no-pager --lines=0 status fips-ui.service | sed -n '1,4p'; fi
echo; echo "done: http://$host:$port"
