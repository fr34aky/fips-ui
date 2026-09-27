# Upgrading the node from the UI

The **Upgrade** page installs a new `fips` (plus `fipsctl`, `fipstop`, `fips-gateway`)
from one of two sources and restarts the daemon:

| Source | What happens |
| ------ | ------------ |
| **Stable release** | Downloads the GitHub release artifact for this OS/arch, verifies its SHA-256 against the release's `checksums-<os>.txt`, stages the binaries (Linux tar.gz, Windows zip) or the installer package (macOS/FreeBSD `.pkg`). |
| **Development build (master)** | Clones/fetches `https://github.com/jmcorgan/fips`, checks out `origin/master` (or any tag/branch/sha you type), runs `cargo build --release --locked`, stages the resulting binaries. |

In both cases the current binaries are backed up first (last 10 kept) and can be
restored from the **Backups** table. After the restart the page waits for the
control socket to answer and confirms the running version matches what was staged.

## A machine without fips

When no fips is installed, the page shows an **Install fips** card instead of the release and development
sources: it installs the newest release through the helper (v9, verb `daemon-install`) with a persistent
identity and the bootstrap peers you choose, starts it, and restarts fips-ui into the `fips` group. See
[install.md](install.md#installing-the-fips-daemon). `POST /api/upgrade/install-daemon {"tag"?: "vX.Y.Z",
"peers": ["npub1...@udp/host:port"]}` does the same (admin).

## OS support

Cargo is portable, so the build path works on every OS Rust supports. The
OS-specific parts are isolated:

| | Linux | macOS | FreeBSD | pfSense | Windows |
|---|---|---|---|---|---|
| Release artifact | `fips-<v>-linux-<arch>.tar.gz` | `fips-<v>-macos-<arch>.pkg` (installed with `installer`) | `fips-<v>-freebsd-<arch>.pkg` (`pkg add`) | `fips-<v>-pfsense-<products>-<arch>.pkg` (`pkg add`), see below | `fips-<v>-windows-<arch>.zip` |
| Install dir | `/usr/bin` (or where `fips` is on PATH) | `/usr/local/bin` | `/usr/local/bin` | `/usr/local/bin` | dir of `fips.exe` / `FIPS_BIN_DIR` |
| Service restart | systemd (`fips.service`), OpenRC, SysV | launchd (`com.fips.daemon`) | rc.d (`service fips restart`) | its boot script (`/usr/local/etc/rc.d/fips.sh restart`) | SCM (`sc stop/start fips`) |
| Privilege | helper via `sudo` | helper via `sudo` | helper via `sudo` | helper via `sudo` (install `bash` and `sudo` first) | backend must run elevated |
| Build deps install | pacman / apt / dnf / zypper / apk / emerge | Homebrew (no sudo) | `pkg` | not supported: releases only | winget |

### pfSense

pfSense is FreeBSD underneath, but upstream's FreeBSD package does not work there (it never starts at boot and
its DNS drop-in is never read), so fips publishes separate pfSense packages, named after the pfSense products
an ABI serves. fips-ui detects pfSense (`/etc/platform`) and the FreeBSD ABI (from the kernel version) and
installs only the matching one:

| ABI | pfSense | Package |
|---|---|---|
| `FreeBSD:15:amd64` | CE 2.8 | `fips-<v>-pfsense-ce2.8-amd64.pkg` |
| `FreeBSD:16:amd64` | CE 2.9, Plus 26.x (Intel) | `fips-<v>-pfsense-ce2.9-plus26-amd64.pkg` |
| `FreeBSD:16:aarch64` | Plus 26.x (ARM) | `fips-<v>-pfsense-plus26-aarch64.pkg` |

A release without the matching pfSense package, or an ABI not in this table, is refused rather than falling
back to the FreeBSD package; `FIPS_UI_PFSENSE_PRODUCT` sets the product tag for a newer pfSense. Source builds
are not offered on pfSense. The helper (v7) restarts fips through pfSense's boot script. Netgate treats
third-party packages as unsupported; the same caution applies here.

## Privilege model

The UI backend never runs as root on POSIX. Everything network- or CPU-heavy
(download, checksum, git, cargo) runs as the UI user inside the work dir
(`~/.local/share/fips-ui`, `~/Library/Application Support/fips-ui`,
`%LOCALAPPDATA%\fips-ui`; override with `FIPS_UI_WORKDIR`).

Only the final steps need root and go through `scripts/fips-ui-helper`, a
small bash script installed root-owned at `/usr/local/libexec/fips-ui-helper`.
A single sudoers rule lets the UI user run **that file and nothing else** without
a password:

```
<ui-user> ALL=(root) NOPASSWD: /usr/local/libexec/fips-ui-helper
```

Install it from a shell on the host:

```sh
sudo ./deploy/install-upgrade-helper.sh          # defaults to $SUDO_USER
```

The Upgrade page shows this command when the helper is missing. This is
deliberately a shell step: the web UI never asks for a sudo password and has no
code path that can grant itself privileges. To remove the capability again,
delete `/etc/sudoers.d/fips-ui` and `/usr/local/libexec/fips-ui-helper`.

Whoever may run `fips-ui-helper install` can place arbitrary root-owned
binaries in the install dir — that is inherent to upgrading. Keep the UI on
loopback or behind authentication, and keep the sudoers rule to one user.

Helper verbs: `check`, `install <stagedir> [--no-restart]`, `rollback <id>`,
`restart`, `list-backups`. The helper refuses symlinks, checks that every staged
binary executes, backs up before every swap and keeps the last 10 backups.

## Missing build tools

`cargo build` needs `cargo`, `rustc`, `git`, and `libclang` (the gateway's
conntrack bindings use bindgen); on Linux also `pkg-config` and the `dbus-1`
development package for the BLE transport. The Upgrade page checks these and,
when something is missing, shows the exact package-manager command to run from
a shell (Homebrew and winget need no sudo).

## Environment

| Variable | Purpose | Default |
|---|---|---|
| `FIPS_UI_WORKDIR` | downloads, source checkout, cargo target, stage dirs | per-OS data dir + `/fips-ui` |
| `FIPS_UI_HELPER` | helper path | `/usr/local/libexec/fips-ui-helper` |
| `FIPS_UI_BACKUPS` | backups dir; forwarded to the helper through the sudoers `env_keep` rule so both sides agree | `/var/lib/fips-ui/backups` (Linux) |
| `FIPS_BIN_DIR` | where the binaries live; forwarded to the helper the same way | autodetected |
| `FIPS_CONTROL_SOCKET` | daemon control socket (or loopback port on Windows) | autodetected |
| `FIPS_UI_GITHUB_TOKEN` | lifts the 60 req/h unauthenticated GitHub limit | – |
| `FIPS_UI_GITHUB_REPO` / `FIPS_UI_REPO_URL` | build a fork instead | `jmcorgan/fips` |
| `FIPS_UI_CARGO_ARGS` | extra cargo flags, e.g. `--features profiling` | – |
| `FIPS_SERVICE_NAME` | Windows service name | `fips` |

## API

All under `/api/upgrade` (mounted with `createUpgradeHandler({ authorize })`;
`POST`s are gated by `authorize`).

| Method | Path | Body | Purpose |
|---|---|---|---|
| GET | `/status` | | versions, latest release, master head + commits ahead, helper/toolchain state, backups, current job |
| POST | `/jobs` | `{source, ref?, restart?, dryRun?}` | start an upgrade job |
| GET | `/jobs/current` | `?since=<seq>` | job summary + log lines after `since` |
| GET | `/jobs/current/events` | `?since=<seq>` | SSE: `log` and `state` events |
| POST | `/jobs/current/cancel` | | cancel (not during privileged steps) |
| POST | `/rollback` | `{id}` | restore a backup |
| POST | `/restart` | | restart the service |
| GET | `/toolchain/plan` | | which build dependencies are missing and the command that installs them |

## Package-manager drift

If `fips` came from a distro package (the page shows it, e.g. `pacman: fips-git`),
installing binaries directly makes the package database stale: `pacman -Qkk`
reports modified files and the next package upgrade overwrites them. That is
harmless for a dev box but worth knowing. On Arch, rebuilding through the AUR
`fips-git` PKGBUILD keeps pacman consistent.

## Testing without root

```sh
node server/upgrade.ts                         # standalone API on :8787
curl -s localhost:8787/api/upgrade/status | jq .installed
curl -s -XPOST localhost:8787/api/upgrade/jobs -d '{"source":"release","dryRun":true}'
curl -N localhost:8787/api/upgrade/jobs/current/events
```

The helper's file logic can be exercised as a normal user against a scratch
directory: `FIPS_UI_HELPER_TEST=1 FIPS_BIN_DIR=/tmp/x/bin FIPS_SERVICE=none
FIPS_UI_BACKUPS=/tmp/x/backups scripts/fips-ui-helper install <stagedir>`.

## fips.yaml and the template

The daemon ships a commented configuration template (`packaging/common/fips.yaml` upstream). When it changes
between the running and the installed version (renamed keys, new sections, updated comments), the upgrade job's
last step, **Update fips.yaml to the template**, brings `/etc/fips/fips.yaml` in line, the way package managers
treat changed config files:

1. The template is read at the running and at the installed revision (from the source checkout for builds,
   from GitHub for releases).
2. The template's change is merged into the node's file with a 3-way merge (`git merge-file`): your edits
   stay, the template's are added. The merge runs on the redacted file, so secrets never leave the helper.
3. A clean merge is applied like a save on the Configuration page: the current file is backed up, the daemon
   restarted, and the previous file restored if it does not stay up.
4. A merge with conflicts (a line both you and the template changed), a rolled-back one, or any merge when the
   option is off, waits on the **Configuration** page: review it in the editor (conflicts are marked), apply or
   dismiss it.

The job also lists deprecation warnings the new daemon logs about the configuration (keys it still accepts
under an old name). The step never fails the upgrade itself: the new daemon is already running.
