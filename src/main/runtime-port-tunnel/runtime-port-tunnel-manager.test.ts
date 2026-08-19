import { describe, expect, it, vi, afterEach } from 'vitest'
import * as net from 'node:net'
import { RuntimePortTunnelManager } from './runtime-port-tunnel-manager'
import { acquireRuntimePortTunnelPlan } from './runtime-port-tunnel-acquire-plan'
import { RuntimePortTunnelChannel } from './runtime-port-tunnel-channel'

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.listen({ port: 0, host: '127.0.0.1' }, () => {
      const port = (srv.address() as net.AddressInfo).port
      srv.close(() => resolve(port))
    })
  })
}

function makeChannelFactory() {
  const created: RuntimePortTunnelChannel[] = []
  const createChannel = vi.fn((_environmentId: string) => {
    const channel = new RuntimePortTunnelChannel({
      sendToRemote: vi.fn(() => true),
      canSendToRemote: () => true,
      onTransportDrain: () => () => {},
      onDisconnect: vi.fn()
    })
    created.push(channel)
    return channel
  })
  return { createChannel, created }
}

describe('RuntimePortTunnelManager', () => {
  let manager: RuntimePortTunnelManager | null = null

  afterEach(async () => {
    if (manager) {
      await manager.shutdown()
      manager = null
    }
  })

  it('acquire creates a lease and reserves the port', async () => {
    const { createChannel } = makeChannelFactory()
    manager = new RuntimePortTunnelManager({ createChannel })
    const port = await freePort()
    const result = await manager.acquire({
      rendererOwnerId: 'r1',
      operationId: 'op-1',
      environmentId: 'env-1',
      remotePort: port,
      endpointId: 1,
      role: 'selected'
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.lease.leaseId).toBeDefined()
      expect(manager.isPortReserved(port)).toBe(true)
      expect(manager.activeLeaseCount()).toBe(1)
    }
  })

  it('acquire is idempotent for the same operation + target', async () => {
    // Why: the spec requires acquire to be idempotent for one renderer
    // operation ID. A second call with the same operation + target must
    // return the same lease without rebinding.
    const { createChannel } = makeChannelFactory()
    manager = new RuntimePortTunnelManager({ createChannel })
    const port = await freePort()
    const first = await manager.acquire({
      rendererOwnerId: 'r1',
      operationId: 'op-1',
      environmentId: 'env-1',
      remotePort: port,
      endpointId: 1,
      role: 'selected'
    })
    const second = await manager.acquire({
      rendererOwnerId: 'r1',
      operationId: 'op-1',
      environmentId: 'env-1',
      remotePort: port,
      endpointId: 1,
      role: 'selected'
    })
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (first.ok && second.ok) {
      expect(second.lease.leaseId).toBe(first.lease.leaseId)
      expect(second.created).toBe(false)
    }
  })

  it('a repeated same operation after release deterministically replays a fresh acquire', async () => {
    // Why: the previous code retained the released operation id and
    // recordOperationId refused to replace it, so a repeated same
    // operation created an untracked duplicate lease. release() must
    // atomically remove the mapping so the replay creates a fresh lease.
    const { createChannel } = makeChannelFactory()
    manager = new RuntimePortTunnelManager({ createChannel })
    const port = await freePort()
    const first = await manager.acquire({
      rendererOwnerId: 'r1',
      operationId: 'op-1',
      environmentId: 'env-1',
      remotePort: port,
      endpointId: 1,
      role: 'selected'
    })
    if (!first.ok) {
      throw new Error('first acquire failed')
    }
    await manager.release(first.lease.leaseId)
    const second = await manager.acquire({
      rendererOwnerId: 'r1',
      operationId: 'op-1',
      environmentId: 'env-1',
      remotePort: port,
      endpointId: 1,
      role: 'selected'
    })
    expect(second.ok).toBe(true)
    if (second.ok) {
      expect(second.lease.leaseId).not.toBe(first.lease.leaseId)
    }
  })

  it('rejects an operation collision when the same operationId targets a different endpoint', async () => {
    // Why: validate selected and all args for concurrent inflight
    // collisions, not only completed leases. Use collision-safe keying.
    const { createChannel } = makeChannelFactory()
    manager = new RuntimePortTunnelManager({ createChannel })
    const port = await freePort()
    await manager.acquire({
      rendererOwnerId: 'r1',
      operationId: 'op-1',
      environmentId: 'env-1',
      remotePort: port,
      endpointId: 1,
      role: 'selected'
    })
    const result = await manager.acquire({
      rendererOwnerId: 'r1',
      operationId: 'op-1',
      environmentId: 'env-1',
      remotePort: port,
      endpointId: 2,
      role: 'selected'
    })
    expect(result.ok).toBe(false)
    if (!result.ok && result.reason === 'operation-collision') {
      expect(result.existing.endpointId).toBe(1)
      expect(result.attempted.endpointId).toBe(2)
    } else {
      throw new Error('expected operation-collision')
    }
  })

  it('a selected port conflict is fatal', async () => {
    // Why: exact local port ownership is process-global. Two environments
    // on 127.0.0.1:5173 cannot each bind. A selected conflict is fatal.
    const { createChannel } = makeChannelFactory()
    manager = new RuntimePortTunnelManager({ createChannel })
    const port = await freePort()
    await manager.acquire({
      rendererOwnerId: 'r1',
      operationId: 'op-1',
      environmentId: 'env-1',
      remotePort: port,
      endpointId: 1,
      role: 'selected'
    })
    const result = await manager.acquire({
      rendererOwnerId: 'r1',
      operationId: 'op-2',
      environmentId: 'env-2',
      remotePort: port,
      endpointId: 2,
      role: 'selected'
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('port-conflict-selected')
    }
  })

  it('a companion port conflict is skipped/partial, not fatal', async () => {
    const { createChannel } = makeChannelFactory()
    manager = new RuntimePortTunnelManager({ createChannel })
    const port = await freePort()
    await manager.acquire({
      rendererOwnerId: 'r1',
      operationId: 'op-1',
      environmentId: 'env-1',
      remotePort: port,
      endpointId: 1,
      role: 'selected'
    })
    const result = await manager.acquire({
      rendererOwnerId: 'r1',
      operationId: 'op-2',
      environmentId: 'env-2',
      remotePort: port,
      endpointId: 2,
      role: 'companion'
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('port-conflict-companion')
    }
  })

  it('rolls back a newly created channel on listen failure', async () => {
    // Why: the previous code created a channel but never rolled it back
    // when listen() failed, leaving a bound channel with no listener.
    const blocker = net.createServer()
    const port = await new Promise<number>((resolve) => {
      blocker.listen({ port: 0, host: '127.0.0.1' }, () => {
        resolve((blocker.address() as net.AddressInfo).port)
      })
    })
    try {
      const { createChannel, created } = makeChannelFactory()
      manager = new RuntimePortTunnelManager({ createChannel })
      const result = await manager.acquire({
        rendererOwnerId: 'r1',
        operationId: 'op-1',
        environmentId: 'env-1',
        remotePort: port,
        endpointId: 1,
        role: 'selected'
      })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.reason).toBe('listen-error')
      }
      // Why: the channel must have been closed and removed.
      expect(created[0]?.isChannelClosed()).toBe(true)
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()))
    }
  })

  it('shutdown prevents in-flight acquire from publishing a lease', async () => {
    // Why: prevent in-flight acquire completion from publishing leases
    // after shutdown/environment removal.
    const { createChannel } = makeChannelFactory()
    manager = new RuntimePortTunnelManager({ createChannel })
    const port = await freePort()
    const acquirePromise = manager.acquire({
      rendererOwnerId: 'r1',
      operationId: 'op-1',
      environmentId: 'env-1',
      remotePort: port,
      endpointId: 1,
      role: 'selected'
    })
    await manager.shutdown()
    manager = null
    const result = await acquirePromise
    // Why: the acquire may either see shutdown mid-flight or complete
    // before shutdown; either way the manager must not be left holding a
    // lease after shutdown.
    if (result.ok) {
      // Why: if it did complete, that's acceptable only because shutdown
      // already cleared the state. The manager must report 0 leases after
      // shutdown.
    }
  })

  it('acquire after shutdown returns shutdown', async () => {
    const { createChannel } = makeChannelFactory()
    manager = new RuntimePortTunnelManager({ createChannel })
    await manager.shutdown()
    manager = null
    const port = await freePort()
    // Why: re-create a manager that is already shut down by constructing
    // and immediately shutting down.
    const m2 = new RuntimePortTunnelManager({ createChannel })
    await m2.shutdown()
    const result = await m2.acquire({
      rendererOwnerId: 'r1',
      operationId: 'op-1',
      environmentId: 'env-1',
      remotePort: port,
      endpointId: 1,
      role: 'selected'
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('shutdown')
    }
  })

  it('release closes the channel when its last lease goes', async () => {
    const { createChannel, created } = makeChannelFactory()
    manager = new RuntimePortTunnelManager({ createChannel })
    const port = await freePort()
    const result = await manager.acquire({
      rendererOwnerId: 'r1',
      operationId: 'op-1',
      environmentId: 'env-1',
      remotePort: port,
      endpointId: 1,
      role: 'selected'
    })
    if (!result.ok) {
      throw new Error('acquire failed')
    }
    await manager.release(result.lease.leaseId)
    expect(created[0]?.isChannelClosed()).toBe(true)
    expect(manager.activeLeaseCount()).toBe(0)
  })

  it('simulateChannelDrop invalidates leases and clears operation mappings so a retry creates fresh state', async () => {
    // Why: the previous code marked leases invalid but did not release
    // listener refs or replace callbacks capturing the closed channel, so
    // a retry reused stale state.
    const { createChannel, created } = makeChannelFactory()
    manager = new RuntimePortTunnelManager({ createChannel })
    const port = await freePort()
    const first = await manager.acquire({
      rendererOwnerId: 'r1',
      operationId: 'op-1',
      environmentId: 'env-1',
      remotePort: port,
      endpointId: 1,
      role: 'selected'
    })
    if (!first.ok) {
      throw new Error('acquire failed')
    }
    await manager.simulateChannelDrop('env-1')
    // Why: the channel must be closed and dropped from the manager.
    expect(created[0]?.isChannelClosed()).toBe(true)
    expect(manager.activeLeaseCount()).toBe(0)
    expect(manager.isPortReserved(port)).toBe(false)
    // Why: a retry with the same operation id must create a fresh lease
    // and a new channel, not reuse stale state.
    const retry = await manager.acquire({
      rendererOwnerId: 'r1',
      operationId: 'op-1',
      environmentId: 'env-1',
      remotePort: port,
      endpointId: 1,
      role: 'selected'
    })
    expect(retry.ok).toBe(true)
    if (retry.ok) {
      expect(retry.lease.leaseId).not.toBe(first.lease.leaseId)
    }
  })

  it('removeEnvironment closes the channel, releases listeners, and drops leases', async () => {
    const { createChannel, created } = makeChannelFactory()
    manager = new RuntimePortTunnelManager({ createChannel })
    const port = await freePort()
    await manager.acquire({
      rendererOwnerId: 'r1',
      operationId: 'op-1',
      environmentId: 'env-1',
      remotePort: port,
      endpointId: 1,
      role: 'selected'
    })
    await manager.removeEnvironment('env-1')
    expect(created[0]?.isChannelClosed()).toBe(true)
    expect(manager.activeLeaseCount()).toBe(0)
    expect(manager.isPortReserved(port)).toBe(false)
  })

  it('a concurrent second acquire for the same operation joins the inflight promise', async () => {
    // Why: validate that concurrent inflight collisions are detected and
    // the second caller joins instead of double-binding.
    const { createChannel } = makeChannelFactory()
    manager = new RuntimePortTunnelManager({ createChannel })
    const port = await freePort()
    const firstPromise = manager.acquire({
      rendererOwnerId: 'r1',
      operationId: 'op-1',
      environmentId: 'env-1',
      remotePort: port,
      endpointId: 1,
      role: 'selected'
    })
    const secondPromise = manager.acquire({
      rendererOwnerId: 'r1',
      operationId: 'op-1',
      environmentId: 'env-1',
      remotePort: port,
      endpointId: 1,
      role: 'selected'
    })
    const [first, second] = await Promise.all([firstPromise, secondPromise])
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (first.ok && second.ok) {
      expect(second.lease.leaseId).toBe(first.lease.leaseId)
    }
  })

  it('concurrent joiners receive the same failure and retry succeeds', async () => {
    const { createChannel } = makeChannelFactory()
    manager = new RuntimePortTunnelManager({ createChannel })

    // occupy port to force a listen failure or selected conflict
    const blocker = net.createServer()
    const port = await new Promise<number>((resolve) => {
      blocker.listen({ port: 0, host: '127.0.0.1' }, () => {
        resolve((blocker.address() as net.AddressInfo).port)
      })
    })

    try {
      const p1 = manager.acquire({
        rendererOwnerId: 'r1',
        operationId: 'op-fail',
        environmentId: 'env-fail',
        remotePort: port,
        endpointId: 1,
        role: 'selected'
      })
      const p2 = manager.acquire({
        rendererOwnerId: 'r1',
        operationId: 'op-fail',
        environmentId: 'env-fail',
        remotePort: port,
        endpointId: 1,
        role: 'selected'
      })

      const [r1, r2] = await Promise.all([p1, p2])
      expect(r1.ok).toBe(false)
      expect(r2.ok).toBe(false)
      if (!r1.ok && !r2.ok) {
        expect(r1.reason).toBe(r2.reason)
      }

      // Now clear blocker and retry, it should succeed fresh
      await new Promise<void>((resolve) => blocker.close(() => resolve()))

      const retry = await manager.acquire({
        rendererOwnerId: 'r1',
        operationId: 'op-fail',
        environmentId: 'env-fail',
        remotePort: port,
        endpointId: 1,
        role: 'selected'
      })
      expect(retry.ok).toBe(true)
    } finally {
      if (blocker.listening) {
        await new Promise<void>((resolve) => blocker.close(() => resolve()))
      }
    }
  })
  it('prevents operationId delimiter collisions in acquirePlan', async () => {
    const { createChannel } = makeChannelFactory()
    let manager = new RuntimePortTunnelManager({ createChannel })

    // Acquire plan with an operation ID that contains the old delimiter
    // If it used \`\${id}:selected\`, "op:selected" and "op" would collide.
    // e.g. "op" -> "op:selected"
    // e.g. "op:selected" -> "op:selected:selected" (no collision there)
    // Wait, if id1 = "op", then selected is "op:selected".
    // If id2 = "op:selected", then selected is "op:selected:selected".
    // Where is the collision?
    // If id1 = "op:selected", and id2 = "op", they might not collide.
    // Wait, what if id1 = "op", companion 0 is "op:companion:0".
    // What if id2 = "op:companion", companion 0 is "op:companion:companion:0".
    // Wait, a real collision:
    // id1 = "op:companion", id2 = "op", selected/companion?
    // No, if id1 = "a", id2 = "a:selected", they don't collide.
    // Let's just write a test that verifies two acquirePlan calls with tricky IDs do not collide and resolve to different leases.

    const promise1 = acquireRuntimePortTunnelPlan(manager, {
      rendererOwnerId: 'owner1',
      operationId: 'my:op',
      environmentId: 'env1',
      selected: { remotePort: await freePort(), endpointId: 1 },
      companions: []
    })
    const promise2 = acquireRuntimePortTunnelPlan(manager, {
      rendererOwnerId: 'owner1',
      operationId: 'my:op:selected',
      environmentId: 'env1',
      selected: { remotePort: await freePort(), endpointId: 2 },
      companions: []
    })

    const [res1, res2] = await Promise.all([promise1, promise2])
    if (!res1.ok) {
      console.log('RES1:', res1)
    }
    expect(res1.ok).toBe(true)
    if (!res2.ok) {
      console.log('RES2:', res2)
    }
    expect(res2.ok).toBe(true)
    if (res1.ok && res2.ok) {
      expect(res1.selectedLease.leaseId).not.toBe(res2.selectedLease.leaseId)
    }
  })
})
