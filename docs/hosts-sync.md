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

## Conflicts

The daemon uses the last entry for a name. Within one hosts file that is the later line; across a sync it is
the master's entry (the synced block comes last). A local entry that a synced one overrides is marked
"overridden by master" in the editor. One npub under several names is not a conflict: every name resolves.
