import { useMemo, useState } from 'react';
import type { Snapshot } from '../lib/types';
import { Card, Chip, Copyable, KV, Empty, ErrorNote } from '../components/ui';
import { shortKey, fmtMs, fmtCompact } from '../lib/format';
import { CounterTable } from '../components/CounterTable';

interface Node { id: string; label: string; kind: 'root' | 'ancestor' | 'parent' | 'me' | 'child' | 'cross'; depth?: number; npub?: string; rtt?: number | null }

export function Topology({ snap, onSelectPeer }: { snap: Snapshot; onSelectPeer: (npub: string) => void }) {
  const tree = snap.tree;
  const peers = snap.peers?.peers ?? [];
  const [hover, setHover] = useState<string | null>(null);
  const byAddr = useMemo(() => new Map(peers.map((p) => [p.node_addr, p])), [peers]);

  if (!tree) return snap.errors?.tree ? <ErrorNote>{snap.errors.tree}</ErrorNote> : <Empty>Waiting for tree state…</Empty>;

  const nameOf = (addr: string) => byAddr.get(addr)?.display_name || (addr === tree.my_node_addr ? 'this node' : addr === tree.root && tree.root_npub ? shortKey(tree.root_npub, 10, 4) : shortKey(addr, 6, 4));
  const coords = tree.my_coords ?? [];
  // coords: [me, parent, grandparent, ..., root]
  const ancestry: Node[] = coords.slice(1).map((addr, i) => ({ id: addr, label: nameOf(addr), kind: (i === 0 ? 'parent' : addr === tree.root ? 'root' : 'ancestor') as Node['kind'], depth: coords.length - 2 - i, npub: byAddr.get(addr)?.npub, rtt: byAddr.get(addr)?.mmp?.srtt_ms })).reverse();
  if (tree.is_root && ancestry.length === 0) { /* root: nothing above */ }
  const me: Node = { id: tree.my_node_addr, label: 'this node', kind: 'me', depth: tree.depth };
  const children: Node[] = peers.filter((p) => p.is_child).map((p) => ({ id: p.node_addr, label: p.display_name || shortKey(p.npub, 8, 4), kind: 'child', depth: p.tree_depth ?? undefined, npub: p.npub, rtt: p.mmp?.srtt_ms }));
  const cross: Node[] = peers.filter((p) => !p.is_child && !p.is_parent).map((p) => ({ id: p.node_addr, label: p.display_name || shortKey(p.npub, 8, 4), kind: 'cross', depth: p.tree_depth ?? undefined, npub: p.npub, rtt: p.mmp?.srtt_ms }));

  // Layout
  const W = 760, rowH = 84, padY = 40, nodeW = 168, nodeH = 44;
  const rows = ancestry.length + 1 + (children.length ? 1 : 0);
  const H = padY * 2 + rowH * (rows - 1) + nodeH;
  const cx = cross.length ? W * 0.38 : W / 2;
  const pos = new Map<string, { x: number; y: number }>();
  ancestry.forEach((n, i) => pos.set(n.id, { x: cx, y: padY + i * rowH }));
  const meY = padY + ancestry.length * rowH;
  pos.set(me.id, { x: cx, y: meY });
  const spread = Math.min(nodeW + 16, (W - 80) / Math.max(1, children.length));
  children.forEach((n, i) => pos.set(n.id, { x: cx + (i - (children.length - 1) / 2) * spread, y: meY + rowH }));
  const crossX = W - nodeW / 2 - 20;
  cross.forEach((n, i) => pos.set(n.id, { x: crossX, y: padY + i * (rowH * 0.8) }));

  const color = (k: Node['kind']) => k === 'me' ? 'var(--accent)' : k === 'root' ? 'var(--s4)' : k === 'child' ? 'var(--s3)' : k === 'cross' ? 'var(--s7)' : 'var(--s1)';
  const NodeBox = ({ n }: { n: Node }) => {
    const p = pos.get(n.id)!;
    const clickable = !!n.npub;
    return (
      <g transform={`translate(${p.x - nodeW / 2},${p.y - nodeH / 2})`} className={clickable ? 'cursor-pointer' : ''} onClick={() => n.npub && onSelectPeer(n.npub)} onMouseEnter={() => setHover(n.id)} onMouseLeave={() => setHover(null)}>
        <rect width={nodeW} height={nodeH} rx={10} fill={n.kind === 'me' ? 'var(--accent-soft)' : 'var(--surface-2)'} stroke={hover === n.id || n.kind === 'me' ? color(n.kind) : 'var(--border-strong)'} strokeWidth={n.kind === 'me' ? 1.5 : 1} />
        <circle cx={16} cy={nodeH / 2} r={5} fill={color(n.kind)} />
        <text x={30} y={nodeH / 2 - 3} fontSize={12.5} fontWeight={600} fill="var(--text)">{n.label.length > 18 ? n.label.slice(0, 17) + '…' : n.label}</text>
        <text x={30} y={nodeH / 2 + 12} fontSize={10.5} fill="var(--text-3)" fontFamily="var(--mono)">{n.kind === 'root' ? 'root' : `d${n.depth ?? '?'}`}{n.rtt != null ? ` · ${fmtMs(n.rtt, 0)}` : ''}{n.kind === 'cross' ? ' · crosslink' : ''}</text>
      </g>
    );
  };
  const Edge = ({ a, b, dashed }: { a: string; b: string; dashed?: boolean }) => {
    const p = pos.get(a)!, q = pos.get(b)!;
    return <path d={`M${p.x},${p.y + nodeH / 2} C${p.x},${(p.y + q.y) / 2} ${q.x},${(p.y + q.y) / 2} ${q.x},${q.y - nodeH / 2}`} fill="none" stroke={dashed ? 'var(--s7)' : 'var(--axis)'} strokeWidth={1.5} strokeDasharray={dashed ? '4 4' : undefined} opacity={0.9} />;
  };
  const CrossEdge = ({ a }: { a: string }) => {
    const p = pos.get(a)!, q = pos.get(me.id)!;
    return <path d={`M${p.x - nodeW / 2},${p.y} C${(p.x + q.x) / 2},${p.y} ${(p.x + q.x) / 2},${q.y} ${q.x + nodeW / 2},${q.y}`} fill="none" stroke="var(--s7)" strokeWidth={1.5} strokeDasharray="4 4" opacity={0.8} />;
  };

  return (
    <div className="grid gap-4 fade-in xl:grid-cols-[minmax(0,1fr)_360px]">
      <Card title="Spanning tree position" hint="Ancestry from the root down to this node, then its children. Dashed links are peers outside the tree path (crosslinks).">
        <div className="overflow-x-auto">
          <svg viewBox={`0 0 ${W} ${Math.max(H, cross.length ? padY * 2 + (cross.length - 1) * rowH * 0.8 + nodeH : 0)}`} className="w-full min-w-[560px]" style={{ maxHeight: 620 }}>
            {ancestry.map((n, i) => <Edge key={n.id} a={n.id} b={i + 1 < ancestry.length ? ancestry[i + 1].id : me.id} />)}
            {children.map((n) => <Edge key={n.id} a={me.id} b={n.id} />)}
            {cross.map((n) => <CrossEdge key={n.id} a={n.id} />)}
            {ancestry.map((n) => <NodeBox key={n.id} n={n} />)}
            <NodeBox n={me} />
            {children.map((n) => <NodeBox key={n.id} n={n} />)}
            {cross.map((n) => <NodeBox key={n.id} n={n} />)}
          </svg>
        </div>
        <div className="flex flex-wrap gap-3 text-xs text-ink-3 mt-2">
          {[['root', 'var(--s4)'], ['ancestor', 'var(--s1)'], ['this node', 'var(--accent)'], ['child', 'var(--s3)'], ['crosslink', 'var(--s7)']].map(([l, c]) => <span key={l} className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full" style={{ background: c }} />{l}</span>)}
        </div>
      </Card>

      <div className="grid gap-4 content-start">
        <Card title="Tree state">
          <KV items={[
            ['Role', tree.is_root ? <Chip tone="accent">root</Chip> : <Chip>depth {tree.depth}</Chip>],
            ['Root', <Copyable text={tree.root_npub ?? tree.root} display={shortKey(tree.root_npub ?? tree.root, 12, 6)} />],
            ['Parent', tree.parent ? `${tree.parent_display_name ?? shortKey(tree.parent, 8, 4)}` : '–'],
            ['Declaration seq', tree.declaration_sequence],
            ['Signed', tree.declaration_signed ? 'yes' : 'no'],
            ['Peers with tree pos', tree.peer_tree_count],
            ['Parent switches', fmtCompact(tree.stats?.parent_switches)],
            ['Parent losses', fmtCompact(tree.stats?.parent_losses)],
          ]} />
        </Card>
        <Card title="Coordinates" hint="This node's coordinate vector: itself first, root last">
          <ol className="grid gap-1">{coords.map((c, i) => <li key={c} className="flex items-center gap-2 text-xs"><span className="w-5 text-ink-3 tabular text-right">{coords.length - 1 - i}</span><Copyable text={c} display={<span>{nameOf(c)} <span className="text-ink-3">{shortKey(c, 8, 6)}</span></span>} className="min-w-0" /></li>)}</ol>
        </Card>
        {tree.stats && <Card title="Tree protocol counters" pad={false}><CounterTable data={tree.stats} compact /></Card>}
      </div>

      <Card title="Peer tree positions" className="xl:col-span-2" pad={false}>
        {tree.peers.length === 0 ? <Empty>No peers have announced a tree position.</Empty> : (
          <div className="overflow-x-auto"><table className="data"><thead><tr><th>Peer</th><th className="num">Depth</th><th className="num">Distance</th><th>Root</th><th>Coordinates (self → root)</th></tr></thead><tbody>
            {tree.peers.map((t) => <tr key={t.node_addr} className="row" onClick={() => { const p = byAddr.get(t.node_addr); if (p) onSelectPeer(p.npub); }}><td className="font-medium">{t.display_name || shortKey(t.node_addr, 8, 6)}</td><td className="num">{t.depth}</td><td className="num">{t.distance_to_us}</td><td><span className={`mono text-xs ${t.root !== tree.root ? 'text-crit' : ''}`} title={t.root !== tree.root ? 'Different root: this peer is in another tree' : ''}>{shortKey(t.root, 8, 6)}</span></td><td><div className="flex gap-1 flex-wrap">{t.coords.map((c) => <span key={c} className="chip mono" title={c}>{shortKey(c, 5, 4)}</span>)}</div></td></tr>)}
          </tbody></table></div>
        )}
      </Card>
    </div>
  );
}
