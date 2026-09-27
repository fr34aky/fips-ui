# Hosts file and names

FIPS resolves `<name>.fips` from a hosts file: one `hostname npub` per line, reloaded by the daemon on its next
lookup (no restart). fips-ui edits that file on the **Access** page and uses it to show a clear name next to
every npub in the UI.

## Where the file is

| System | Path |
| ------ | ---- |
| Linux | `/etc/fips/hosts` |
| macOS, FreeBSD | `/usr/local/etc/fips/hosts` if it exists, else `/etc/fips/hosts` |
| Windows | `%ProgramData%\fips\hosts` |

`FIPS_HOSTS` overrides the path.

## Editing (Access → Hosts file)

- **Add** a name for an npub (or for a connected peer, picked from the list or typed by its display name) and
  **remove** names; **Save** writes the file. Adding a name for an npub that already has one renames it.
- Names are lowercase letters, digits and hyphens, at most 63 characters, no hyphen at either end.
- Everything else in the file stays as it is: comments, blank lines, the order of the entries, the line ending
  (LF or CRLF), and hand-written lines the editor would not create itself.
- A save is refused if the file changed on disk since the page loaded it (reload and make the change again).
- The **Status** column shows whether a name's npub is a direct peer (and how it is connected), this node, or
  neither; **Probe** runs a reachability probe to it.
- A peer's detail panel (Peers page) shows its name, with **add a name…** / **change…** links that open the
  editor with the npub filled in.

How the file is written:

| System | How |
| ------ | --- |
| Where the helper runs (Linux with systemd, FreeBSD, pfSense; macOS experimental) | Through the privileged helper (`hosts-apply`, helper v6): every line is checked, the previous file is kept as a backup (newest 20), the new one installed atomically, owned by root and mode 0644. Install or update the helper with `sudo ./deploy/setup-local.sh` ([install.md](install.md)). |
| Everything else | Directly, when the UI's user may write the file (for example a group-writable file, or an elevated Windows service); the file keeps its owner, group and mode. Otherwise the page says what permission is missing. |

## Web UI access per name

For admins the table has a **Web UI** column: each name's access to [Web UI over the mesh](mesh-access.md)
(not allowed, viewer, admin), changeable right there. The change is saved at once; granting admin asks for
confirmation, since admin over the mesh has the same rights as someone on this machine. The "Web UI over the
mesh" card also offers a **From hosts file…** dropdown to add allowed npubs by name.

## Names next to npubs

Wherever the UI shows an npub (the header, overview, peers, topology, sessions, identity cache, diagnostics,
peer ACL, firewall rules, the mesh-access list), it also shows the npub's hosts-file name. With several names
for one npub the first in the file is shown. The daemon labels peers without a name by a shortened npub
("npub1ab...cdef"); fips-ui does not treat that as a name.

## Syncing from a master

Trusted nodes can copy the names of one master node into their own hosts file, in a tree of masters if
needed: see [hosts-sync.md](hosts-sync.md). With names synced, the editor shows them read-only and folds the
node's own entries into a "Local entries" line.
