import { describe, it, expect } from 'vitest'
import { withDedup } from './tunnel-dedup'
import { TunnelLeaseState } from './tunnel-lease-state'

describe('withDedup — concurrent callers share one promise and outcome', () => {
  it('deduplicates concurrent operations on the same dedup key + fingerprint', async () => {
    const leaseState = new TunnelLeaseState()
    let acquireCalls = 0
    let resolveAcquire!: () => void
    const acquirePromise = new Promise<void>((r) => (resolveAcquire = r))
    const run = async () => {
      acquireCalls++
      await acquirePromise
      return 'done'
    }
    const first = withDedup(leaseState, 'k1', 'fp1', run)
    const second = withDedup(leaseState, 'k1', 'fp1', run)
    expect(acquireCalls).toBe(1)
    resolveAcquire()
    expect(await first).toBe('done')
    expect(await second).toBe('done')
  })
  it('propagates failure to all awaiters of the shared promise', async () => {
    const leaseState = new TunnelLeaseState()
    let resolveRun!: () => void
    const runPromise = new Promise<void>((r) => (resolveRun = r))
    const run = async () => {
      await runPromise
      throw new Error('acquire failed')
    }
    const first = withDedup(leaseState, 'k1', 'fp1', run)
    const second = withDedup(leaseState, 'k1', 'fp1', run)
    resolveRun()
    await expect(first).rejects.toThrow('acquire failed')
    await expect(second).rejects.toThrow('acquire failed')
  })
  it('runs separate operations for different dedup keys', async () => {
    const leaseState = new TunnelLeaseState()
    let calls = 0
    const run = async () => {
      calls++
      return calls
    }
    const a = withDedup(leaseState, 'k1', 'fp1', run)
    const b = withDedup(leaseState, 'k2', 'fp1', run)
    expect(await a).toBe(1)
    expect(await b).toBe(2)
  })
  it('rejects boundedly when the same dedup key has a different fingerprint', async () => {
    const leaseState = new TunnelLeaseState()
    let resolveFirst!: () => void
    const firstPromise = new Promise<void>((r) => (resolveFirst = r))
    const run1 = async () => {
      await firstPromise
      return 'first'
    }
    const run2 = async () => 'second'
    const first = withDedup(leaseState, 'k1', 'fp-ws1', run1)
    const second = withDedup(leaseState, 'k1', 'fp-ws2', run2)
    await expect(second).rejects.toThrow('dedup key collision')
    resolveFirst()
    expect(await first).toBe('first')
  })
})
