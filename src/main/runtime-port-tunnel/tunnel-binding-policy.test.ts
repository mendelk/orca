import { describe, expect, it, vi } from 'vitest'
import type { WorkspacePort } from '../../shared/workspace-ports'
import {
  applyExactPortBindingPolicy,
  partitionBoundCompanions,
  type BindProbe,
  type BindingPolicyEndpoint
} from './tunnel-binding-policy'

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
      worktreeId: 'repo::/repo',
      repoId: 'repo',
      displayName: 'repo',
      path: '/repo',
      confidence: 'cwd'
    },
    ...overrides
  }
}

function makeEndpoint(
  overrides: Partial<BindingPolicyEndpoint> & { port: WorkspacePort }
): BindingPolicyEndpoint {
  return {
    requiredLocalPort: overrides.port.port,
    bindHost: '127.0.0.1',
    ...overrides
  }
}

const freeProbe: BindProbe = {
  isLocalPortFree: vi.fn(async () => true)
}
const busyProbe: BindProbe = {
  isLocalPortFree: vi.fn(async () => false)
}
const throwingProbe: BindProbe = {
  isLocalPortFree: vi.fn(async () => {
    throw new Error('EACCES')
  })
}

describe('applyExactPortBindingPolicy — selected origin', () => {
  it('binds the selected origin on its exact port', async () => {
    const selected = makeEndpoint({ port: makeWorkspacePort({ port: 5173 }) })
    const result = await applyExactPortBindingPolicy(selected, [], freeProbe)
    expect(result.selected.ok).toBe(true)
    if (result.selected.ok) {
      expect(result.selected.localPort).toBe(5173)
      expect(result.selected.bindHost).toBe('127.0.0.1')
    }
  })
  it('returns a fatal conflict when the selected port is busy', async () => {
    const selected = makeEndpoint({ port: makeWorkspacePort({ port: 5173 }) })
    const result = await applyExactPortBindingPolicy(selected, [], busyProbe)
    expect(result.selected.ok).toBe(false)
    if (!result.selected.ok) {
      expect(result.selected.reason).toBe('port-occupied')
      expect(result.selected.detail).toContain('5173')
    }
    // Why: companions are not probed when the selected origin fails.
    expect(result.companions).toEqual([])
  })
  it('returns a fatal conflict when the bind probe throws', async () => {
    const selected = makeEndpoint({ port: makeWorkspacePort({ port: 5173 }) })
    const result = await applyExactPortBindingPolicy(selected, [], throwingProbe)
    expect(result.selected.ok).toBe(false)
    if (!result.selected.ok) {
      expect(result.selected.reason).toBe('bind-failed')
      expect(result.selected.detail).toContain('EACCES')
    }
  })
  it('returns a fatal conflict when no selected endpoint is provided', async () => {
    const result = await applyExactPortBindingPolicy(null, [], freeProbe)
    expect(result.selected).toEqual({ ok: false, reason: 'missing-selected' })
  })
  it('rejects an invalid selected port', async () => {
    const port = makeWorkspacePort({ port: 5173 })
    const selected = makeEndpoint({ port, requiredLocalPort: -1 })
    const result = await applyExactPortBindingPolicy(selected, [], freeProbe)
    expect(result.selected.ok).toBe(false)
    if (!result.selected.ok) {
      expect(result.selected.reason).toBe('invalid-port')
    }
  })
})

describe('applyExactPortBindingPolicy — companions', () => {
  it('binds all companions when their ports are free', async () => {
    const selected = makeEndpoint({ port: makeWorkspacePort({ port: 5173 }) })
    const companions = [
      makeEndpoint({ port: makeWorkspacePort({ port: 3000 }) }),
      makeEndpoint({ port: makeWorkspacePort({ port: 3001 }) })
    ]
    const result = await applyExactPortBindingPolicy(selected, companions, freeProbe)
    expect(result.selected.ok).toBe(true)
    expect(result.companions).toHaveLength(2)
    expect(result.companions.every((c) => c.ok)).toBe(true)
  })
  it('skips conflicted companions (non-blocking) while keeping the selected origin direct', async () => {
    const selected = makeEndpoint({ port: makeWorkspacePort({ port: 5173 }) })
    const busyCompanion = makeEndpoint({ port: makeWorkspacePort({ port: 3000 }) })
    const freeCompanion = makeEndpoint({ port: makeWorkspacePort({ port: 3001 }) })
    // Why: probe that's free for the selected port (5173) but busy for companions.
    const selectiveProbe: BindProbe = {
      isLocalPortFree: vi.fn(async (port: number) => port === 5173)
    }
    const result = await applyExactPortBindingPolicy(
      selected,
      [busyCompanion, freeCompanion],
      selectiveProbe
    )
    expect(result.selected.ok).toBe(true)
    expect(result.companions).toHaveLength(2)
    expect(result.companions[0].ok).toBe(false)
    expect(result.companions[1].ok).toBe(false)
  })
  it('uses the bind host from the endpoint', async () => {
    const selected = makeEndpoint({
      port: makeWorkspacePort({ port: 5173 }),
      bindHost: '127.0.0.1'
    })
    const probe = {
      isLocalPortFree: vi.fn(async (_port: number, bindHost?: string) => {
        expect(bindHost).toBe('127.0.0.1')
        return true
      })
    }
    const result = await applyExactPortBindingPolicy(selected, [], probe)
    expect(result.selected.ok).toBe(true)
    expect(probe.isLocalPortFree).toHaveBeenCalledWith(5173, '127.0.0.1')
  })
})

describe('partitionBoundCompanions', () => {
  it('splits outcomes into bound and conflicted', () => {
    const outcomes = [
      { ok: true as const, localPort: 3000, bindHost: '127.0.0.1', port: makeWorkspacePort({ port: 3000 }) },
      { ok: false as const, reason: 'port-occupied' as const, detail: 'busy', port: makeWorkspacePort({ port: 3001 }) },
      { ok: true as const, localPort: 3002, bindHost: '127.0.0.1', port: makeWorkspacePort({ port: 3002 }) }
    ]
    const { bound, conflicted } = partitionBoundCompanions(outcomes)
    expect(bound.map((b) => b.localPort)).toEqual([3000, 3002])
    expect(conflicted.map((c) => c.port.port)).toEqual([3001])
  })
  it('returns empty arrays for no outcomes', () => {
    const { bound, conflicted } = partitionBoundCompanions([])
    expect(bound).toEqual([])
    expect(conflicted).toEqual([])
  })
})
