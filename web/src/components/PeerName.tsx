import { Copyable } from './ui';
import { shortKey } from '../lib/format';

export function PeerName({ name, npub, nodeAddr, size = 'md' }: { name?: string | null; npub?: string; nodeAddr?: string; size?: 'sm' | 'md' | 'lg' }) {
  const key = npub ?? nodeAddr ?? '';
  const primary = name || shortKey(key, 12, 6);
  return (
    <span className="inline-flex flex-col min-w-0 leading-tight">
      <span className={`font-medium truncate ${size === 'lg' ? 'text-lg' : size === 'sm' ? 'text-xs' : ''}`}>{primary}</span>
      {name && key && <Copyable text={key} display={shortKey(key, 12, 6)} className="text-[11px] text-ink-3" />}
    </span>
  );
}
