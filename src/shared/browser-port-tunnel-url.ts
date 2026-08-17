/* Why: Stage 2 URL translation for client-owned tunneled browser pages.
 *
 * The local webview navigates to a loopback URL served by a Stage 1 tunnel
 * listener. The persisted descriptor records the original remote origin and
 * port so fallback can translate the local URL back to the remote origin and
 * so restore can present the remote origin in UI before the tunnel reacquires.
 *
 * Pure functions here keep the store actions focused: they never touch the
 * tunnel manager (Stage 1), never persist lease/grant/socket state, and never
 * rewrite path/query/fragment — those survive origin translation unchanged.
 *
 * The local origin is supplied by the caller (from Stage 1 acquisition)
 * rather than reconstructed from remotePort, so custom loopback hostnames
 * needed for Host headers, cookies, and TLS SNI are preserved.
 */
import type { BrowserPortTunnelDescriptor } from './browser-workspace-types'

/** Normalized local origin: `protocol://hostname:port` with no path or slash.
 *  Used as the matching side for local-to-remote translation. */
export type NormalizedOrigin = {
  protocol: string
  hostname: string
  port: string
  origin: string
}

const DEFAULT_PORTS: Record<string, number> = { 'http:': 80, 'https:': 443 }

function explicitPort(hostname: string, port: number): string {
  const isIpv6 = hostname.includes(':')
  const host = isIpv6 ? `[${hostname}]` : hostname
  return `${host}:${port}`
}

/** Parse an origin string into normalized protocol/hostname/port. Returns
 *  null when the input is not a valid http(s) URL. The port is always the
 *  string form a URL parser yields (empty string for default ports); callers
 *  that need the numeric port should parse it themselves. */
export function normalizeOrigin(value: string): NormalizedOrigin | null {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null
    }
    return {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      origin: url.origin
    }
  } catch {
    return null
  }
}

export function effectiveOriginPort(origin: Pick<NormalizedOrigin, 'port' | 'protocol'>): number {
  return origin.port === '' ? (DEFAULT_PORTS[origin.protocol] ?? 0) : Number(origin.port)
}

function samePort(parsed: URL, origin: NormalizedOrigin): boolean {
  const parsedPort =
    parsed.port === '' ? (DEFAULT_PORTS[parsed.protocol] ?? 0) : Number(parsed.port)
  return parsedPort === effectiveOriginPort(origin)
}

function originsEquivalent(a: NormalizedOrigin, b: NormalizedOrigin): boolean {
  if (a.protocol !== b.protocol) {
    return false
  }
  if (a.hostname !== b.hostname) {
    return false
  }
  const aPort = a.port === '' ? String(DEFAULT_PORTS[a.protocol] ?? 0) : a.port
  const bPort = b.port === '' ? String(DEFAULT_PORTS[b.protocol] ?? 0) : b.port
  return aPort === bPort
}

/** Build the remote origin string for a descriptor. Always carries an
 *  explicit port so a default-port listener on the runtime is not lost when
 *  the local listener is remapped to a non-default port. */
export function remoteOriginForDescriptor(
  descriptor: BrowserPortTunnelDescriptor
): NormalizedOrigin {
  const parsed = normalizeOrigin(descriptor.remoteOrigin)
  if (!parsed) {
    throw new Error('BrowserPortTunnelDescriptor.remoteOrigin is invalid')
  }
  return {
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    port: String(descriptor.remotePort),
    origin: `${parsed.protocol}//${explicitPort(parsed.hostname, descriptor.remotePort)}`
  }
}

/** Normalize a local origin string supplied by Stage 1 acquisition into the
 *  shape used by translation. The caller receives the actual local URL the
 *  tunnel listener bound (which may use a custom loopback hostname, not just
 *  127.0.0.1), so Host headers, cookies, and TLS SNI are preserved. Returns
 *  null when the input is not a valid http(s) URL. */
export function normalizeLocalOrigin(localOrigin: string): NormalizedOrigin | null {
  return normalizeOrigin(localOrigin)
}

/** Translate a local tunnel URL back to its remote origin, preserving
 *  path/query/fragment. Used by fallback to capture the last committed URL in
 *  remote terms before the page transitions to a host-owned screencast.
 *
 *  Returns null when the URL does not match the local tunnel origin (e.g. the
 *  user navigated away to a different site). In that case fallback keeps the
 *  URL verbatim — top-level navigation away from the tunneled origin is
 *  allowed and uses the desktop's normal network. */
export function translateLocalUrlToRemote(
  localUrl: string,
  descriptor: BrowserPortTunnelDescriptor,
  localOrigin: NormalizedOrigin
): string | null {
  let parsed: URL
  try {
    parsed = new URL(localUrl)
  } catch {
    return null
  }
  if (parsed.protocol !== localOrigin.protocol) {
    return null
  }
  // Why: accept loopback aliases (127.0.0.1, localhost, ::1) so a navigated-to
  // variant of the same origin still translates when the tunnel bound a
  // custom hostname. Cross-origin top-level navigation does not translate.
  const hostnameAliases = new Set(['127.0.0.1', 'localhost', '::1'])
  const matchesHostname =
    parsed.hostname === localOrigin.hostname || hostnameAliases.has(parsed.hostname)
  if (!matchesHostname) {
    return null
  }
  if (!samePort(parsed, localOrigin)) {
    return null
  }
  const remote = remoteOriginForDescriptor(descriptor)
  if (localOrigin.protocol !== remote.protocol) {
    return null
  }
  let result = `${remote.origin}${parsed.pathname}`
  if (parsed.search) {
    result += parsed.search
  }
  if (parsed.hash) {
    result += parsed.hash
  }
  return result
}

/** Inverse of translateLocalUrlToRemote: translate a remote URL (e.g. the
 *  advertised origin from a workspace port) to the local tunnel origin so the
 *  client-owned webview can navigate to it. Path/query/fragment preserved. */
export function translateRemoteUrlToLocal(
  remoteUrl: string,
  descriptor: BrowserPortTunnelDescriptor,
  localOrigin: NormalizedOrigin
): string | null {
  let parsed: URL
  try {
    parsed = new URL(remoteUrl)
  } catch {
    return null
  }
  const remote = remoteOriginForDescriptor(descriptor)
  if (parsed.protocol !== remote.protocol) {
    return null
  }
  if (parsed.hostname !== remote.hostname) {
    return null
  }
  const remoteUrlPort =
    parsed.port === '' ? String(DEFAULT_PORTS[remote.protocol] ?? 0) : parsed.port
  const remoteDescriptorPort = remote.port
  if (remoteUrlPort !== remoteDescriptorPort) {
    return null
  }
  let result = `${localOrigin.origin}${parsed.pathname}`
  if (parsed.search) {
    result += parsed.search
  }
  if (parsed.hash) {
    result += parsed.hash
  }
  return result
}

/** True when two normalized origins are the same site (protocol+host+port).
 *  Used by the restore gate to decide whether a persisted local URL is still
 *  on the tunnel origin or has navigated elsewhere. */
export function isSameTunnelOrigin(
  a: NormalizedOrigin | null,
  b: NormalizedOrigin | null
): boolean {
  if (!a || !b) {
    return false
  }
  return originsEquivalent(a, b)
}
