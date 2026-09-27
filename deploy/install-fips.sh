#!/usr/bin/env bash
# Install the fips daemon from its newest GitHub release (or --tag vX.Y.Z), checksum-verified, and start it.
# Called by setup-local.sh when fips is missing; also usable on its own:
#   sudo ./deploy/install-fips.sh [--tag vX.Y.Z]
# Linux with systemd  the .deb (Debian, Ubuntu) or the tarball's install.sh (other distributions)
# FreeBSD             the FreeBSD package (pkg add), enabled with sysrc
# pfSense             the pfSense package for this pfSense's ABI (FIPS_UI_PFSENSE_PRODUCT overrides the product tag)
# macOS               the macOS package (installer)
# Upgrades of an installed fips go through fips-ui's Upgrade page, not this script.
set -euo pipefail
[[ $(id -u) -eq 0 ]] || { echo "run with sudo" >&2; exit 1; }
fail() { echo "error: $*" >&2; exit 1; }

repo=${FIPS_UI_FIPS_REPO:-jmcorgan/fips}
tag=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag) [[ $# -ge 2 ]] || fail "--tag needs a value"; tag=$2; shift 2 ;;
    *) fail "unknown argument $1 (usage: $0 [--tag vX.Y.Z])" ;;
  esac
done
[[ -z "$tag" || "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || fail "--tag must look like v0.5.1"

# ---- which system ----
os=$(uname -s); machine=$(uname -m)
if [[ "$os" == Linux ]] && command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then kind=systemd
elif [[ "$os" == FreeBSD ]] && grep -qi pfsense /etc/platform 2>/dev/null; then kind=pfsense
elif [[ "$os" == FreeBSD ]]; then kind=freebsd
elif [[ "$os" == Darwin ]]; then kind=macos
else fail "no fips install for this system ($os without systemd); see docs/install.md"; fi

for b in fips /usr/bin/fips /usr/local/bin/fips; do
  if command -v "$b" >/dev/null 2>&1; then fail "fips is already installed ($(command -v "$b")); upgrade it from fips-ui's Upgrade page"; fi
done

# ---- download helpers (curl, or FreeBSD's fetch) ----
download() { # <url> <file>
  if command -v curl >/dev/null 2>&1; then
    local auth=()
    [[ -n "${FIPS_UI_GITHUB_TOKEN:-}" && "$1" == https://api.github.com/* ]] && auth=(-H "Authorization: Bearer $FIPS_UI_GITHUB_TOKEN")
    curl -fsSL --retry 3 ${auth[@]+"${auth[@]}"} -o "$2" "$1"
  elif command -v fetch >/dev/null 2>&1; then fetch -q -o "$2" "$1"
  else fail "neither curl nor fetch is installed"; fi
}
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v sha256 >/dev/null 2>&1; then sha256 -q "$1"
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
api=https://api.github.com/repos/$repo/releases/${tag:+tags/$tag}
[[ -n "$tag" ]] || api+=latest
download "$api" "$work/release.json" || fail "cannot read the release from $api"
tag=$(sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' "$work/release.json" | head -n 1)
[[ -n "$tag" ]] || fail "no release found at $api"
urls=$(grep -o '"browser_download_url": *"[^"]*"' "$work/release.json" | sed 's/.*"\(https[^"]*\)"/\1/')
pick() { grep -E "/$1\$" <<<"$urls" | head -n 1 || true; } # <file-name regex>

# ---- which artifact ----
case "$machine" in x86_64|amd64) arch=x86_64 deb_arch=amd64 bsd_arch=amd64 ;; aarch64|arm64) arch=aarch64 deb_arch=arm64 bsd_arch=aarch64 ;; *) fail "no fips release for $machine" ;; esac
case "$kind" in
  systemd)
    sums=checksums-linux.txt
    # FIPS_UI_FIPS_ARTIFACT=tarball skips the .deb (tests, or dpkg without apt).
    url=""
    if command -v dpkg >/dev/null 2>&1 && [[ "${FIPS_UI_FIPS_ARTIFACT:-}" != tarball ]]; then url=$(pick "fips_[^/]*_${deb_arch}\\.deb"); fi
    [[ -n "$url" ]] || url=$(pick "fips-[^/]*-linux-${arch}\\.tar\\.gz") ;;
  freebsd) sums=checksums-freebsd.txt; url=$(pick "fips-[^/]*-freebsd-${bsd_arch}\\.pkg") ;;
  pfsense)
    sums=checksums-freebsd.txt
    abi=$(pkg config abi 2>/dev/null || true)
    # Upstream names pfSense packages after the pfSense products an ABI serves (like server/upgrade.ts).
    case "$abi" in FreeBSD:15:amd64) product=ce2.8 ;; FreeBSD:16:amd64) product=ce2.9-plus26 ;; FreeBSD:16:aarch64) product=plus26 ;; *) product="" ;; esac
    product=${FIPS_UI_PFSENSE_PRODUCT:-$product}
    [[ -n "$product" ]] || fail "no pfSense package is known for ABI '$abi'; set FIPS_UI_PFSENSE_PRODUCT (e.g. ce2.9-plus26)"
    url=$(pick "fips-[^/]*-pfsense-${product}-${bsd_arch}\\.pkg")
    [[ -n "$url" ]] || fail "release $tag publishes no pfSense package for $abi (fips-…-pfsense-$product-$bsd_arch.pkg); the FreeBSD package does not work on pfSense" ;;
  macos) sums=checksums-macos.txt; url=$(pick "fips-[^/]*-macos-$([[ $arch == x86_64 ]] && echo x86_64 || echo arm64)\\.pkg") ;;
esac
[[ -n "$url" ]] || fail "release $tag publishes no fips package for $kind/$machine"
file=${url##*/}
sums_url=$(pick "$(sed 's/\./\\./g' <<<"$sums")")
[[ -n "$sums_url" ]] || fail "release $tag publishes no $sums to verify $file against"

echo "== fips $tag: $file"
download "$url" "$work/$file"
download "$sums_url" "$work/$sums"
want=$(awk -v f="$file" '$2 == f || $2 == "*" f {print $1}' "$work/$sums" | head -n 1)
[[ -n "$want" ]] || fail "$sums has no checksum for $file"
got=$(sha256_of "$work/$file")
[[ "$got" == "$want" ]] || fail "checksum mismatch for $file (expected $want, got $got)"
echo "checksum ok"

# ---- install and start ----
case "$kind" in
  systemd)
    if [[ "$file" == *.deb ]]; then
      if command -v apt-get >/dev/null 2>&1; then DEBIAN_FRONTEND=noninteractive apt-get install -y -q "$work/$file"
      else dpkg -i "$work/$file"; fi
    else
      tar xzf "$work/$file" -C "$work"
      "$work/${file%.tar.gz}/install.sh"
    fi
    systemctl enable --now fips.service ;;
  freebsd)
    pkg add "$work/$file"
    sysrc -q fips_enable=YES >/dev/null
    # rc.d's daemon(8) keeps the caller's output open: detach it.
    service fips start </dev/null >/dev/null 2>&1 || true ;;
  pfsense)
    pkg add "$work/$file"
    [[ -x /usr/local/etc/rc.d/fips.sh ]] && /usr/local/etc/rc.d/fips.sh start </dev/null >/dev/null 2>&1 || true ;;
  macos)
    installer -pkg "$work/$file" -target / ;;
esac

# ---- verify ----
sock=/run/fips/control.sock; [[ "$os" == Linux ]] || sock=/var/run/fips/control.sock
for _ in $(seq 1 40); do [[ -S "$sock" ]] && break; sleep 0.5; done
[[ -S "$sock" ]] || fail "fips was installed but its control socket $sock did not appear; check the daemon's log"
echo "fips $tag is installed and running (control socket $sock)."
echo "It starts with the release's default configuration: set a persistent identity and add peers on"
echo "fips-ui's Configuration page (or in fips.yaml), then restart fips."
