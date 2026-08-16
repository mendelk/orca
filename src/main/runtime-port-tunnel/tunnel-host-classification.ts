import { isIP } from 'node:net'

export const WILDCARD_HOSTS = new Set(['*', '0.0.0.0', '::', '[::]'])
export const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

export function isWildcardHost(host: string): boolean {
  if (!host) {
    return false
  }
  return WILDCARD_HOSTS.has(host) || WILDCARD_HOSTS.has(host.toLowerCase())
}

export function isLoopbackLiteral(host: string): boolean {
  if (!host) {
    return false
  }
  const lower = host.toLowerCase()
  if (LOOPBACK_HOSTS.has(lower)) {
    return true
  }
  const stripped = lower.replace(/^\[|\]$/g, '')
  if (stripped === '::1') {
    return true
  }
  const family = isIP(stripped)
  if (family === 4) {
    return stripped.startsWith('127.')
  }
  if (family === 6) {
    return stripped === '::1'
  }
  return false
}

export function isPrivateOrPublicIpLiteral(host: string): boolean {
  if (!host) {
    return false
  }
  const lower = host.toLowerCase()
  if (isWildcardHost(lower) || isLoopbackLiteral(lower)) {
    return false
  }
  const stripped = lower.replace(/^\[|\]$/g, '')
  const family = isIP(stripped)
  if (family === 0) {
    // Not an IP literal — a hostname; handled by DNS probe.
    return false
  }
  return family !== 0
}

export function normalizeLoopbackBindHost(host: string): string {
  if (isWildcardHost(host) || isLoopbackLiteral(host)) {
    return '127.0.0.1'
  }
  return host
}
