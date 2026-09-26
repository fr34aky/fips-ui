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
guard is loaded; without it (for example before helper v4 is installed) nobody is admitted from the mesh.
Something outside the UI (restarting `nftables.service`, for example) can flush the whole ruleset, so the
guard's presence is proven for every mesh connection at the moment it is accepted, without privileges: the
same table holds a canary rule that resets TCP to a private port on `::1` where the UI listens. On accept
the UI connects to its canary; if that connection is accepted instead of reset, the table is gone, the new
connection is destroyed and the guard is re-applied. What remains is the time between the kernel finishing
a handshake and this check, well under a millisecond, during which someone else would have to re-load the
guard for a forged connection to pass. In addition the UI asks the helper every 30 seconds whether the
guard, including its canary, still matches (one read-only sudo call, visible in the auth log).

While mesh access is on, `fd00::/8` sources are treated as mesh identities on the main listener too. If you
expose the main listener on a LAN that itself uses `fd` ULA addresses, those clients cannot use it over IPv6
while mesh access is on (the guard drops them); use IPv4 or a non-`fd` address. With mesh access off,
nothing changes for them.

As a further layer, the UI keeps a rule in its managed firewall drop-in that opens the mesh port on fips0
only to the allowed npubs. Both are updated right after every change to the allow-list and retried every
15 seconds until they succeed.

Removing an npub or changing its role closes its open connections, including live event streams. An
operation it had already started, such as a configuration apply, still completes.

## Roles

| Role | Can |
| ---- | --- |
| viewer | Everything read-only: dashboards, peers, metrics, logs, topology. No Configuration, Firewall or Upgrade pages, no connect, disconnect or probe, and no view of the access list. |
| admin | The same as someone at this machine, including changing the node's configuration and firewall as root and upgrading it. Grant it only to keys you trust as much as this host's own login. |

The local listener (loopback) is always admin. Mesh access requires helper v4 (`sudo ./deploy/setup-local.sh`). `FIPS_UI_TOKEN`, when set, is required on the local
listener only; over the mesh the npub is the credential.

## Configuration

Managed on **Access → Web UI over the mesh** (admins only) and stored in
`~/.config/fips-ui/access.json` (mode 0600; override with `FIPS_UI_ACCESS_FILE`):

```json
{ "enabled": true, "port": 8321, "allowed": [ { "npub": "npub1…", "label": "laptop", "role": "admin" } ] }
```

Browsers may address the mesh listener by this node's fips0 address or any `.fips` name; other `Host` and
`Origin` values are refused, as on the local listener. Someone who is not on the list gets a page that tells
them their own npub, so they can send it to you.
