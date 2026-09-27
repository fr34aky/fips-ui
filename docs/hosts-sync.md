# Syncing hosts files between nodes

One node keeps the shared list of names. Other trusted nodes copy it into their own FIPS hosts file, so every
node resolves the same `<name>.fips` names and fips-ui shows the same names next to npubs.

## Roles

Names flow down a tree. fips-ui derives each node's role from its settings and the nodes that sync from it, and
shows it on the Hosts card:

| Role | Syncs from another node | Other nodes sync from it | |
| ---- | :---: | :---: | --- |
| **Master node** | no | yes | The origin of the names at the top of the tree. |
| **Distribution node** | yes | yes | Receives names from above and passes them on, with its own. |
| **Follower** | yes | no | Only receives names. |

The node a node syncs from is its **upstream node** (its parent): the master node or a distribution node.

## How it works

- Nodes **pull**. Every few minutes (default 5) and on **Sync now**, a node's fips-ui fetches
  `http://[<upstream node's fips0 address>]:<port>/api/hosts` from the upstream node's web UI over the mesh.
- **Both sides are authenticated by the mesh.** FIPS delivers packets for a node's fips0 address only to that
  node's npub, so the syncing node knows the list is genuine. The upstream node admits it by its npub: it must be
  on the upstream node's **Web UI over the mesh** list, and the **viewer** role is enough. The upstream node never
  gets rights on the nodes syncing from it.
- The syncing node writes the names into a marked block at the **end** of its hosts file:

  ```text
  # >>> fips-ui sync from npub1… (hub): managed by fips-ui, edits here are replaced on the next sync
  nas            npub1…
  printer        npub1…
  # <<< fips-ui sync
  ```

  Local entries outside the block stay as they are. On a duplicate name the daemon uses the last entry, so
  **the synced entry wins**; the editor marks such local entries "overridden by sync".
- The file is only rewritten when the upstream list changes, through the same path as the editor (the helper
  where it runs, directly elsewhere).
- Every entry is checked like one added in the editor (lowercase name of at most 63 characters, valid npub);
  invalid entries are left out and counted. At most 2000 entries are taken.
- A node shares every entry of its hosts file (what `/api/hosts` shows its viewers), synced ones included.

## Nodes syncing from this one

A master or distribution node's hosts card lists the nodes that sync from it: name and npub, when each last
synced (amber once three of its intervals have passed without a sync), how many names it received, its interval
and its fips-ui version. Nodes mark their sync request with an `x-fips-ui-sync` header carrying version and
interval; nodes on versions before that are recognised by their plain `node` client and shown as "older". A
person browsing the dashboard over the mesh is not counted. The list is kept in
`~/.config/fips-ui/hosts-followers.json` (`FIPS_UI_HOSTS_FOLLOWERS_FILE`); forgetting an entry removes it until
that node's next sync.

## If the upstream node is offline

The names synced last stay in effect. Automatic retries back off to once a day while the upstream node cannot be
reached (or refuses this node); **Sync now** always tries at once and restores the normal interval when it
succeeds. Turning sync off removes the synced block.

## Setting it up

1. **On the upstream node** (the master node, or a distribution node): Access → **Web UI over the mesh**: enable
   it and add the npub of each node that will sync from it with the **viewer** role. Note the port (default
   8321).
2. **On each syncing node:** Access → Hosts file → **Sync names from another node**: enter the upstream node's
   npub (or a name this node already knows for it) under **Sync from**, its UI port and the interval, then
   **Save**. The panel shows when the last sync succeeded, or why it failed.

The settings are stored in `~/.config/fips-ui/hosts-sync.json` (`FIPS_UI_HOSTS_SYNC_FILE`). The API keeps the
field name `master` for the upstream node.

## Chains of distribution nodes

A distribution node serves what its own daemon resolves: its own names and the block it syncs from above, so
names flow down the tree (A → B → C: C gets A's and B's names). A name defined higher up wins further down,
since every node puts its synced block last. Changes take up to the sum of the intervals to reach the bottom.

Every sync answer carries the serving node's upstream chain (itself first). A node that finds its own npub in
it refuses the sync and keeps its names: otherwise names would go round in a circle, and a name deleted anywhere
in the circle would keep coming back. Chains longer than 16 nodes are refused the same way. Nodes on fips-ui
versions before this check send no chain, so loops through them are not detected.

## The hierarchy on each node

- **Upward**: a syncing node's card shows where its names come from, from the chain its upstream node reported:
  `A (master node) › B (distribution node, parent) › this node`. It changes with the next sync when a node
  moves. The top is labelled master node only when every node on the way confirmed its own upstream (each sync
  answer says whether its chain is complete); after a failed sync anywhere above, or through a node on an older
  fips-ui, the card shows the nodes known and says that what is further up is not confirmed.
- **Downward**: the list of nodes syncing from this one is a tree. Each node's row shows its role and how many
  nodes sync below it (`3 below`); the arrow opens them, indented by depth, with the node each one syncs from.

A node learns what is below it from the syncs themselves, without extra requests: every sync request carries an
`x-fips-ui-subtree` header with the node's own active followers and what they reported below them (parents
first, about 70 bytes per node, at most 128 nodes and a count of the rest). So C tells B about D, B tells A about
C and D, and each level knows its whole subtree one sync interval after the level below it synced. A node that
has not synced for three of its intervals drops out of its upstream node's report, and with it everything it
reported, so a removed node disappears from every tree above it within a few intervals.

The tree is informational: each node describes its own subtree, so the rows below a node are labelled
"reported by" it, and nothing is granted or changed because of them. Reports are checked (valid npubs, no
repeats, no reference to the receiving node, depth at most 16); nodes on older fips-ui versions send none and
show no subtree.

## Conflicts

The daemon uses the last entry for a name. Within one hosts file that is the later line; across a sync it is
the upstream node's entry (the synced block comes last). A local entry that a synced one overrides is marked
"overridden by sync" in the editor. One npub under several names is not a conflict: every name resolves.
