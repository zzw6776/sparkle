const CLOUDFLARE_CONNECTION_TARGET_BYTES = 10_000_000

export function resolveEffectiveSpeedTestConnections(
  source: SpeedTestSource,
  maxBytes: number,
  configuredConnections: number
): number {
  const normalizedConnections = Math.min(16, Math.max(1, Math.trunc(configuredConnections)))
  if (source !== 'cloudflare') return normalizedConnections

  const connectionsSupportedByTraffic = Math.max(
    1,
    Math.ceil(maxBytes / CLOUDFLARE_CONNECTION_TARGET_BYTES)
  )
  return Math.min(normalizedConnections, connectionsSupportedByTraffic)
}
