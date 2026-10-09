# Web UI over the mesh

Other FIPS nodes can open this node's dashboard at its mesh address, for example
`http://[fd97:…]:8321` or `http://<npub>.fips:8321`. Access is granted per npub, with no password.

## Why no login is needed

FIPS strips IPv6 addresses from packets on the sending side and reconstructs the header on the receiving
side from the authenticated end-to-end session (upstream `docs/design/fips-ipv6-adapter.md`). The source
address of a connection that arrives through fips0 is therefore the `fd00::/8` address derived from the
sender's public key. The UI derives the address of every allowed npub with `fipsctl address` and admits a
connection only if its source address matches one of them.

A source address alone is not proof, because a host on the local network could send packets with
someone's `fd00::/8` address, and with a forged router advertisement even complete a TCP handshake. So
the privileged helper loads a small kernel rule, table `inet fips_ui_guard`, that drops TCP from
`fd00::/8` to the UI's ports unless it arrives on `lo` or the FIPS TUN device. The kernel applies it to
every packet, the handshake included. The UI trusts `fd00::/8` sources only while it has confirmed the
guard is loaded; without it (for example before helper v5 is installed) nobody is admitted from the mesh.
Something outside the UI (restarting `nftables.service`, for example) can flush the whole ruleset, so the
guard's presence is proven for every mesh connection at the moment it is accepted, without privileges: the
same table holds a canary rule that resets TCP to a private port on `::1` where the UI listens. On accept
the UI connects to its canary; if that connection is accepted instead of reset, the table is gone, the new
connection is destroyed and the guard is re-applied. What remains is the time between the kernel finishing
a handshake and this check, well under a millisecond, during which someone else would have to re-load the
guard for a forged connection to pass. In addition the UI asks the helper every 30 seconds whether the
guard, including its canary, still matches (one read-only sudo call, visible in the auth log).

Mesh identities are admitted on the mesh listener only. While mesh access is on, an `fd00::/8` source on
the main listener is refused, so if you expose the main listener on a LAN that itself uses `fd` ULA
addresses, those clients need IPv4 or a non-`fd` address while mesh access is on. With mesh access off,
nothing changes for them. Whenever the guard is actually (re)loaded (it was missing, its ports or interface changed, or the helper
reloaded it), the mesh listener is closed and rebound, which discards any connection that queued while the
guard was missing, and connections accepted in the first second after that are answered "retry" (503)
rather than admitted. Saving the allow-list does not reload a guard that is already confirmed.

As a further layer, the UI keeps a rule in its managed firewall drop-in that opens the mesh port on fips0
only to the allowed npubs. The firewall rule is updated right after every change to the allow-list, the guard whenever it is
missing or no longer matches, and both are retried every 15 seconds until they succeed.

Removing an npub or changing its role closes its open connections, including live event streams. An
operation it had already started, such as a configuration apply, still completes.

## Systems

The guard is an nftables table on Linux and a pf anchor on FreeBSD and macOS (`fips-ui/guard`, with the same
canary rule and a nested anchor that drops mesh-source TCP to the UI's port unless it arrives on `lo0` or the
FIPS interface). On pf the guard never enables pf itself: turn the fips firewall on first (Firewall page), so
pf evaluates the fips-ui anchors. pfSense has no guard, so mesh access stays off there. If pf stops evaluating
the anchors (pf disabled, pf.conf reloaded without them), the per-connection canary check notices and mesh
access stops admitting anyone.

## Roles

| Role | Can |
| ---- | --- |
| viewer | Everything read-only: dashboards, peers, metrics, logs, topology. No Configuration, Firewall or Upgrade pages, no connect, disconnect or probe, and no view of the access list. |
| admin | The same as someone at this machine, including changing the node's configuration and firewall as root and upgrading it. Grant it only to keys you trust as much as this host's own login. |

An npub is a node, not a person: **everything that leaves the listed node under its npub gets its role**,
including every local user of that node and, if it runs `fips-gateway`, every LAN client behind it. List
only nodes whose users you would all trust with that role. This node's own npub cannot be listed (any local
user could use it to get around `FIPS_UI_TOKEN`). Browsers must address the node by its fips0 address,
`<its npub>.fips`, or a name that this node's own `/etc/fips/hosts` maps to its npub (a name that only exists
in the visiting node's hosts file is refused; use the npub name or the address).

The local listener (loopback) is always admin. Mesh access requires helper v5 (`sudo ./deploy/setup-local.sh`). `FIPS_UI_TOKEN`, when set, is required on the local
listener only; over the mesh the npub is the credential.

## Configuration

Managed on **Access → Web UI over the mesh** (admins only) and stored in
`~/.config/fips-ui/access.json` (mode 0600; override with `FIPS_UI_ACCESS_FILE`):

```json
{ "enabled": true, "port": 8321, "allowed": [ { "npub": "npub1…", "label": "laptop", "role": "admin" } ] }
```

Browsers may address the mesh listener by this node's fips0 address or any `<name>.fips` name, including a
name from the visitor's own hosts file (`.fips` names are resolved by the visitor's FIPS daemon, never by
public DNS, so they cannot be rebound to this node). It also accepts the public domain names this node serves
itself with fips-pub-domains: the names its domain server answers with this node (target `self`: the domain,
a label, or what a `*` entry covers, by the server's own lookup rule), for zones whose claim is published without
an error, read from the
server's zones every 15 seconds. A visitor's resolver binds
such a name to a node only when that node published the claim, so they cannot be pointed here by anyone else;
names in the zones that point to other nodes are not accepted ([public-domains.md](public-domains.md#reaching-this-dashboard-under-a-public-domain)).
Other `Host` values, such as a bare name without `.fips`, are refused, and the browser shows the reason; cross-origin writes need the request's exact `Origin`. Someone who is not on the list gets a page that tells
them their own npub, so they can send it to you.
