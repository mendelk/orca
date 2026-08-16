import { describe, expect, it, vi } from 'vitest'
import type { WorkspacePort } from '../../shared/workspace-ports'
import {
  evaluateTunnelEligibility,
  evaluateTunnelEligibilityWith,
  filterTunnelEligiblePorts,
  VALID_TCP_PORT_MAX,
  VALID_TCP_PORT_MIN,
  type DnsLoopbackProbe
} from './tunnel-eligibility'

const WORKTREE = 'repo::/repo'

function makeWorkspacePort(
  overrides: Partial<Extract<WorkspacePort, { kind: 'workspace' }>> = {}
): Extract<WorkspacePort, { kind: 'workspace' }> {
  return {
    id: 'row-1',
    bindHost: '127.0.0.1',
    connectHost: '127.0.0.1',
    port: 5173,
    protocol: 'http',
    kind: 'workspace',
    owner: {
      worktreeId: WORKTREE,
      repoId: 'repo',
      displayName: 'repo',
      path: '/repo',
      confidence: 'cwd'
    },
    ...overrides
  }
}

const loopbackDns: DnsLoopbackProbe = {
  resolvesExclusivelyToLoopback: vi.fn(async () => true)
}
const nonLoopbackDns: DnsLoopbackProbe = {
  resolvesExclusivelyToLoopback: vi.fn(async () => false)
}
const throwingDns: DnsLoopbackProbe = {
  resolvesExclusivelyToLoopback: vi.fn(async () => {
    throw new Error('ENOTFOUND')
  })
}

describe('evaluateTunnelEligibility — workspace rows', () => {
  it('accepts a loopback http workspace row owned by the selected workspace', async () => {
    const result = await evaluateTunnelEligibility(makeWorkspacePort(), WORKTREE, loopbackDns)
    expect(result.eligible).toBe(true)
  })
  it('accepts a wildcard bind workspace row', async () => {
    const port = makeWorkspacePort({ bindHost: '0.0.0.0', connectHost: 'localhost' })
    const result = await evaluateTunnelEligibility(port, WORKTREE, loopbackDns)
    expect(result.eligible).toBe(true)
  })
  it('accepts an https workspace row', async () => {
    const port = makeWorkspacePort({ protocol: 'https' })
    const result = await evaluateTunnelEligibility(port, WORKTREE, loopbackDns)
    expect(result.eligible).toBe(true)
  })
  it('accepts ::1 loopback', async () => {
    const port = makeWorkspacePort({ bindHost: '::1' })
    const result = await evaluateTunnelEligibility(port, WORKTREE, loopbackDns)
    expect(result.eligible).toBe(true)
  })
  it('accepts custom hostname when DNS resolves exclusively to loopback', async () => {
    const port = makeWorkspacePort({ bindHost: 'dev.local' })
    const result = await evaluateTunnelEligibility(port, WORKTREE, loopbackDns)
    expect(result.eligible).toBe(true)
  })
  it('rejects custom hostname when DNS resolves to non-loopback', async () => {
    const port = makeWorkspacePort({ bindHost: 'dev.local' })
    const result = await evaluateTunnelEligibility(port, WORKTREE, nonLoopbackDns)
    expect(result.eligible).toBe(false)
    if (!result.eligible) {
      expect(result.reason).toBe('dns-not-loopback')
    }
  })
  it('rejects custom hostname when DNS lookup throws', async () => {
    const port = makeWorkspacePort({ bindHost: 'dev.local' })
    const result = await evaluateTunnelEligibility(port, WORKTREE, throwingDns)
    expect(result.eligible).toBe(false)
    if (!result.eligible) {
      expect(result.reason).toBe('dns-not-loopback')
      expect(result.detail).toContain('ENOTFOUND')
    }
  })
})

describe('evaluateTunnelEligibility — kind and owner', () => {
  it('rejects container listeners', async () => {
    const port: WorkspacePort = {
      id: 'c1',
      bindHost: '127.0.0.1',
      connectHost: '127.0.0.1',
      port: 5173,
      protocol: 'http',
      kind: 'container'
    }
    const result = await evaluateTunnelEligibility(port, WORKTREE, loopbackDns)
    expect(result.eligible).toBe(false)
    if (!result.eligible) {
      expect(result.reason).toBe('container-listener')
    }
  })
  it('rejects external listeners', async () => {
    const port: WorkspacePort = {
      id: 'e1',
      bindHost: '127.0.0.1',
      connectHost: '127.0.0.1',
      port: 5173,
      protocol: 'http',
      kind: 'external'
    }
    const result = await evaluateTunnelEligibility(port, WORKTREE, loopbackDns)
    expect(result.eligible).toBe(false)
    if (!result.eligible) {
      expect(result.reason).toBe('external-listener')
    }
  })
  it('rejects a workspace row owned by a different workspace', async () => {
    const port = makeWorkspacePort({
      owner: {
        worktreeId: 'other::/other',
        repoId: 'other',
        displayName: 'other',
        path: '/other',
        confidence: 'cwd'
      }
    })
    const result = await evaluateTunnelEligibility(port, WORKTREE, loopbackDns)
    expect(result.eligible).toBe(false)
    if (!result.eligible) {
      expect(result.reason).toBe('owner-mismatch')
    }
  })
})

describe('evaluateTunnelEligibility — port and protocol', () => {
  it('rejects out-of-range ports', async () => {
    const tooLow = makeWorkspacePort({ port: VALID_TCP_PORT_MIN - 1 })
    const tooHigh = makeWorkspacePort({ port: VALID_TCP_PORT_MAX + 1 })
    expect((await evaluateTunnelEligibility(tooLow, WORKTREE, loopbackDns)).eligible).toBe(false)
    expect((await evaluateTunnelEligibility(tooHigh, WORKTREE, loopbackDns)).eligible).toBe(false)
  })
  it('rejects unknown protocol by default', async () => {
    const port = makeWorkspacePort({ protocol: 'unknown' })
    const result = await evaluateTunnelEligibility(port, WORKTREE, loopbackDns)
    expect(result.eligible).toBe(false)
    if (!result.eligible) {
      expect(result.reason).toBe('protocol-not-http-https')
    }
  })
  it('accepts unknown protocol when allowUnknownProtocol is set', async () => {
    const port = makeWorkspacePort({ protocol: 'unknown' })
    const result = await evaluateTunnelEligibility(port, WORKTREE, loopbackDns, {
      allowUnknownProtocol: true
    })
    expect(result.eligible).toBe(true)
  })
})

describe('evaluateTunnelEligibility — IP literal rejection', () => {
  it('rejects private IPv4 bind host', async () => {
    const port = makeWorkspacePort({ bindHost: '10.0.0.1', connectHost: '10.0.0.1' })
    const result = await evaluateTunnelEligibility(port, WORKTREE, loopbackDns)
    expect(result.eligible).toBe(false)
    if (!result.eligible) {
      expect(result.reason).toBe('private-or-public-ip-literal')
    }
  })
  it('rejects public IPv4 bind host', async () => {
    const port = makeWorkspacePort({ bindHost: '8.8.8.8', connectHost: '8.8.8.8' })
    const result = await evaluateTunnelEligibility(port, WORKTREE, loopbackDns)
    expect(result.eligible).toBe(false)
    if (!result.eligible) {
      expect(result.reason).toBe('private-or-public-ip-literal')
    }
  })
})

describe('evaluateTunnelEligibilityWith — injectable resolver', () => {
  it('uses the injected resolver for custom hostnames', async () => {
    const port = makeWorkspacePort({ bindHost: 'dev.local' })
    const resolver = vi.fn(async () => true)
    const result = await evaluateTunnelEligibilityWith(
      port,
      WORKTREE,
      loopbackDns,
      resolver,
      {}
    )
    expect(result.eligible).toBe(true)
    expect(resolver).toHaveBeenCalledWith(loopbackDns, 'dev.local')
  })
})

describe('filterTunnelEligiblePorts', () => {
  it('partitions a scan into eligible and rejected', async () => {
    const ports: WorkspacePort[] = [
      makeWorkspacePort({ id: 'a', port: 5173 }),
      makeWorkspacePort({ id: 'b', port: 3000, protocol: 'unknown' }),
      {
        id: 'c',
        bindHost: '127.0.0.1',
        connectHost: '127.0.0.1',
        port: 8080,
        protocol: 'http',
        kind: 'container'
      },
      makeWorkspacePort({ id: 'd', port: 4173, bindHost: '10.0.0.1', connectHost: '10.0.0.1' })
    ]
    const { eligible, rejected } = await filterTunnelEligiblePorts(ports, WORKTREE, loopbackDns)
    expect(eligible.map((p) => p.id)).toEqual(['a'])
    expect(rejected.map((r) => r.port.id)).toEqual(['b', 'c', 'd'])
  })
})