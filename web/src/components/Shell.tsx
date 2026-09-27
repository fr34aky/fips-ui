import { useEffect, useState, type ReactNode } from 'react';
import { Activity, Users, Network, GitBranch, LineChart, Cpu, ScrollText, Stethoscope, ShieldCheck, Router, ArrowUpCircle, FileCog, BrickWall, Sun, Moon, Menu, X, Wifi, WifiOff } from 'lucide-react';
import type { ConnState } from '../lib/api';
import type { Principal } from '../lib/types';
import { useUiUpdate } from '../lib/uiUpdate';

export type ViewId = 'overview' | 'peers' | 'topology' | 'metrics' | 'network' | 'internals' | 'logs' | 'diagnostics' | 'access' | 'gateway' | 'upgrade' | 'config' | 'firewall';

export const NAV: { id: ViewId; label: string; icon: ReactNode; hint: string }[] = [
  { id: 'overview', label: 'Overview', icon: <Activity size={17} />, hint: 'Node status at a glance' },
  { id: 'peers', label: 'Peers', icon: <Users size={17} />, hint: 'Authenticated peers, connect and disconnect' },
  { id: 'topology', label: 'Topology', icon: <GitBranch size={17} />, hint: 'Spanning tree and coordinates' },
  { id: 'metrics', label: 'Metrics', icon: <LineChart size={17} />, hint: 'Time series history' },
  { id: 'network', label: 'Network', icon: <Network size={17} />, hint: 'Transports, links, sessions, flows' },
  { id: 'internals', label: 'Internals', icon: <Cpu size={17} />, hint: 'Routing, bloom, caches, counters' },
  { id: 'logs', label: 'Logs', icon: <ScrollText size={17} />, hint: 'Live daemon journal' },
  { id: 'diagnostics', label: 'Diagnostics', icon: <Stethoscope size={17} />, hint: 'Probe reachability of a node' },
  { id: 'access', label: 'Access', icon: <ShieldCheck size={17} />, hint: 'ACL, firewall exposure, hosts' },
  { id: 'gateway', label: 'Gateway', icon: <Router size={17} />, hint: 'LAN gateway pool and mappings' },
  { id: 'config', label: 'Configuration', icon: <FileCog size={17} />, hint: 'Edit fips.yaml with automatic rollback' },
  { id: 'firewall', label: 'Firewall', icon: <BrickWall size={17} />, hint: 'fips0 firewall service and inbound rules' },
  { id: 'upgrade', label: 'Upgrade', icon: <ArrowUpCircle size={17} />, hint: 'Install a release or build master' },
];

export function useTheme() {
  const [theme, setTheme] = useState<'dark' | 'light'>(() => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'));
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('fips-ui-theme', theme); } catch { /* ignore */ }
    document.querySelector('meta[name=theme-color]')?.setAttribute('content', theme === 'light' ? '#f3f5f9' : '#0a1220');
  }, [theme]);
  return [theme, () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))] as const;
}

/** Pages that only make sense with the admin role. */
export const ADMIN_VIEWS: ViewId[] = ['config', 'firewall', 'upgrade'];

export function Shell({ view, onNav, conn, nodeName, version, uiVersion, principal, children, badge }: { view: ViewId; onNav: (v: ViewId) => void; conn: ConnState; nodeName: string; version?: string; uiVersion?: string; principal?: Principal; children: ReactNode; badge?: ReactNode }) {
  const nav = principal?.role === 'viewer' ? NAV.filter((n) => !ADMIN_VIEWS.includes(n.id)) : NAV;
  const [theme, toggleTheme] = useTheme();
  const [open, setOpen] = useState(false);
  const current = NAV.find((n) => n.id === view)!;
  useEffect(() => { setOpen(false); }, [view]);

  const connChip = conn === 'live'
    ? <span className="chip good"><Wifi size={12} />live</span>
    : conn === 'connecting' ? <span className="chip pulse"><span className="chip-dot" />connecting</span>
    : <span className="chip crit pulse"><WifiOff size={12} />reconnecting</span>;

  return (
    <div className="min-h-full flex">
      {/* Sidebar */}
      <aside className={`fixed lg:sticky top-0 z-40 h-dvh w-64 shrink-0 flex flex-col border-r border-line bg-page/95 backdrop-blur transition-transform lg:translate-x-0 ${open ? 'translate-x-0' : '-translate-x-full'}`} style={{ background: 'color-mix(in srgb, var(--page) 92%, transparent)' }}>
        <div className="flex items-center gap-3 px-4 h-16 shrink-0">
          <img src="/favicon.svg" alt="" width={30} height={30} className="rounded-lg" />
          <div className="min-w-0 leading-tight">
            <div className="font-semibold tracking-tight">FIPS Node</div>
            <div className="text-[11px] text-ink-3 truncate">{version ?? 'mesh dashboard'}</div>
          </div>
          <button className="btn ghost icon sm ml-auto lg:hidden" onClick={() => setOpen(false)} aria-label="Close menu"><X size={16} /></button>
        </div>
        <nav className="flex flex-col gap-0.5 px-3 py-2 overflow-y-auto">
          {nav.map((n) => (
            <a key={n.id} href={`#/${n.id}`} className={`nav-item ${view === n.id ? 'active' : ''}`} onClick={(e) => { e.preventDefault(); onNav(n.id); }} title={n.hint}>
              {n.icon}<span>{n.label}</span>
              {n.id === 'gateway' && badge}
            </a>
          ))}
        </nav>
        <div className="mt-auto px-4 py-4 text-[11px] text-ink-3 border-t border-line">
          <div className="flex items-center justify-between gap-2">
            <span>{connChip}</span>
            <button className="btn ghost icon sm" onClick={toggleTheme} aria-label="Toggle theme" title="Toggle theme">{theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}</button>
          </div>
          {principal?.kind === 'mesh' && <div className="mt-2 flex items-center gap-1.5" title={principal.npub}><span className={`chip ${principal.role === 'admin' ? 'accent' : ''}`}><span className="chip-dot" />via mesh · {principal.label || `${principal.npub.slice(0, 12)}…`} · {principal.role}</span></div>}
          {uiVersion && <div className="mt-2 flex flex-wrap items-center gap-1.5"><a href="https://github.com/fr34aky/fips-ui/blob/main/CHANGELOG.md" target="_blank" rel="noreferrer" className="hover:text-ink" title="Changelog">fips-ui v{uiVersion}</a><UiUpdateBadge admin={principal?.role !== 'viewer'} /></div>}
        </div>
      </aside>
      {open && <div className="fixed inset-0 z-30 lg:hidden" style={{ background: 'rgba(3,8,18,0.5)' }} onClick={() => setOpen(false)} />}

      {/* Main */}
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="sticky top-0 z-20 h-14 flex items-center gap-3 px-4 sm:px-6 border-b border-line" style={{ background: 'color-mix(in srgb, var(--page) 88%, transparent)', backdropFilter: 'blur(10px)' }}>
          <button className="btn ghost icon sm lg:hidden" onClick={() => setOpen(true)} aria-label="Open menu"><Menu size={18} /></button>
          <div className="min-w-0">
            <h1 className="text-base font-semibold leading-tight truncate">{current.label}</h1>
            <div className="text-[11px] text-ink-3 truncate hidden sm:block">{current.hint}</div>
          </div>
          <div className="ml-auto flex items-center gap-2 min-w-0">
            <span className="text-xs text-ink-2 truncate hidden sm:inline mono">{nodeName}</span>
            <span className="lg:hidden">{connChip}</span>
          </div>
        </header>
        <main className="flex-1 px-4 sm:px-6 py-5 max-w-[1500px] w-full mx-auto min-w-0">{children}</main>
      </div>
    </div>
  );
}

/** "v0.4.0 available" next to the version: admins go to the Upgrade page, others to the release notes. */
function UiUpdateBadge({ admin }: { admin: boolean }) {
  const u = useUiUpdate();
  if (!u?.newer || !u.latest) return null;
  return <a className="chip accent" href={admin ? '#/upgrade' : u.latest.url} target={admin ? undefined : '_blank'} rel="noreferrer" title={admin ? 'Update fips-ui from the Upgrade page' : 'Release notes'}>v{u.latest.version} available</a>;
}
