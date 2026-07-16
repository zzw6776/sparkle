export function formatLatency(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) return '—'
  if (value >= 1000) return `${Number((value / 1000).toFixed(2))} s`
  return `${Math.round(value)} ms`
}
