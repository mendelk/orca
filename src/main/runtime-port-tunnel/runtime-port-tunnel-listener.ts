import * as net from 'node:net'
import { EventEmitter } from 'node:events'

export type RuntimePortTunnelListenerOptions = {
  port: number
  onConnection: (socket: net.Socket) => void
}

/**
 * Loopback TCP listener for one tunneled remote endpoint.
 *
 * Why a shared close promise: the previous release() started server.close()
 * and then the pool called close() again. The second call returned early
 * because isClosed was already true, so the pool deleted the entry before the
 * server.close callback fired. The pool is now the sole zero-ref close owner
 * and awaits this promise before rebinding; release() delegates to the pool
 * instead of closing inline.
 *
 * Why an EventEmitter error guard: Node EventEmitter throws on 'error' with
 * no listener. The noop error handler is installed here, not just on the
 * channel, so a server 'error' after listen cannot crash the process.
 */
export class RuntimePortTunnelListener extends EventEmitter {
  private server: net.Server | null = null
  private readonly port: number
  private readonly onConnection: (socket: net.Socket) => void
  private activeSockets = new Set<net.Socket>()
  private refCount = 0
  private closePromise: Promise<void> | null = null

  private listenPromise: Promise<void> | null = null
  private isClosing = false

  constructor(options: RuntimePortTunnelListenerOptions) {
    super()
    // Why: install the noop error handler so an uncaught 'error' event from
    // this EventEmitter cannot crash the process. The channel has its own
    // guard too; this one covers direct listeners on the listener itself.
    this.on('error', () => {
      // swallowed — closePromise / listen reject carry the real failure
    })
    this.port = options.port
    this.onConnection = options.onConnection
  }

  /**
   * Bind to 127.0.0.1 on the configured port. Idempotent: a second call
   * while the first is in flight returns the same promise; a call after a
   * successful listen resolves immediately. Rejects when the bind fails or
   * when close() was called while listen was in flight.
   */
  async listen(): Promise<void> {
    if (this.server) {
      return
    }
    if (this.closePromise) {
      // Why: a close was already started; do not allow a re-listen on the
      // same listener. The pool must create a new listener instead.
      throw new Error('runtime port tunnel listener is closed')
    }
    if (this.listenPromise) {
      return this.listenPromise
    }
    this.listenPromise = this.doListen()
    try {
      await this.listenPromise
    } finally {
      this.listenPromise = null
    }
  }

  private doListen(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const server = net.createServer((socket) => {
        this.activeSockets.add(socket)
        socket.on('close', () => {
          this.activeSockets.delete(socket)
        })
        try {
          this.onConnection(socket)
        } catch {
          socket.destroy()
        }
      })
      server.once('error', (err) => {
        if (this.server === server) {
          this.server = null
        }
        reject(err)
      })
      server.listen({ port: this.port, host: '127.0.0.1' }, () => {
        server.removeAllListeners('error')
        // Why: install a persistent error handler so a late server error
        // (e.g. the socket was closed underneath) routes through our
        // EventEmitter instead of throwing uncaught.
        server.on('error', (err) => {
          this.emit('error', err)
        })
        this.server = server
        resolve()
      })
    })
  }

  retain(): void {
    this.refCount += 1
  }

  /**
   * Decrement the ref count. Does NOT close inline; the pool is the sole
   * zero-ref close owner and calls closeAsync() so callers awaiting the
   * close can be sure the server.close callback has fired before rebind.
   */
  release(): void {
    if (this.refCount > 0) {
      this.refCount -= 1
    }
  }

  getRefCount(): number {
    return this.refCount
  }

  /** The configured bind port. Exposed so the pool can clear port
   *  reservations without reaching into private state. */
  getPort(): number {
    return this.port
  }

  /**
   * Close the listener and resolve only after server.close callback fires.
   * Idempotent: subsequent calls return the same promise. Used by the pool
   * when refCount hits zero, and by shutdown paths that need to await the
   * close before deleting the listener entry.
   */
  closeAsync(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise
    }
    this.isClosing = true
    this.closePromise = (async () => {
      if (this.listenPromise) {
        try {
          await this.listenPromise
        } catch {
          // ignore listen errors during close
        }
      }
      if (this.server) {
        const server = this.server
        this.server = null
        for (const socket of this.activeSockets) {
          socket.destroy()
        }
        this.activeSockets.clear()
        return new Promise<void>((resolve) => {
          server.close(() => resolve())
        })
      }

      for (const socket of this.activeSockets) {
        socket.destroy()
      }
      this.activeSockets.clear()
    })()
    return this.closePromise
  }

  /** Synchronous close used by the constructor-time error path and tests. */
  close(): void {
    void this.closeAsync()
  }

  /** True once closeAsync() has been called, even before it resolves. */
  isClosed(): boolean {
    return this.isClosing
  }
}
