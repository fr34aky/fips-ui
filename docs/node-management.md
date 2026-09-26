# Node management

The **Configuration** and **Firewall** pages change the node itself: `/etc/fips/fips.yaml`, the fips0
nftables firewall and the fips systemd units. All of it needs root, and all of it goes through the same
privileged helper as upgrades (`scripts/fips-ui-helper`, installed by `deploy/setup-local.sh`). Version 3
of the helper is required; older helpers keep upgrades working and the pages explain how to update.

## What the helper does

| Verb | Effect |
| ---- | ------ |
| `config-show [id]` | Prints `fips.yaml` (or a config backup) with secret values replaced by `"<redacted>"`. Keys treated as secrets: `nsec`, `secret`, `secret_key`, `private_key`, `password`, `passphrase`, `token`, `api_key`. |
| `config-apply [--no-restart]` | Reads the new file from **stdin**, restores every `"<redacted>"` value from the current file (matched by key and occurrence), backs the current file up, installs the new one (root, 0600), restarts `fips.service` and waits for it to be active and answering on its control socket three times in a row. If it does not, the backup is reinstalled and the daemon restarted again; the answer carries the daemon's journal from the failed attempt. |
| `config-backups`, `config-restore <id>` | Lists backups (root-only, newest 20 kept) and reinstalls one with the same health check. |
| `firewall-status` | Unit state and the live `inet fips` table as JSON. |
| `dropin-apply <name>`, `dropin-delete <name>` | Reads a drop-in from **stdin**, validates the complete ruleset (baseline plus every drop-in, with this one substituted) with `nft -c`, then writes `/etc/fips/fips.d/<name>.nft` and reloads the firewall if it is running. |
| `service <action> <unit>` | `start`, `stop`, `restart`, `reload`, `enable`, `disable` for `fips`, `fips-firewall`, `fips-dns`, `fips-gateway` only. |

Content is passed on stdin rather than as a file path so it cannot be swapped between validation and
install. Secret values are never printed by the helper, never sent to the browser, and never stored
by the UI.

## Firewall rules made by the UI

Rules created on the Firewall page live in `/etc/fips/fips.d/fips-ui.nft`. Each rule line is preceded by a
`# fips-ui-rule {…}` comment with its definition so the page can read it back; manual edits to that file
are overwritten. Sources can be anyone on the mesh, specific nodes (npubs or hosts-file names, converted
to their `fd00::/8` address with `fipsctl address`), or `fd00::/8` prefixes. Other drop-ins, such as ones
shipped by other software, are shown and can be edited raw with the same validation.

## Security considerations

With helper v3 installed, whoever can make state-changing requests to the UI can rewrite the daemon's
configuration and firewall as root. The browser-origin checks (see the README) stop other websites from
doing that through your browser, and read-only mode (`FIPS_UI_READ_ONLY=1`) turns it off entirely. The
remaining exposure is **other local users of the same host**: the loopback listener does not know which
local account is connecting. On a shared machine, set `FIPS_UI_TOKEN`.

To remove the capability, delete `/etc/sudoers.d/fips-ui` and `/usr/local/libexec/fips-ui-helper`.
