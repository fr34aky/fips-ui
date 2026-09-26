# PR Review Checklist

<!-- markdownlint-disable MD013 -->

This is the 13-criteria checklist run against every incoming PR. The
first pass on any submission is exactly this list, so executing it
yourself before opening, or after pushing a fresh revision, saves a
review round trip.

The document is also written so you can hand it to a coding agent
with "review my branch against this checklist" and get a structured
pass.

## Step 1 — Should this even be reviewed?

Skip the review (and say so) if the PR is:

- closed, merged, or marked draft
- automated (bot author, dependency bumps) and trivially OK
- so small and obviously correct (typo fix, single-line doc tweak)
  that a thirteen-point pass is overkill; a one-paragraph informal
  review is better in that case

## Step 2 — Gather context

Read these *before* analyzing the diff:

1. PR metadata.

   ```bash
   gh pr view <num> --json title,body,author,headRefName,baseRefName,headRefOid,baseRefOid,mergeable,statusCheckRollup,commits
   ```

2. The diff.

   ```bash
   gh pr diff <num>
   ```

3. Base-branch freshness: how far `main` has moved since the PR forked.
4. Project guidance: [CONTRIBUTING.md](CONTRIBUTING.md), and
   [docs/upgrade.md](docs/upgrade.md) if the diff touches
   `server/upgrade.ts`, `scripts/`, or `deploy/`.
5. The upstream contract. Every backend query is built on the daemon's
   [control-socket reference](https://github.com/jmcorgan/fips/blob/master/docs/reference/control-socket.md).
   If the PR adds or reshapes a query, check the field names against
   that document, not against what the frontend happens to render.
6. Related work: skim open issues and PRs for overlap.
7. For "this looks wrong" observations: `git blame` the lines first.
   What looks like a bug is sometimes a deliberate workaround with a
   commit message explaining it.

## Step 3 — The 13 criteria

### Group A — PR hygiene

1. **PR body and issue cross-reference.** Does the body describe the
   change accurately and match what the diff does? Should it carry
   `Closes #N`? For visual changes, are there screenshots?
2. **Commit hygiene and base freshness.** Clean commits or a single
   commit, no "WIP" / "fix typo" noise, based on a recent `main`.
3. **Commit message quality.** Subject plus body where warranted,
   accurate to the commit, and free of extraneous footers, in
   particular coding-assistant attribution trailers.

### Group B — Diff content

4. **Does it do what it says it does.** Walk each claimed behavior
   from the PR body against the diff.
5. **Coherent whole.** All of the diff serves the stated goal; no
   drive-by formatting, no unrelated touch-ups, no scope creep.
6. **Fits the codebase as a natural extension.** Uses the existing
   pieces: `query()` for socket access rather than a new client,
   `usePoll` / `useLive` for data, the shared `Card` / `Chip` /
   `KV` / `TimeSeries` components, the `fmt*` helpers, tokens from
   `index.css` rather than hard-coded colours. New CSS primitives
   live inside `@layer components` so utilities can still override
   them.

### Group C — Cross-cutting concerns

7. **New dependency surface.** The server has zero npm dependencies
   and that is a feature; adding one needs a stated reason. Frontend
   dependencies, system tools shelled out to, and external services
   (GitHub API, package managers) all count.
8. **Verification.** There is no test suite yet, so the question is:
   was this exercised against a live daemon, and does the PR say
   how? For backend changes, was the endpoint hit with `curl`? For
   frontend changes, both themes and phone width?
9. **Documentation impact.** README (env vars, API table, features),
   `docs/upgrade.md`, and a CHANGELOG entry under `[Unreleased]`.
10. **Security and the privilege boundary.** Any new endpoint that
    mutates state, and is it refused in read-only mode? Untrusted
    input reaching a shell (`execFile` with argument arrays, never
    string interpolation), path traversal in static serving, token
    handling, anything that widens what the helper can do as root,
    and above all anything that would let the web process obtain or
    forward a password. The socket protocol has a 4096-byte request
    cap and a 5-second timeout; queries must respect both.
11. **TypeScript and Node practices.** Server code must run under
    Node's type stripping (no enums, parameter properties, or
    namespaces). Errors surface to the client as JSON with a useful
    message rather than being swallowed; no `any` where a shape is
    known; hooks obey the rules of hooks; effects that set state
    have a reason.
12. **Overlap with existing work.** Open issues and PRs that this
    duplicates, partially addresses, or unblocks.
13. **Other concerns.** Behaviour on nodes unlike the author's (no
    gateway socket, no `systemd-journal` access, non-systemd hosts,
    Windows loopback control port), deployment impact on the unit
    and setup script, and fragility notes for future maintainers.

## Step 4 — Compose the review

The report is **not** a Q&A walk through the 13 criteria. Write it as
prose that reads start to finish, ordered by what matters most for
this PR. All 13 criteria are addressed somewhere in the body; do not
reference criterion numbers.

A typical shape: an opening paragraph on what the PR does and the
headline observations; a body covering diff analysis, design fit,
cross-cutting concerns and surprises; a closing with a disposition:
*land*, *land-with-followups* (list them), *request-changes* (name
the blockers), or *hold*.

## Step 5 — Filter aggressively

Do not flag:

- pre-existing issues on lines the PR did not modify
- anything `tsc`, `oxlint`, or the build would catch
- pedantic style nitpicks a senior engineer would not call out
- likely intentional changes related to the broader goal
- stylistic preferences not anchored in CONTRIBUTING.md or the
  surrounding code

For every issue you do surface, include a concrete fix suggestion so
the author can act without a round trip.

## Step 6 — Citation discipline

Reference code by full-SHA permalink so the link survives history
rewrites:

```text
https://github.com/fr34aky/fips-ui/blob/<full-40-char-sha>/<path>#L<start>-L<end>
```

## Notes

- Distinguish "blocker" from "worth asking about" from "fragility
  note". The closing disposition makes the action explicit.
- On re-review after new commits, lead with the delta from the prior
  review.
- The checklist exists to surface problems, not to assign blame.
