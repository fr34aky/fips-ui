# Installing fips-ui

fips-ui runs from a git checkout, on the same machine as the fips daemon. Everywhere the steps are the same:
install the prerequisites, clone and build, then run it as a service. What differs per system is where the
prerequisites come from and which service manager `deploy/setup-local.sh` sets up.

| System | `setup-local.sh` installs | Settings file | Log | Status |
| ------ | ------------------------- | ------------- | --- | ------ |
| [Linux with systemd](#linux-with-systemd) | systemd unit `fips-ui.service` | `/etc/default/fips-ui` | `journalctl -u fips-ui` | tested, smoke-tested in CI (Ubuntu 24.04) |
| [NixOS](#nixos) | the flake's NixOS module (`services.fips-ui`), next to upstream's `services.fips` | the module's options | `journalctl -u fips-ui` | NixOS VM test in CI |
| [FreeBSD](#freebsd) | rc.d script `fips_ui` (daemon(8)) | `/usr/local/etc/fips-ui.env` | `/var/log/fips-ui.log` | tested (FreeBSD 15.1 VM), smoke-tested in CI |
| [pfSense](#pfsense) | boot script `rc.d/fips-ui.sh` (daemon(8)) | `/usr/local/etc/fips-ui.env` | `/var/log/fips-ui.log` | untested (no CI image), see the warning |
| [macOS](#macos) | LaunchDaemon `network.fips-ui` | the plist itself | `/usr/local/var/log/fips-ui.log` | experimental, smoke-tested in CI |
| [Other Linux](#other-linux-openrc-openwrt) (OpenRC, OpenWrt) | nothing: run it by hand | – | – | read-only pages; CI runs it by hand on Debian, Fedora, Arch and Alpine, not under OpenRC or OpenWrt |
| [Windows](#windows) | nothing: run it by hand | – | – | experimental, smoke-tested in CI |

What `setup-local.sh` does on every supported system:

1. Checks the preconditions before changing anything: run with sudo, `web/dist` is built, Node 22.18+, 23.6+
   or 24+.
2. Finds node the way your login shell does (nvm, mise, volta, Homebrew) and pins the real binary, so the
   service does not depend on shims.
3. Checks that the fips daemon is installed. If it is not, it offers to install the newest fips release with a
   persistent identity and bootstrap peers ([below](#installing-the-fips-daemon)), or leaves it for the
   Upgrade page.
4. Installs the privileged helper `/usr/local/libexec/fips-ui-helper` and one sudoers rule for the UI user
   ([node-management.md](node-management.md)).
5. Adds the UI user to the `fips` group (the daemon's control socket), and on systemd to `systemd-journal`.
6. Installs the service. It runs fips-ui from the checkout as the UI user, starts it at boot and restarts it
   when it exits, which is how fips-ui restarts after [updating itself](self-update.md).
7. (Re)starts it and checks `/api/health`.

Arguments: `sudo ./deploy/setup-local.sh [--install-fips|--no-install-fips] [--fips-test-peer]
[--fips-peer npub1...@udp/host:port]... [ui-user] [node-binary]`. The UI
user defaults to the one running sudo. Run it again after moving the checkout, changing node, or when a release ships a newer helper; it keeps an
existing settings file.

## Installing the fips daemon

fips-ui can install fips on a machine that does not have it yet, in two places:

- **`setup-local.sh`** asks whether to install the newest fips release (`--install-fips` installs without
  asking, for scripts; `--no-install-fips` skips it). It then asks for bootstrap peers, or takes them as
  `--fips-test-peer` (the public test node) and `--fips-peer npub1...@udp/host:port` (repeatable). The same step on
  its own is `sudo ./deploy/install-fips.sh [--tag vX.Y.Z] [--test-peer] [--peer npub1...@udp/host:port]...`.
- **The Upgrade page**, when fips-ui runs without fips (for example after `setup-local.sh --no-install-fips`),
  shows an **Install fips** card instead of the upgrade sources, with the same peer choices. It needs helper v9.

Both run the privileged helper's `daemon-install` verb. It downloads the release from
[jmcorgan/fips](https://github.com/jmcorgan/fips/releases) itself, so the web UI chooses at most the version,
never the file, and checks it against the release's `checksums-<os>.txt`:

| System | Package | How |
| ------ | ------- | --- |
| Debian, Ubuntu | `fips_<version>_<amd64\|arm64>.deb` | `apt-get install` |
| Other Linux with systemd | `fips-<version>-linux-<x86_64\|aarch64>.tar.gz` | the tarball's `install.sh` |
| FreeBSD | `fips-<version>-freebsd-<arch>.pkg` | `pkg add`, `sysrc fips_enable=YES` |
| pfSense | `fips-<version>-pfsense-<product>-<arch>.pkg` for this pfSense's ABI | `pkg add` |
| macOS | `fips-<version>-macos-<arm64\|x86_64>.pkg` | `installer -pkg` |

Before the daemon's first start it adjusts the release's `fips.yaml`, which would otherwise start an isolated
node with a new identity at every start and no peers:

- `node.identity.persistent: true`: the key is generated once and kept (`fips.key` next to `fips.yaml`), so the
  node's npub stays the same. fips-ui's mesh access and hosts names are per npub.
- `peers:` the bootstrap peers chosen, each with `connect_policy: auto_connect`. The public test node is the
  one upstream's template lists (`test-us01.fips.network:2121`). Without any peer the node only reaches peers
  that connect to it.

Everything else stays as the release ships it; change it on the **Configuration** page. The helper then starts
fips, waits for its control socket and adds the UI's user to the `fips` group. On the Upgrade page fips-ui then
restarts itself to join that group (under the services `setup-local.sh` installs), and the page reloads.

An installed fips (a binary, its socket, service or group) is never touched by this step; upgrade it from the
**Upgrade** page ([upgrade.md](upgrade.md)). Run as root, `FIPS_UI_FIPS_ARTIFACT=tarball` prefers the tarball,
`FIPS_UI_PFSENSE_PRODUCT` names the pfSense product and `FIPS_UI_FIPS_REPO` installs from another repository;
through the UI (sudo) they do not apply.

## After the setup

The dashboard listens on `http://127.0.0.1:8321`. Open it from another machine through an SSH tunnel
(`ssh -L 8321:127.0.0.1:8321 node`), or turn on [Web UI over the mesh](mesh-access.md). Settings such as
`FIPS_UI_TOKEN` or `FIPS_UI_GITHUB_TOKEN` go into the settings file (see the README's Configuration section);
restart the service after changing it.

## Linux with systemd

```sh
# Prerequisites (pick your distribution)
sudo apt install git python3-yaml nftables          # Debian, Ubuntu (Node: nodesource.com or nvm/mise)
sudo dnf install git nodejs python3-pyyaml nftables # Fedora
sudo pacman -S git nodejs npm python-yaml nftables  # Arch

git clone https://github.com/fr34aky/fips-ui.git && cd fips-ui
npm run install:all && npm run build
sudo ./deploy/setup-local.sh
```

Distribution packages of Node are often older than 22.18 (Debian 12 ships 18, Ubuntu 24.04 ships 18);
use nodesource, nvm or mise there. `python3` with PyYAML is only needed for the configuration editor, `nft` only
for the firewall and Web UI over the mesh.

Manage it with `sudo systemctl restart fips-ui`, logs with `journalctl -u fips-ui -f`. A dedicated service
account instead of your own user is described in the README (Running as a service).

## NixOS

`setup-local.sh` does not fit NixOS: units, sudo rules and packages are declared in the NixOS configuration. fips-ui
ships a flake with a package and a NixOS module instead, to use next to upstream fips' own module
([packaging/nixos](https://github.com/jmcorgan/fips/tree/master/packaging/nixos)):

```nix
# flake.nix
{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    fips = { url = "github:jmcorgan/fips"; inputs.nixpkgs.follows = "nixpkgs"; };
    fips-ui = { url = "github:fr34aky/fips-ui"; inputs.nixpkgs.follows = "nixpkgs"; };
  };
  outputs = { nixpkgs, fips, fips-ui, ... }: {
    nixosConfigurations.mynode = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      modules = [
        ./configuration.nix
        fips.nixosModules.default
        fips-ui.nixosModules.default
        {
          nixpkgs.overlays = [ fips.overlays.default ];
          services.fips.enable = true;
          services.fips-ui.enable = true;
        }
      ];
    };
  };
}
```

Then `sudo nixos-rebuild switch --flake .#mynode`. To follow a release, pin the input to its tag
(`github:fr34aky/fips-ui/v0.8.0`).

| Option | Default | |
| ------ | ------- | --- |
| `services.fips-ui.enable` | `false` | Run fips-ui as `fips-ui.service`. |
| `services.fips-ui.user` | `"fips-ui"` | The user it runs as; the default is a system user. Any user is added to the `fips` and `systemd-journal` groups. |
| `services.fips-ui.host`, `.port` | `127.0.0.1`, `8321` | Where the dashboard listens. |
| `services.fips-ui.environment` | `{ }` | Further `FIPS_UI_*` settings (README). |
| `services.fips-ui.environmentFile` | `null` | A file with secrets such as `FIPS_UI_TOKEN`, read by systemd. |
| `services.fips-ui.helper.enable` | `true` | The privileged helper, with its tools on its PATH, and one NOPASSWD sudo rule for the UI user. |
| `services.fips-ui.meshAccess.openFirewall` | `false` | Open the dashboard's port on `fips0` in the NixOS firewall, for Web UI over the mesh. |

What is different on NixOS:

- **fips and fips-ui are updated with the flake** (`nix flake update fips fips-ui`, then `nixos-rebuild switch`). The
  Upgrade page says so instead of installing, upgrading or rolling back fips, and fips-ui's own update card points
  to the flake.
- The **configuration editor** edits `/var/lib/fips/fips.yaml`, where upstream's module keeps it, with the usual
  backup, health check and rollback; the file keeps its mode (group-writable for `fips`). The hosts file keeps
  upstream's `root:fips 0664`.
- **Services** can be started, stopped and restarted; whether they start at boot is part of the configuration.
- The **Firewall page** does not apply: NixOS declares its firewall, and upstream's module has no
  `fips-firewall` unit. **Web UI over the mesh** works: its guard is a separate nftables table that fips-ui
  loads through the helper (a rebuild that flushes nftables removes it; fips-ui then stops mesh access until it has
  loaded it again). Open the port on `fips0` with `meshAccess.openFirewall`.
- The frontend is built by Nix from `web/package-lock.json`; the native build tools (rolldown, Tailwind's oxide,
  lightningcss) are patched for the Nix store, so `programs.nix-ld` is not needed.

## FreeBSD

```sh
# Prerequisites (as root); python and PyYAML only for the configuration editor
pkg install git bash sudo node24 npm-node24 python3 py312-pyyaml

git clone https://github.com/fr34aky/fips-ui.git && cd fips-ui
npm run install:all && npm run build
sudo ./deploy/setup-local.sh
```

- Without fips, the script offers to install the FreeBSD package (see above). The PyYAML package is named
  after the Python version (`py312-pyyaml`, `py311-pyyaml`, …: `pkg search pyyaml`).
- `bash` is needed by the setup script and the helper; they are started through `#!/usr/bin/env bash`.
- The service is `/usr/local/etc/rc.d/fips_ui`, enabled with `sysrc fips_ui_enable=YES`. It runs node under
  daemon(8), which restarts it after it exits. Manage it with `sudo service fips_ui restart|stop|status`.
- The Firewall and Web UI over the mesh use pf anchors; enabling them adds marked lines to `/etc/pf.conf`
  ([node-management.md](node-management.md#the-pf-firewall-freebsd-macos)).
- The login shell's greeting (the `fortune` tips) is ignored when the script looks for node.

## pfSense

> **Warning:** fips-ui needs Node, bash and git, which are not pfSense packages. Netgate does not support
> installing packages from the FreeBSD repositories on pfSense: it can break the system or the next pfSense
> upgrade. Do this only on a firewall you can reinstall, and at your own risk. fips-ui must run on the node it
> manages, so there is no way around it other than not running fips-ui on pfSense.

Steps, if you accept that:

1. Install the fips daemon's pfSense package (the one matching your pfSense version, see
   [upgrade.md](upgrade.md)), or let `setup-local.sh` install it in step 4.
2. Install sudo from **System → Package Manager** (the official `sudo` package).
3. Install Node (22.18+), npm, bash and git from the FreeBSD repository matching your pfSense's FreeBSD base,
   for example by enabling that repository temporarily in `/usr/local/etc/pkg/repos/` or with
   `pkg add <url of the .pkg>`.
4. As a normal user with a home directory (create one under **System → User Manager**, with shell access):

   ```sh
   git clone https://github.com/fr34aky/fips-ui.git && cd fips-ui
   npm run install:all && npm run build
   sudo ./deploy/setup-local.sh
   ```

- The service is the boot script `/usr/local/etc/rc.d/fips-ui.sh`; pfSense runs every `*.sh` there at boot.
  Manage it with `sudo /usr/local/etc/rc.d/fips-ui.sh restart|stop|status`.
- The Firewall page and Web UI over the mesh are not available: pfSense owns pf and rewrites its rules.
  Configure access to port 8321 in pfSense's own firewall rules instead, or use an SSH tunnel.
- After a pfSense upgrade check that node still runs (`node -v`) and run `setup-local.sh` again.

## macOS

Experimental: CI installs it with `setup-local.sh` on macOS 15 next to the fips package and checks the
helper, the configuration editor, the pf state and the restart; configuration changes, the firewall and Web UI
over the mesh have not been tried on a Mac.

```sh
brew install node git                     # node 22.18+
# Configuration editor: PyYAML for the python3 the helper finds on the service's PATH (node's directory first,
# so Homebrew's python when node comes from Homebrew)
sudo PIP_BREAK_SYSTEM_PACKAGES=1 $(PATH="$(dirname "$(command -v node)"):/usr/local/bin:/usr/bin" command -v python3) -m pip install pyyaml

git clone https://github.com/fr34aky/fips-ui.git && cd fips-ui
npm run install:all && npm run build
sudo ./deploy/setup-local.sh
```

- The service is the LaunchDaemon `/Library/LaunchDaemons/network.fips-ui.plist`. It starts at boot and after
  a non-zero exit. Manage it with `sudo launchctl kickstart -k system/network.fips-ui` (restart) and
  `sudo launchctl bootout system/network.fips-ui` (stop).
- There is no settings file: add `FIPS_UI_*` variables under `EnvironmentVariables` in the plist (root-only,
  mode 0600), then `sudo launchctl bootout system/network.fips-ui && sudo launchctl bootstrap system
  /Library/LaunchDaemons/network.fips-ui.plist`. Running `setup-local.sh` again rewrites the plist and drops
  them.
- If the fips package creates no `fips` group, the UI user must be able to open the daemon's control socket
  some other way (for example by being the user that runs the daemon).
- The Firewall and Web UI over the mesh use pf anchors below Apple's `com.apple/*` anchor; `/etc/pf.conf` is
  not changed.

## Other Linux (OpenRC, OpenWrt)

`setup-local.sh` supports systemd only. The read-only pages, service state and logs work
([README](../README.md#operating-systems)); node management does not. Install node, clone and build as above,
then run fips-ui with your init system, for example on OpenRC a service that runs, as a user in the `fips`
group, in the checkout directory:

```sh
NODE_ENV=production node server/index.ts
```

fips-ui can still update itself from the Upgrade page; restart it afterwards by hand.

On Alpine and other musl systems the fips release binaries do not run (they are built for glibc); build the
daemon from source there. fips-ui itself runs on Alpine's `nodejs-current`.

## Windows

Experimental: CI only checks that fips-ui builds, starts and answers (without a daemon).

```powershell
winget install OpenJS.NodeJS.LTS Git.Git

git clone https://github.com/fr34aky/fips-ui.git; cd fips-ui
npm run install:all; npm run build
npm start
```

- fips-ui talks to the daemon over TCP `127.0.0.1:21210`; no group membership is needed.
- There is no helper. The configuration editor and service buttons are unavailable; the hosts file
  (`%ProgramData%\fips\hosts`) and daemon upgrades need fips-ui to run elevated (from an Administrator shell).
- To start it at boot, create a Task Scheduler task "At startup" that runs `node server\index.ts` with the
  checkout as its start folder. fips-ui cannot restart itself there: after a self-update, restart the task.
