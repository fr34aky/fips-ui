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

## OS support

Cargo is portable, so the build path works on every OS Rust supports. The
OS-specific parts are isolated:

| | Linux | macOS | FreeBSD | Windows |
|---|---|---|---|---|
| Release artifact | `fips-<v>-linux-<arch>.tar.gz` | `fips-<v>-macos-<arch>.pkg` (installed with `installer`) | `fips-<v>-freebsd-<arch>.pkg` (`pkg add`) | `fips-<v>-windows-<arch>.zip` |
| Install dir | `/usr/bin` (or where `fips` is on PATH) | `/usr/local/bin` | `/usr/local/bin` | dir of `fips.exe` / `FIPS_BIN_DIR` |
| Service restart | systemd (`fips.service`), OpenRC, SysV | launchd (`com.fips.daemon`) | rc.d (`service fips restart`) | SCM (`sc stop/start fips`) |
| Privilege | helper via `sudo` | helper via `sudo` | helper via `sudo` | backend must run elevated |
| Build deps install | pacman / apt / dnf / zypper / apk / emerge | Homebrew (no sudo) | `pkg` | winget |

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
