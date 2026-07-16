const NON_NETWORK_PROXY_TYPES = new Set<MihomoProxyType>([
  'Direct',
  'Reject',
  'RejectDrop',
  'Compatible',
  'Pass',
  'Dns'
])

export function isTestableProxy(
  proxy: ControllerProxiesDetail | ControllerGroupDetail
): proxy is ControllerProxiesDetail {
  return !('all' in proxy) && !NON_NETWORK_PROXY_TYPES.has(proxy.type)
}
