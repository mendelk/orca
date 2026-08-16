import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkspacePortTunnelGrantStore } from './workspace-port-tunnel-grant-store'
import type { WorkspacePortTunnelEndpointTarget } from '../../shared/workspace-port-tunnel'

const DEVICE_TOKEN_A = 'device-token-a-very-long-secret'
const DEVICE_TOKEN_B = 'device-token-b-very-long-secret'
const RUNTIME_A = 'runtime-instance-a'
const RUNTIME_B = 'runtime-instance-b'
const WORKTREE_A = 'worktree-a'
const WORKTREE_B = 'worktree-b'

function endpoint(
  port: number,
  protocol: 'http' | 'https' | 'unknown' = 'http'
): WorkspacePortTunnelEndpointTarget {
  return {
    port,
    connectHost: '127.0.0.1',
    protocol
  }
}

function endpoints(count: number): WorkspacePortTunnelEndpointTarget[] {
  return Array.from({ length: count }, (_, i) => endpoint(3000 + i))
}

describe('WorkspacePortTunnelGrantStore', () => {
  let now = 1_000_000
  let store: WorkspacePortTunnelGrantStore

  beforeEach(() => {
    now = 1_000_000
    store = new WorkspacePortTunnelGrantStore({ now: () => now })
  })

  afterEach(() => {
    store.shutdown()
  })

  function issue(args?: Partial<Parameters<WorkspacePortTunnelGrantStore['issue']>[0]>) {
    return store.issue({
      deviceToken: DEVICE_TOKEN_A,
      deviceScope: 'runtime',
      runtimeInstanceId: RUNTIME_A,
      resolvedWorkspace: { worktreeId: WORKTREE_A, runtimeInstanceId: RUNTIME_A },
      endpoints: [endpoint(3000)],
      ...args
    })
  }

  describe('issue', () => {
    it('issues a grant with a fresh id, ttl, and stable endpoint ids', () => {
      const result = issue()
      expect(result.ok).toBe(true)
      if (!result.ok) {
        return
      }
      const { grant } = result
      expect(grant.grantId).toMatch(/.{20,}/)
      expect(grant.expiresAt).toBe(now + 30_000)
      expect(grant.endpoints).toHaveLength(1)
      expect(grant.endpoints[0]!.endpointId).toBeGreaterThan(0)
      expect(grant.endpoints[0]!.port).toBe(3000)
    })

    it('denies mobile-scoped device tokens', () => {
      const result = issue({ deviceScope: 'mobile' })
      expect(result.ok).toBe(false)
      if (result.ok) {
        return
      }
      expect(result.error).toBe('mobile_scope_denied')
    })

    it('rejects more than 16 endpoints', () => {
      const result = issue({ endpoints: endpoints(17) })
      expect(result.ok).toBe(false)
      if (result.ok) {
        return
      }
      expect(result.error).toBe('too_many_endpoints')
    })

    it('rejects an empty endpoint set', () => {
      const result = issue({ endpoints: [] })
      expect(result.ok).toBe(false)
      if (result.ok) {
        return
      }
      expect(result.error).toBe('no_eligible_endpoints')
    })

    it('rejects a resolved workspace from a different runtime instance', () => {
      const result = issue({
        resolvedWorkspace: { worktreeId: WORKTREE_A, runtimeInstanceId: RUNTIME_B }
      })
      expect(result.ok).toBe(false)
      if (result.ok) {
        return
      }
      expect(result.error).toBe('workspace_not_found')
    })

    it('produces unique grant ids across calls', () => {
      const a = issue()
      const b = issue()
      expect(a.ok && b.ok && a.grant.grantId !== b.grant.grantId).toBe(true)
    })

    it('assigns dense, non-reused endpoint ids when endpoints are pre-numbered', () => {
      const result = issue({ endpoints: endpoints(3) })
      expect(result.ok).toBe(true)
      if (!result.ok) {
        return
      }
      const ids = result.grant.endpoints.map((e) => e.endpointId)
      expect(new Set(ids).size).toBe(3)
      expect(ids.every((id) => id > 0)).toBe(true)
    })

    it('assigns endpoint ids that remain unique across grants on one channel', () => {
      const first = issue({ endpoints: endpoints(2) })
      const second = issue({
        endpoints: endpoints(2).map((entry) => ({ ...entry, port: entry.port + 100 }))
      })
      if (!first.ok || !second.ok) {
        throw new Error('issue failed')
      }
      const ids = [...first.grant.endpoints, ...second.grant.endpoints].map(
        (entry) => entry.endpointId
      )
      expect(new Set(ids).size).toBe(ids.length)
    })

    it('rejects duplicate endpoint targets', () => {
      const duplicate = endpoint(3000)
      const result = issue({ endpoints: [duplicate, { ...duplicate }] })
      expect(result.ok).toBe(false)
      if (result.ok) {
        return
      }
      expect(result.error).toBe('duplicate_endpoint')
    })
  })

  describe('consume', () => {
    it('consumes a valid unattached grant once', () => {
      const issued = issue()
      if (!issued.ok) {
        throw new Error('issue failed')
      }
      const result = store.consume({
        grantId: issued.grant.grantId,
        deviceToken: DEVICE_TOKEN_A,
        runtimeInstanceId: RUNTIME_A
      })
      expect(result.ok).toBe(true)
      expect(store.isConsumed(issued.grant.grantId)).toBe(true)
    })

    it('rejects a second consume (one-use)', () => {
      const issued = issue()
      if (!issued.ok) {
        throw new Error('issue failed')
      }
      store.consume({
        grantId: issued.grant.grantId,
        deviceToken: DEVICE_TOKEN_A,
        runtimeInstanceId: RUNTIME_A
      })
      const replay = store.consume({
        grantId: issued.grant.grantId,
        deviceToken: DEVICE_TOKEN_A,
        runtimeInstanceId: RUNTIME_A
      })
      expect(replay.ok).toBe(false)
      if (replay.ok) {
        return
      }
      expect(replay.error).toBe('grant_already_consumed')
    })

    it('rejects consume with the wrong device token', () => {
      const issued = issue()
      if (!issued.ok) {
        throw new Error('issue failed')
      }
      const result = store.consume({
        grantId: issued.grant.grantId,
        deviceToken: DEVICE_TOKEN_B,
        runtimeInstanceId: RUNTIME_A
      })
      expect(result.ok).toBe(false)
      if (result.ok) {
        return
      }
      expect(result.error).toBe('device_mismatch')
    })

    it('rejects consume with the wrong runtime instance', () => {
      const issued = issue()
      if (!issued.ok) {
        throw new Error('issue failed')
      }
      const result = store.consume({
        grantId: issued.grant.grantId,
        deviceToken: DEVICE_TOKEN_A,
        runtimeInstanceId: RUNTIME_B
      })
      expect(result.ok).toBe(false)
      if (result.ok) {
        return
      }
      expect(result.error).toBe('runtime_mismatch')
    })

    it('rejects consume of an expired unattached grant', () => {
      const issued = issue()
      if (!issued.ok) {
        throw new Error('issue failed')
      }
      now += 31_000
      const result = store.consume({
        grantId: issued.grant.grantId,
        deviceToken: DEVICE_TOKEN_A,
        runtimeInstanceId: RUNTIME_A
      })
      expect(result.ok).toBe(false)
      if (result.ok) {
        return
      }
      expect(result.error).toBe('grant_expired')
      expect(store.size()).toBe(0)
    })

    it('rejects consume of an unknown grant id', () => {
      const result = store.consume({
        grantId: 'unknown-grant-id',
        deviceToken: DEVICE_TOKEN_A,
        runtimeInstanceId: RUNTIME_A
      })
      expect(result.ok).toBe(false)
      if (result.ok) {
        return
      }
      expect(result.error).toBe('grant_not_found')
    })
  })

  describe('authorizeEndpoint', () => {
    it('returns the exact endpoint for a consumed grant', () => {
      const issued = issue({ endpoints: endpoints(2) })
      if (!issued.ok) {
        throw new Error('issue failed')
      }
      store.consume({
        grantId: issued.grant.grantId,
        deviceToken: DEVICE_TOKEN_A,
        runtimeInstanceId: RUNTIME_A
      })
      const result = store.authorizeEndpoint({
        grantId: issued.grant.grantId,
        endpointId: issued.grant.endpoints[1]!.endpointId,
        deviceToken: DEVICE_TOKEN_A,
        runtimeInstanceId: RUNTIME_A
      })
      expect(result.ok).toBe(true)
      if (!result.ok) {
        return
      }
      expect(result.endpoint.port).toBe(3001)
    })

    it('rejects an endpoint id not in the grant', () => {
      const issued = issue({ endpoints: endpoints(1) })
      if (!issued.ok) {
        throw new Error('issue failed')
      }
      store.consume({
        grantId: issued.grant.grantId,
        deviceToken: DEVICE_TOKEN_A,
        runtimeInstanceId: RUNTIME_A
      })
      const result = store.authorizeEndpoint({
        grantId: issued.grant.grantId,
        endpointId: 99,
        deviceToken: DEVICE_TOKEN_A,
        runtimeInstanceId: RUNTIME_A
      })
      expect(result.ok).toBe(false)
      if (result.ok) {
        return
      }
      expect(result.error).toBe('endpoint_not_authorized')
    })

    it('rejects endpoint access before consume', () => {
      const issued = issue()
      if (!issued.ok) {
        throw new Error('issue failed')
      }
      const result = store.authorizeEndpoint({
        grantId: issued.grant.grantId,
        endpointId: issued.grant.endpoints[0]!.endpointId,
        deviceToken: DEVICE_TOKEN_A,
        runtimeInstanceId: RUNTIME_A
      })
      expect(result.ok).toBe(false)
      if (result.ok) {
        return
      }
      expect(result.error).toBe('grant_not_found')
    })

    it('rejects endpoint access with the wrong device token', () => {
      const issued = issue()
      if (!issued.ok) {
        throw new Error('issue failed')
      }
      store.consume({
        grantId: issued.grant.grantId,
        deviceToken: DEVICE_TOKEN_A,
        runtimeInstanceId: RUNTIME_A
      })
      const result = store.authorizeEndpoint({
        grantId: issued.grant.grantId,
        endpointId: issued.grant.endpoints[0]!.endpointId,
        deviceToken: DEVICE_TOKEN_B,
        runtimeInstanceId: RUNTIME_A
      })
      expect(result.ok).toBe(false)
      if (result.ok) {
        return
      }
      expect(result.error).toBe('device_mismatch')
    })

    it('allows endpoint access past expiresAt once consumed', () => {
      const issued = issue()
      if (!issued.ok) {
        throw new Error('issue failed')
      }
      store.consume({
        grantId: issued.grant.grantId,
        deviceToken: DEVICE_TOKEN_A,
        runtimeInstanceId: RUNTIME_A
      })
      now += 60_000
      const result = store.authorizeEndpoint({
        grantId: issued.grant.grantId,
        endpointId: issued.grant.endpoints[0]!.endpointId,
        deviceToken: DEVICE_TOKEN_A,
        runtimeInstanceId: RUNTIME_A
      })
      expect(result.ok).toBe(true)
    })
  })

  describe('revocation', () => {
    it('revokes a single grant by id', () => {
      const issued = issue()
      if (!issued.ok) {
        throw new Error('issue failed')
      }
      expect(store.revokeGrant(issued.grant.grantId)).toBe(true)
      const result = store.consume({
        grantId: issued.grant.grantId,
        deviceToken: DEVICE_TOKEN_A,
        runtimeInstanceId: RUNTIME_A
      })
      expect(result.ok).toBe(false)
      if (result.ok) {
        return
      }
      expect(result.error).toBe('grant_not_found')
    })

    it('revokes all grants for a device token on unpair', () => {
      const a = issue()
      const b = issue()
      if (!a.ok || !b.ok) {
        throw new Error('issue failed')
      }
      const removed = store.revokeForDevice(DEVICE_TOKEN_A)
      expect(removed).toBe(2)
      expect(store.size()).toBe(0)
    })

    it('revokes all grants for a runtime instance on stop', () => {
      issue()
      issue()
      const removed = store.revokeForRuntime(RUNTIME_A)
      expect(removed).toBe(2)
      expect(store.size()).toBe(0)
    })

    it('revokes only grants matching both runtime and workspace', () => {
      issue()
      issue({ resolvedWorkspace: { worktreeId: WORKTREE_B, runtimeInstanceId: RUNTIME_A } })
      const removed = store.revokeForWorkspace(RUNTIME_A, WORKTREE_A)
      expect(removed).toBe(1)
      expect(store.size()).toBe(1)
    })

    it('does not affect other devices when revoking one', () => {
      issue()
      issue({ deviceToken: DEVICE_TOKEN_B })
      expect(store.revokeForDevice(DEVICE_TOKEN_A)).toBe(1)
      expect(store.size()).toBe(1)
    })

    it('shutdown clears everything', () => {
      issue()
      issue()
      store.shutdown()
      expect(store.size()).toBe(0)
      expect(store.activeGrantCount()).toBe(0)
    })
  })

  describe('memory bounds and cleanup', () => {
    it('evicts expired unattached grants on the next issue', () => {
      issue()
      issue()
      expect(store.size()).toBe(2)
      now += 31_000
      issue()
      expect(store.size()).toBe(1)
    })

    it('keeps consumed grants past their expiry until revoked', () => {
      const issued = issue()
      if (!issued.ok) {
        throw new Error('issue failed')
      }
      store.consume({
        grantId: issued.grant.grantId,
        deviceToken: DEVICE_TOKEN_A,
        runtimeInstanceId: RUNTIME_A
      })
      now += 31_000
      store.issue({
        deviceToken: DEVICE_TOKEN_A,
        deviceScope: 'runtime',
        runtimeInstanceId: RUNTIME_A,
        resolvedWorkspace: { worktreeId: WORKTREE_A, runtimeInstanceId: RUNTIME_A },
        endpoints: [endpoint(3100)]
      })
      expect(store.activeGrantCount()).toBe(1)
      expect(store.size()).toBe(2)
    })

    it('bounds the stored grant map by evicting oldest unattached first', () => {
      const many = 80
      for (let i = 0; i < many; i++) {
        const result = issue({ endpoints: [endpoint(4000 + i)] })
        if (!result.ok) {
          throw new Error('issue failed')
        }
      }
      expect(store.size()).toBeLessThanOrEqual(32)
    })

    it('refuses to evict consumed grants when the active capacity is full', () => {
      for (let i = 0; i < 32; i += 1) {
        const issued = issue({ endpoints: [endpoint(4000 + i)] })
        if (!issued.ok) {
          throw new Error('issue failed')
        }
        const consumed = store.consume({
          grantId: issued.grant.grantId,
          deviceToken: DEVICE_TOKEN_A,
          runtimeInstanceId: RUNTIME_A
        })
        if (!consumed.ok) {
          throw new Error('consume failed')
        }
      }
      const overflow = issue({ endpoints: [endpoint(5000)] })
      expect(overflow.ok).toBe(false)
      if (overflow.ok) {
        return
      }
      expect(overflow.error).toBe('grant_capacity_reached')
      expect(store.activeGrantCount()).toBe(32)
    })

    it('counts only consumed grants as active', () => {
      const a = issue()
      if (!a.ok) {
        throw new Error('issue failed')
      }
      issue()
      store.consume({
        grantId: a.grant.grantId,
        deviceToken: DEVICE_TOKEN_A,
        runtimeInstanceId: RUNTIME_A
      })
      expect(store.activeGrantCount()).toBe(1)
    })
  })

  describe('replay protection across restarts', () => {
    it('a new store instance does not honor grants from an old instance', () => {
      const issued = issue()
      if (!issued.ok) {
        throw new Error('issue failed')
      }
      const fresh = new WorkspacePortTunnelGrantStore({ now: () => now })
      const result = fresh.consume({
        grantId: issued.grant.grantId,
        deviceToken: DEVICE_TOKEN_A,
        runtimeInstanceId: RUNTIME_A
      })
      expect(result.ok).toBe(false)
      if (result.ok) {
        return
      }
      expect(result.error).toBe('grant_not_found')
    })
  })
})
