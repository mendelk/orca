import { createConnection, type Socket } from 'node:net'

// Why: the runtime-side tunnel session opens one TCP socket per OPEN frame t...

export type TunnelSocketConnectOutcome =
  | { kind: 'connected'; socket: NetSocketLike }
  | { kind: 'refused' }
  | { kind: 'timeout' }
  | { kind: 'error' }

// Why: the session talks to a minimal socket surface so tests can substitute...
export type NetSocketLike = {
  write(bytes: Uint8Array<ArrayBufferLike>): boolean
  end(): void
  destroy(error?: Error): void
  setNoDelay(noDelay?: boolean): void
  setTimeout(ms: number, callback?: () => void): void
  pause(): void
  resume(): void
  on(event: 'data', handler: (data: Buffer) => void): void
  on(event: 'error', handler: (error: Error) => void): void
  on(event: 'close', handler: (hadError: boolean) => void): void
  on(event: 'end', handler: () => void): void
  on(event: 'drain', handler: () => void): void
  off(event: string, handler: (...args: unknown[]) => void): void
  readonly writable: boolean
  readonly destroyed: boolean
}

export type NetSocketFactoryConnectArgs = {
  host: string
  port: number
  connectTimeoutMs: number
}

// Why: the factory connects asynchronously and reports the outcome via callb...
export type NetSocketFactory = {
  connect(
    args: NetSocketFactoryConnectArgs,
    callbacks: {
      onConnected: (socket: NetSocketLike) => void
      onRefused: () => void
      onTimeout: () => void
      onError: () => void
    }
  ): NetSocketConnectionHandle
}

export type NetSocketConnectionHandle = {
  // Why: cancels a pending connect. Safe to call after connect settled (no-op)...
  cancel(): void
}

export type NetSocketFactoryTimer = {
  setTimeout(callback: () => void, ms: number): () => void
  now(): number
}

// Why: the default Node `net` factory. Honors an injectable timer/clock so t...
export function createNodeNetSocketFactory(timer?: NetSocketFactoryTimer): NetSocketFactory {
  const resolvedTimer: NetSocketFactoryTimer = timer ?? {
    setTimeout: (cb, ms) => {
      const h = setTimeout(cb, ms)
      return () => clearTimeout(h)
    },
    now: () => Date.now()
  }
  return {
    connect(args, callbacks) {
      return connectWithNodeNet(args, callbacks, resolvedTimer)
    }
  }
}

function connectWithNodeNet(
  args: NetSocketFactoryConnectArgs,
  callbacks: {
    onConnected: (socket: NetSocketLike) => void
    onRefused: () => void
    onTimeout: () => void
    onError: () => void
  },
  timer: NetSocketFactoryTimer
): NetSocketConnectionHandle {
  // Why: top-level import keeps the module side-effect free and lets tests sub...
  let settled = false
  let socket: Socket | null = null
  let timerCancel: (() => void) | null = null
  // Why: once settled, ALL later callbacks are suppressed — a late 'connect' a...
  const finishOnce = <T>(action: () => T): boolean => {
    if (settled) {
      return false
    }
    settled = true
    if (timerCancel) {
      timerCancel()
      timerCancel = null
    }
    action()
    return true
  }
  const onConnect = () => {
    const s = socket
    if (!s) {
      return
    }
    s.setTimeout(0)
    s.setNoDelay(true)
    // Why: finishOnce returns false when already settled (timeout/cancel fired f...
    const didSettle = finishOnce(() => callbacks.onConnected(s as unknown as NetSocketLike))
    if (!didSettle) {
      try {
        s.destroy()
      } catch {
        /* best-effort */
      }
    }
  }
  const onError = (err: NodeJS.ErrnoException) => {
    if (settled) {
      return
    }
    // Why: classify ECONNREFUSED / EADDRNOTAVAIL as ConnectRefused so the client...
    if (err.code === 'ECONNREFUSED' || err.code === 'EADDRNOTAVAIL') {
      finishOnce(() => callbacks.onRefused())
      return
    }
    finishOnce(() => callbacks.onError())
  }
  const onClose = (hadError: boolean) => {
    // Why: a close before 'connect' without an explicit error event collapses to...
    if (!settled && !hadError) {
      finishOnce(() => callbacks.onRefused())
    }
  }
  socket = createConnection({ host: args.host, port: args.port }, onConnect)
  socket.on('error', onError)
  socket.on('close', onClose)
  if (args.connectTimeoutMs > 0) {
    timerCancel = timer.setTimeout(() => {
      if (settled) {
        return
      }
      // Why: destroy first so a late 'connect' does not fire onConnected after the...
      try {
        socket?.destroy()
      } catch {
        // best-effort cleanup
      }
      finishOnce(() => callbacks.onTimeout())
    }, args.connectTimeoutMs)
  }
  return {
    cancel() {
      if (settled) {
        return
      }
      settled = true
      if (timerCancel) {
        timerCancel()
        timerCancel = null
      }
      try {
        socket?.destroy()
      } catch {
        // best-effort
      }
    }
  }
}
