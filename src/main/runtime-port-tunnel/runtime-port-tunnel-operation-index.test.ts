import { describe, expect, it } from 'vitest'
import {
  RuntimePortTunnelOperationIndex,
  makeOperationKey,
  type RuntimePortTunnelOperationEntry
} from './runtime-port-tunnel-operation-index'

function entry(
  operationId: string,
  environmentId: string,
  remotePort: number,
  endpointId: number,
  role: 'selected' | 'companion' = 'selected'
): RuntimePortTunnelOperationEntry {
  return { rendererOwnerId: 'r1', operationId, environmentId, remotePort, endpointId, role }
}

describe('RuntimePortTunnelOperationIndex', () => {
  it('makeOperationKey includes the target so two operations sharing an id but targeting different endpoints cannot collide', () => {
    // Why: collision-safe operation keying. A stale operation id for one
    // endpoint cannot silently reuse a lease for a different endpoint.
    const a = entry('op-1', 'env-1', 5173, 1)
    const b = entry('op-1', 'env-1', 5173, 2)
    expect(makeOperationKey(a)).not.toBe(makeOperationKey(b))
  })

  it('lookup returns not-found when no record exists', () => {
    const index = new RuntimePortTunnelOperationIndex()
    const result = index.lookup(entry('op-1', 'env-1', 5173, 1))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('not-found')
    }
  })

  it('registerInflight + lookup returns inflight with the same promise', () => {
    const index = new RuntimePortTunnelOperationIndex()
    const e = entry('op-1', 'env-1', 5173, 1)
    const promise = Promise.resolve()
    expect(index.registerInflight(e, promise)).toBe(true)
    const result = index.lookup(e)
    expect(result.ok).toBe(true)
    if (result.ok && result.kind === 'inflight') {
      expect(result.inflight).toBe(promise)
    } else {
      throw new Error('expected inflight')
    }
  })

  it('registerInflight refuses a duplicate inflight for the same key', () => {
    const index = new RuntimePortTunnelOperationIndex()
    const e = entry('op-1', 'env-1', 5173, 1)
    index.registerInflight(e, Promise.resolve())
    expect(index.registerInflight(e, Promise.resolve())).toBe(false)
  })

  it('completeInflight atomically moves inflight to completed with the lease id', () => {
    const index = new RuntimePortTunnelOperationIndex()
    const e = entry('op-1', 'env-1', 5173, 1)
    index.registerInflight(e, Promise.resolve())
    index.completeInflight(e, 'lease-1')
    expect(index.inflightCount()).toBe(0)
    expect(index.completedCount()).toBe(1)
    const result = index.lookup(e)
    expect(result.ok).toBe(true)
    if (result.ok && result.kind === 'completed') {
      expect(result.leaseId).toBe('lease-1')
    } else {
      throw new Error('expected completed')
    }
  })

  it('a concurrent second caller for the same operation joins the inflight promise', () => {
    // Why: the previous code started a second bind for a concurrent same
    // operation because it only tracked completed leases, not inflight
    // acquires. The index must surface the inflight promise so the caller
    // joins instead of double-binding.
    const index = new RuntimePortTunnelOperationIndex()
    const e = entry('op-1', 'env-1', 5173, 1)
    const promise = new Promise(() => {})
    index.registerInflight(e, promise)
    const result = index.lookup(e)
    expect(result.ok).toBe(true)
    if (result.ok && result.kind === 'inflight') {
      expect(result.inflight).toBe(promise)
    }
  })

  it('release removes the mapping so a repeated same operation replays a fresh acquire', () => {
    // Why: the previous code retained the released operation id and
    // recordOperationId refused to replace it, so a repeated same
    // operation created an untracked duplicate lease. release() must
    // atomically remove the mapping.
    const index = new RuntimePortTunnelOperationIndex()
    const e = entry('op-1', 'env-1', 5173, 1)
    index.registerInflight(e, Promise.resolve())
    index.completeInflight(e, 'lease-1')
    index.release(e)
    const result = index.lookup(e)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('not-found')
    }
  })

  it('lookup returns collision when the same operationId targets a different endpoint', () => {
    // Why: validate selected and all args for concurrent inflight
    // collisions, not only completed leases.
    const index = new RuntimePortTunnelOperationIndex()
    const a = entry('op-1', 'env-1', 5173, 1)
    const b = entry('op-1', 'env-1', 5173, 2)
    index.registerInflight(a, Promise.resolve())
    index.completeInflight(a, 'lease-1')
    const result = index.lookup(b)
    expect(result.ok).toBe(false)
    if (!result.ok && result.reason === 'collision') {
      expect(result.existing.endpointId).toBe(1)
      expect(result.attempted.endpointId).toBe(2)
    } else {
      throw new Error('expected collision')
    }
  })

  it('releaseEnvironment drops all completed and inflight entries for one environment', () => {
    const index = new RuntimePortTunnelOperationIndex()
    const a = entry('op-1', 'env-1', 5173, 1)
    const b = entry('op-2', 'env-1', 5174, 2)
    const c = entry('op-3', 'env-2', 5173, 3)
    index.registerInflight(a, Promise.resolve())
    index.completeInflight(a, 'lease-1')
    index.registerInflight(b, Promise.resolve())
    index.completeInflight(b, 'lease-2')
    index.registerInflight(c, Promise.resolve())
    index.completeInflight(c, 'lease-3')
    const dropped = index.releaseEnvironment('env-1')
    expect(dropped).toHaveLength(2)
    expect(index.completedCount()).toBe(1)
    expect(index.inflightCount()).toBe(0)
    // Why: env-2's entry must remain.
    const cResult = index.lookup(c)
    expect(cResult.ok).toBe(true)
  })

  it('releaseEnvironment also drops inflight entries for the environment', () => {
    const index = new RuntimePortTunnelOperationIndex()
    const a = entry('op-1', 'env-1', 5173, 1)
    index.registerInflight(a, new Promise(() => {}))
    const dropped = index.releaseEnvironment('env-1')
    expect(dropped).toHaveLength(1)
    expect(index.inflightCount()).toBe(0)
  })

  it('clear removes all state on full shutdown', () => {
    const index = new RuntimePortTunnelOperationIndex()
    const a = entry('op-1', 'env-1', 5173, 1)
    index.registerInflight(a, Promise.resolve())
    index.completeInflight(a, 'lease-1')
    index.clear()
    expect(index.inflightCount()).toBe(0)
    expect(index.completedCount()).toBe(0)
  })
})
