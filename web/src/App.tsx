import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { Shell, NAV, ADMIN_VIEWS, type ViewId } from './components/Shell';
import { ToastProvider, Modal, ErrorNote, Empty, Chip } from './components/ui';
import { api, useLive, useAuthNeeded, setAuthNeeded, setToken, getToken, reconnectLive } from './lib/api';
import type { Health } from './lib/types';
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
import { shortKey } from './lib/format';
import { useHostName } from './lib/names';

function parseHash(): { view: ViewId; params: URLSearchParams } {
  const h = location.hash.replace(/^#\/?/, '');
  const [path, qs] = h.split('?');
  const view = (NAV.some((n) => n.id === path) ? path : 'overview') as ViewId;
  return { view, params: new URLSearchParams(qs ?? '') };
}

export default function App() {
  const [route, setRoute] = useState(parseHash);
  const [health, setHealth] = useState<Health | null>(null);
  const live = useLive();
  const authNeeded = useAuthNeeded();
  useEffect(() => { const on = () => setRoute(parseHash()); window.addEventListener('hashchange', on); return () => window.removeEventListener('hashchange', on); }, []);
  useEffect(() => { api.health().then(setHealth).catch(() => {}); }, [authNeeded]);
  useEffect(() => { const s = live.snapshot?.status; document.title = s ? `${route.view === 'overview' ? '' : NAV.find((n) => n.id === route.view)?.label + ' · '}FIPS ${s.peer_count} peer${s.peer_count === 1 ? '' : 's'}` : 'FIPS Node'; }, [live.snapshot, route.view]);

  const nav = useCallback((view: ViewId, params?: Record<string, string>) => {
    const qs = params ? `?${new URLSearchParams(params)}` : '';
    location.hash = `#/${view}${qs}`;
  }, []);
  const selectPeer = useCallback((npub: string | null) => nav('peers', npub ? { peer: npub } : undefined), [nav]);
  const probe = useCallback((peer: string) => nav('diagnostics', { peer }), [nav]);

  const snap = live.snapshot;
  const viewer = health?.principal?.role === 'viewer';
  const ownName = useHostName(snap?.status?.npub);
  const nodeName = useMemo(() => snap?.status ? `${snap.status.tun_name} · ${ownName ? `${ownName} · ` : ''}${shortKey(snap.status.npub, 12, 6)}` : '', [snap, ownName]);
  const gwBadge = snap?.gateway ? <Chip tone="good" className="ml-auto" dot={false}>on</Chip> : undefined;
  // The public-domains page exists where the node runs the resolver or the server (health says), and for an
  // admin whose helper can install them.
  const pd = health?.pubdom;
  const hidden: ViewId[] = (pd && (pd.resolver.installed || pd.server.installed)) || health?.nodeManagement ? [] : ['pubdom'];

  let body: React.ReactNode;
  if (viewer && ADMIN_VIEWS.includes(route.view)) {
    body = <Empty>This page needs the admin role; your npub has viewer access.</Empty>;
  } else if (!snap) {
    body = live.refused ? <ErrorNote>The FIPS UI server refused this browser: {live.refused}</ErrorNote>
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
      case 'config': body = <Suspense fallback={<Empty><div className="pulse">Loading…</div></Empty>}><Config readOnly={!!health?.readOnly} /></Suspense>; break;
      case 'firewall': { const port = route.params.get('port'); body = <Firewall snap={snap} readOnly={!!health?.readOnly} prefill={port ? { port, proto: route.params.get('proto') === 'udp' ? 'udp' : 'tcp', comment: route.params.get('note') ?? undefined } : null} />; break; }
      default: body = <Overview snap={snap} health={health} onNav={nav} />;
    }
  }

  return (
    <ToastProvider>
      <Shell view={route.view} onNav={nav} conn={live.conn} nodeName={nodeName} version={snap?.status?.version} uiVersion={health?.uiVersion} principal={health?.principal} badge={gwBadge} hidden={hidden}>
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
