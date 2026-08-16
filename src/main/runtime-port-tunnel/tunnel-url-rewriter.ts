import { isIP } from 'node:net'
import {
  isLoopbackLiteral,
  isWildcardHost,
  normalizeLoopbackBindHost
} from './tunnel-host-classification'

export type DnsProbe = {
  // Why: resolve every A/AAAA record for a hostname. Tests inject a stub so
  // platform DNS is never touched. Returns [] on NXDOMAIN/timeout.
  resolveAll(hostname: string): Promise<string[]>
}

export type RewriteTunnelUrlResult =
  | {
      ok: true
      // The URL the local webview should load. Same port as the runtime listener.
      localUrl: string
      // The hostname the local listener must bind. Always a loopback literal
      // for wildcard/loopback origins; the custom hostname only when DNS
      // proves it resolves exclusively to 127.0.0.1.
      bindHost: string
      // The hostname used in the URL (may differ from bindHost for custom DNS).
      urlHost: string
    }
  | {
      ok: false
      reason:
        | 'invalid-url'
        | 'non-loopback-dns'
        | 'private-or-public-ip-literal'
        | 'missing-port'
        | 'unsupported-protocol'
      detail?: string
    }

// Why: only http/https origins are tunneled. unknown is allowed only when the
// caller already confirmed the user explicitly opened the listener; this
// rewriter does not handle unknown because it lacks an origin URL to rewrite.
const TUNNEL_PROTOCOLS = new Set(['http:', 'https:'])

export function rewriteTunnelUrl(
  originalUrl: string,
  remotePort: number,
  dns: DnsProbe
): Promise<RewriteTunnelUrlResult> {
  return rewriteTunnelUrlWithLookup(originalUrl, remotePort, defaultDnsLookup(dns))
}

// Why: split for testability — a pre-resolved hostname set lets a test pin
// DNS without a stub, and lets callers cache.
export async function rewriteTunnelUrlWithLookup(
  originalUrl: string,
  remotePort: number,
  lookup: (hostname: string) => Promise<string[]>
): Promise<RewriteTunnelUrlResult> {
  if (!Number.isSafeInteger(remotePort) || remotePort <= 0 || remotePort > 65535) {
    return { ok: false, reason: 'missing-port', detail: `port ${remotePort} is out of range` }
  }

  let parsed: URL
  try {
    parsed = new URL(originalUrl)
  } catch {
    return { ok: false, reason: 'invalid-url', detail: originalUrl }
  }

  if (!TUNNEL_PROTOCOLS.has(parsed.protocol)) {
    return {
      ok: false,
      reason: 'unsupported-protocol',
      detail: `protocol ${parsed.protocol} is not http/https`
    }
  }

  const hostname = parsed.hostname // brackets stripped by URL spec
  if (isWildcardHost(hostname) || isLoopbackLiteral(hostname)) {
    const bindHost = '127.0.0.1'
    const urlHost = '127.0.0.1'
    return {
      ok: true,
      localUrl: buildUrl(parsed, urlHost, remotePort),
      bindHost,
      urlHost
    }
  }

  if (isIP(hostname.replace(/^\[|\]$/g, '')) !== 0) {
    return {
      ok: false,
      reason: 'private-or-public-ip-literal',
      detail: `IP literal ${hostname} is not loopback`
    }
  }

  let addresses: string[]
  try {
    addresses = await lookup(hostname)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { ok: false, reason: 'non-loopback-dns', detail }
  }
  if (addresses.length === 0) {
    return {
      ok: false,
      reason: 'non-loopback-dns',
      detail: `hostname ${hostname} did not resolve`
    }
  }
  const allLoopback = addresses.every((address) => address === '127.0.0.1')
  if (!allLoopback) {
    return {
      ok: false,
      reason: 'non-loopback-dns',
      detail: `hostname ${hostname} resolved to non-loopback addresses: ${addresses.join(', ')}`
    }
  }

  return {
    ok: true,
    localUrl: buildUrl(parsed, hostname, remotePort),
    bindHost: '127.0.0.1',
    urlHost: hostname
  }
}

// Why: the runtime-origin -> local-origin translation used during fallback.
// Translates a local tunnel URL (127.0.0.1 or proven custom host) back to the
// descriptor's remote origin, preserving path/query/fragment.
export function translateLocalUrlToRemote(
  localUrl: string,
  remoteOrigin: string
): string | null {
  let local: URL
  try {
    local = new URL(localUrl)
  } catch {
    return null
  }
  let remote: URL
  try {
    remote = new URL(remoteOrigin)
  } catch {
    return null
  }
  remote.pathname = local.pathname
  remote.search = local.search
  remote.hash = local.hash
  return remote.href
}

function defaultDnsLookup(dns: DnsProbe): (hostname: string) => Promise<string[]> {
  return (hostname: string) => dns.resolveAll(hostname)
}

function buildUrl(parsed: URL, host: string, port: number): string {
  const out = new URL(parsed.href)
  out.hostname = host
  out.port = String(port)
  out.username = ''
  out.password = ''
  return out.href
}

// Re-export for callers that classify without rewriting (e.g. eligibility).
export { isWildcardHost, isLoopbackLiteral, normalizeLoopbackBindHost }
