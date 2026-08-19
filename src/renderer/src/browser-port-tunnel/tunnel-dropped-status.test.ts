import { describe, it, expect } from 'vitest'
import { planDroppedStatusAction } from './tunnel-dropped-status'
import { TunnelLeaseState } from './tunnel-lease-state'
import type { BrowserPortTunnelDescriptor } from '../../../shared/browser-workspace-types'
import type { NormalizedOrigin } from '../../../shared/browser-port-tunnel-url'

const descriptor: BrowserPortTunnelDescriptor = {
  environmentId: 'env-1',
  worktreeId: 'repo::/srv/app',
  remoteOrigin: 'http://127.0.0.1:5173',
  remotePort: 5173
}

const localOrigin: NormalizedOrigin = {
  protocol: 'http:',
  hostname: '127.0.0.1',
  port: '5173',
  origin: 'http://127.0.0.1:5173'
}

function seed(
  leaseState: TunnelLeaseState,
  pageId: string,
  selectedId: string,
  companionIds: string[] = []
) {
  leaseState.recordLeases(pageId, descriptor, [
    { leaseId: selectedId, localOrigin, kind: 'selected' },
    ...companionIds.map((id) => ({ leaseId: id, localOrigin, kind: 'companion' as const }))
  ])
}

describe('planDroppedStatusAction — companion drop is partial degradation', () => {
  it('returns companion-partial for a companion lease', () => {
    const leaseState = new TunnelLeaseState()
    seed(leaseState, 'p1', 'L-sel', ['L-c1'])
    const action = planDroppedStatusAction({
      leaseState,
      leaseId: 'L-c1',
      reason: 'channel closed',
      runFallback: async () => ({ outcome: 'fallback', pageId: 'p1' })
    })
    expect(action.kind).toBe('companion-partial')
  })
})

describe('planDroppedStatusAction — selected drop triggers one-shot fallback', () => {
  it('returns selected-fallback for a selected lease', () => {
    const leaseState = new TunnelLeaseState()
    seed(leaseState, 'p1', 'L-sel', ['L-c1'])
    const action = planDroppedStatusAction({
      leaseState,
      leaseId: 'L-sel',
      reason: 'channel closed',
      runFallback: async () => ({ outcome: 'fallback', pageId: 'p1' })
    })
    expect(action.kind).toBe('selected-fallback')
    if (action.kind === 'selected-fallback') {
      expect(action.complete).toBeDefined()
    }
  })
  it('passes the stored actual local origin to runFallback', () => {
    const leaseState = new TunnelLeaseState()
    const customOrigin: NormalizedOrigin = {
      protocol: 'https:',
      hostname: 'local.getmontecarlo.com',
      port: '3001',
      origin: 'https://local.getmontecarlo.com:3001'
    }
    leaseState.recordLeases('p1', descriptor, [
      { leaseId: 'L-sel', localOrigin: customOrigin, kind: 'selected' }
    ])
    let captured: NormalizedOrigin | null = null
    planDroppedStatusAction({
      leaseState,
      leaseId: 'L-sel',
      reason: 'closed',
      runFallback: async (_id, _desc, origin) => {
        captured = origin
        return { outcome: 'fallback', pageId: 'p1' }
      }
    })
    expect(captured).toEqual(customOrigin)
  })
})

describe('planDroppedStatusAction — one-shot suppression', () => {
  it('returns ignore when a fallback is already pending', () => {
    const leaseState = new TunnelLeaseState()
    seed(leaseState, 'p1', 'L-sel')
    leaseState.beginFallback('p1', Promise.resolve())
    const action = planDroppedStatusAction({
      leaseState,
      leaseId: 'L-sel',
      reason: 'closed again',
      runFallback: async () => ({ outcome: 'fallback', pageId: 'p1' })
    })
    expect(action.kind).toBe('ignore')
  })
  it('returns ignore when a fallback is already done (never auto-promote)', () => {
    const leaseState = new TunnelLeaseState()
    seed(leaseState, 'p1', 'L-sel')
    leaseState.beginFallback('p1', Promise.resolve())
    leaseState.completeFallback('p1')
    const action = planDroppedStatusAction({
      leaseState,
      leaseId: 'L-sel',
      reason: 'closed again',
      runFallback: async () => ({ outcome: 'fallback', pageId: 'p1' })
    })
    expect(action.kind).toBe('ignore')
  })
  it('returns ignore for an unknown lease id', () => {
    const leaseState = new TunnelLeaseState()
    const action = planDroppedStatusAction({
      leaseState,
      leaseId: 'unknown',
      reason: 'closed',
      runFallback: async () => ({ outcome: 'fallback', pageId: 'p1' })
    })
    expect(action.kind).toBe('ignore')
  })
  it('complete callback settles pending state and marks done', () => {
    const leaseState = new TunnelLeaseState()
    seed(leaseState, 'p1', 'L-sel')
    const action = planDroppedStatusAction({
      leaseState,
      leaseId: 'L-sel',
      reason: 'closed',
      runFallback: async () => ({ outcome: 'fallback', pageId: 'p1' })
    })
    expect(action.kind).toBe('selected-fallback')
    if (action.kind === 'selected-fallback') {
      action.complete()
      expect(leaseState.fallbackState('p1').state).toBe('done')
    }
  })
})
