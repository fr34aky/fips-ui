import { useId } from 'react';

export function Sparkline({ values, width = 120, height = 32, color = 'var(--accent)', fill = true, className = '' }: { values: (number | null)[]; width?: number; height?: number; color?: string; fill?: boolean; className?: string }) {
  const id = useId();
  const pts = values.map((v) => (v == null || !Number.isFinite(v) ? null : v));
  const nums = pts.filter((v): v is number => v != null);
  if (nums.length < 2) return <svg width={width} height={height} className={className} aria-hidden />;
  const min = Math.min(...nums), max = Math.max(...nums);
  const range = max - min || 1;
  const pad = 3;
  const x = (i: number) => pad + (i / (pts.length - 1)) * (width - pad * 2);
  const y = (v: number) => height - pad - ((v - min) / range) * (height - pad * 2);
  let d = '';
  let started = false;
  pts.forEach((v, i) => { if (v == null) { started = false; return; } d += `${started ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)} `; started = true; });
  const lastIdx = pts.length - 1 - [...pts].reverse().findIndex((v) => v != null);
  const last = pts[lastIdx] as number;
  const area = `${d}L${x(lastIdx).toFixed(1)},${height - pad} L${x(pts.findIndex((v) => v != null)).toFixed(1)},${height - pad} Z`;
  return (
    <svg width={width} height={height} className={className} aria-hidden viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
      {fill && (
        <>
          <defs><linearGradient id={id} x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor={color} stopOpacity="0.28" /><stop offset="100%" stopColor={color} stopOpacity="0" /></linearGradient></defs>
          <path d={area} fill={`url(#${id})`} />
        </>
      )}
      <path d={d} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      <circle cx={x(lastIdx)} cy={y(last)} r="3" fill={color} stroke="var(--surface)" strokeWidth="2" />
    </svg>
  );
}
