# Public domains

<!-- markdownlint-disable MD013 -->

[fips-pub-domains](https://github.com/fr34aky/fips-pub-domains) makes ordinary domain names
(`www.example.org`) resolve to fips mesh nodes, with or without the Internet. It has two halves, and a
node may run either or both:

- **`fips-pubdom-server`**, on the node that serves a domain: answers the mesh's DNS queries for the
  names in its zone files and publishes the domain's claim to Nostr relays.
- **`fips-pubdomd`**, on any node that should resolve such names: a resolver in front of the system's
  DNS that verifies a domain's binding (DNSSEC, or two agreeing resolvers) and pins it.

When fips-ui finds either on the node — its control socket (`/run/fips-pubdom-server/control.sock`,
`/run/fips-pubdom/control.sock`), or its configuration on disk — a **Public domains** page appears in
the sidebar. It reads the sockets (fips's own line-JSON protocol, so the same client code), and shows:

| Tab | What you see |
| --- | ------------ |
| **Domain server** | This node's npub and mesh address, where it listens, whether it publishes; each relay with when it last accepted and its last rejection reason; one card per domain: the names and where they point (this node, another node — by its Mesh name where known — or legacy), the port, when the claim and the zone record were published, how long the DNSSEC proof is valid, the next publication, the exact TXT record to add at the domain's hoster (copyable); zone files the server could not load. |
| **Resolver** | Online or offline, upstreams and where they come from, the OS integration `setup` chose, DNSSEC and plain-probe settings, witnesses and the attestation threshold, relays; the verified (pinned) domains with their server, port, verification method and time. |
| **Log** | The last lines of the chosen process, from its own ring buffer — no journal access needed. |

Viewers see all of it. Admins also get the buttons:

| Button | What it does |
| ------ | ------------ |
| **Publish now** / **Publish all now** | Asks the server to publish the domain's claim and zone record (or every domain's) at once; the outcome shows on the relays table and the domain card within seconds. |
| **Check DNS** | The server verifies the domain's `_fips-dns` TXT record as a client would (DNSSEC, or two agreeing resolvers) and says `verified`, `no record`, `names another key`, `names this server with another port`, `resolvers disagree` or `unreachable`. |
| **Attestations** | Who vouches for the domain on the configured relays: every attestation (kind 37198), the newest per witness, and whether it names this server. The server's view, not a verification — a resolver believes only the witnesses it configured. Available to viewers too. |
| **Add domain**, **Edit**, remove | A zone file as a table: each name under the domain and where it points (this node, another node by npub, or *legacy* for a name that stays on the ordinary Internet), the port, with the wildcard's warning; or the file itself under **File**. |
| **Publishing and server settings**, **Resolver settings** | `/etc/fips-pubdom/server.yaml` and `/etc/fips-pubdom/config.yaml` as text, with YAML syntax checked as you type. |
| **Forget** | Drops a verified domain's pin; the next lookup verifies it again. |
| **Flush caches** | Forgets cached answers and decisions; the pins stay. |
| **Start** | On a side that is installed but not running, starts its unit (with service control enabled). |

The actions go over the control sockets, which trust whoever can open them, so they need no helper. The
files are read by the backend for admins only (a `server.yaml` whose `key:` holds the key itself rather
than a path is not shown at all) and written through the privileged helper (version 11 or newer, `sudo ./deploy/setup-local.sh`): each is
checked with the binary's own parser before it is written — `fips-pubdom-server validate zone`,
`fips-pubdom-server validate config`, `fips-pubdomd validate config` — refused if the file changed since
the editor read it, backed up, and replaced atomically as `root:root 0644`. A zone file is picked up by
the server within a second — into the directory the running server reports, which the helper checks
against its own; a configuration change restarts the unit if it was running (the checkbox in the
confirmation turns that off). Comments in a hand-written zone file do not survive a save from the
table; the **File** view offers to start from the file on disk to keep them. A file the server skipped
(it would not parse) opens as text under **Repair**.

A side that is installed but whose unit is not running shows the page with a note instead of data. The
UI's user must be in group `fips` (the sockets are group-readable and -writable), as it already is for
fips's own socket. `FIPS_PUBDOM_SOCKET` and `FIPS_PUBDOM_SERVER_SOCKET` override the socket paths for a
daemon or server run by hand.

## Installing, updating, starting and stopping

Where the node runs systemd (what fips-pub-domains' packaging ships units for) and the helper is version 12
or newer, an admin sees the page even before anything is installed, with an **Install** card per side:

- **Resolver**: the release archive is downloaded from GitHub and verified against its `SHA256SUMS`, the
  three binaries go to `/usr/bin` and `fips-pubdom.service` to `/etc/systemd/system`; `fips-pubdomd setup`
  points the OS resolver at the daemon (systemd-resolved, NetworkManager, dnsmasq or a plain resolv.conf) and
  writes `/etc/fips-pubdom/config.yaml`, unless that file already exists; the unit is enabled and started.
- **Domain server**: the same fetch; `fips-pubdom-server.service`, an empty `/etc/fips-pubdom/zones`,
  the firewall drop-in where `/etc/fips/fips.d` exists (fips's baseline firewall drops inbound on `fips0`
  otherwise), and `server.yaml` from `fips-pubdom-server init`; the unit is enabled and started, serving
  nothing until a domain is added on the page.

Each installed side has a **service** card: the unit's state, whether it starts at boot, the installed
version and the newest release on GitHub (checked every six hours, `FIPS_UI_GITHUB_TOKEN` honoured), with
**Start**, **Stop**, **Restart**, **Enable/Disable at boot** (service control through the helper), and
**Update** when a newer release is out: the archive is fetched and verified the same way, the binaries and
every installed unit are replaced, and the units that were running are restarted. Configuration and zone
files are never touched by an update.

A server upgraded from before 0.2.7 may still run from `--zone` flags: it reports no zones directory, and
the Domain server tab says so instead of offering the editing buttons. `sudo fips-pubdom-server init`
writes `/etc/fips-pubdom/server.yaml` from the existing zone files and `server.env` (skip it if the file
is already there), then `sudo systemctl restart fips-pubdom-server` makes the unit use it.

Over the mesh the page is subject to the same access list as the rest of the dashboard
([mesh-access.md](mesh-access.md)).
