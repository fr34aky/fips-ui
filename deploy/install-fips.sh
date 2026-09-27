#!/usr/bin/env bash
# Install the fips daemon from its newest GitHub release (or --tag vX.Y.Z), checksum-verified, configured and started.
# Called by setup-local.sh when fips is missing; also usable on its own:
#   sudo ./deploy/install-fips.sh [--tag vX.Y.Z] [--test-peer] [--peer npub1...@udp/host:port]...
#   sudo ./deploy/install-fips.sh --check     exit 0 if fips is installed (binary, socket, service or group), 1 if not
# The release's fips.yaml starts an isolated node; before the first start the identity is made persistent and the
# peers are added (--test-peer: the public test node from upstream's template). Without any peer the node only
# reaches peers that dial it.
# The work is the privileged helper's "daemon-install" verb (scripts/fips-ui-helper), the same one the Upgrade page
# uses: the .deb on apt systems, the tarball's install.sh on other Linux with systemd, the FreeBSD, pfSense or macOS
# package. As root, FIPS_UI_FIPS_ARTIFACT=tarball, FIPS_UI_PFSENSE_PRODUCT and FIPS_UI_FIPS_REPO adjust the choice.
# Upgrades of an installed fips go through fips-ui's Upgrade page, not this script.
set -euo pipefail
[[ $(id -u) -eq 0 ]] || { echo "run with sudo" >&2; exit 1; }
here=$(cd "$(dirname "$0")/.." && pwd)
helper=$here/scripts/fips-ui-helper
# The public FIPS test node, as upstream's fips.yaml template lists it (also web/src/lib/fipsInstall.ts).
TEST_PEER=npub1qmc3cvfz0yu2hx96nq3gp55zdan2qclealn7xshgr448d3nh6lks7zel98@udp/test-us01.fips.network:2121
usage() { echo "usage: $0 [--tag vX.Y.Z] [--test-peer] [--peer npub1...@udp/host:port]... | --check" >&2; exit 1; }
tag=""; peers=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --check) [[ $# -eq 1 ]] || usage; exec "$helper" daemon-installed ;;
    --tag) [[ $# -ge 2 ]] || usage; tag=$2; shift 2 ;;
    --peer) [[ $# -ge 2 ]] || usage; peers+=("$2"); shift 2 ;;
    --test-peer) peers+=("$TEST_PEER"); shift ;;
    *) usage ;;
  esac
done
"$helper" daemon-install "$tag" ${peers[@]+"${peers[@]}"} >/dev/null
[[ ${#peers[@]} -gt 0 ]] || echo "note: no peers configured; add some on fips-ui's Configuration page (or in fips.yaml) and restart fips."
