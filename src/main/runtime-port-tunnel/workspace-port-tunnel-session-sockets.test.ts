import { describe, it, expect, vi } from 'vitest'
import { createNodeNetSocketFactory } from './workspace-port-tunnel-session-sockets'
import EventEmitter from 'node:events'
import { createConnection, type Socket } from 'node:net'

vi.mock('node:net', () => ({
  createConnection: vi.fn()
}))

type FakeSocket = EventEmitter & {
  setTimeout: ReturnType<typeof vi.fn>
  setNoDelay: ReturnType<typeof vi.fn>
  destroy: ReturnType<typeof vi.fn>
  onConnectCb?: () => void
}

describe('connectWithNodeNet', () => {
  it('a normal successful Node-style void callback does not destroy', () => {
    const fakeSocket = new EventEmitter() as FakeSocket
    fakeSocket.setTimeout = vi.fn()
    fakeSocket.setNoDelay = vi.fn()
    fakeSocket.destroy = vi.fn()

    vi.mocked(createConnection).mockImplementation((_opts, onConnect) => {
      fakeSocket.onConnectCb = onConnect
      return fakeSocket as unknown as Socket
    })

    const factory = createNodeNetSocketFactory({ setTimeout: vi.fn(), now: () => Date.now() })
    const onConnected = vi.fn()
    factory.connect(
      { host: 'localhost', port: 8080, connectTimeoutMs: 1000 },
      {
        onConnected,
        onRefused: vi.fn(),
        onTimeout: vi.fn(),
        onError: vi.fn()
      }
    )

    // Simulate normal connect (Node's net.createConnection callback receives undefined)
    fakeSocket.onConnectCb?.()

    expect(onConnected).toHaveBeenCalledWith(fakeSocket)
    // Should NOT have called destroy because it was a successful connect
    expect(fakeSocket.destroy).not.toHaveBeenCalled()
  })

  it('late connect after timeout/cancel does destroy without callback', () => {
    const fakeSocket = new EventEmitter() as FakeSocket
    fakeSocket.setTimeout = vi.fn()
    fakeSocket.setNoDelay = vi.fn()
    fakeSocket.destroy = vi.fn()

    vi.mocked(createConnection).mockImplementation((_opts, onConnect) => {
      fakeSocket.onConnectCb = onConnect
      return fakeSocket as unknown as Socket
    })

    let timeoutCb: (() => void) | undefined
    const timer = {
      setTimeout: (_cb: () => void, _ms: number) => {
        timeoutCb = _cb
        return vi.fn()
      },
      now: () => Date.now()
    }

    const factory = createNodeNetSocketFactory(timer)
    const onConnected = vi.fn()
    const onTimeout = vi.fn()
    factory.connect(
      { host: 'localhost', port: 8080, connectTimeoutMs: 1000 },
      {
        onConnected,
        onRefused: vi.fn(),
        onTimeout,
        onError: vi.fn()
      }
    )

    // Simulate timeout firing first
    timeoutCb?.()
    expect(onTimeout).toHaveBeenCalled()

    // Now simulate late connect
    fakeSocket.onConnectCb?.()

    // Should NOT fire onConnected, and MUST destroy the socket to prevent leaks
    expect(onConnected).not.toHaveBeenCalled()
    expect(fakeSocket.destroy).toHaveBeenCalled()
  })
})
