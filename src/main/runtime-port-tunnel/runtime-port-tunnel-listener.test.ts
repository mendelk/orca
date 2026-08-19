import { test, expect, describe, afterEach } from 'vitest'
import * as net from 'node:net'
import { RuntimePortTunnelListener } from './runtime-port-tunnel-listener'

describe('RuntimePortTunnelListener', () => {
  let listener: RuntimePortTunnelListener | null = null

  afterEach(async () => {
    if (listener) {
      await listener.closeAsync()
      listener = null
    }
  })

  test('listens on exact loopback port', async () => {
    let connectionCount = 0
    let resolveConnection: () => void
    const connectionPromise = new Promise<void>((r) => {
      resolveConnection = r
    })
    listener = new RuntimePortTunnelListener({
      port: 0,
      onConnection: () => {
        connectionCount++
        resolveConnection()
      }
    })

    await listener.listen()
    const server = (listener as unknown as { server: net.Server }).server
    const assignedPort = (server!.address() as net.AddressInfo).port

    const socket = net.connect({ port: assignedPort, host: '127.0.0.1' })
    await new Promise((resolve) => socket.once('connect', resolve))
    await connectionPromise
    socket.destroy()

    expect(connectionCount).toBe(1)
  })

  test('reference counting does not close inline on release', async () => {
    listener = new RuntimePortTunnelListener({ port: 0, onConnection: () => {} })
    await listener.listen()

    listener.retain()
    listener.retain()
    expect(listener.getRefCount()).toBe(2)

    listener.release()
    expect(listener.getRefCount()).toBe(1)
    // Why: release() no longer closes inline; the pool is the sole zero-ref
    // close owner. The server must still be present after release.
    expect((listener as unknown as { server: net.Server | null }).server).not.toBeNull()

    listener.release()
    expect(listener.getRefCount()).toBe(0)
    // Why: server is still present until closeAsync is awaited; release
    // alone does not close.
    expect((listener as unknown as { server: net.Server | null }).server).not.toBeNull()
  })

  test('closeAsync resolves after server.close callback fires', async () => {
    listener = new RuntimePortTunnelListener({ port: 0, onConnection: () => {} })
    await listener.listen()
    const server = (listener as unknown as { server: net.Server }).server
    expect(server).not.toBeNull()

    await listener.closeAsync()
    // Why: after closeAsync resolves, the server must be nulled so a later
    // re-listen on this listener is rejected.
    expect((listener as unknown as { server: net.Server | null }).server).toBeNull()
    expect(listener.isClosed()).toBe(true)
  })

  test('closeAsync is idempotent and returns the same shared promise', async () => {
    listener = new RuntimePortTunnelListener({ port: 0, onConnection: () => {} })
    await listener.listen()
    const first = listener.closeAsync()
    const second = listener.closeAsync()
    // Why: the pool awaits this promise before rebinding; it must be the
    // same promise so awaiting twice does not start a second close.
    expect(first).toBe(second)
    await first
  })

  test('a second listen while the first is in flight returns the same promise', async () => {
    listener = new RuntimePortTunnelListener({ port: 0, onConnection: () => {} })
    const firstPromise = listener.listen()
    const secondPromise = listener.listen()
    // Why: concurrent listen calls must not start a second server; they
    // must join the same in-flight promise.
    await Promise.all([firstPromise, secondPromise])
    const server = (listener as unknown as { server: net.Server }).server
    expect(server).not.toBeNull()
  })

  test('listen after close is rejected so the pool must create a new listener', async () => {
    listener = new RuntimePortTunnelListener({ port: 0, onConnection: () => {} })
    await listener.listen()
    await listener.closeAsync()
    await expect(listener.listen()).rejects.toThrow()
  })

  test('EventEmitter error does not crash when no listener is attached', async () => {
    listener = new RuntimePortTunnelListener({ port: 0, onConnection: () => {} })
    await listener.listen()
    // Why: a server 'error' event with no explicit listener must not crash
    // the process. The noop error handler is installed in the constructor.
    const server = (listener as unknown as { server: net.Server }).server
    expect(() => server!.emit('error', new Error('boom'))).not.toThrow()
  })

  test('closeAsync destroys active sockets so the close resolves promptly', async () => {
    let serverSocket: net.Socket | null = null
    listener = new RuntimePortTunnelListener({
      port: 0,
      onConnection: (socket) => {
        serverSocket = socket
      }
    })
    await listener.listen()
    const server = (listener as unknown as { server: net.Server }).server
    const port = (server!.address() as net.AddressInfo).port
    const client = net.connect({ port, host: '127.0.0.1' })
    await new Promise((resolve) => client.once('connect', resolve))
    // Why: wait for the server-side socket to be registered.
    await new Promise((resolve) => {
      const check = () => {
        if (serverSocket) {
          resolve(null)
        } else {
          setTimeout(check, 10)
        }
      }
      check()
    })
    // Why: closeAsync must destroy active server-side sockets instead of
    // waiting for peer FINs, so the close promise resolves promptly on a
    // channel drop.
    await listener.closeAsync()
    // Why: TS doesn't track assignments inside closures across awaits, so
    // cast through unknown to access the socket's destroyed flag.
    const sock = serverSocket as unknown as { destroyed: boolean } | null
    expect(sock?.destroyed).toBe(true)
    client.destroy()
  })
})
