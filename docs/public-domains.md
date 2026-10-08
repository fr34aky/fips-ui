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

Everything on the page is read-only in this version, for viewers and admins alike. Editing zone files,
the configuration, **Publish now**, **Check DNS**, **Forget** and **Flush** follow with the next
helper version.

A side that is installed but whose unit is not running shows the page with a note instead of data. The
UI's user must be in group `fips` (the sockets are group-readable and -writable), as it already is for
fips's own socket. `FIPS_PUBDOM_SOCKET` and `FIPS_PUBDOM_SERVER_SOCKET` override the socket paths for a
daemon or server run by hand.

Over the mesh the page is subject to the same access list as the rest of the dashboard
([mesh-access.md](mesh-access.md)).
