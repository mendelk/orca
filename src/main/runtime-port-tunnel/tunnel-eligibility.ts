import type { WorkspacePort } from '../../shared/workspace-ports'
import { isLoopbackLiteral, isWildcardHost, isPrivateOrPublicIpLiteral } from './tunnel-host-classification'

export type DnsLoopbackProbe = {
  // Why: resolve a custom hostname to confirm it points exclusively at
  // loopback. Tests inject a stub; production uses Node dns/promises.
  resolvesExclusivelyToLoopback(hostname: string): Promise<boolean>
}

export type TunnelEligibilityReason =
  | 'kind-not-workspace'
  | 'owner-mismatch'
  | 'port-out-of-range'
  | 'bind-address-not-loopback'
  | 'container-listener'
  | 'external-listener'
  | 'private-or-public-ip-literal'
  | 'dns-not-loopback'
  | 'protocol-not-http-https'

export type TunnelEligibilityResult =
  | { eligible: true }
  | { eligible: false; reason: TunnelEligibilityReason; detail?: string }

export const VALID_TCP_PORT_MIN = 1
export const VALID_TCP_PORT_MAX = 65535

// Why: a workspace port row is tunneable only when it is workspace-owned by
// the selected workspace, has a valid port, binds to loopback/wildcard (or
// a custom hostname that DNS proves is loopback), and speaks http/https.
// unknown protocol is allowed only when allowUnknownProtocol is set (the
// renderer-side "open anyway" path).
export function evaluateTunnelEligibility(
  port: WorkspacePort,
  expectedWorktreeId: string,
  dns: DnsLoopbackProbe,
  options: { allowUnknownProtocol?: boolean } = {}
): Promise<TunnelEligibilityResult> {
  return evaluateTunnelEligibilityWith(
    port,
    expectedWorktreeId,
    dns,
    (probe, hostname) => probe.resolvesExclusivelyToLoopback(hostname),
    options
  )
}

// Why: split so tests can inject a deterministic resolver without building a
// full DnsLoopbackProbe object.
export async function evaluateTunnelEligibilityWith(
  port: WorkspacePort,
  expectedWorktreeId: string,
  dns: DnsLoopbackProbe,
  resolveLoopback: (probe: DnsLoopbackProbe, hostname: string) => Promise<boolean>,
  options: { allowUnknownProtocol?: boolean } = {}
): Promise<TunnelEligibilityResult> {
  if (port.kind === 'container') {
    return { eligible: false, reason: 'container-listener' }
  }
  if (port.kind === 'external') {
    return { eligible: false, reason: 'external-listener' }
  }
  if (port.kind !== 'workspace') {
    return { eligible: false, reason: 'kind-not-workspace' }
  }
  if (port.owner.worktreeId !== expectedWorktreeId) {
    return {
      eligible: false,
      reason: 'owner-mismatch',
      detail: `expected ${expectedWorktreeId}, got ${port.owner.worktreeId}`
    }
  }
  if (
    !Number.isSafeInteger(port.port) ||
    port.port < VALID_TCP_PORT_MIN ||
    port.port > VALID_TCP_PORT_MAX
  ) {
    return { eligible: false, reason: 'port-out-of-range', detail: `port ${port.port}` }
  }
  if (port.protocol !== 'http' && port.protocol !== 'https') {
    if (!options.allowUnknownProtocol) {
      return { eligible: false, reason: 'protocol-not-http-https', detail: port.protocol }
    }
  }

  const bindHost = port.bindHost
  if (isPrivateOrPublicIpLiteral(bindHost)) {
    return {
      eligible: false,
      reason: 'private-or-public-ip-literal',
      detail: `bindHost ${bindHost}`
    }
  }
  if (isWildcardHost(bindHost) || isLoopbackLiteral(bindHost)) {
    return { eligible: true }
  }

  // Custom hostname: prove it resolves exclusively to loopback.
  let resolvesToLoopback: boolean
  try {
    resolvesToLoopback = await resolveLoopback(dns, bindHost)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { eligible: false, reason: 'dns-not-loopback', detail }
  }
  if (!resolvesToLoopback) {
    return {
      eligible: false,
      reason: 'dns-not-loopback',
      detail: `hostname ${bindHost} did not resolve exclusively to loopback`
    }
  }
  return { eligible: true }
}

// Why: filter a fresh scan to tunneable rows for one workspace. The caller
// still picks the selected origin separately; this is the universe.
export async function filterTunnelEligiblePorts(
  ports: readonly WorkspacePort[],
  expectedWorktreeId: string,
  dns: DnsLoopbackProbe,
  options: { allowUnknownProtocol?: boolean } = {}
): Promise<{ eligible: WorkspacePort[]; rejected: { port: WorkspacePort; result: TunnelEligibilityResult }[] }> {
  const eligible: WorkspacePort[] = []
  const rejected: { port: WorkspacePort; result: TunnelEligibilityResult }[] = []
  for (const port of ports) {
    const result = await evaluateTunnelEligibility(port, expectedWorktreeId, dns, options)
    if (result.eligible) {
      eligible.push(port)
    } else {
      rejected.push({ port, result })
    }
  }
  return { eligible, rejected }
}