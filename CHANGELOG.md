# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Followers on the master**: the hosts card of a master lists the nodes that
  sync their names from it (by name and npub), with the last sync (flagged when
  overdue), the number of names, their interval and fips-ui version. Followers
  identify their sync with a header; older followers are recognised too.

## [0.5.4] - 2026-09-27

### Fixed

- fips-ui's self-update on Windows: `npm` is `npm.cmd` there and is now started
  through the shell, and node's directory is prepended to `Path` (not added as a
  second `PATH` variable).
- The fips.yaml template step of daemon upgrades is skipped on systems where the
  helper cannot apply configuration (macOS, FreeBSD, Windows) instead of leaving
  a proposal nothing there can apply.

## [0.5.3] - 2026-09-27

### Fixed

- Updating fips-ui from the Upgrade page failed silently at `npm ci` when node
  comes from nvm, mise or a tarball: the service starts node by its absolute
  path, and `npm` (next to it) was not on the service's PATH. The updater now
  puts node's directory first on PATH for its commands, and the job log says why
  a command could not start or was stopped. `deploy/setup-local.sh` also adds
  node's directory to the service's PATH.

### Upgrading

- Nodes on 0.5.2 or older run the previous updater: update them once from a
  shell (`git pull && npm ci --prefix web && npm run build`, then restart
  fips-ui), or re-run `sudo ./deploy/setup-local.sh` first, which fixes the
  service's PATH so the Update button works.

## [0.5.2] - 2026-09-27

### Fixed

- The names synced from a master had no Status column (direct peer, this node,
  not a direct peer) and no header row; they now show the same columns as the
  local entries.

## [0.5.1] - 2026-09-27

### Fixed

- Updating fips-ui from the Upgrade page failed with `tsc: not found` when the
  dependencies changed: the service runs with `NODE_ENV=production`, in which
  `npm ci` leaves out the build tools. They are now always installed, and
  reinstalled whenever they are missing. Nodes still on 0.4.0/0.5.0 run the old
  updater: update them once from a shell (`git pull && npm ci --prefix web &&
  npm run build`, then restart fips-ui).

## [0.5.0] - 2026-09-27

### Added

- **fips.yaml follows the template across daemon upgrades** (release and source
  builds): after the new daemon runs, the changes of the upstream template
  (`packaging/common/fips.yaml`) between the old and the new version are merged
  into this node's fips.yaml with a 3-way merge, on the redacted file so secrets
  stay with the helper. Your own edits stay. A clean merge is applied with a
  backup, restart and automatic rollback; a merge with conflicts (or a rolled
  back one) waits on the Configuration page for review. Deprecation warnings the
  new daemon logs about the configuration are reported in the job. Option on the
  Upgrade page: "Update fips.yaml to the new template" (on by default).

### Upgrading

- Install from the Upgrade page (fips-ui card) or `git pull && npm run build`
  and restart fips-ui.

## [0.4.0] - 2026-09-27

### Added

- **fips-ui updates itself**: the server looks up the newest fips-ui release on
  GitHub every 6 hours; a newer one shows as "vX available" next to the version
  in the sidebar. On the Upgrade page admins see the release notes and **Update**:
  the git checkout is fast-forwarded to the release tag (refused when it has
  local changes or commits not in the release), dependencies are reinstalled if
  they changed, the UI is rebuilt (rolled back if that fails) and the service
  restarts by itself under systemd. A newer privileged helper is reported, since
  only `sudo ./deploy/setup-local.sh` can install it.
- **Hosts-file sync from a master node** (Access → Hosts file): followers fetch
  the master's names over the mesh every few minutes and keep them in a marked
  block at the end of their hosts file; local entries stay, and on a duplicate
  name the master wins. The master only grants followers the viewer role. While
  the master is offline the last names stay and retries back off to once a day.
  See `docs/hosts-sync.md`.
- **Web UI over the mesh**: a "From hosts file…" dropdown next to the npub field
  picks a hosts-file name (entries already allowed and this node are left out),
  and the field suggests hosts names while typing.
- **Hosts file table**: a "Web UI" column shows each name's web UI access (not
  allowed, viewer, admin) and admins change it right there; granting admin asks
  for confirmation. The Access card and the table share one copy of the list.
- With names synced from a master, the hosts card lists the synced names first
  and folds the node's own entries into a "Local entries (N)" line (opened on
  request, while editing, or from an "add a name…" link; remembered per browser).

### Upgrading

- Update this time from a shell (`git pull && npm run build`, then restart
  fips-ui); from 0.4.0 on, new releases can be installed from the Upgrade page.

## [0.3.0] - 2026-09-27

### Added

- **Hosts file editor** on the Access page: add and remove names for npubs in the
  FIPS hosts file (`<name>.fips`), with comments, order and line endings kept and
  a refusal when the file changed meanwhile. The daemon picks changes up on its
  next lookup. On Linux with systemd it is written through the helper (new verb
  `hosts-apply`, helper v6, previous file kept as a backup); on other systems
  directly when the UI may write the file (`%ProgramData%\fips\hosts` on
  Windows, `/usr/local/etc/fips/hosts` or `/etc/fips/hosts` on macOS and
  FreeBSD). Peer details link to it ("add a name…").
- **Names next to npubs** throughout the UI: the header, overview, peers,
  topology, sessions, identity cache, diagnostics, peer ACL, firewall rules and
  the mesh-access list show the hosts-file name together with the shortened npub.
  The daemon's placeholder names for unnamed peers ("npub1ab...cdef") are no
  longer shown as names.

### Changed

- Web UI over the mesh accepts any `<name>.fips` address, so visitors can use a
  name from their own hosts file. A bare name without `.fips` is still refused.
- When the server refuses the browser (for example an address it does not
  accept), the page shows the reason instead of "Cannot reach the FIPS UI server".
- Listener tables (Overview, Access, Firewall) scroll when long and show how
  many listeners the mesh can reach.
- README screenshots show the current pages, including the Services card.

### Upgrading

- Re-run `sudo ./deploy/setup-local.sh` to install helper v6 (needed for the
  hosts-file editor on Linux) and restart the service.

## [0.2.0] - 2026-09-26

### Added

- **Configuration** page: edit `/etc/fips/fips.yaml` with YAML validation,
  a diff view and backups. Secret values are redacted by the helper and
  restored on save; applying restarts the daemon, waits for it to stay
  healthy, and restores the previous file automatically if it does not.
- **Firewall** page: control `fips-firewall` (enable, start, stop, reload,
  disable), see the drop counter, manage inbound rules for npubs, hosts-file
  names, `fd00::/8` prefixes or anyone, allow a filtered listener in one
  click, and edit other drop-ins. All changes are validated with `nft -c`
  against the full ruleset before being written.
- Service buttons work through the helper, without polkit rules.
- **Web UI over the mesh**: a second listener on this node's fips0 address,
  admitting only allowed npubs with viewer or admin roles. The mesh
  authenticates the source address of every connection, so no password is
  involved; the UI also opens its port in the firewall for exactly those
  npubs. Managed on the Access page; see `docs/mesh-access.md`.
- Helper v5 (`mesh-guard`) on top of v4's `config-*`, `firewall-status`, `dropin-*` and `service`
  verbs. Re-run `deploy/setup-local.sh` to install it.
- Multi-OS support for the dashboard: service state, service actions and the
  Logs page now work with systemd, OpenRC, OpenWrt's procd, macOS launchd,
  FreeBSD rc.d and the Windows Service Control Manager, reading logs from
  journald, logread, the macOS unified log or the daemon's log file. The
  control endpoint may be a TCP port (Windows' default `21210`) or
  `host:port` as well as a Unix socket. The detected platform is shown at
  startup and in `/api/health`. New settings: `FIPS_UI_SERVICE_MANAGER`,
  `FIPS_UI_SERVICE_<NAME>`, `FIPS_UI_LOG_FILE`.

### Changed

- `/api/service/<name>/<action>` takes the portable service id (`fips`,
  `fips-gateway`, …); the old `fips.service` form is still accepted.

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

[Unreleased]: https://github.com/fr34aky/fips-ui/compare/v0.5.4...HEAD
[0.5.4]: https://github.com/fr34aky/fips-ui/compare/v0.5.3...v0.5.4
[0.5.3]: https://github.com/fr34aky/fips-ui/compare/v0.5.2...v0.5.3
[0.5.2]: https://github.com/fr34aky/fips-ui/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/fr34aky/fips-ui/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/fr34aky/fips-ui/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/fr34aky/fips-ui/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/fr34aky/fips-ui/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/fr34aky/fips-ui/compare/v0.1.3...v0.2.0
[0.1.3]: https://github.com/fr34aky/fips-ui/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/fr34aky/fips-ui/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/fr34aky/fips-ui/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/fr34aky/fips-ui/releases/tag/v0.1.0
