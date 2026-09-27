# Updating fips-ui itself

fips-ui can install its own new releases from the **Upgrade** page (card **fips-ui (this dashboard)**). This is
separate from upgrading the fips daemon ([upgrade.md](upgrade.md)).

## Finding new releases

The server asks GitHub for the newest release of `fr34aky/fips-ui` about 10 seconds after it starts and then
every 6 hours; **Check now** asks at once. Releases are published from tags
(`vX.Y.Z`, see [CONTRIBUTING.md](../CONTRIBUTING.md#releasing)); a bare tag without a release, a draft and a
pre-release are not offered. A newer release shows as **vX available** next to the version in the
sidebar (admins go to the Upgrade page from it, others to the release notes), and the card shows its release
notes. Each check is one GitHub API request; unauthenticated requests are limited to 60 per hour per public IP
address. Set `FIPS_UI_GITHUB_TOKEN` (a token without any permissions is enough) in the settings file
(`/etc/default/fips-ui`, on FreeBSD and pfSense `/usr/local/etc/fips-ui.env`) to lift that.

## Version

The version in the sidebar comes from the checkout: the release tag it is on (`0.8.0`), or the last tag and the
number of commits after it (`0.8.0+3`, for a checkout that follows `main`). Such a checkout counts as that
release: it is offered the next one. Without git history fips-ui shows `package.json`'s version instead.

## What Update does

1. **Checks the installation**: fips-ui must run from a git checkout of the release repository, on a branch,
   without local changes. Otherwise the card explains why it cannot update itself.
2. `git fetch --tags`, then **fast-forwards** the checkout to the release tag. A checkout with commits that are
   not in the release (ahead of it or diverged) is refused, never rewritten.
3. `npm ci` for the frontend when its dependencies changed or its build tools are missing (with
   `--include=dev`: the service runs with `NODE_ENV=production`), then `npm run build`.
4. **Self-test**: starts the new server once in a mode without side effects, on a spare loopback port. If it
   does not come up, the update fails.
5. If any step fails, the checkout is put back to the previous commit and rebuilt; the running service is
   never touched. The previous commit is also written to `.git/fips-ui-previous`, with the command to go back
   by hand (`git reset --hard <commit> && npm run build`).
6. **Restart**: the server exits (status 75) and its service manager starts the new version (systemd's
   `Restart=on-failure`, daemon(8) on FreeBSD and pfSense, launchd's KeepAlive on macOS); the page reloads when the new version answers. The restart waits while a fips upgrade or a
   node-management change is running, and an update cannot start during one.

Commands run with the running node's directory first on `PATH`, so `npm` is found when node comes from nvm,
mise or a tarball.

## A newer helper

A release may ship a newer privileged helper (`scripts/fips-ui-helper`). The UI cannot install it (it runs with
its own user's rights only); the card says when the installed helper is older than the shipped one. Install
it with:

```sh
sudo ./deploy/setup-local.sh
```

## Other systems

The update works wherever fips-ui runs from a git checkout (on Windows `npm.cmd` is used). It restarts itself
under systemd and under the services `deploy/setup-local.sh` installs on FreeBSD, pfSense and macOS (they set
`FIPS_UI_SUPERVISED=1`: exiting restarts fips-ui). Elsewhere it builds the new version and asks you to restart
fips-ui ([install.md](install.md)).

## Variables

| Variable | Purpose | Default |
| -------- | ------- | ------- |
| `FIPS_UI_REPO` | GitHub "owner/repo" whose releases are installed | `fr34aky/fips-ui` |
| `FIPS_UI_GITHUB_TOKEN` | lifts the GitHub API limit (shared with the daemon upgrade) | – |
