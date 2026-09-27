#!/usr/bin/env bash
# Installs the privileged upgrade helper and a sudoers rule that lets one user
# (the account the FIPS UI backend runs as) invoke it without a password.
# Linux, macOS and FreeBSD.
#
#   sudo ./deploy/install-upgrade-helper.sh [ui-user]
#
# Defaults to the user who invoked sudo. This is deliberately a shell step:
# the web UI never asks for a sudo password and cannot grant itself privileges.
set -euo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
user=${1:-${SUDO_USER:-}}
[[ $(id -u) -eq 0 ]] || { echo "run with sudo" >&2; exit 1; }
[[ -n "$user" ]] && id "$user" >/dev/null 2>&1 || { echo "usage: $0 <ui-user>" >&2; exit 1; }
[[ "$user" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "invalid user name" >&2; exit 1; }

# sudo from FreeBSD's (and pfSense's) pkg reads /usr/local/etc/sudoers.d; Linux and macOS use /etc/sudoers.d.
case "$(uname -s)" in
  Darwin)  backups=/usr/local/var/fips-ui/backups; sudoers_d=/etc/sudoers.d ;;
  FreeBSD) backups=/var/db/fips-ui/backups; sudoers_d=/usr/local/etc/sudoers.d ;;
  *)       backups=/var/lib/fips-ui/backups; sudoers_d=/etc/sudoers.d ;;
esac

# BSD install(1) has no -D; create directories explicitly. gid 0 is root/wheel everywhere.
mkdir -p /usr/local/libexec "$backups" "$sudoers_d"
install -m 0755 -o 0 -g 0 "$here/scripts/fips-ui-helper" /usr/local/libexec/fips-ui-helper
chmod 0755 "$backups"

tmp=$(mktemp)
sed "s/@UI_USER@/$user/g" "$here/deploy/sudoers.d/fips-ui" > "$tmp"
visudo -cf "$tmp" >/dev/null
install -m 0440 -o 0 -g 0 "$tmp" "$sudoers_d/fips-ui"
rm -f "$tmp"

# sudoers.d must be included by the main sudoers file (default on all three OSes).
if ! grep -qE "^[#@]includedir[[:space:]]+$sudoers_d" /etc/sudoers /private/etc/sudoers /usr/local/etc/sudoers 2>/dev/null; then
  echo "warning: sudoers does not include $sudoers_d — add '@includedir $sudoers_d' with visudo" >&2
fi

echo "helper installed: /usr/local/libexec/fips-ui-helper"
echo "sudoers rule:     $sudoers_d/fips-ui  (user: $user)"
echo "self-test:"
sudo -n -u "$user" sudo -n /usr/local/libexec/fips-ui-helper check
