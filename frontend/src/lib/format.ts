/** Formatting helpers. Every number in the product is rendered through here. */
import { latencyThresholds } from '@/theme/tokens';

export const formatUsd = (v: number, digits = 2) =>
  `$${v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;

export const formatNumber = (v: number) => v.toLocaleString('en-US');

export const formatPercent = (v: number, digits = 1) => `${(v * 100).toFixed(digits)}%`;

export const formatMs = (v: number) => `${Math.round(v)} ms`;

export function formatDuration(seconds: number): string {
  if (seconds <= 0) return '—';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Relative time without pulling in a locale-heavy dependency. */
export function formatRelative(iso: string, now = Date.now()): string {
  const diff = now - new Date(iso).getTime();
  const abs = Math.abs(diff);
  const units: Array<[number, Intl.RelativeTimeFormatUnit]> = [
    [1000 * 60, 'minute'],
    [1000 * 60 * 60, 'hour'],
    [1000 * 60 * 60 * 24, 'day'],
    [1000 * 60 * 60 * 24 * 30, 'month'],
  ];
  const fmt = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  if (abs < 45_000) return 'just now';
  for (let i = 0; i < units.length; i++) {
    const [ms, unit] = units[i]!;
    const next = units[i + 1]?.[0] ?? Infinity;
    if (abs < next) return fmt.format(-Math.round(diff / ms), unit);
  }
  return new Date(iso).toLocaleDateString();
}

export type LatencyGrade = 'good' | 'warn' | 'bad';

/** One rule for latency colour, used by every tile, table cell and lane. */
export function gradeLatency(ms: number): LatencyGrade {
  if (ms <= latencyThresholds.good) return 'good';
  if (ms <= latencyThresholds.warn) return 'warn';
  return 'bad';
}

/** Tax-ID label follows the country (docs/10 §Just-in-time collection). */
export function taxIdLabel(country: string): string {
  switch (country.toUpperCase()) {
    case 'IN':
      return 'GSTIN';
    case 'US':
      return 'EIN';
    case 'GB':
      return 'VAT number';
    default:
      return 'VAT ID';
  }
}
