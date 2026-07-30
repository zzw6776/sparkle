import { is } from '@electron-toolkit/utils'

export const systemDNSListenHost = '127.0.0.1'
export const systemDNSListenPort = is.dev ? 15353 : 5335
export const systemDNSListenAddress = `${systemDNSListenHost}:${systemDNSListenPort}`
