# Installing fips-ui

fips-ui runs from a git checkout, on the same machine as the fips daemon. Everywhere the steps are the same:
install the prerequisites, clone and build, then run it as a service. What differs per system is where the
prerequisites come from and which service manager `deploy/setup-local.sh` sets up.

| System | `setup-local.sh` installs | Settings file | Log | Status |
| ------ | ------------------------- | ------------- | --- | ------ |
| [Linux with systemd](#linux-with-systemd) | systemd unit `fips-ui.service` | `/etc/default/fips-ui` | `journalctl -u fips-ui` | tested |
| [FreeBSD](#freebsd) | rc.d script `fips_ui` (daemon(8)) | `/usr/local/etc/fips-ui.env` | `/var/log/fips-ui.log` | tested (FreeBSD 15.1 VM) |
| [pfSense](#pfsense) | boot script `rc.d/fips-ui.sh` (daemon(8)) | `/usr/local/etc/fips-ui.env` | `/var/log/fips-ui.log` | untested, see the warning |
| [macOS](#macos) | LaunchDaemon `network.fips-ui` | the plist itself | `/usr/local/var/log/fips-ui.log` | experimental, untested |
| [Other Linux](#other-linux-openrc-openwrt) (OpenRC, OpenWrt) | nothing: run it by hand | – | – | read-only pages |
| [Windows](#windows) | nothing: run it by hand | – | – | experimental, untested |

What `setup-local.sh` does on every supported system:

1. Checks the preconditions before changing anything: run with sudo, the `fips` group exists (the daemon is
   installed), `web/dist` is built, Node 22.18+, 23.6+ or 24+.
2. Finds node the way your login shell does (nvm, mise, volta, Homebrew) and pins the real binary, so the
   service does not depend on shims.
3. Installs the privileged helper `/usr/local/libexec/fips-ui-helper` and one sudoers rule for the UI user
   ([node-management.md](node-management.md)).
4. Adds the UI user to the `fips` group (the daemon's control socket), and on systemd to `systemd-journal`.
5. Installs the service. It runs fips-ui from the checkout as the UI user, starts it at boot and restarts it
   when it exits, which is how fips-ui restarts after [updating itself](self-update.md).
6. (Re)starts it and checks `/api/health`.

Arguments: `sudo ./deploy/setup-local.sh [ui-user] [node-binary]`. The UI user defaults to the one running
sudo. Run it again after moving the checkout, changing node, or when a release ships a newer helper; it keeps an
existing settings file.

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

## FreeBSD

```sh
# Prerequisites (as root); python and PyYAML only for the configuration editor
pkg install git bash sudo node24 npm-node24 python3 py312-pyyaml

git clone https://github.com/fr34aky/fips-ui.git && cd fips-ui
npm run install:all && npm run build
sudo ./deploy/setup-local.sh
```

- The fips daemon must be installed first (its package creates the `fips` group). The PyYAML package is named
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
   [upgrade.md](upgrade.md)).
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

Experimental: the code paths exist but have not been tested on a Mac.

```sh
brew install node git                     # node 22.18+
sudo /usr/bin/python3 -m pip install pyyaml  # configuration editor (the helper uses the system python)

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

## Windows

Experimental: the code paths exist but have not been tested on Windows.

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
