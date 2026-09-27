# Contributing to FIPS UI

<!-- markdownlint-disable MD013 -->

FIPS UI is a web dashboard for a single [FIPS](https://github.com/jmcorgan/fips)
mesh node. It is deliberately small, and the architecture is three layers:

- **Control-socket client** (`server/control.ts`) — speaks the daemon's
  line-delimited JSON protocol, one request per connection, exactly as
  documented in the upstream
  [control-socket reference](https://github.com/jmcorgan/fips/blob/master/docs/reference/control-socket.md).
  Nothing else in the tree talks to the socket.
- **API server** (`server/index.ts`, `journal.ts`, `system.ts`,
  `upgrade.ts`) — a zero-dependency Node HTTP server. It proxies the
  read-only `show_*` queries through an allow-list, polls a fixed set
  of them while at least one browser is connected and fans the result
  out over Server-Sent Events, follows `journalctl -u fips`, reads
  systemd unit state, and exposes the few mutating actions (connect,
  disconnect, probe, service control, upgrade).
- **Frontend** (`web/`) — Vite, React, Tailwind and uPlot. One file
  per page under `web/src/views/`, shared pieces under
  `web/src/components/`, the API client and live store under
  `web/src/lib/`.

The one place privilege crosses a boundary is the upgrade path:
`scripts/fips-ui-helper` is the only root-capable code, reached via a
single sudoers rule installed by an administrator from a shell. The
web process itself never runs as root and never handles a sudo
password. Changes anywhere near that boundary get the strictest review
in the project; see [docs/upgrade.md](docs/upgrade.md) for the model.

Most changes are visible against a live node, and there is no mock
daemon. Run your change against a real `fips` daemon (a node joined to
the public test mesh is enough) before opening a PR.

## Quick start

```bash
git clone https://github.com/fr34aky/fips-ui.git
cd fips-ui
npm run install:all      # frontend dependencies; the server has none
npm run dev              # API on :8321 with reload, Vite on :5173 with proxy
```

Requirements: Node.js 22.18+, 23.6+ or 24+ (the server is TypeScript executed
directly by Node with type stripping, so no parameter properties,
enums or other syntax that needs transformation), and membership in
the `fips` group so `/run/fips/control.sock` is reachable. The Logs
page needs `journalctl` access to the fips unit.

A production build and run is:

```bash
npm run build && npm start
```

## Branches

There is one long-lived branch, `main`. Open PRs against it. Tags mark
releases (see [Releasing](#releasing)) and [CHANGELOG.md](CHANGELOG.md)
records what changed between them.

## Reporting bugs

Search [open issues](https://github.com/fr34aky/fips-ui/issues) before
filing a new one.

When you open a bug report, please include:

- **FIPS UI commit** (`git rev-parse --short HEAD`) and how it runs
  (`npm run dev`, `npm start`, or the systemd unit).
- **Node version** (`node -v`) and **FIPS version** (`fipsctl --version`).
- **OS / distro** and, for frontend bugs, the browser and version.
- **What you expected to happen** and **what actually happened**.
- **Reproduction steps**, minimal and deterministic where you can.
- **Evidence** — the browser console for frontend bugs, the UI's
  output (`journalctl -u fips-ui` when running as a service) for
  backend bugs, and the relevant `fipsctl show <x>` JSON when the
  page renders daemon state wrongly. Redact npubs and addresses if
  you prefer; shapes matter more than values.

One issue per bug.

## Submitting pull requests

### Scope discipline

Every PR should make one logical change. The reviewer should be able
to read the whole diff and trace every line back to the PR's stated
purpose.

- No drive-by reformatting of unrelated files.
- No unrelated refactors folded into a bug fix or a feature PR.
- No "while I was in there" cleanups outside the change's natural
  footprint. Send them separately; they land faster on their own.

### Required before opening any PR

Run these locally and confirm they pass:

```bash
npm run build                        # tsc -b (strict) + vite build
npm --prefix web run lint            # oxlint
node --check server/index.ts         # server parses under type stripping
bash -n scripts/fips-ui-helper deploy/*.sh
```

Then exercise the change against a live daemon. For UI changes,
look at the result in both themes and at phone width; for backend
changes, hit the endpoint with `curl` and confirm the shape the
frontend expects.

### Self-review against the project review checklist

The 13-criteria checklist used on every incoming PR is published at
[PR-REVIEW.md](PR-REVIEW.md). Run your own change through it before
opening, or hand the document to your coding agent with "review my
branch against this checklist". It is the first thing that happens to
any submission, so doing it yourself saves a round trip.

### Additional requirements for feature PRs

- **Documentation updated alongside the code.** New environment
  variables and endpoints go in [README.md](README.md); anything
  touching the upgrade flow updates [docs/upgrade.md](docs/upgrade.md).
- **A CHANGELOG entry** under `[Unreleased]`.
- **Screenshots** in the PR body for anything visual.

### Additional requirements for changes to the privilege boundary

Changes to `scripts/fips-ui-helper`, `deploy/`, or the upgrade
module's calls into them must:

- keep the helper the only root-capable path and keep its verb set
  narrow and argument-validated;
- never introduce a way for the web process to prompt for, receive,
  or forward a sudo or account password;
- state in the PR body what a caller who can reach the endpoint can
  now do as root that they could not before.

### Merge mechanics

PRs are squash-merged. One logical change per PR becomes one commit
on `main`; the commit message is rewritten at merge time, so in-PR
history does not need to be pretty.

## Releasing

Not every merged change is a release. Changes collect under `[Unreleased]` in
[CHANGELOG.md](CHANGELOG.md) until the maintainer decides to release them;
a release is then a single tag:

```bash
git switch main && git pull
git tag -a v0.8.0 -m "fips-ui 0.8.0"
git push origin v0.8.0
```

Versions follow [Semantic Versioning](https://semver.org/): patch for fixes,
minor for features, major for breaking changes to the API, environment
variables or the helper protocol.

Pushing the tag runs [`.github/workflows/release.yml`](.github/workflows/release.yml):

1. Checks the tag: `vX.Y.Z` or `vX.Y.Z-pre` (for example `v0.8.0-rc.1`),
   on a commit of `main` (nodes fast-forward their checkout of `main` to it),
   and not released yet.
2. Runs the [smoke tests](.github/workflows/smoke.yml) on the tagged commit.
   If they fail, nothing is published; delete the tag
   (`git push --delete origin v0.8.0 && git tag -d v0.8.0`), fix, tag again.
3. Publishes the GitHub release with the `[Unreleased]` section as its notes
   (GitHub's generated notes when the section is empty). A tag with a
   pre-release suffix becomes a pre-release, which nodes do not install.
4. Moves the `[Unreleased]` entries under `## [X.Y.Z] - date` on `main`
   and updates the compare links (a commit by `github-actions[bot]`; skipped
   with a warning if `[Unreleased]` changed after the tag).

Nodes see the new release on their next check ([docs/self-update.md](docs/self-update.md)).

The version comes from the tag: a git checkout reports the tag it is on
(`0.8.0`), or the last tag and the commits after it (`0.8.0+3`), as
`uiVersion` in `/api/health` and in the sidebar (`server/version.ts`).
`"version"` in `package.json` is only the fallback without git history
and is not bumped for releases.

Deployments made with `deploy/setup-local.sh` run from the checkout, so
the Upgrade page updates them, or by hand
`git pull && npm run build` and a restart of the service.

## AI coding assistant policy

Use of AI coding assistants in preparing a contribution is welcome.
What is required is that the contributor does a thorough manual
review and editorial pass over the output before submission:

- Verify the code does what it claims, not just that it builds.
- Verify the documentation matches the behavior.
- Spot-check the diff: no unrelated files, no fabricated APIs, no
  references to symbols that do not exist, no version bumps you did
  not intend.
- Do not include coding-assistant attribution trailers in commit
  messages or PR descriptions.
- Be ready to discuss the design choices in the PR as if you wrote
  every line, because for the purposes of accountability you did.

Submissions that show signs of being unreviewed agent output will be
closed without human review.

## Where the conversation happens

- **GitHub issues** — bugs, feature requests, design discussion.
- **GitHub PRs** — discussion specific to a change in flight.

For anything about the FIPS protocol or daemon itself, go upstream to
[jmcorgan/fips](https://github.com/jmcorgan/fips); this project only
renders and drives what the daemon exposes.

## Further reading

- [PR-REVIEW.md](PR-REVIEW.md) — the review checklist.
- [docs/upgrade.md](docs/upgrade.md) — the upgrade flow and privilege model.
- [README.md](README.md) — features, configuration, API.
- Upstream [control-socket reference](https://github.com/jmcorgan/fips/blob/master/docs/reference/control-socket.md)
  — the contract every backend query is built on.
