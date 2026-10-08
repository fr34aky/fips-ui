# FIPS UI

A modern web dashboard to **watch and manage a [FIPS](https://github.com/jmcorgan/fips) mesh node**.
It talks to the daemon's control socket directly, streams live state to the browser over
Server-Sent Events and follows the daemon's log. It can connect and disconnect peers and run
reachability probes. With its small privileged helper it also edits `fips.yaml`, manages the fips
firewall and services, and upgrades the daemon. Other FIPS nodes can open the dashboard over the mesh,
authorised by npub. Names from the FIPS hosts file (optionally synced from another node, in a tree below a master node) are shown next
to npubs throughout, and fips-ui can update itself to its newest release.

![overview](docs/screenshots/overview.png)

## Features

| Page | What you get |
| ---- | ------------ |
| **Overview** | Identity (npub, IPv6, node address), role in the tree, mesh-size / peers / depth / traffic / loss tiles with sparklines, uplink quality, systemd unit health, forwarding counters, transports, and which local services are exposed on `fips0` and how the fips firewall treats them. |
| **Peers** | Sortable, filterable table of authenticated peers (by name and npub) with role, RTT, loss, ETX, goodput and traffic. Click a peer for a detail panel with 10-minute RTT / loss / throughput charts, tree coordinates, Noise counters and a link to name it. **Connect** (npub or hostname, address, transport) and **Disconnect** with confirmation. |
| **Topology** | The spanning tree drawn from the root down through the ancestry to this node and its children, with crosslink peers on the side. Coordinates, tree state and protocol counters. |
| **Metrics** | Time series from the daemon's history rings: every node-level metric, one metric compared across peers, or all metrics for one peer. 10 min / 1 h at 1 s resolution, 6 h / 24 h at 1 min. |
| **Network** | Transports (with interface presence for interface-bound ones), links per transport, end-to-end sessions, native datagram flows and listeners. |
| **Internals** | Every protocol counter family (searchable), routing state (pending lookups, retries, congestion), Bloom filters with fill meters, coordinate and identity caches. |
| **Logs** | Live `journalctl -u fips` with level filter, search, pause, and target highlighting. |
| **Diagnostics** | Staged reachability probes (bloom → discovery → path → session → RTT) against any npub or hosts-file name, with path visualisation and a run history. |
| **Access** | **Web UI over the mesh**: other FIPS nodes open this dashboard, authorised by npub with viewer or admin roles and no password, because the mesh authenticates every connection's source address ([docs/mesh-access.md](docs/mesh-access.md)). The **hosts file** editor: names for npubs, resolved as `<name>.fips` and shown next to npubs everywhere in the UI, with each name's web UI access ([docs/hosts.md](docs/hosts.md)); optionally synced from another node over the mesh, in a tree of master, distribution and follower nodes that each node shows ([docs/hosts-sync.md](docs/hosts-sync.md)). Also peer ACL state, firewall exposure of local listeners and identity file facts. |
| **Gateway** | `fips-gateway` pool utilisation and mappings when the gateway socket is present. |
| **Public domains** | Where the node runs [fips-pub-domains](https://github.com/fr34aky/fips-pub-domains): the domains this node serves over fips (names, relays, when the claim was published, the DNS record to add, who attested it) and the domains its resolver has verified, read from their control sockets. Admins add and edit zone files as a table, edit both configurations, publish now, check the DNS record, forget a pin and flush caches ([docs/public-domains.md](docs/public-domains.md)). |
| **Configuration** | Edit `/etc/fips/fips.yaml` with live YAML validation, a diff of your changes and backups. Secrets stay redacted and are restored on save; applying restarts the daemon and rolls back automatically if it does not stay up. Offers template merges from daemon upgrades that need review. See [docs/node-management.md](docs/node-management.md). |
| **Firewall** | Enable, start, stop and reload `fips-firewall`, see drop counters, add inbound rules for specific npubs, hosts-file names, prefixes or anyone, one-click "allow" for a filtered listener, and raw editing of other drop-ins. Every change is validated with `nft -c` before it is written. |
| **Upgrade** | Install the latest fips release (checksum-verified) or build any ref from source with cargo, with backups and rollback; afterwards `fips.yaml` is merged with the new version's template ([docs/upgrade.md](docs/upgrade.md)). Root steps go through a tiny helper you install once from a shell. On a machine without fips it **installs fips** itself, with a persistent identity and bootstrap peers ([docs/install.md](docs/install.md#installing-the-fips-daemon)). Also updates **fips-ui itself** to its newest release, shown next to the version in the sidebar ([docs/self-update.md](docs/self-update.md)). |

Dark and light themes, responsive down to phone width, no external fonts or CDNs.

## Requirements

- Node.js 22.18+, 23.6+ or 24+ (the backend is TypeScript run directly by Node's unflagged type stripping; no build step for the server)
- A running `fips` daemon; the UI user must be in the **`fips`** group to reach `/run/fips/control.sock`
- `journalctl` access to the fips unit for the Logs page (membership in `systemd-journal`, or `adm` on Debian, or being the same user that runs the daemon)
- For node management: the privileged helper (`sudo ./deploy/setup-local.sh`, [docs/install.md](docs/install.md)), `bash`, `python3` with PyYAML for the configuration editor (Arch `python-yaml`, Debian/Ubuntu `python3-yaml`, Fedora `python3-pyyaml`), `nft` (Linux) or pf (FreeBSD, macOS) for the firewall
- `git` for fips-ui's self-update and for merging `fips.yaml` with the template after daemon upgrades

## Operating systems

The dashboard reads the daemon through its control socket and asks the local service manager and log system
for everything else, so the read-only pages work wherever FIPS runs:

| | Control endpoint | Service state and actions | Logs page |
|---|---|---|---|
| Linux, systemd | `/run/fips/control.sock` | systemctl | journald |
| Linux, OpenRC | `/run/fips/control.sock` | rc-service | `/var/log/fips/fips.log` or `/var/log/fips.log` |
| OpenWrt | `/run/fips/control.sock` | procd (ubus, `/etc/init.d/fips`) | logread |
| macOS | `/var/run/fips/control.sock` | launchd (`com.fips.daemon`) | `/var/log/fips/fips.log`, else unified log |
| NixOS | `/run/fips/control.sock` | systemd; installed with the flake's NixOS module ([docs/install.md](docs/install.md#nixos)) | journald |
| FreeBSD | `/var/run/fips/control.sock` | rc.d (`service fips`) | `/var/log/fips/fips.log` or `/var/log/fips.log` |
| Windows | TCP `127.0.0.1:21210` | Service Control Manager | `%ProgramData%\fips\logs\fips.log` |

What works beyond the read-only pages:

| Feature | Where |
| ------- | ----- |
| Configuration editor, service buttons, hosts file through the helper | Linux with systemd, FreeBSD, pfSense; macOS experimental |
| Firewall | Linux (nftables), FreeBSD (pf); macOS experimental; not pfSense |
| Web UI over the mesh | Linux (nftables guard), FreeBSD (pf guard); macOS experimental; not pfSense |
| Hosts-file editor | everywhere: through the helper where it runs, elsewhere directly when the UI may write the file |
| fips.yaml template merge after daemon upgrades | where the helper applies the configuration (skipped elsewhere) |
| Daemon upgrade | all of the above (tested on Linux) |
| fips-ui self-update | everywhere from a git checkout; restarts itself under the services `setup-local.sh` installs |

`deploy/setup-local.sh` installs the helper and a service on Linux with systemd, FreeBSD, pfSense and macOS; installation per system, including OpenRC, OpenWrt and Windows, is in [docs/install.md](docs/install.md).

## Quick start

```sh
git clone <this repo> fips-ui && cd fips-ui
npm run install:all          # installs the frontend dependencies (the server has none)
npm run build                # builds web/dist
npm start                    # http://127.0.0.1:8321
```

Development (API on :8321 with auto-reload, Vite on :5173 with proxy):

```sh
npm run dev
```

## Configuration

Everything is via environment variables.

| Variable | Default | Purpose |
| -------- | ------- | ------- |
| `FIPS_UI_HOST` | `127.0.0.1` | Bind address. Only bind to a non-loopback address together with `FIPS_UI_TOKEN` or a reverse proxy that authenticates. |
| `FIPS_UI_PORT` | `8321` | Port. |
| `FIPS_UI_ALLOWED_HOSTS` | – | Comma-separated hostnames browsers may use to reach the UI, in addition to loopback and the bind address, e.g. `mynode.lan,mynode.fips`. Requests with any other `Host` are refused (DNS-rebinding protection). |
| `FIPS_UI_ACCESS_FILE` | `~/.config/fips-ui/access.json` | Mesh access settings and allowed npubs, managed from the Access page. |
| `FIPS_UI_TOKEN` | – | When set, every API call needs `Authorization: Bearer <token>`; the UI prompts for it once and stores it in the browser. Put it in `/etc/default/fips-ui` (mode 0600), not in the unit file. |
| `FIPS_UI_READ_ONLY` | – | `1` disables every mutating action (connect, disconnect, probe, service control, upgrade). |
| `FIPS_UI_ALLOW_SERVICE_CONTROL` | – | Legacy: `1` enables service buttons through plain `systemctl` (polkit rule or root) when the helper is not installed. With helper v3 they work without it. |
| `FIPS_UI_POLL_MS` | `2000` | How often the backend polls the daemon while at least one browser is connected. |
| `FIPS_SOCKET` | auto | Control endpoint: a Unix socket path, a TCP port (Windows default `21210`), or `host:port`. |
| `FIPS_UI_SERVICE_MANAGER` | auto | Force `systemd`, `openrc`, `procd`, `launchd`, `rc` or `scm`. |
| `FIPS_UI_SERVICE_FIPS`, `FIPS_UI_SERVICE_FIPS_GATEWAY`, … | per OS | Native service name for each service if your packaging differs (e.g. a custom launchd label). |
| `FIPS_UI_LOG_FILE` | per OS | Read the daemon log from this file instead of the OS log system. |
| `FIPS_GATEWAY_SOCKET` | auto | Gateway control socket override. |
| `FIPS_UNIT` | `fips.service` | Journal unit to follow (systemd only). |
| `FIPS_HOSTS` | per OS | Hosts file ([docs/hosts.md](docs/hosts.md)). |
| `FIPS_PUBDOM_SOCKET`, `FIPS_PUBDOM_SERVER_SOCKET` | `/run/fips-pubdom/control.sock`, `/run/fips-pubdom-server/control.sock` | The public-domains resolver's and server's control sockets ([docs/public-domains.md](docs/public-domains.md)). |
| `FIPS_UI_HOSTS_SYNC_FILE` | `~/.config/fips-ui/hosts-sync.json` | Settings for syncing names from another node. |
| `FIPS_UI_HOSTS_FOLLOWERS_FILE` | `~/.config/fips-ui/hosts-followers.json` | On a master or distribution node: the nodes that sync from it. |
| `FIPS_UI_CONFIG_PROPOSAL_FILE` | `~/.config/fips-ui/config-proposal.json` | A fips.yaml template merge waiting for review. |
| `FIPS_UI_REPO` | `fr34aky/fips-ui` | Repository whose releases fips-ui installs for itself. |
| `FIPS_UI_STATIC` | `web/dist` | Directory with the built frontend. |

Upgrade-specific variables (`FIPS_UI_WORKDIR`, `FIPS_UI_GITHUB_TOKEN`, …) are listed in [docs/upgrade.md](docs/upgrade.md). `FIPS_UI_GITHUB_TOKEN` (a token without permissions) also lifts GitHub's 60-requests-per-hour limit for the release checks.

## Running as a service

On the machine where the checkout lives, one command installs the upgrade helper, a service running the UI
from the checkout as your user (systemd, FreeBSD rc.d, pfSense boot script or macOS LaunchDaemon), and starts
it. On a machine without fips it offers to install the newest fips release first, with a persistent identity
and bootstrap peers (`--install-fips --fips-test-peer` for scripts), or leaves that to the Upgrade page. Per-system details are in [docs/install.md](docs/install.md):

```sh
sudo ./deploy/setup-local.sh
```

For a dedicated service account instead (Linux with systemd):

```sh
sudo useradd -r -s /usr/sbin/nologin -G fips,systemd-journal fips-ui
sudo mkdir -p /opt/fips-ui && sudo cp -r . /opt/fips-ui && sudo chown -R fips-ui: /opt/fips-ui
sudo cp deploy/fips-ui.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now fips-ui
```

Then browse to `http://127.0.0.1:8321`, or put it behind a reverse proxy with TLS and authentication.
To open the dashboard from other FIPS nodes, turn on **Access → Web UI over the mesh** and allow their npubs;
fips-ui then listens on the node's fips0 address and opens the port in the fips firewall for exactly those
npubs ([docs/mesh-access.md](docs/mesh-access.md)). Updates of fips-ui itself are installed from the Upgrade page
([docs/self-update.md](docs/self-update.md)).

## Security model

- The backend only ever speaks the documented [control-socket protocol](https://github.com/jmcorgan/fips/blob/master/docs/reference/control-socket.md) and shells out to `journalctl`/`systemctl`. It runs unprivileged.
- Read queries are proxied through an allow-list; only `connect`, `disconnect` and the probe triplet are mutating, plus service control and upgrade when explicitly enabled/installed.
- The web UI never asks for a sudo password. The only root-capable path is the helper, installed by an administrator from a shell with a single-command sudoers rule ([docs/upgrade.md](docs/upgrade.md#privilege-model)). With it, the UI can upgrade the node and manage its configuration, firewall and services ([docs/node-management.md](docs/node-management.md)); on a host shared with other users, set `FIPS_UI_TOKEN`.
- Bind to loopback (default) or set `FIPS_UI_TOKEN`.
- Over the mesh there is no password: FIPS authenticates each connection's source address, a kernel guard stops spoofed mesh addresses from the LAN, and only allowed npubs get in, as viewers or admins ([docs/mesh-access.md](docs/mesh-access.md)).
- Secret values in `fips.yaml` never reach the browser: the helper redacts them and restores them on save ([docs/node-management.md](docs/node-management.md#what-the-redaction-protects-and-what-it-does-not)).

## API

The frontend uses a small JSON API you can script against as well:

```
GET  /api/health                     UI + daemon health, enabled features, who you are
GET  /api/snapshot                   latest polled state (status, peers, links, transports, tree, sessions, …)
GET  /api/events                     SSE stream: `snapshot` every poll, `log` per log line
GET  /api/q/<show_command>?k=v       any read-only control-socket query, e.g. /api/q/show_stats_history?metric=srtt_ms&peer=home&window=1h
GET  /api/logs?lines=300             recent daemon log lines (parsed)
GET  /api/system                     host facts + service state
GET  /api/resolve?id=<name>          npub for an npub, hosts-file name or peer name
POST /api/connect                    {peer, address, transport}
POST /api/disconnect                 {peer}
POST /api/probe/start                {peer}  → {probe_id}; POST /api/probe/:id (poll), POST /api/probe/:id/cancel
POST /api/service/<id>/<action>      start|stop|restart|reload for fips, fips-dns, fips-firewall, fips-gateway

GET  /api/hosts                      hosts file: effective names, local entries, synced block (+ how it can be written, for admins)
POST /api/hosts                      {entries, base}  replace the local entries (admin)
GET  /api/hosts/sync                 sync settings, status and this node's role (admin);  POST {enabled, master (the upstream node), port, intervalMin}
POST /api/hosts/sync/run             sync now
GET  /api/hosts/followers            the nodes that sync from this one, with their subtrees (admin);  POST /api/hosts/followers/forget {npub}
GET  /api/access                     Web UI over the mesh: settings, status, who you are;  POST (admin) saves them
GET  /api/ui-update                  newest fips-ui release and update state;  POST /api/ui-update/install {tag} (admin)
     /api/admin/*                    configuration, firewall, services through the helper (admin), see docs/node-management.md
     /api/upgrade/*                  daemon upgrades, see docs/upgrade.md
```

`peer` accepts an npub, a name from `/etc/fips/hosts`, or the display name of a known peer.

## Project layout

```
server/        zero-dependency Node backend
  index.ts       HTTP + SSE server, routing, mesh-access wiring
  control.ts     control-socket client        platform.ts, system.ts  service state, logs, host facts per OS
  access.ts      Web UI over the mesh         net6.ts                 IPv6 helpers
  admin.ts       configuration, firewall and services through the helper
  hosts.ts       hosts file                   hosts-sync.ts, hosts-followers.ts  syncing names between nodes
  upgrade.ts     daemon upgrades              config-merge.ts         fips.yaml template merge after upgrades
  self-update.ts fips-ui's own updates        journal.ts, http.ts     log follower, HTTP helpers
web/           Vite + React + Tailwind frontend (src/views/* one file per page, src/components/* shared, src/lib/* API and stores)
scripts/       fips-ui-helper (the privileged helper), dev.mjs
deploy/        setup-local.sh (systemd, FreeBSD, pfSense, macOS), install-fips.sh (fresh fips install), systemd unit, helper installer, sudoers snippet
docs/          feature documentation, screenshots
```

## Documentation

| Document | Covers |
| -------- | ------ |
| [docs/install.md](docs/install.md) | Installing and running fips-ui as a service on Linux, FreeBSD, pfSense, macOS and Windows |
| [docs/mesh-access.md](docs/mesh-access.md) | Web UI over the mesh: why no login is needed, roles, the spoofing guard |
| [docs/hosts.md](docs/hosts.md) | The hosts-file editor, names next to npubs, web UI access per name |
| [docs/hosts-sync.md](docs/hosts-sync.md) | Syncing names between nodes: master, distribution and follower nodes, the hierarchy, loops, conflicts |
| [docs/node-management.md](docs/node-management.md) | The helper, the configuration editor and its redaction, firewall rules, services |
| [docs/upgrade.md](docs/upgrade.md) | Upgrading the fips daemon, the privilege model, the fips.yaml template merge |
| [docs/self-update.md](docs/self-update.md) | fips-ui updating itself |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow, [PR-REVIEW.md](PR-REVIEW.md) for the review
checklist every PR goes through, and [CHANGELOG.md](CHANGELOG.md) for what changed between releases.
Every pull request runs smoke tests that install fips-ui on Linux (systemd, Debian, Fedora, Arch, Alpine),
FreeBSD, macOS and Windows (`.github/workflows/smoke.yml`); `node scripts/smoke-test.mjs` runs the same checks
against a local installation.

## License

MIT. FIPS itself is © its authors, MIT licensed.
