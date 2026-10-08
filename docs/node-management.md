# Node management

The **Configuration** and **Firewall** pages change the node itself: `fips.yaml`, the fips firewall and the
fips services. All of it needs root, and all of it goes through the same privileged helper as upgrades
(`scripts/fips-ui-helper`). Version 4 of the helper is required on Linux with systemd (version 6 for writing
the hosts file, see [hosts.md](hosts.md)); on the other systems below, version 8.

## Systems

| | Linux (systemd) | FreeBSD | pfSense | macOS |
|---|---|---|---|---|
| Configuration editor (`fips.yaml`) | `/etc/fips/fips.yaml` | `/usr/local/etc/fips/fips.yaml` | `/usr/local/etc/fips/fips.yaml` | `/usr/local/etc/fips/fips.yaml` (experimental) |
| Services (restart, start, stop, at boot) | systemctl | rc.d (`service`, `sysrc`) | its boot script `rc.d/fips.sh` (no "at boot": pfSense starts it) | launchd (experimental) |
| Hosts file | yes | yes | yes | yes (experimental) |
| Firewall | nftables (`fips-firewall`) | pf anchor, see below | no: pfSense owns pf | pf anchor (experimental) |
| Web UI over the mesh (spoofing guard) | nftables | pf | no | pf (experimental) |
| Install the helper | `sudo ./deploy/setup-local.sh` | `sudo ./deploy/install-upgrade-helper.sh` (needs `bash`, `sudo`, `python3` with PyYAML from pkg) | same as FreeBSD | same |

FreeBSD is tested in a VM (FreeBSD 15.1 with upstream's package); pfSense uses the same code paths with its boot
script; macOS is untested. Health checks after a configuration change use systemd's restart counter under
systemd and the daemon's pid elsewhere; the log lines returned with a failed change come from the journal or
from the daemon's log file.

On FreeBSD the daemon's log (`/var/log/fips.log`) is created readable by root only; the Logs page offers to let
the fips group read it (helper verb `log-access`), after which it shows the log like the journal on Linux.

## The pf firewall (FreeBSD, macOS)

pf has no fips firewall of its own, so fips-ui provides one that mirrors the Linux baseline: connections
arriving on the FIPS interface (from the daemon: `tun0` on FreeBSD, `utunN` on macOS) are dropped unless a rule
passes them; established connections and pings are allowed.

- Rules live in `/usr/local/etc/fips/pf.d/*.pf`; the rules made on the Firewall page are `fips-ui.pf`. The
  helper renders the baseline and all drop-ins into `/usr/local/etc/fips/fips-ui-firewall.pf` and loads it
  into the anchor `fips-ui/firewall` (macOS: `com.apple/fips-ui-firewall`).
- A drop-in may hold only inbound `pass` or `block` rules on `$tun`, so it cannot affect other interfaces;
  `anchor`, `load`, `table`, redirects and similar are refused, and every change is parsed with `pfctl -n`
  before it is written.
- **Enable** (FreeBSD) adds a marked block to `/etc/pf.conf` (the anchor reference `anchor "fips-ui/*"` and
  `load anchor` for boot), sets `pf_enable=YES` and starts pf if it is not running; the previous pf.conf is
  kept as `/etc/pf.conf.fips-ui.bak`, and a pf.conf that does not exist is created with `pass all` first, so
  only the fips-ui anchors restrict anything. **Disable** removes the block again; pf keeps running with your
  other rules. **Stop** empties the anchor. Check that your own pf.conf keeps SSH open before enabling pf.
- On macOS the anchors go under Apple's existing `com.apple/*` anchor, so `/etc/pf.conf` is not touched; pf is
  not enabled at boot by fips-ui there (use Start after a reboot).

## What the helper does

| Verb | Effect |
| ---- | ------ |
| `config-show [id]` | Prints a `base <sha256>` line, then `fips.yaml` (or a config backup) with each secret value replaced by a numbered placeholder, `"<redacted #N>"`. What is secret is decided from the **parsed YAML tree** (PyYAML's safe composer, run as `python3 -I`), not from text, so escaped, quoted, explicit (`? key`) and flow-style keys are all recognised. Each secret key's value must be a single-line plain or quoted scalar with no anchor, tag or alias, and exactly its characters are replaced. A comment that names a secret key, quotes a secret of 8 or more characters, or holds an `nsec` or 64-hex key (also wrapped over consecutive comment lines, in which case every line holding part of it is hidden) is shown as `# <redacted comment #N>` (the stock `fips.yaml` has one). Otherwise the file is **not shown at all** and the reasons are given; so is a file where a secret value of 8 or more characters (also wrapped over lines) appears in another value, anchor, tag or directive, or an `nsec` or 64-hex key sits outside a secret key and `npub` (also wrapped over consecutive comment lines, which are then hidden together). Shorter secrets (a Tor password such as `control`) are redacted where they are set, but the same word elsewhere is not treated as a copy: it is indistinguishable from the configuration's own words, and refusing it would lock the editor on normal files. Keys treated as secrets: `nsec`, `control_auth`, `secret`, `secret_key`, `private_key`, `password`, `passphrase`, `token`, `api_key`, `auth_token`, `psk`, `preshared_key`, `mnemonic`, `seed`. Needs python3 with PyYAML (Arch `python-yaml`, Debian/Ubuntu `python3-yaml`, Fedora `python3-pyyaml`). |
| `config-apply [--no-restart] --base <sha256>` | Reads the new file from **stdin** and refuses if `fips.yaml` changed since the `base` it was loaded from. Each placeholder #N must be a whole scalar value under the same key at the same path as in the current file, and be used once; a secret line may also be commented out as a whole (`# nsec: "<redacted #1>"`), which puts the value back inside the comment, where it stays hidden. Placeholders anywhere else (other comments, keys, inside longer strings) are refused. A comment placeholder must stay a whole comment and puts the hidden comment back; deleting it deletes the comment. A save is refused if a hidden comment would become visible (it quotes a secret you changed or removed, or a new line splits comment lines that are only sensitive together) or if the result could not be shown again. Only the value's characters are replaced by the original, then the result is parsed again and each secret must be exactly its original value at its original path and appear nowhere else. Deleting a secret deletes it. The current file is backed up, the new one installed (root, 0600) and `fips.service` restarted. Healthy means the unit stays active without systemd restarting it and the control socket (at `node.control.socket_path` if the new file sets it) answers for 8 consecutive seconds within 45 s; with `node.control.enabled: false` only the unit state is checked. Otherwise the backup is reinstalled and the daemon restarted again; the answer carries the journal of the failed start. The helper ignores termination signals while installing or rolling back. |
| `config-backups`, `config-restore <id>` | Lists backups (root-only, newest 20 kept) and reinstalls one with the same health check. |
| `firewall-status` | Unit state and the live `inet fips` table as JSON. |
| `hosts-apply --base <sha256\|none>` (v6) | Reads a new `/etc/fips/hosts` from **stdin**. Every line must be blank, a comment, or `hostname npub [# comment]` (lowercase name of at most 63 characters). Refused if the file changed since the `base` it was read from. The previous file is kept in the config-backups directory (newest 20), the new one installed root:root 0644 atomically; the daemon reloads it on its next lookup. |
| `dropin-apply <name>`, `dropin-delete <name>` | Reads a drop-in from **stdin**. It may contain only rule statements: `include`, `define`, table/chain/flush and similar commands, `;`, `$` and braces that do not balance within a line are refused, so a drop-in can neither read other files nor leave the `inbound` chain. The complete ruleset (baseline plus every drop-in, with this one substituted) is then checked with `nft -c`, and only nft's one-line error summaries are returned. On success `/etc/fips/fips.d/<name>.nft` is written and the firewall reloaded if it is running. |
| `service <action> <unit>` | `start`, `stop`, `restart`, `reload`, `enable`, `disable` for `fips`, `fips-firewall`, `fips-dns`, `fips-gateway`, and (v11) `fips-pubdom`, `fips-pubdom-server`. |
| `pubdom-zone-apply <file> --base <sha256\|none> [--dir <zones-dir>]` (v11) | Reads a zone file for `fips-pubdom-server` from **stdin**, checks it with `fips-pubdom-server validate zone`, refuses if `<file>` changed since it was read, backs it up and writes it atomically (`root:root 0644`) into the zones directory (`zones:` in `/etc/fips-pubdom/server.yaml`, else `/etc/fips-pubdom/zones`). `<file>` is a plain `<name>.yaml`; `--dir` is the directory the running server reports, and the helper refuses when it is not the one it would write to. See [public-domains.md](public-domains.md). |
| `pubdom-zone-delete <file> [--dir <zones-dir>]` (v11) | Removes a zone file; a backup is kept. |
| `pubdom-config-apply <server\|resolver> [--no-restart] --base <sha256\|none>` (v11) | Reads `/etc/fips-pubdom/server.yaml` or `config.yaml` from **stdin**, checks it with the binary's own `validate config`, refuses if the file changed, backs it up, writes it atomically and restarts the unit if it was running. |
| `pubdom-install <server\|resolver> [vX.Y.Z]` (v12) | Downloads the newest (or the given) fips-pub-domains release from GitHub (`FIPS_UI_PUBDOM_REPO`, default `fr34aky/fips-pub-domains`), verifies it against its `SHA256SUMS`, installs the three binaries to `/usr/bin` and the side's unit; the resolver gets `fips-pubdomd setup` when it has no `config.yaml` yet, the server its zones directory, the firewall drop-in where `/etc/fips/fips.d` exists, and `init`'s `server.yaml`; the unit is enabled and started. systemd only. |
| `pubdom-update [vX.Y.Z]` (v12) | The same fetch and verification; the binaries and every installed unit are replaced and the units that were running restarted. |

Content is passed on stdin rather than as a file path so it cannot be swapped between validation and
install. Secret values are never printed by the helper, never sent to the browser, and never stored
by the UI. Every changing verb, including the upgrade verbs, takes a system-wide lock
(`/var/run/fips-ui-helper.lock`), so two operations never overlap; the UI also refuses to start an upgrade
while a configuration change runs and the other way round. Config backups live in a fixed root-only
directory (`/var/lib/fips-ui/config-backups` on Linux) that callers cannot redirect.

## What the redaction protects, and what it does not

Redaction keeps secret values off screens, out of the browser, its cache, logs and screenshots, and away from
accidental copying: the values never leave the helper. It is **not** a boundary against someone allowed to
edit `fips.yaml`. Such a person can always make the daemon use a secret somewhere else (for example point
the Tor control address at a listener of their own, which then receives the control password), or learn a
weak value by trial. That is why only admins may edit the configuration, and why admin rights, locally or
over the mesh, should be treated as equivalent to root on the node.

List entries are identified by their `npub`, `alias`, `name` or `id` (or their position if they have none),
so a secret stays bound to its entry while the entry's other fields, and other entries, are edited freely.

## Firewall rules made by the UI

Rules created on the Firewall page live in `/etc/fips/fips.d/fips-ui.nft`. Each rule line is preceded by a
`# fips-ui-rule {…}` comment with its definition so the page can read it back; manual edits to that file
are overwritten. Sources can be anyone on the mesh, specific nodes (npubs or hosts-file names, converted
to their `fd00::/8` address with `fipsctl address`), or `fd00::/8` prefixes. Other drop-ins, such as ones
shipped by other software, are shown and can be edited raw with the same validation.

## Security considerations

With helper v4 installed, whoever can make state-changing requests to the UI can rewrite the daemon's
configuration and firewall as root. The browser-origin checks (see the README) stop other websites from
doing that through your browser, and read-only mode (`FIPS_UI_READ_ONLY=1`) turns it off entirely. The
remaining exposure is **other local users of the same host**: the loopback listener does not know which
local account is connecting. On a shared machine, set `FIPS_UI_TOKEN`.

To remove the capability, delete `/etc/sudoers.d/fips-ui` and `/usr/local/libexec/fips-ui-helper`.
