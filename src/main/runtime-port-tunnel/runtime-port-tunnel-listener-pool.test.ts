import { describe, expect, it, vi, afterEach } from 'vitest'
import * as net from 'node:net'
import { RuntimePortTunnelListenerPool, makeListenerKey } from './runtime-port-tunnel-listener-pool'
import { RuntimePortTunnelListener } from './runtime-port-tunnel-listener'

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.listen({ port: 0, host: '127.0.0.1' }, () => {
      const port = (srv.address() as net.AddressInfo).port
      srv.close(() => resolve(port))
    })
  })
}

describe('RuntimePortTunnelListenerPool', () => {
  let pool: RuntimePortTunnelListenerPool | null = null

  afterEach(async () => {
    if (pool) {
      await pool.closeAll()
      pool = null
    }
  })

  it('acquires a listener for one environment/endpoint', async () => {
    pool = new RuntimePortTunnelListenerPool()
    const port = await freePort()
    const result = await pool.acquire({
      environmentId: 'env-1',
      remotePort: port,
      endpointId: 1,
      role: 'selected',
      onConnection: () => {}
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.created).toBe(true)
      expect(result.port).toBe(port)
      expect(pool.isPortReserved(port)).toBe(true)
      expect(pool.portOwner(port)).toBe(makeListenerKey('env-1', port, 1))
    }
  })

  it('attaches to an existing listener for the same environment/endpoint instead of rebinding', async () => {
    pool = new RuntimePortTunnelListenerPool()
    const port = await freePort()
    const first = await pool.acquire({
      environmentId: 'env-1',
      remotePort: port,
      endpointId: 1,
      role: 'selected',
      onConnection: () => {}
    })
    const second = await pool.acquire({
      environmentId: 'env-1',
      remotePort: port,
      endpointId: 1,
      role: 'selected',
      onConnection: () => {}
    })
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (first.ok && second.ok) {
      expect(second.created).toBe(false)
      expect(first.listener).toBe(second.listener)
      expect(first.listener.getRefCount()).toBe(2)
    }
  })

  it('a selected conflict on the same local port is fatal (no bind attempted)', async () => {
    // Why: exact local port ownership is process-global. Two environments
    // on 127.0.0.1:5173 cannot each bind. A selected conflict must be
    // fatal, not silently remapped.
    pool = new RuntimePortTunnelListenerPool()
    const port = await freePort()
    await pool.acquire({
      environmentId: 'env-1',
      remotePort: port,
      endpointId: 1,
      role: 'selected',
      onConnection: () => {}
    })
    const result = await pool.acquire({
      environmentId: 'env-2',
      remotePort: port,
      endpointId: 2,
      role: 'selected',
      onConnection: () => {}
    })
    expect(result.ok).toBe(false)
    if (!result.ok && result.reason === 'port-conflict-selected') {
      expect(result.port).toBe(port)
      expect(result.conflictingKey).toBe(makeListenerKey('env-1', port, 1))
    } else {
      throw new Error('expected port-conflict-selected')
    }
    // Why: the second environment must NOT have an active lease for the
    // port; no bind was attempted.
    expect(pool.portOwner(port)).toBe(makeListenerKey('env-1', port, 1))
  })

  it('a companion conflict is skipped/partial, not fatal and not bound', async () => {
    // Why: a companion conflict must produce an explicit skipped/partial
    // result rather than attempting a bind or inventing an active lease.
    pool = new RuntimePortTunnelListenerPool()
    const port = await freePort()
    await pool.acquire({
      environmentId: 'env-1',
      remotePort: port,
      endpointId: 1,
      role: 'selected',
      onConnection: () => {}
    })
    const result = await pool.acquire({
      environmentId: 'env-2',
      remotePort: port,
      endpointId: 2,
      role: 'companion',
      onConnection: () => {}
    })
    expect(result.ok).toBe(false)
    if (!result.ok && result.reason === 'port-conflict-companion') {
      expect(result.port).toBe(port)
      expect(result.conflictingKey).toBe(makeListenerKey('env-1', port, 1))
    } else {
      throw new Error('expected port-conflict-companion')
    }
    expect(pool.portOwner(port)).toBe(makeListenerKey('env-1', port, 1))
  })

  it('release decrements ref count; the pool is the sole zero-ref close owner', async () => {
    pool = new RuntimePortTunnelListenerPool()
    const port = await freePort()
    const result = await pool.acquire({
      environmentId: 'env-1',
      remotePort: port,
      endpointId: 1,
      role: 'selected',
      onConnection: () => {}
    })
    if (!result.ok) {
      throw new Error('acquire failed')
    }
    expect(result.listener.getRefCount()).toBe(1)
    await pool.release(result.listenerKey)
    // Why: after release the listener must be gone from the pool and the
    // port reservation cleared.
    expect(pool.size()).toBe(0)
    expect(pool.isPortReserved(port)).toBe(false)
  })

  it('release awaits the shared close promise before deleting so a rebind cannot race', async () => {
    // Why: the previous release started close then the pool deleted the
    // entry before the server.close callback fired, so a re-acquire for
    // the same port could race with a pending close. The pool must await
    // closeAsync before deleting.
    pool = new RuntimePortTunnelListenerPool()
    const port = await freePort()
    const result = await pool.acquire({
      environmentId: 'env-1',
      remotePort: port,
      endpointId: 1,
      role: 'selected',
      onConnection: () => {}
    })
    if (!result.ok) {
      throw new Error('acquire failed')
    }
    await pool.release(result.listenerKey)
    // Why: after release completes, a new acquire for the same port must
    // succeed because the close promise has resolved.
    const reacquire = await pool.acquire({
      environmentId: 'env-1',
      remotePort: port,
      endpointId: 1,
      role: 'selected',
      onConnection: () => {}
    })
    expect(reacquire.ok).toBe(true)
  })

  it('awaitClose waits for an in-flight close before a rebind', async () => {
    pool = new RuntimePortTunnelListenerPool()
    const port = await freePort()
    const result = await pool.acquire({
      environmentId: 'env-1',
      remotePort: port,
      endpointId: 1,
      role: 'selected',
      onConnection: () => {}
    })
    if (!result.ok) {
      throw new Error('acquire failed')
    }
    // Why: start a close without awaiting, then awaitClose must block
    // until the close promise resolves.
    void result.listener.closeAsync()
    await pool.awaitClose(result.listenerKey)
    expect(result.listener.isClosed()).toBe(true)
  })

  it('listen-error does not reserve the port and returns a bounded error', async () => {
    // Why: when listen fails (EADDRINUSE at the OS level), the pool must
    // not reserve the port and must not publish a listener.
    pool = new RuntimePortTunnelListenerPool()
    const blocker = net.createServer()
    const port = await new Promise<number>((resolve) => {
      blocker.listen({ port: 0, host: '127.0.0.1' }, () => {
        resolve((blocker.address() as net.AddressInfo).port)
      })
    })
    try {
      const result = await pool.acquire({
        environmentId: 'env-1',
        remotePort: port,
        endpointId: 1,
        role: 'selected',
        onConnection: () => {}
      })
      expect(result.ok).toBe(false)
      if (!result.ok && result.reason === 'listen-error') {
        expect(result.port).toBe(port)
        expect(result.error).toBeInstanceOf(Error)
      } else {
        throw new Error('expected listen-error')
      }
      expect(pool.isPortReserved(port)).toBe(false)
    } finally {
      blocker.close()
    }
  })

  it('uses the injected factory to create listeners', async () => {
    const factory = vi.fn(
      (options: { port: number; onConnection: (socket: net.Socket) => void }) =>
        new RuntimePortTunnelListener(options)
    )
    pool = new RuntimePortTunnelListenerPool(factory)
    const port = await freePort()
    await pool.acquire({
      environmentId: 'env-1',
      remotePort: port,
      endpointId: 1,
      role: 'selected',
      onConnection: () => {}
    })
    expect(factory).toHaveBeenCalledOnce()
  })
})
