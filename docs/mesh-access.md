# Web UI over the mesh

Other FIPS nodes can open this node's dashboard at its mesh address, for example
`http://[fd97:…]:8321` or `http://<npub>.fips:8321`. Access is granted per npub, with no password.

## Why no login is needed

FIPS strips IPv6 addresses from packets on the sending side and reconstructs the header on the receiving
side from the authenticated end-to-end session (upstream `docs/design/fips-ipv6-adapter.md`). The source
address of a connection that arrives through fips0 is therefore the `fd00::/8` address derived from the
sender's public key. The UI derives the address of every allowed npub with `fipsctl address` and admits a
connection only if its source address matches one of them.

A source address alone is not proof, because an attacker on the local network could advertise a route
for someone's `fd00::/8` address and complete a TCP handshake over the LAN. So a connection counts as an
npub only if the kernel routes replies to its address through the FIPS TUN device (a reverse-path check
with `ip route get`), or it is this node's own address over loopback. The mesh listener, bound to the
fips0 address, refuses every other source. As a further layer, the UI keeps a rule in its managed firewall
drop-in that opens the port only to the allowed npubs (this needs helper v3; see
[node-management.md](node-management.md)). The rule is rewritten in the same step as every change to the
allow-list, waiting if another node-management change is running.

Removing an npub or changing its role closes its open connections, including live event streams. An
operation it had already started, such as a configuration apply, still completes.

## Roles

| Role | Can |
| ---- | --- |
| viewer | Everything read-only: dashboards, peers, metrics, logs, topology. No Configuration, Firewall or Upgrade pages, no connect, disconnect or probe, and no view of the access list. |
| admin | The same as someone at this machine, including changing the node's configuration and firewall as root and upgrading it. Grant it only to keys you trust as much as this host's own login. |

The local listener (loopback) is always admin. `FIPS_UI_TOKEN`, when set, is required on the local
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
