import { describe, it, expect } from 'vitest'
import { buildLeaseSet, releaseLeaseSet, releaseAcquired } from './tunnel-lease-helpers'
import type { TunnelAcquireOutcome } from './runtime-port-tunnel-client-port'
import type { NormalizedOrigin } from '../../../shared/browser-port-tunnel-url'

const localOrigin: NormalizedOrigin = {
  protocol: 'http:',
  hostname: '127.0.0.1',
  port: '5173',
  origin: 'http://127.0.0.1:5173'
}

describe('buildLeaseSet', () => {
  it('builds a selected + companion lease set from a successful acquire', () => {
    const outcome: TunnelAcquireOutcome = {
      selected: { ok: true, leaseId: 'L-sel', localOrigin: 'http://127.0.0.1:5173' },
      companions: [
        { ok: true, leaseId: 'L-c1', localOrigin: 'http://127.0.0.1:3001' },
        { ok: false, reason: 'companion port occupied' }
      ]
    }
    const leases = buildLeaseSet(outcome, localOrigin)
    expect(leases.map((l) => l.leaseId)).toEqual(['L-sel', 'L-c1'])
    expect(leases[0].kind).toBe('selected')
    expect(leases[1].kind).toBe('companion')
    expect(leases[0].localOrigin).toEqual(localOrigin)
  })
  it('omits the selected lease when selected acquire failed', () => {
    const outcome: TunnelAcquireOutcome = {
      selected: { ok: false, reason: 'selected port occupied' },
      companions: [{ ok: true, leaseId: 'L-c1', localOrigin: 'http://127.0.0.1:3001' }]
    }
    expect(buildLeaseSet(outcome, localOrigin).map((l) => l.leaseId)).toEqual(['L-c1'])
  })
})

describe('releaseLeaseSet', () => {
  it('releases every lease through the supplied safeRelease', async () => {
    const released: string[] = []
    await releaseLeaseSet(
      [
        { leaseId: 'L-sel', localOrigin, kind: 'selected' },
        { leaseId: 'L-c1', localOrigin, kind: 'companion' }
      ],
      async (id) => {
        released.push(id)
      }
    )
    expect(released).toEqual(['L-sel', 'L-c1'])
  })
})

describe('releaseAcquired', () => {
  it('releases the selected + successful companion leases', async () => {
    const released: string[] = []
    const outcome: TunnelAcquireOutcome = {
      selected: { ok: true, leaseId: 'L-sel', localOrigin: 'http://127.0.0.1:5173' },
      companions: [
        { ok: true, leaseId: 'L-c1', localOrigin: 'http://127.0.0.1:3001' },
        { ok: false, reason: 'occupied' }
      ]
    }
    await releaseAcquired(outcome, async (id) => {
      released.push(id)
    })
    expect(released).toEqual(['L-sel', 'L-c1'])
  })
})
