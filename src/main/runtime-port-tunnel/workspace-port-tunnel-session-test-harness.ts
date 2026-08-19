import type {
  NetSocketFactory,
  NetSocketLike,
  NetSocketConnectionHandle,
  NetSocketFactoryConnectArgs
} from './workspace-port-tunnel-session-sockets'

// Why: deterministic test doubles for the tunnel session. The fake factory
// lets a test drive each connect outcome (connected, refused, timeout, error)
// and the fake socket lets a test emit 'data', 'drain', 'error', and 'close'
// events on demand so the session's async lifecycle is fully controllable.

export type FakeSocket = NetSocketLike & {
  readonly emittedData: Uint8Array<ArrayBufferLike>[]
  emitData(bytes: Uint8Array<ArrayBufferLike>): void
  emitDrain(): void
  emitError(): void
  emitEnd(): void
  emitClose(hadError?: boolean): void
  writeReturnValue: boolean
  readonly pauseCalls: number
  readonly resumeCalls: number
}

export function createFakeSocket(): FakeSocket {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  let destroyed = false
  let writable = true
  let writtenBytes: Uint8Array<ArrayBufferLike>[] = []
  let pauseCount = 0
  let resumeCount = 0
  // Why: mutable holder the test updates via socket.writeReturnValue; the write
  // closure reads this object so the property actually controls the return.
  const writeReturnHolder = { value: true }
  const socket: FakeSocket = {
    writable: false as boolean,
    destroyed: false as boolean,
    writeReturnValue: true,
    emittedData: [],
    pauseCalls: 0,
    resumeCalls: 0,
    write(bytes) {
      if (destroyed) {
        return false
      }
      writtenBytes.push(bytes)
      return writeReturnHolder.value
    },
    end() {
      writable = false
    },
    destroy() {
      destroyed = true
      writable = false
    },
    setNoDelay() {},
    setTimeout() {},
    pause() {
      pauseCount++
    },
    resume() {
      resumeCount++
    },
    on(event, handler) {
      let set = listeners.get(event)
      if (!set) {
        set = new Set()
        listeners.set(event, set)
      }
      set.add(handler as (...args: unknown[]) => void)
    },
    off(event, handler) {
      listeners.get(event)?.delete(handler as (...args: unknown[]) => void)
    },
    emitData(bytes) {
      this.emittedData.push(bytes)
      listeners.get('data')?.forEach((h) => {
        h(bytes as unknown as Buffer)
      })
    },
    emitDrain() {
      listeners.get('drain')?.forEach((h) => {
        h()
      })
    },
    emitError() {
      listeners.get('error')?.forEach((h) => {
        h(new Error('fake socket error'))
      })
    },
    emitEnd() {
      listeners.get('end')?.forEach((h) => {
        h()
      })
    },
    emitClose(hadError = false) {
      listeners.get('close')?.forEach((h) => {
        h(hadError)
      })
    }
  }
  // Why: define writable/destroyed as live getters so tests can assert state.
  Object.defineProperty(socket, 'writable', { get: () => writable })
  Object.defineProperty(socket, 'destroyed', { get: () => destroyed })
  Object.defineProperty(socket, 'emittedData', { get: () => writtenBytes })
  Object.defineProperty(socket, 'pauseCalls', { get: () => pauseCount })
  Object.defineProperty(socket, 'resumeCalls', { get: () => resumeCount })
  // Why: define writeReturnValue as a live setter/getter backed by the holder
  // so mutating socket.writeReturnValue actually flips write()'s return value.
  Object.defineProperty(socket, 'writeReturnValue', {
    get: () => writeReturnHolder.value,
    set: (v: boolean) => {
      writeReturnHolder.value = v
    }
  })
  return socket
}

export type FakeConnectController = {
  resolve(socket: FakeSocket): void
  refuse(): void
  timeout(): void
  error(): void
}

export type FakeSocketFactory = NetSocketFactory & {
  readonly pendingConnects: FakeConnectController[]
  readonly connects: NetSocketFactoryConnectArgs[]
}

export function createFakeSocketFactory(): FakeSocketFactory {
  const pendingConnects: FakeConnectController[] = []
  const connects: NetSocketFactoryConnectArgs[] = []
  const factory: FakeSocketFactory = {
    pendingConnects,
    connects,
    connect(args, callbacks) {
      connects.push(args)
      const controller: FakeConnectController = {
        resolve(socket) {
          const idx = pendingConnects.indexOf(controller)
          if (idx !== -1) {
            pendingConnects.splice(idx, 1)
          }
          callbacks.onConnected(socket)
        },
        refuse() {
          const idx = pendingConnects.indexOf(controller)
          if (idx !== -1) {
            pendingConnects.splice(idx, 1)
          }
          callbacks.onRefused()
        },
        timeout() {
          const idx = pendingConnects.indexOf(controller)
          if (idx !== -1) {
            pendingConnects.splice(idx, 1)
          }
          callbacks.onTimeout()
        },
        error() {
          const idx = pendingConnects.indexOf(controller)
          if (idx !== -1) {
            pendingConnects.splice(idx, 1)
          }
          callbacks.onError()
        }
      }
      pendingConnects.push(controller)
      const handle: NetSocketConnectionHandle = {
        cancel() {
          const idx = pendingConnects.indexOf(controller)
          if (idx !== -1) {
            pendingConnects.splice(idx, 1)
          }
        }
      }
      return handle
    }
  }
  return factory
}
