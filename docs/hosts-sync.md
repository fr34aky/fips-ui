# Syncing hosts files from a master node

One node (the **master**) keeps the shared list of names. Other trusted nodes (**followers**) copy it into
their own FIPS hosts file, so every node resolves the same `<name>.fips` names and fips-ui shows the same
names next to npubs.

## How it works

- Followers **pull**. Every few minutes (default 5) and on **Sync now**, a follower's fips-ui fetches
  `http://[<master's fips0 address>]:<port>/api/hosts` from the master's web UI over the mesh.
- **Both sides are authenticated by the mesh.** FIPS delivers packets for the master's fips0 address only to
  the master's npub, so the follower knows the list is genuine. The master admits the follower by its npub:
  the follower must be on the master's **Web UI over the mesh** list, and the **viewer** role is enough. The
  master never gets rights on the follower.
- The follower writes the names into a marked block at the **end** of its hosts file:

  ```text
  # >>> fips-ui sync from npub1… (master): managed by fips-ui, edits here are replaced on the next sync
  nas            npub1…
  printer        npub1…
  # <<< fips-ui sync
  ```

  Local entries outside the block stay as they are. On a duplicate name the daemon uses the last entry, so
  **the master's entry wins**; the editor marks such local entries "overridden by master".
- The file is only rewritten when the master's list changes, through the same path as the editor (the
  helper on Linux with systemd, directly elsewhere).
- Every entry is checked like one added in the editor (lowercase name of at most 63 characters, valid npub);
  invalid entries are left out and counted. At most 2000 entries are taken.
- The master shares every entry of its hosts file (what `/api/hosts` shows its viewers).

## Followers on the master

The master's hosts card lists the nodes that sync from it: name and npub, when each last synced (amber once
three of its intervals have passed without a sync), how many names it received, its interval and its fips-ui
version. Followers mark their sync request with an `x-fips-ui-sync` header carrying version and interval;
followers on versions before that are recognised by their plain `node` client and shown as "older". A person
browsing the dashboard over the mesh is not counted. The list is kept in `~/.config/fips-ui/hosts-followers.json`
(`FIPS_UI_HOSTS_FOLLOWERS_FILE`); forgetting an entry removes it until that node's next sync.

## If the master is offline

The names synced last stay in effect. Automatic retries back off to once a day while the master cannot be
reached (or refuses this node); **Sync now** always tries at once and restores the normal interval when it
succeeds. Turning sync off removes the synced block.

## Setting it up

1. **On the master:** Access → **Web UI over the mesh**: enable it and add each follower's npub with the
   **viewer** role. Note the port (default 8321).
2. **On each follower:** Access → Hosts file → **Sync names from a master node**: enter the master's npub (or
   a name this node already knows for it), the master's UI port and the interval, then **Save**. The panel
   shows when the last sync succeeded, or why it failed.

The follower's settings are stored in `~/.config/fips-ui/hosts-sync.json` (`FIPS_UI_HOSTS_SYNC_FILE`).

## Chains of masters

A node that follows a master can itself be the master of other nodes: it serves what its own daemon resolves,
its own names and the block it syncs from above, so names flow down a tree (A → B → C: C gets A's and B's
names). A name defined higher up wins further down, since every node puts its synced block last. Changes take
up to the sum of the intervals to reach the bottom.

Every sync answer carries the serving node's upstream chain (itself first). A follower that finds its own npub
in it refuses the sync and keeps its names: otherwise names would go round in a circle, and a name deleted
anywhere in the circle would keep coming back. Chains longer than 16 nodes are refused the same way. Masters on
fips-ui versions before this check send no chain, so loops through them are not detected.

## The hierarchy on each node

- **Upward**: a follower's sync card shows where its names come from, from the chain the master reported:
  `A (top) › B (parent) › this node`. It changes with the next sync when a master moves.
- **Downward**: the followers list is a tree. Each follower's row shows how many nodes sync below it
  (`3 below`); the arrow opens them, indented by depth, with the node each one syncs from.

A node learns what is below it from the syncs themselves, without extra requests: every sync request carries an
`x-fips-ui-subtree` header with the node's own active followers and what they reported below them (parents
first, about 70 bytes per node, at most 128 nodes and a count of the rest). So C tells B about D, B tells A about
C and D, and each level knows its whole subtree one sync interval after the level below it synced. A follower
that has not synced for three of its intervals drops out of its master's report, and with it everything it
reported, so a removed node disappears from every tree above it within a few intervals.

The tree is informational: each node describes its own subtree, so the rows below a follower are labelled
"reported by" it, and nothing is granted or changed because of them. Reports are checked (valid npubs, no
repeats, no reference to the receiving node, depth at most 16); followers on older fips-ui versions send none and
show no subtree.

## Conflicts

The daemon uses the last entry for a name. Within one hosts file that is the later line; across a sync it is
the master's entry (the synced block comes last). A local entry that a synced one overrides is marked
"overridden by master" in the editor. One npub under several names is not a conflict: every name resolves.
