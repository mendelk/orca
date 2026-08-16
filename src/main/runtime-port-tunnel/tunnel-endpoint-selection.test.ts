import { describe, expect, it, vi } from 'vitest'
import type { WorkspacePort } from '../../shared/workspace-ports'
import {
  enforceEndpointCap,
  rankCompanions,
  selectTunnelEndpoints,
  MAX_COMPANION_ENDPOINTS,
  MAX_TUNNEL_ENDPOINTS
} from './tunnel-endpoint-selection'
import type { DnsLoopbackProbe } from './tunnel-eligibility'

const WORKTREE = 'repo::/repo'

function makeWorkspacePort(
  overrides: Partial<Extract<WorkspacePort, { kind: 'workspace' }>> = {}
): Extract<WorkspacePort, { kind: 'workspace' }> {
  return {
    id: `row-${overrides.port ?? 5173}`,
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

describe('selectTunnelEndpoints — selected origin', () => {
  it('selects the matching workspace-owned row', async () => {
    const scan = [makeWorkspacePort({ id: 'a', port: 5173 })]
    const result = await selectTunnelEndpoints(scan, 5173, WORKTREE, loopbackDns)
    expect(result.selected?.port).toBe(5173)
    expect(result.companions).toEqual([])
  })
  it('returns unavailable when the selected port is missing', async () => {
    const result = await selectTunnelEndpoints([], 5173, WORKTREE, loopbackDns)
    expect(result.selected).toBeNull()
    expect(result.unavailableReason).toContain('5173')
  })
  it('returns unavailable when the selected port is owned by a different workspace', async () => {
    const port = makeWorkspacePort({
      id: 'a',
      port: 5173,
      owner: {
        worktreeId: 'other::/other',
        repoId: 'other',
        displayName: 'other',
        path: '/other',
        confidence: 'cwd'
      }
    })
    const result = await selectTunnelEndpoints([port], 5173, WORKTREE, loopbackDns)
    expect(result.selected).toBeNull()
    expect(result.unavailableReason).toContain('no longer owned')
  })
  it('returns unavailable when the selected row fails eligibility (non-loopback DNS)', async () => {
    const port = makeWorkspacePort({ id: 'a', port: 5173, bindHost: 'dev.local' })
    const result = await selectTunnelEndpoints([port], 5173, WORKTREE, nonLoopbackDns)
    expect(result.selected).toBeNull()
    expect(result.unavailableReason).toContain('not eligible')
  })
})

describe('selectTunnelEndpoints — companions', () => {
  it('includes eligible companions from the same workspace', async () => {
    const scan = [
      makeWorkspacePort({ id: 'selected', port: 5173 }),
      makeWorkspacePort({ id: 'api', port: 3000 }),
      makeWorkspacePort({ id: 'admin', port: 3001, protocol: 'https' })
    ]
    const result = await selectTunnelEndpoints(scan, 5173, WORKTREE, loopbackDns)
    expect(result.selected?.port).toBe(5173)
    expect(result.companions.map((c) => c.port).sort((a, b) => a - b)).toEqual([3000, 3001])
  })
  it('ranks advertised URLs before non-advertised, then ascending port', async () => {
    const scan = [
      makeWorkspacePort({ id: 'selected', port: 5173 }),
      makeWorkspacePort({ id: 'lowport', port: 3000 }),
      makeWorkspacePort({ id: 'withurl', port: 8080, advertisedUrl: 'http://localhost:8080' }),
      makeWorkspacePort({ id: 'withurl2', port: 4000, advertisedUrl: 'http://localhost:4000' })
    ]
    const result = await selectTunnelEndpoints(scan, 5173, WORKTREE, loopbackDns)
    expect(result.companions.map((c) => c.id)).toEqual(['withurl2', 'withurl', 'lowport'])
  })
  it('caps companions at MAX_COMPANION_ENDPOINTS (15)', async () => {
    const scan = [
      makeWorkspacePort({ id: 'selected', port: 5173 }),
      ...Array.from({ length: 20 }, (_, i) =>
        makeWorkspacePort({ id: `c${i}`, port: 10000 + i })
      )
    ]
    const result = await selectTunnelEndpoints(scan, 5173, WORKTREE, loopbackDns)
    expect(result.companions).toHaveLength(MAX_COMPANION_ENDPOINTS)
    expect(result.companions.map((c) => c.port).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 15 }, (_, i) => 10000 + i)
    )
  })
  it('excludes companions owned by a different workspace', async () => {
    const otherOwner = {
      worktreeId: 'other::/other',
      repoId: 'other',
      displayName: 'other',
      path: '/other',
      confidence: 'cwd' as const
    }
    const scan = [
      makeWorkspacePort({ id: 'selected', port: 5173 }),
      makeWorkspacePort({ id: 'mine', port: 3000 }),
      makeWorkspacePort({ id: 'theirs', port: 3001, owner: otherOwner })
    ]
    const result = await selectTunnelEndpoints(scan, 5173, WORKTREE, loopbackDns)
    expect(result.companions.map((c) => c.id)).toEqual(['mine'])
  })
  it('excludes an unknown-protocol companion only when it lacks an advertised URL', async () => {
    const scan = [
      makeWorkspacePort({ id: 'selected', port: 5173 }),
      makeWorkspacePort({ id: 'unknown', port: 3000, protocol: 'unknown' }),
      makeWorkspacePort({ id: 'unknown-with-url', port: 3001, protocol: 'unknown', advertisedUrl: 'http://localhost:3001' })
    ]
    const result = await selectTunnelEndpoints(scan, 5173, WORKTREE, loopbackDns)
    expect(result.companions.map((c) => c.id)).toEqual(['unknown-with-url'])
  })
  it('includes an unknown-protocol companion with an advertised URL', async () => {
    const scan = [
      makeWorkspacePort({ id: 'selected', port: 5173 }),
      makeWorkspacePort({ id: 'unknown-with-url', port: 3001, protocol: 'unknown', advertisedUrl: 'http://localhost:3001' })
    ]
    const result = await selectTunnelEndpoints(scan, 5173, WORKTREE, loopbackDns)
    expect(result.companions.map((c) => c.id)).toEqual(['unknown-with-url'])
  })
  it('ranks the complete eligible set before applying the companion cap', async () => {
    const scan = [
      makeWorkspacePort({ id: 'selected', port: 5173 }),
      ...Array.from({ length: 16 }, (_, i) =>
        makeWorkspacePort({ id: `plain-${i}`, port: 10000 + i })
      ),
      makeWorkspacePort({
        id: 'advertised-last',
        port: 20000,
        advertisedUrl: 'http://localhost:20000'
      })
    ]
    const result = await selectTunnelEndpoints(scan, 5173, WORKTREE, loopbackDns)
    expect(result.companions).toHaveLength(MAX_COMPANION_ENDPOINTS)
    expect(result.companions[0]?.id).toBe('advertised-last')
  })
})

describe('rankCompanions', () => {
  it('ranks advertised URLs first, then ascending port', () => {
    const companions = [
      makeWorkspacePort({ id: 'a', port: 8080 }),
      makeWorkspacePort({ id: 'b', port: 3000, advertisedUrl: 'http://localhost:3000' }),
      makeWorkspacePort({ id: 'c', port: 4000 }),
      makeWorkspacePort({ id: 'd', port: 2000, advertisedUrl: 'http://localhost:2000' })
    ]
    const ranked = rankCompanions(companions)
    expect(ranked.map((c) => c.id)).toEqual(['d', 'b', 'c', 'a'])
  })
  it('is stable for equal priority', () => {
    const companions = [
      makeWorkspacePort({ id: 'a', port: 3000 }),
      makeWorkspacePort({ id: 'b', port: 3000 })
    ]
    const ranked = rankCompanions(companions)
    expect(ranked.map((c) => c.id)).toEqual(['a', 'b'])
  })
})

describe('enforceEndpointCap', () => {
  it('caps total endpoints at MAX_TUNNEL_ENDPOINTS (16)', () => {
    const selected = makeWorkspacePort({ id: 'selected', port: 5173 })
    const companions = Array.from({ length: 20 }, (_, i) =>
      makeWorkspacePort({ id: `c${i}`, port: 10000 + i })
    )
    const { endpoints, dropped } = enforceEndpointCap(selected, companions)
    expect(endpoints).toHaveLength(MAX_TUNNEL_ENDPOINTS)
    expect(endpoints[0]).toBe(selected)
    expect(dropped).toHaveLength(companions.length - (MAX_TUNNEL_ENDPOINTS - 1))
  })
  it('returns only companions when selected is null', () => {
    const companions = Array.from({ length: 5 }, (_, i) =>
      makeWorkspacePort({ id: `c${i}`, port: 10000 + i })
    )
    const { endpoints, dropped } = enforceEndpointCap(null, companions)
    expect(endpoints).toHaveLength(5)
    expect(dropped).toEqual([])
  })
  it('drops nothing when under the cap', () => {
    const selected = makeWorkspacePort({ id: 'selected', port: 5173 })
    const companions = [makeWorkspacePort({ id: 'c1', port: 3000 })]
    const { endpoints, dropped } = enforceEndpointCap(selected, companions)
    expect(endpoints).toHaveLength(2)
    expect(dropped).toEqual([])
  })
})
