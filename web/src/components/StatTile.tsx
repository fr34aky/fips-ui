import type { ReactNode } from 'react';
import { Sparkline } from './Sparkline';

export function StatTile({ label, value, sub, trend, icon, tone, hero = false, onClick }: { label: string; value: ReactNode; sub?: ReactNode; trend?: (number | null)[]; icon?: ReactNode; tone?: string; hero?: boolean; onClick?: () => void }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag onClick={onClick} className={`card text-left px-4 pt-3.5 pb-3 flex flex-col gap-1 min-w-0 ${onClick ? 'hover:border-line-strong transition-colors cursor-pointer' : ''}`} style={{ borderColor: tone }}>
      <div className="flex items-center justify-between gap-2 text-ink-3 text-xs font-medium"><span className="truncate">{label}</span>{icon}</div>
      <div className={`${hero ? 'text-[30px]' : 'text-2xl'} font-semibold leading-tight tracking-tight whitespace-nowrap`}>{value}</div>
      {sub && <div className="text-xs text-ink-3 truncate">{sub}</div>}
      {trend && trend.length > 1 && <div className="mt-1 -mx-1"><Sparkline values={trend} width={200} height={28} className="w-full h-7 block" /></div>}
    </Tag>
  );
}
