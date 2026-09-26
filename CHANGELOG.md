# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- A malformed line from the control socket (a JSON scalar or `null`) crashed
  the whole server from inside the socket's data handler; it is now reported
  as a transport error for that one query.
- Two upgrade jobs could start concurrently, because the "already running"
  guard ran before an `await`; the slot is now claimed synchronously.
- A non-numeric `FIPS_UI_POLL_MS` produced a NaN interval that fired every
  millisecond; numeric settings are validated and clamped, with a warning.
- A user-supplied git ref could begin with `-` and be parsed as a git option;
  refs must now start with an alphanumeric character and are passed after `--`.
- Service "since" times on the Overview never showed because systemd's
  localized timestamps did not parse; monotonic timestamps are used instead.
- `FIPS_BIN_DIR` and `FIPS_UI_BACKUPS` were honoured by the backend but
  stripped by sudo before reaching the helper; the sudoers rule now forwards
  exactly those two variables. Re-run `deploy/install-upgrade-helper.sh` to
  pick this up on an existing install.
- Rust toolchains installed with rustup were invisible under systemd's minimal
  `PATH`; tool discovery and builds now also look in `~/.cargo/bin`,
  `/usr/local/bin` and `/opt/homebrew/bin`.
- Cancelling an upgrade during the download had no effect until the download
  finished; in-process work is now aborted too, and any failure after a
  cancel request reports as cancelled rather than failed.
- The job panel's Dismiss button did nothing because the panel fell back to
  the server's last job.
- The Upgrade page's 15-second status poll spawned about 25 processes and one
  sudo helper check every time. Slow probes are now cached for ten minutes and
  re-run only on the Refresh button or when a job ends.

## [0.1.0] - 2026-09-26

Initial release, developed and verified against FIPS `0.6.0-dev`.

### Added

- Zero-dependency Node backend (`server/`) that speaks the daemon's
  control-socket protocol directly, proxies every documented read-only
  `show_*` query through an allow-list at `/api/q/<command>`, and polls
  a fixed set of them while a browser is connected, fanning the result
  out over Server-Sent Events at `/api/events`. Peer identifiers in
  requests may be an npub, a name from `/etc/fips/hosts`, or a known
  peer's display name.
- Journal following: `journalctl -u fips` parsed into level, target and
  message, seeded with recent lines and streamed live.
- Systemd awareness: unit state for `fips`, `fips-dns`, `fips-firewall`
  and `fips-gateway`, with optional restart/start actions behind
  `FIPS_UI_ALLOW_SERVICE_CONTROL=1`.
- Frontend (`web/`, Vite + React + Tailwind + uPlot) with dark and
  light themes, responsive to phone width, no external fonts or CDNs:
  - **Overview**: identity, tree role, mesh size / peers / depth /
    traffic / loss tiles with sparklines, uplink quality, service
    health, forwarding counters, transports, and the local listeners
    exposed on `fips0` with their firewall classification.
  - **Peers**: filterable table, detail panel with per-peer RTT, loss
    and throughput history, connect dialog (npub or hostname, address,
    transport) and disconnect with confirmation.
  - **Topology**: the spanning tree from the root through the
    ancestry to this node and its children, crosslinks aside.
  - **Metrics**: node history, one metric across peers, or all metrics
    for one peer, from 10 minutes at 1 s to 24 hours at 1 min.
  - **Network**: transports with interface presence, links, sessions,
    native datagram flows.
  - **Internals**: every counter family, routing state, Bloom filters,
    coordinate and identity caches.
  - **Logs**, **Diagnostics** (staged reachability probes),
    **Access** (ACL, firewall exposure, hosts file) and **Gateway**.
  - **Upgrade**: install the latest checksum-verified GitHub release
    or build any ref from source, with backups and rollback.
- Privilege model for upgrades: the only root-capable code is
  `scripts/fips-ui-helper`, installed together with a single-command
  sudoers rule by `deploy/install-upgrade-helper.sh`. The web process
  never prompts for or handles a sudo password.
- Deployment: `deploy/fips-ui.service` and `deploy/setup-local.sh`,
  which checks preconditions, installs the helper, installs the unit
  with a drop-in for the local user, node binary and checkout, and
  verifies health. Optional bearer-token auth (`FIPS_UI_TOKEN`) and
  read-only mode (`FIPS_UI_READ_ONLY=1`).

[Unreleased]: https://github.com/fr34aky/fips-ui/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/fr34aky/fips-ui/releases/tag/v0.1.0
