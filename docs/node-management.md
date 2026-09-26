# Node management

The **Configuration** and **Firewall** pages change the node itself: `/etc/fips/fips.yaml`, the fips0
nftables firewall and the fips systemd units. All of it needs root, and all of it goes through the same
privileged helper as upgrades (`scripts/fips-ui-helper`, installed by `deploy/setup-local.sh`). Version 3
of the helper is required; older helpers keep upgrades working and the pages explain how to update.

## What the helper does

| Verb | Effect |
| ---- | ------ |
| `config-show [id]` | Prints a `base <sha256>` line, then `fips.yaml` (or a config backup) with each secret value replaced by a numbered placeholder, `"<redacted #N>"`. What is secret is decided from the **parsed YAML tree** (PyYAML's safe composer, run as `python3 -I`), not from text, so escaped, quoted, explicit (`? key`) and flow-style keys are all recognised. Each secret key's value must be a single-line plain or quoted scalar with no anchor, tag or alias, and exactly its characters are replaced. Otherwise the file is **not shown at all** and the reasons are given; so is a file where a secret value also appears elsewhere (a comment, another key) or an `nsec` value sits outside a secret key. Keys treated as secrets: `nsec`, `control_auth`, `secret`, `secret_key`, `private_key`, `password`, `passphrase`, `token`, `api_key`, `auth_token`, `psk`, `preshared_key`, `mnemonic`, `seed`. Needs python3 with PyYAML (Arch `python-yaml`, Debian/Ubuntu `python3-yaml`, Fedora `python3-pyyaml`). |
| `config-apply [--no-restart] --base <sha256>` | Reads the new file from **stdin** and refuses if `fips.yaml` changed since the `base` it was loaded from. Each placeholder #N must be a whole scalar value under the same key at the same path as in the current file, and be used once; placeholders anywhere else (comments, keys, inside longer strings) are refused. Only the value's characters are replaced by the original, then the result is parsed again and each secret must be exactly its original value at its original path and appear nowhere else. Deleting a secret deletes it. The current file is backed up, the new one installed (root, 0600) and `fips.service` restarted. Healthy means the unit stays active without systemd restarting it and the control socket (at `node.control.socket_path` if the new file sets it) answers for 8 consecutive seconds within 45 s. Otherwise the backup is reinstalled and the daemon restarted again; the answer carries the journal of the failed start. The helper ignores termination signals while installing or rolling back. |
| `config-backups`, `config-restore <id>` | Lists backups (root-only, newest 20 kept) and reinstalls one with the same health check. |
| `firewall-status` | Unit state and the live `inet fips` table as JSON. |
| `dropin-apply <name>`, `dropin-delete <name>` | Reads a drop-in from **stdin**. It may contain only rule statements: `include`, `define`, table/chain/flush and similar commands, `;`, `$` and braces that do not balance within a line are refused, so a drop-in can neither read other files nor leave the `inbound` chain. The complete ruleset (baseline plus every drop-in, with this one substituted) is then checked with `nft -c`, and only nft's one-line error summaries are returned. On success `/etc/fips/fips.d/<name>.nft` is written and the firewall reloaded if it is running. |
| `service <action> <unit>` | `start`, `stop`, `restart`, `reload`, `enable`, `disable` for `fips`, `fips-firewall`, `fips-dns`, `fips-gateway` only. |

Content is passed on stdin rather than as a file path so it cannot be swapped between validation and
install. Secret values are never printed by the helper, never sent to the browser, and never stored
by the UI. Every changing verb, including the upgrade verbs, takes a system-wide lock
(`/var/run/fips-ui-helper.lock`), so two operations never overlap; the UI also refuses to start an upgrade
while a configuration change runs and the other way round. Config backups live in a fixed root-only
directory (`/var/lib/fips-ui/config-backups` on Linux) that callers cannot redirect.

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
