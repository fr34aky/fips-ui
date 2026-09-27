import { Copyable } from './ui';
import { shortKey } from '../lib/format';
import { realName, useHostName } from '../lib/names';

/** Two lines: the clear name (given, or from the hosts file) and below it the shortened npub. */
export function PeerName({ name, npub, nodeAddr, size = 'md' }: { name?: string | null; npub?: string; nodeAddr?: string; size?: 'sm' | 'md' | 'lg' }) {
  const host = useHostName(npub);
  const shown = realName(name) || host;
  const key = npub ?? nodeAddr ?? '';
  const primary = shown || shortKey(key, 12, 6);
  return (
    <span className="inline-flex flex-col min-w-0 leading-tight">
      <span className={`font-medium truncate ${size === 'lg' ? 'text-lg' : size === 'sm' ? 'text-xs' : ''}`}>{primary}</span>
      {shown && key && <Copyable text={key} display={shortKey(key, 12, 6)} className="text-[11px] text-ink-3" />}
    </span>
  );
}

/** One line: the clear name, if any, followed by the shortened npub (copyable). */
export function NpubInline({ npub, name, head = 10, tail = 6, className = '' }: { npub: string | null | undefined; name?: string | null; head?: number; tail?: number; className?: string }) {
  const host = useHostName(npub);
  const shown = realName(name) || host;
  if (!npub) return <span className={className}>{shown ?? '–'}</span>;
  return (
    <span className={`inline-flex items-baseline gap-1.5 min-w-0 ${className}`}>
      {shown && <span className="font-medium truncate">{shown}</span>}
      <Copyable text={npub} display={shortKey(npub, head, tail)} className={shown ? 'text-[11px] text-ink-3' : ''} />
    </span>
  );
}

/** Just the text: the given name, else the hosts-file name, else the fallback. */
export function NameText({ npub, name, fallback }: { npub: string | null | undefined; name?: string | null; fallback: React.ReactNode }) {
  const host = useHostName(npub);
  return <>{realName(name) || host || fallback}</>;
}

/** A peer's hosts-file name with a link to add or change it on the Access page. */
export function HostNameLink({ npub, readOnly }: { npub: string; readOnly?: boolean }) {
  const host = useHostName(npub);
  return (
    <span className="inline-flex items-center gap-2">
      {host ? <Copyable text={`${host}.fips`} display={<b>{host}</b>} mono={false} /> : <span className="text-ink-3">none</span>}
      {!readOnly && <a className="text-xs text-ink-3 hover:text-ink" href={`#/access?name=${encodeURIComponent(npub)}`}>{host ? 'change…' : 'add a name…'}</a>}
    </span>
  );
}
