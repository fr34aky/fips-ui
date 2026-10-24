import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { Shell, NAV, ADMIN_VIEWS, type ViewId } from './components/Shell';
import { ToastProvider, Modal, ErrorNote, Empty, Chip } from './components/ui';
import { api, ApiError, useLive, useAuthNeeded, setAuthNeeded, setToken, getToken, reconnectLive, setApiBase } from './lib/api';
import { isAdmin, type Health } from './lib/types';
import { baseFor, hashFor, parseHash as parseRoute, type Route } from './lib/route';
import { fleetApi } from './lib/fleet';
import { Overview } from './views/Overview';
import { Peers } from './views/Peers';
import { Topology } from './views/Topology';
import { Metrics } from './views/Metrics';
import { Network } from './views/Network';
import { Internals } from './views/Internals';
import { Logs } from './views/Logs';
import { Diagnostics } from './views/Diagnostics';
import { Access } from './views/Access';
import { Gateway } from './views/Gateway';
import { Upgrade } from './views/Upgrade';
const Config = lazy(() => import('./views/Config'));
import { Firewall } from './views/Firewall';
import { PublicDomains } from './views/PublicDomains';
import { Fleet } from './views/Fleet';
import { Security } from './views/Security';
import { shortKey } from './lib/format';
import { useHostName } from './lib/names';

type AppRoute = Route & { view: ViewId };
function parseHash(): AppRoute {
  const r = parseRoute();
  return { ...r, view: (NAV.some((n) => n.id === r.view) ? r.view : 'overview') as ViewId };
}

/**
 * Owns the hash. The page looks at this node, or at a node managed from here ('#/node/<npub>/…', Node manager →
 * Open): the API base is set before the App for that node renders, and the App is remounted per node so that
 * nothing (drafts, streams, polls) carries over.
 */
export default function Root() {
  const [route, setRoute] = useState(() => { const r = parseHash(); setApiBase(baseFor(r.node)); return r; });
  useEffect(() => {
    const on = () => { const r = parseHash(); setApiBase(baseFor(r.node)); setRoute(r); };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return <App key={route.node ?? 'local'} route={route} />;
}

function App({ route }: { route: AppRoute }) {
  const [health, setHealth] = useState<Health | null>(null);
  /** What this node's backend said about reaching the managed node: 404 (no longer managed), 403 (this user is no superadmin), 502/504 (the proxy could not reach it, with its reason). */
  const [nodeProblem, setNodeProblem] = useState<{ status: number; message: string } | null>(null);
  /** For a managed node: how the Node manager calls it, and this node's own npub (for the "add me as admin" hint). */
  const [fleetMeta, setFleetMeta] = useState<{ own?: string; label?: string } | null>(null);
  const live = useLive();
  const authNeeded = useAuthNeeded();
  const nodeNpub = route.node;
  // Health describes the node the page looks at; read again when the stream comes (back) up, e.g. after its restart.
  const up = live.conn === 'live';
  // A 403 from the node itself (it refuses this node's npub) is the live store's `refused` case, with its hint; a 403
  // from this node (no superadmin) and the proxy's own 404/502/504 are told here.
  useEffect(() => { api.health().then((h) => { setHealth(h); setNodeProblem(null); }).catch((e) => { if (nodeNpub && e instanceof ApiError && [403, 404, 502, 504].includes(e.status) && !(e.status === 403 && e.fromNode)) setNodeProblem({ status: e.status, message: e.message }); }); }, [authNeeded, up, nodeNpub]);
  // The App is mounted per node (Root), so the node never changes while this runs.
  useEffect(() => {
    if (!nodeNpub) return;
    fleetApi.get().then((f) => setFleetMeta({ own: f.own, label: f.config.nodes.find((n) => n.npub === nodeNpub)?.label })).catch(() => setFleetMeta({}));
  }, [nodeNpub]);
  useEffect(() => { const s = live.snapshot?.status; document.title = s ? `${route.view === 'overview' ? '' : NAV.find((n) => n.id === route.view)?.label + ' · '}FIPS ${s.peer_count} peer${s.peer_count === 1 ? '' : 's'}` : 'FIPS Node'; }, [live.snapshot, route.view]);

  const nav = useCallback((view: ViewId, params?: Record<string, string>) => { location.hash = hashFor(view, params); }, []);
  const selectPeer = useCallback((npub: string | null) => nav('peers', npub ? { peer: npub } : undefined), [nav]);
  const probe = useCallback((peer: string) => nav('diagnostics', { peer }), [nav]);

  const snap = live.snapshot;
  const viewer = !!health?.principal && !isAdmin(health.principal.role);
  const ownName = useHostName(snap?.status?.npub);
  const nodeName = useMemo(() => snap?.status ? `${snap.status.tun_name} · ${ownName ? `${ownName} · ` : ''}${shortKey(snap.status.npub, 12, 6)}` : '', [snap, ownName]);
  const managedName = useHostName(nodeNpub);
  const node = nodeNpub ? { npub: nodeNpub, name: fleetMeta?.label || managedName || shortKey(nodeNpub, 12, 6) } : undefined;
  const backToFleet = <a className="btn sm mt-3" href={hashFor('fleet', undefined, null)}>Back to Node manager</a>;
  const gwBadge = snap?.gateway ? <Chip tone="good" className="ml-auto" dot={false}>on</Chip> : undefined;
  // The public-domains page exists where the node runs the resolver or the server (health says), and for an
  // admin whose helper can install them.
  const pd = health?.pubdom;
  // The Node manager is this node's page: never offered while a managed node's pages are shown.
  // The security page exists where the helper can scan (helper v13 on Linux); health says.
  const hidden: ViewId[] = [...((pd && (pd.resolver.installed || pd.server.installed)) || health?.nodeManagement ? [] : ['pubdom' as const]), ...(health?.fleet && !nodeNpub ? [] : ['fleet' as const]), ...(health?.security ? [] : ['security' as const])];

  let body: React.ReactNode;
  if (viewer && ADMIN_VIEWS.includes(route.view)) {
    body = <Empty>This page needs the admin role; your npub has viewer access.</Empty>;
  } else if (route.view === 'fleet' && ((health && !health.fleet) || nodeNpub)) {
    body = <Empty>{nodeNpub ? 'The Node manager is this node\'s own page.' : health?.readOnly ? 'This UI instance is read-only; the Node manager is off.' : 'This page needs the superadmin role.'}{nodeNpub && backToFleet}</Empty>;
  } else if (node && nodeProblem?.status === 404) {
    body = <Empty>{node.name} is no longer managed from here.{backToFleet}</Empty>;
  } else if (node && nodeProblem?.status === 403) {
    body = <Empty>Opening a managed node needs the superadmin role here: {nodeProblem.message}.{backToFleet}</Empty>;
  } else if (!snap) {
    body = node ? (
      nodeProblem ? <Empty><ErrorNote>Cannot reach {node.name} through this node: {nodeProblem.message}</ErrorNote><div className="flex gap-2 justify-center"><button className="btn sm mt-3" onClick={() => reconnectLive()}>Retry</button>{backToFleet}</div></Empty>
        : live.refused ? <Empty><ErrorNote>{node.name} refuses this node: {live.refused}</ErrorNote><p className="text-sm text-ink-2 mt-3">On that node, under <b>Access → Web UI over the mesh</b>, add {fleetMeta?.own ? <code>{fleetMeta.own}</code> : 'this node\'s npub'} as an <b>admin</b>.</p><div className="flex gap-2 justify-center"><button className="btn sm mt-3" onClick={() => reconnectLive()}>Retry</button>{backToFleet}</div></Empty>
        : live.conn === 'reconnecting' ? <Empty><ErrorNote>Cannot reach {node.name} through this node. Retrying…</ErrorNote>{backToFleet}</Empty>
        : <Empty><div className="pulse">Connecting to {node.name}…</div></Empty>
    ) : live.refused ? <ErrorNote>The FIPS UI server refused this browser: {live.refused}</ErrorNote>
      : live.conn === 'reconnecting' ? <ErrorNote>Cannot reach the FIPS UI server. Retrying…</ErrorNote> : <Empty><div className="pulse">Connecting to the node…</div></Empty>;
  } else {
    switch (route.view) {
      case 'peers': body = <Peers snap={snap} health={health} onProbe={probe} selected={route.params.get('peer')} onSelect={selectPeer} />; break;
      case 'topology': body = <Topology snap={snap} onSelectPeer={selectPeer} />; break;
      case 'metrics': body = <Metrics initialPeer={route.params.get('peer')} />; break;
      case 'network': body = <Network snap={snap} onSelectPeer={selectPeer} />; break;
      case 'internals': body = <Internals snap={snap} />; break;
      case 'logs': body = <Logs />; break;
      case 'diagnostics': body = <Diagnostics initialPeer={route.params.get('peer')} snap={snap} readOnly={!!health?.readOnly} />; break;
      case 'access': body = <Access snap={snap} onProbe={probe} readOnly={!!health?.readOnly} prefillNpub={route.params.get('name')} />; break;
      case 'gateway': body = <Gateway snap={snap} />; break;
      case 'pubdom': body = <PublicDomains health={health} />; break;
      case 'upgrade': body = <Upgrade />; break;
      case 'fleet': body = <Fleet snap={snap} />; break;
      case 'security': body = <Security readOnly={!!health?.readOnly} />; break;
      case 'config': body = <Suspense fallback={<Empty><div className="pulse">Loading…</div></Empty>}><Config readOnly={!!health?.readOnly} /></Suspense>; break;
      case 'firewall': { const port = route.params.get('port'); body = <Firewall snap={snap} readOnly={!!health?.readOnly} prefill={port ? { port, proto: route.params.get('proto') === 'udp' ? 'udp' : 'tcp', comment: route.params.get('note') ?? undefined } : null} />; break; }
      default: body = <Overview snap={snap} health={health} onNav={nav} />;
    }
  }

  return (
    <ToastProvider>
      <Shell view={route.view} onNav={nav} conn={live.conn} nodeName={nodeName} version={snap?.status?.version} uiVersion={health?.uiVersion} principal={health?.principal} badge={gwBadge} hidden={hidden} node={node}>
        {body}
      </Shell>
      <TokenDialog open={authNeeded} />
    </ToastProvider>
  );
}

function TokenDialog({ open }: { open: boolean }) {
  const [tok, setTok] = useState(getToken() ?? '');
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setToken(tok.trim() || null);
    try { const h = await fetch('/api/snapshot', { headers: { authorization: `Bearer ${tok.trim()}` } }); if (h.status === 401) { setErr('Token rejected'); return; } setErr(null); setAuthNeeded(false); reconnectLive(); }
    catch { setErr('Server unreachable'); }
  };
  return (
    <Modal open={open} onClose={() => {}} title="Access token required" width="max-w-sm">
      <form onSubmit={submit} className="grid gap-3">
        <p className="text-sm text-ink-2">This FIPS UI instance is protected. Enter the token configured via <code>FIPS_UI_TOKEN</code>.</p>
        <input className="input mono" type="password" value={tok} onChange={(e) => setTok(e.target.value)} placeholder="token" autoFocus />
        {err && <ErrorNote>{err}</ErrorNote>}
        <button className="btn primary">Unlock</button>
      </form>
    </Modal>
  );
}
