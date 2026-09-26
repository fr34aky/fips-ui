# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.3] - 2026-09-26

### Changed

- Node.js requirement corrected to 22.18+, 23.6+ or 24+: earlier versions
  only strip TypeScript behind a flag. `deploy/setup-local.sh` enforces it.
- Job and backup ids are UTC, millisecond-resolution and counter-suffixed, so
  two jobs in the same second get distinct ids and ordering survives DST.

### Fixed

- Oversized bodies on the main API got a connection reset instead of a 413.
- Deterministic GitHub errors (404 for a rev that is not on master, or no
  releases) were retried every minute and exhausted the anonymous limit; they
  are now cached as long as successes.
- The three GitHub calls behind the upgrade status ran sequentially, so an
  unreachable GitHub stalled the page for up to 45 s; they now run together.
- When the helper could not restart the service, the job waited two minutes
  for a daemon that was never restarted and then blamed the daemon; the
  restart step now fails immediately with the helper's message.
- Rollback discarded the helper's result; the safety backup taken before a
  rollback is now shown so a bad rollback can itself be undone.
- A non-boolean `dryRun` could skip the installer precheck yet perform a real
  install; the request is normalised once.
- Stage dirs, downloads and partial files accumulated forever under the work
  dir; a successful install removes its stage dir, and the newest three stage
  dirs and two artifacts are kept.
- A revision with a suffix (`-dirty`) defeated the staging check because the
  version parser did not capture it. The full token is now kept everywhere so
  a dirty and a clean build of the same commit are no longer conflated.
- Non-boolean `dryRun`/`restart` values are rejected with 400 rather than
  coerced. A 413 now closes the connection so a kept-alive socket is not left
  mid-body. GitHub 403/429 answers honour `retry-after` and suggest a token.

## [0.1.2] - 2026-09-26

### Fixed

- Regression in 0.1.1: `systemctl show --timestamp=unix` is rejected by
  systemd older than 251, which left the Services card empty there. The
  flag is now probed once and the monotonic fallback actually runs.
- Regression in 0.1.1: rebuilding a ref that was already built (dry run
  then real run, or a retry) failed at staging because cargo does not relink
  fresh binaries. Staged binaries are now validated by the revision they
  report against the commit that was built, which also catches leftovers.
- GitHub negative caching only worked for the first minute; an expired
  error entry no longer blocks a fresh one.
- A stale hashed asset URL fell through to `index.html` and was served with
  a one-year immutable cache header; missing assets now return 404 and the
  SPA fallback is never marked immutable.
- A tab that had launched an earlier job did not follow a newer job started
  elsewhere; the newer server-side job now supersedes it.
- A refused start (helper missing) was briefly published as a job and then
  withdrawn, which the page reported as a backend restart. The slot is now
  reserved without publishing until the job actually launches.
- Reconnecting event streams probed the full snapshot route to detect an
  expired token; they now use a cheap `HEAD` request.
- The Upgrade page used its own modal instead of the shared component.
- `GET /api/logs?lines=<non-number>` produced `journalctl -n NaN` and an
  empty result; the value is validated.
- Oversized upgrade request bodies caused a connection reset instead of a
  413 response.

## [0.1.1] - 2026-09-26

### Added

- The UI reports its own version: `uiVersion` in `/api/health`, in the startup
  log, and at the bottom of the sidebar.

### Security

- Mutating API requests now require `content-type: application/json`, a
  same-site `Origin` when the browser sends one, and no `cross-site`
  `Sec-Fetch-Site`; every API request must address the UI by an allowed
  hostname (loopback, the bind address, or `FIPS_UI_ALLOWED_HOSTS`). This
  closes cross-site request forgery and DNS-rebinding against a token-less
  loopback instance, which previously could have been made to disconnect
  peers, stop the service, or start a root-level upgrade.

### Fixed

- A missing or unreadable file under `web/dist` (for example mid-build)
  crashed the server through an unhandled stream error; it now answers 404
  or 500 for that request.
- A bare branch name typed into the build box resolved to the never-updated
  local branch from clone time and silently built stale code; refs are now
  resolved against `origin/<ref>` first.
- Binaries left in the shared cargo target directory by an earlier build of
  a different ref could be staged and installed next to a new `fips`; only
  binaries produced by the current build are staged.
- On Windows an install with "restart" unchecked left the service stopped;
  it is always started again after a swap, with a note.
- Service "since" times drifted by the time spent suspended; systemd's
  `--timestamp=unix` output is used, with a monotonic-clock fallback.
- The Upgrade page's GitHub polling exceeded the anonymous rate limit and
  retried failures immediately; answers are cached for ten minutes and
  failures for a minute or until the limit resets.
- The toolchain plan was still probed on every status poll, and the helper
  self-test ran twice per job.
- After a backend restart mid-job, the job panel retried two failing
  requests every three seconds forever; a 404 now ends the job as unknown.
- `node server/upgrade.ts` did nothing on Node 22 and 23 because its
  entry-point check relied on a Node 24.2 feature.

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

[Unreleased]: https://github.com/fr34aky/fips-ui/compare/v0.1.3...HEAD
[0.1.3]: https://github.com/fr34aky/fips-ui/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/fr34aky/fips-ui/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/fr34aky/fips-ui/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/fr34aky/fips-ui/releases/tag/v0.1.0
