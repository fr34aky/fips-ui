import { useEffect, useMemo, useState } from 'react';
import { KeyRound, Play, RefreshCw, ShieldAlert, ShieldCheck } from 'lucide-react';
import { Card, Chip, Copyable, Empty, ErrorNote, KV, Segmented, Skeleton, useNow, useToast } from '../components/ui';
import { StatTile } from '../components/StatTile';
import { usePoll } from '../lib/api';
import { hashFor } from '../lib/route';
import { fmtAgo, fmtDuration, fmtTime } from '../lib/format';
import { CATEGORIES, SECURITY_HELPER_VERSION, SEVERITIES, WEEKDAYS, gradeTone, securityApi, severityTone, type Listener, type Report, type ScanSettings, type Severity, type Verdict } from '../lib/security';

export function Security({ readOnly }: { readOnly: boolean }) {
  const toast = useToast();
  // While a scan runs (or one was just asked for), poll quickly; the toast says how it ended.
  const [watching, setWatching] = useState(false);
  const st = usePoll(() => securityApi.get(), [], watching ? 3000 : 30000);
  const hist = usePoll(() => securityApi.history(), [st.data?.latest?.scannedAt], 0);
  const s = st.data;
  // Poll quickly while a scan runs, and say when it is over.
  // Every answer is a new object: a scan that ended before the next poll still ends the watch.
  useEffect(() => {
    if (!s) return;
    if (s.running) { setWatching(true); return; }
    if (!watching) return;
    setWatching(false);
    if (s.lastError) toast('err', `Scan failed: ${s.lastError}`); else toast('ok', 'Scan finished');
  }, [s]); // eslint-disable-line react-hooks/exhaustive-deps

  const scan = async () => {
    try { await securityApi.scan(); setWatching(true); st.refresh(); toast('info', 'Scan started; it takes a minute or a few'); }
    catch (e) { toast('err', (e as Error).message); }
  };

  if (st.error && !s) return <ErrorNote>{st.error}</ErrorNote>;
  if (!s) return <Skeleton className="h-40 w-full" />;
  const r = s.latest;
  const trend = (hist.data?.history ?? []).map((h) => h.score);

  return (
    <div className="grid gap-4 fade-in">
      <p className="text-ink-2 text-sm max-w-3xl">
        Once a week the privileged helper runs a fixed set of read-only checks on this machine: what listens and whether the host firewall lets it through,
        pending and security updates and known vulnerabilities from the distribution's own tools, reboots that updates are waiting for, and a few hardening settings.
        Nothing is changed and nothing leaves the node; the score is explained in <a className="underline" href="https://github.com/fr34aky/fips-ui/blob/main/docs/security-scan.md" target="_blank" rel="noreferrer">docs/security-scan.md</a>.
      </p>
      {!s.available && <HelperNotice helper={s.helper} />}
      {s.lastError && !s.running && <ErrorNote>The last scan failed{s.lastFailure ? ` ${fmtAgo(s.lastFailure)}` : ''}: {s.lastError}</ErrorNote>}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatTile hero label="Score" value={r ? <span className="flex items-baseline gap-2">{r.score}<span className="text-base text-ink-3">/ 100</span><Chip tone={gradeTone(r.grade)} dot={false} className="text-sm">{r.grade}</Chip></span> : '–'} sub={r ? `scanned ${fmtAgo(r.scannedAt)}` : 'not scanned yet'} trend={trend} />
        <StatTile label="Findings" value={r ? <SeverityCounts report={r} /> : '–'} sub={r ? `${r.findings.filter((f) => f.severity !== 'info').length} that cost points` : undefined} />
        <StatTile label="Reachable services" value={r ? String(reachable(r.listeners).length) : '–'} sub={r ? `${r.firewall.backend === 'none' ? 'no host firewall' : r.firewall.defaultDeny ? `${FW_NAME[r.firewall.backend] ?? r.firewall.backend} · default deny` : r.firewall.defaultDeny === false ? `${FW_NAME[r.firewall.backend] ?? r.firewall.backend} · open by default` : 'firewall unknown'}` : undefined} />
        <StatTile label="Pending updates" value={r?.packages.updates ? String(r.packages.updates.length) : '–'} sub={r?.packages.updates ? `${r.packages.updates.filter((u) => u.security).length} security${r.reboot.required ? ' · reboot needed' : ''}` : r ? (r.packages.supported ? 'could not be read' : 'not supported here') : undefined} />
      </div>

      <div className="grid gap-4 lg:grid-cols-[360px_minmax(0,1fr)]">
        <ScheduleCard settings={s.settings} running={s.running} startedAt={s.startedAt} nextRun={s.nextRun} available={s.available} readOnly={readOnly} onScan={scan} onSaved={() => st.refresh()} />
        {r ? <CategoryCard report={r} /> : <Card title="Categories"><Empty>{s.running ? <span className="pulse">Scanning…</span> : 'No scan yet. Run one now, or wait for the schedule.'}</Empty></Card>}
      </div>

      {r && <>
        <FindingsCard report={r} />
        <ListenersCard listeners={r.listeners} readOnly={readOnly} defaultDeny={r.firewall.defaultDeny} />
        <PackagesCard report={r} />
        <Card title="About this scan">
          <KV items={[
            ['System', r.system.name ?? '–'], ['Kernel', <span key="k" className="mono">{r.system.kernel ?? '–'}</span>], ['Package manager', r.system.nixos ? 'Nix (NixOS)' : r.system.manager],
            ['Firewall', `${r.firewall.backend}${r.firewall.detail ? ` · ${r.firewall.detail}` : ''}`], ['Scanned', `${fmtTime(r.scannedAt, true)} · took ${fmtDuration(r.durationSecs)}`], ['Helper', `v${r.helperVersion}`],
          ]} />
          {r.notes.length > 0 && <div className="mt-3 text-xs text-ink-3 grid gap-1"><div className="font-medium text-ink-2">Not covered by this scan</div>{r.notes.map((n, i) => <div key={i} className="break-words">{n}</div>)}</div>}
        </Card>
      </>}
    </div>
  );
}

function HelperNotice({ helper }: { helper: { version: number | null; available: boolean; error?: string } }) {
  return (
    <Card>
      <div className="flex items-start gap-3 text-sm">
        <KeyRound size={18} className="text-warn mt-0.5 shrink-0" />
        <div className="grid gap-2">
          <div className="font-medium">The security scan needs the privileged helper, version {SECURITY_HELPER_VERSION} or newer, on Linux</div>
          <div className="text-ink-2">{helper.available && helper.version ? `The installed helper is v${helper.version}.` : helper.error ?? 'The helper is not available.'} Listing every listener with its process, reading the firewall and the account files needs root; install or update the helper from a shell in the fips-ui directory:</div>
          <Copyable text="sudo ./deploy/setup-local.sh" className="rounded-lg bg-surface-2 px-3 py-2 text-xs w-fit" />
        </div>
      </div>
    </Card>
  );
}

function SeverityCounts({ report }: { report: Report }) {
  const counts = Object.fromEntries(SEVERITIES.map((s) => [s, report.findings.filter((f) => f.severity === s).length])) as Record<Severity, number>;
  const shown = SEVERITIES.filter((s) => s !== 'info' && counts[s] > 0);
  if (shown.length === 0) return <span className="text-good">none</span>;
  return <span className="flex gap-1.5 flex-wrap text-base">{shown.map((s) => <Chip key={s} tone={severityTone(s)} dot={false}>{counts[s]} {s}</Chip>)}</span>;
}

function ScheduleCard({ settings, running, startedAt, nextRun, available, readOnly, onScan, onSaved }: { settings: ScanSettings; running: boolean; startedAt?: number; nextRun: number | null; available: boolean; readOnly: boolean; onScan: () => void; onSaved: () => void }) {
  const toast = useToast();
  const now = useNow(1000);
  const [draft, setDraft] = useState(settings);
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft(settings), [settings.enabled, settings.weekday, settings.hour]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = draft.enabled !== settings.enabled || draft.weekday !== settings.weekday || draft.hour !== settings.hour;
  const save = async () => {
    setBusy(true);
    try { await securityApi.saveSettings(draft); toast('ok', 'Schedule saved'); onSaved(); }
    catch (e) { toast('err', (e as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <Card title="Schedule" actions={!readOnly && <button className="btn primary sm" disabled={running || !available} onClick={onScan} title={available ? 'Run the checks now' : 'Needs helper v13'}>{running ? <RefreshCw size={14} className="animate-spin" /> : <Play size={14} />}{running ? 'Scanning…' : 'Scan now'}</button>}>
      <div className="grid gap-3 text-sm">
        {running && <div className="text-ink-2 pulse">Scanning since {startedAt ? fmtDuration(Math.round((now - startedAt) / 1000)) : 'now'}…</div>}
        <Segmented value={draft.enabled ? 'on' : 'off'} onChange={(v) => setDraft({ ...draft, enabled: v === 'on' })} options={[{ value: 'on', label: 'Weekly' }, { value: 'off', label: 'Off' }]} />
        <div className="flex gap-2 items-center flex-wrap">
          <select className="input w-auto" disabled={!draft.enabled || readOnly} value={draft.weekday} onChange={(e) => setDraft({ ...draft, weekday: Number(e.target.value) })}>{WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}</select>
          <span className="text-ink-3">at</span>
          <select className="input w-auto" disabled={!draft.enabled || readOnly} value={draft.hour} onChange={(e) => setDraft({ ...draft, hour: Number(e.target.value) })}>{Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}</select>
        </div>
        <div className="text-xs text-ink-3">{nextRun === null ? 'Automatic scans are off.' : nextRun <= now ? 'A scheduled scan is due now.' : `Next scan ${fmtSlot(nextRun)}. A scan missed while fips-ui was down runs when it is back.`}</div>
        {!readOnly && <div><button className="btn sm" disabled={!dirty || busy} onClick={save}>Save schedule</button></div>}
      </div>
    </Card>
  );
}

function CategoryCard({ report }: { report: Report }) {
  return (
    <Card title="Categories" hint="Points each category takes off the score (each has a cap)">
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
        {CATEGORIES.map((c) => {
          const v = report.categories[c.id];
          // Notes (info) cost nothing and are not counted here; the findings table shows them under All.
          const scored = report.findings.filter((f) => f.category === c.id && f.severity !== 'info').length;
          const tone = v.deducted === 0 ? 'good' : v.deducted >= 15 ? 'crit' : v.deducted >= 5 ? 'warn' : 'accent';
          return (
            <div key={c.id} className="rounded-lg bg-surface-2 px-3 py-2.5 min-w-0" title={c.hint}>
              <div className="text-xs text-ink-3 truncate">{c.label}</div>
              <div className="flex items-baseline gap-2 mt-0.5"><span className="text-xl font-semibold">{v.deducted === 0 ? <ShieldCheck size={18} className="text-good inline" /> : `−${v.deducted}`}</span><Chip tone={tone} dot={false}>{scored} finding{scored === 1 ? '' : 's'}</Chip></div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function FindingsCard({ report }: { report: Report }) {
  const [filter, setFilter] = useState<'scored' | 'all'>('scored');
  const shown = report.findings.filter((f) => filter === 'all' || f.severity !== 'info');
  const label = Object.fromEntries(CATEGORIES.map((c) => [c.id, c.label]));
  return (
    <Card title={`Findings (${shown.length})`} pad={false} actions={<Segmented value={filter} onChange={setFilter} options={[{ value: 'scored', label: 'Scored' }, { value: 'all', label: 'All' }]} />}>
      {shown.length === 0 ? <Empty icon={<ShieldCheck size={22} className="text-good" />}>Nothing that costs points.</Empty> : (
        <div className="overflow-x-auto"><table className="data"><thead><tr><th>Severity</th><th>Category</th><th>Finding</th><th>What to do</th></tr></thead><tbody>
          {shown.map((f) => (
            <tr key={f.id}>
              <td><Chip tone={severityTone(f.severity)}>{f.severity}</Chip></td>
              <td className="text-xs text-ink-2">{label[f.category]}</td>
              <td className="whitespace-normal min-w-[260px]"><div className="font-medium">{f.title}</div>{f.detail && <div className="text-xs text-ink-3 break-words mono">{f.detail}</div>}</td>
              <td className="whitespace-normal min-w-[220px] text-xs text-ink-2">{f.fix ?? '–'}</td>
            </tr>
          ))}
        </tbody></table></div>
      )}
    </Card>
  );
}

const FW_NAME: Record<string, string> = { nft: 'nftables', ufw: 'ufw', firewalld: 'firewalld', iptables: 'iptables' };
const fmtSlot = (ms: number) => new Date(ms).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

const reachable = (ls: Listener[]) => ls.filter((l) => !l.ephemeral && l.scope !== 'loopback' && (open(l.lan) || open(l.mesh)));
const open = (v?: Verdict) => v === 'allowed' || v === 'none' || v === 'unknown';
const VERDICT: Record<Verdict, { label: string; tone: 'good' | 'warn' | 'crit' | 'neutral' | 'accent' }> = {
  blocked: { label: 'blocked', tone: 'good' }, restricted: { label: 'some sources', tone: 'accent' }, allowed: { label: 'open', tone: 'crit' }, unknown: { label: 'unknown', tone: 'warn' }, none: { label: 'no firewall', tone: 'crit' },
};
/** An open port behind a default-deny firewall was allowed on purpose: said calmly. */
const verdictInfo = (v: Verdict, defaultDeny: boolean | null) => (v === 'allowed' && defaultDeny ? { label: 'allowed', tone: 'warn' as const } : VERDICT[v]);

function ListenersCard({ listeners, readOnly, defaultDeny }: { listeners: Listener[]; readOnly: boolean; defaultDeny: boolean | null }) {
  const [filter, setFilter] = useState<'reachable' | 'all'>('reachable');
  const shown = useMemo(() => (filter === 'all' ? listeners : reachable(listeners)), [filter, listeners]);
  return (
    <Card title={`Listening services (${shown.length})`} hint="What accepts connections on this machine, and what the host firewall does with a new one from the LAN side and from the mesh" pad={false} actions={<Segmented value={filter} onChange={setFilter} options={[{ value: 'reachable', label: 'Reachable' }, { value: 'all', label: 'All' }]} />}>
      {shown.length === 0 ? <Empty>{filter === 'reachable' ? 'Nothing is reachable from outside this machine.' : 'No listeners.'}</Empty> : (
        <div className="overflow-x-auto"><table className="data"><thead><tr><th>Port</th><th>Process</th><th>Bound to</th><th>Scope</th><th>From the LAN</th><th>From the mesh</th><th /></tr></thead><tbody>
          {shown.map((l) => (
            <tr key={`${l.proto}-${l.addr}-${l.iface ?? ''}-${l.port}`} className={l.ephemeral ? 'opacity-60' : ''}>
              <td className="mono">{l.proto}/{l.port}</td>
              <td>{l.process ?? <span className="text-ink-3">–</span>}</td>
              <td className="mono text-xs">{l.addr}{l.iface ? `%${l.iface}` : ''}</td>
              <td className="text-xs text-ink-2">{l.ephemeral ? 'client socket' : l.scope}</td>
              <td>{l.lan ? <Chip tone={verdictInfo(l.lan, defaultDeny).tone}>{verdictInfo(l.lan, defaultDeny).label}</Chip> : <span className="text-ink-3">–</span>}</td>
              <td>{l.mesh ? <Chip tone={verdictInfo(l.mesh, true).tone}>{verdictInfo(l.mesh, true).label}</Chip> : <span className="text-ink-3">–</span>}</td>
              <td>{!readOnly && l.mesh === 'blocked' && <a className="btn ghost sm" href={hashFor('firewall', { port: String(l.port), proto: l.proto, note: l.process ?? '' })} title="Allow npubs to reach it over the mesh">Allow on mesh</a>}</td>
            </tr>
          ))}
        </tbody></table></div>
      )}
    </Card>
  );
}

/** A CVE's page at the distribution's tracker, or NVD. */
function cveUrl(id: string, system: Report['system']): string {
  const name = (system.name ?? '').toLowerCase();
  if (!id.startsWith('CVE-')) return `https://www.google.com/search?q=${encodeURIComponent(id)}`;
  if (name.includes('ubuntu')) return `https://ubuntu.com/security/${id}`;
  if (name.includes('debian') || system.manager === 'apt') return `https://security-tracker.debian.org/tracker/${id}`;
  if (system.manager === 'pacman') return `https://security.archlinux.org/${id}`;
  if (system.manager === 'dnf') return `https://access.redhat.com/security/cve/${id}`;
  if (system.manager === 'zypper') return `https://www.suse.com/security/cve/${id}.html`;
  return `https://nvd.nist.gov/vuln/detail/${id}`;
}

function PackagesCard({ report }: { report: Report }) {
  const p = report.packages;
  const updates = [...(p.updates ?? [])].sort((a, b) => Number(b.security) - Number(a.security) || a.name.localeCompare(b.name));
  const vulns = [...(p.vulns ?? [])].sort((a, b) => Number(b.fixed) - Number(a.fixed) || SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));
  const [tab, setTab] = useState<'updates' | 'vulns'>('updates');
  return (
    <Card title="Packages" pad={false} hint={p.vulnSource ? `Vulnerabilities from ${p.vulnSource}` : undefined} actions={<Segmented value={tab} onChange={setTab} options={[{ value: 'updates', label: `Updates (${updates.length})` }, { value: 'vulns', label: `Vulnerabilities (${vulns.length})` }]} />}>
      {report.reboot.required && <div className="px-4 pt-3 text-sm flex items-start gap-2"><ShieldAlert size={16} className="text-warn mt-0.5 shrink-0" /><span>A reboot is needed: {report.reboot.reasons.join('; ')}.</span></div>}
      {tab === 'updates' ? (
        !p.supported ? <Empty>{report.system.nixos ? 'Updates are managed by Nix: update the flake inputs and run nixos-rebuild switch.' : `Updates cannot be read with ${p.manager}.`}</Empty>
          : p.updates === null ? <Empty>Updates could not be read{p.errors.length ? `: ${p.errors.join('; ')}` : '.'}</Empty>
          : updates.length === 0 ? <Empty icon={<ShieldCheck size={22} className="text-good" />}>Everything is up to date{p.listsAgeDays !== undefined ? ` (package lists ${p.listsAgeDays} days old)` : ''}.</Empty>
          : <div className="overflow-x-auto max-h-[480px]"><table className="data"><thead><tr><th>Package</th><th>Installed</th><th>Available</th><th>Kind</th><th>Origin</th></tr></thead><tbody>
            {updates.map((u) => <tr key={u.name}><td className="mono">{u.name}</td><td className="mono text-xs text-ink-3">{u.from ?? '–'}</td><td className="mono text-xs">{u.to ?? '–'}</td><td>{u.security ? <Chip tone="serious">security</Chip> : <span className="text-xs text-ink-3">update</span>}</td><td className="text-xs text-ink-3">{u.origin ?? ''}</td></tr>)}
          </tbody></table></div>
      ) : (
        p.vulns === null ? <Empty>Known vulnerabilities are not checked here{p.manager === 'apt' ? ': install debsecan' : p.manager === 'pacman' ? ': install arch-audit' : ''}.</Empty>
          : vulns.length === 0 ? <Empty icon={<ShieldCheck size={22} className="text-good" />}>No known vulnerabilities in installed packages.</Empty>
          : <div className="overflow-x-auto max-h-[480px]"><table className="data"><thead><tr><th>Package</th><th>Severity</th><th>Status</th><th>Advisories</th></tr></thead><tbody>
            {vulns.map((v) => (
              <tr key={`${v.pkg}-${v.fixed}`}>
                <td className="mono">{v.pkg}</td>
                <td><Chip tone={severityTone(v.severity)}>{v.severity}</Chip>{v.remote && <span className="ml-1.5 text-xs text-ink-3">remote</span>}</td>
                <td className="text-xs">{v.fixed ? <span>fixed{v.fixedIn ? ` in ${v.fixedIn}` : ''}</span> : <span className="text-ink-3">no fix yet</span>}</td>
                <td className="whitespace-normal text-xs">{v.advisory && <span className="mono mr-2">{v.advisory}</span>}{v.ids.slice(0, 10).map((id) => <a key={id} className="mono underline mr-2" href={cveUrl(id, report.system)} target="_blank" rel="noreferrer">{id}</a>)}{v.ids.length > 10 && <span className="text-ink-3">+{v.ids.length - 10}</span>}</td>
              </tr>
            ))}
          </tbody></table></div>
      )}
    </Card>
  );
}
