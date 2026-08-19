import { describe, it, expect } from 'vitest'
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

const customLocalOrigin: NormalizedOrigin = {
  protocol: 'https:',
  hostname: 'local.getmontecarlo.com',
  port: '5173',
  origin: 'https://local.getmontecarlo.com:5173'
}

function selectedLease(leaseId: string, origin: NormalizedOrigin = localOrigin) {
  return { leaseId, localOrigin: origin, kind: 'selected' as const }
}
function companionLease(leaseId: string, origin: NormalizedOrigin = localOrigin) {
  return { leaseId, localOrigin: origin, kind: 'companion' as const }
}

describe('TunnelLeaseState — generation/stale', () => {
  it('nextGeneration starts at 1 and bumps monotonically', () => {
    const s = new TunnelLeaseState()
    expect(s.nextGeneration('p1')).toBe(1)
    expect(s.nextGeneration('p1')).toBe(2)
    expect(s.generationOf('p1')).toBe(2)
  })
  it('isStale is true when generation does not match', () => {
    const s = new TunnelLeaseState()
    const g = s.nextGeneration('p1')
    s.nextGeneration('p1')
    expect(s.isStale('p1', g)).toBe(true)
  })
  it('isStale is true for unknown page', () => {
    expect(new TunnelLeaseState().isStale('unknown', 1)).toBe(true)
  })
})

describe('TunnelLeaseState — in-flight promise dedup', () => {
  it('inFlightOf is null when no operation is in flight', () => {
    expect(new TunnelLeaseState().inFlightOf('p1')).toBeNull()
  })
  it('setInFlight/clearInFlight round-trips the shared promise', () => {
    const s = new TunnelLeaseState()
    const promise = Promise.resolve(1)
    s.setInFlight('p1', { promise, fingerprint: 'fp1' })
    expect(s.inFlightOf('p1')).not.toBeNull()
    s.clearInFlight('p1')
    expect(s.inFlightOf('p1')).toBeNull()
  })
})

describe('TunnelLeaseState — complete lease set tracking', () => {
  it('recordLeases stores selected + companions', () => {
    const s = new TunnelLeaseState()
    s.recordLeases('p1', descriptor, [
      selectedLease('L-sel', customLocalOrigin),
      companionLease('L-c1'),
      companionLease('L-c2')
    ])
    expect(s.leasesFor('p1')).toHaveLength(3)
    expect(s.selectedLeaseFor('p1')?.leaseId).toBe('L-sel')
    expect(s.selectedLeaseFor('p1')?.localOrigin).toEqual(customLocalOrigin)
    expect(s.companionLeasesFor('p1').map((l) => l.leaseId)).toEqual(['L-c1', 'L-c2'])
  })
  it('pageIdForLease maps selected and companion leases back to the page', () => {
    const s = new TunnelLeaseState()
    s.recordLeases('p1', descriptor, [selectedLease('L-sel'), companionLease('L-c1')])
    expect(s.pageIdForLease('L-sel')).toBe('p1')
    expect(s.pageIdForLease('L-c1')).toBe('p1')
    expect(s.pageIdForLease('unknown')).toBeNull()
  })
  it('leaseKindFor distinguishes selected vs companion', () => {
    const s = new TunnelLeaseState()
    s.recordLeases('p1', descriptor, [selectedLease('L-sel'), companionLease('L-c1')])
    expect(s.leaseKindFor('L-sel')).toBe('selected')
    expect(s.leaseKindFor('L-c1')).toBe('companion')
    expect(s.leaseKindFor('unknown')).toBeNull()
  })
  it('descriptorFor returns the stored descriptor', () => {
    const s = new TunnelLeaseState()
    s.recordLeases('p1', descriptor, [selectedLease('L-sel')])
    expect(s.descriptorFor('p1')).toEqual(descriptor)
  })
})

describe('TunnelLeaseState — release paths', () => {
  it('dropPage bumps generation and returns the full lease set', () => {
    const s = new TunnelLeaseState()
    const g = s.nextGeneration('p1')
    s.recordLeases('p1', descriptor, [selectedLease('L-sel'), companionLease('L-c1')])
    const leases = s.dropPage('p1')
    expect(leases.map((l) => l.leaseId)).toEqual(['L-sel', 'L-c1'])
    expect(s.has('p1')).toBe(false)
    expect(s.isStale('p1', g)).toBe(true)
  })
  it('dropPage returns [] for an unknown page', () => {
    expect(new TunnelLeaseState().dropPage('unknown')).toEqual([])
  })
  it('clearLeases returns the lease set without dropping the page or bumping generation', () => {
    const s = new TunnelLeaseState()
    s.nextGeneration('p1')
    s.recordLeases('p1', descriptor, [selectedLease('L-sel')])
    const gen = s.generationOf('p1')
    const leases = s.clearLeases('p1')
    expect(leases.map((l) => l.leaseId)).toEqual(['L-sel'])
    expect(s.has('p1')).toBe(true)
    expect(s.generationOf('p1')).toBe(gen)
    expect(s.leasesFor('p1')).toEqual([])
  })
  it('removeCompanionLease removes one companion for partial degradation', () => {
    const s = new TunnelLeaseState()
    s.recordLeases('p1', descriptor, [
      selectedLease('L-sel'),
      companionLease('L-c1'),
      companionLease('L-c2')
    ])
    const removed = s.removeCompanionLease('L-c1')
    expect(removed?.leaseId).toBe('L-c1')
    expect(s.companionLeasesFor('p1').map((l) => l.leaseId)).toEqual(['L-c2'])
    expect(s.selectedLeaseFor('p1')?.leaseId).toBe('L-sel')
  })
  it('removeCompanionLease returns null for a selected lease or unknown lease', () => {
    const s = new TunnelLeaseState()
    s.recordLeases('p1', descriptor, [selectedLease('L-sel'), companionLease('L-c1')])
    expect(s.removeCompanionLease('L-sel')).toBeNull()
    expect(s.removeCompanionLease('unknown')).toBeNull()
  })
  it('activeLeases snapshots all pages with leases for dispose', () => {
    const s = new TunnelLeaseState()
    s.recordLeases('p1', descriptor, [selectedLease('L-sel')])
    s.recordLeases('p2', descriptor, [selectedLease('L-sel2')])
    const entries = s.activeLeases()
    expect(entries.map((e) => e.pageId).sort()).toEqual(['p1', 'p2'])
  })
  it('clear empties all state', () => {
    const s = new TunnelLeaseState()
    s.recordLeases('p1', descriptor, [selectedLease('L-sel')])
    s.clear()
    expect(s.activeLeases()).toEqual([])
  })
})

describe('TunnelLeaseState — one-shot fallback state', () => {
  it('beginFallback returns true on idle and records the pending promise', () => {
    const s = new TunnelLeaseState()
    const p = Promise.resolve()
    expect(s.beginFallback('p1', p)).toBe(true)
    expect(s.fallbackState('p1').state).toBe('pending')
  })
  it('beginFallback returns false when already pending (one-shot suppression)', () => {
    const s = new TunnelLeaseState()
    s.beginFallback('p1', Promise.resolve())
    expect(s.beginFallback('p1', Promise.resolve())).toBe(false)
  })
  it('beginFallback returns false when already done (never auto-promote)', () => {
    const s = new TunnelLeaseState()
    s.beginFallback('p1', Promise.resolve())
    s.completeFallback('p1')
    expect(s.beginFallback('p1', Promise.resolve())).toBe(false)
    expect(s.fallbackState('p1').state).toBe('done')
  })
  it('dropPage resets fallback state to idle', () => {
    const s = new TunnelLeaseState()
    s.beginFallback('p1', Promise.resolve())
    s.dropPage('p1')
    s.nextGeneration('p1')
    expect(s.fallbackState('p1').state).toBe('idle')
  })
})
