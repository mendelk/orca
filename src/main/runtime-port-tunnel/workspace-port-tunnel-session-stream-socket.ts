import type { NetSocketLike } from './workspace-port-tunnel-session-sockets'

// Why: split from the session module to stay under the max-lines ratchet.
// Per-stream TCP socket lifecycle: binds a NetSocketLike to a stream id and
// exposes the small surface the session needs (forward bytes to the client,
// half-close, reset, force-close). The session owns policy; this module owns
// deterministic socket cleanup so a stream reset never leaks an open socket.

export type StreamSocketEvents = {
  onData: (streamId: number, bytes: Uint8Array<ArrayBufferLike>) => void
  onEnded: (streamId: number) => void
  onError: (streamId: number) => void
  onClose: (streamId: number, hadError: boolean) => void
  onDrain: (streamId: number) => void
}

export type StreamSocketController = {
  streamId: number
  // Why: writes client→runtime bytes to the loopback socket. Returns true if
  // the socket accepted the bytes (write returned true) — the session uses
  // that signal to credit the client's receive window. Returns false when the
  // socket's userland buffer is full; the session waits for onDrain before
  // returning WINDOW_UPDATE for those bytes.
  write(bytes: Uint8Array<ArrayBufferLike>): boolean
  end(): void
  destroy(): void
  isWritable(): boolean
  isDestroyed(): boolean
  // Why: pause/resume the source TCP socket so the runtime stops reading
  // data when the client has no send credit or the transport is backpressured.
  // Without this, the source keeps flooding the egress queue during zero
  // credit, growing memory outside the bounded accounting.
  pauseSource(): void
  resumeSource(): void
}

// Why: a per-stream socket is "active" once installed; the session tracks
// active streams so handleClose can deterministically destroy every socket.
export type InstalledStreamSocket = {
  streamId: number
  socket: NetSocketLike
  controller: StreamSocketController
}

export function installStreamSocket(
  streamId: number,
  socket: NetSocketLike,
  events: StreamSocketEvents
): InstalledStreamSocket {
  const onData = (data: Buffer) => events.onData(streamId, new Uint8Array(data))
  const onDrain = () => events.onDrain(streamId)
  const onEnded = () => events.onEnded(streamId)
  const onError = () => events.onError(streamId)
  const onClose = (hadError: boolean) => {
    socket.off('close', onClose as (...args: unknown[]) => void)
    socket.off('data', onData as (...args: unknown[]) => void)
    socket.off('end', onEnded as (...args: unknown[]) => void)
    socket.off('error', onError as (...args: unknown[]) => void)
    socket.off('drain', onDrain as (...args: unknown[]) => void)
    events.onClose(streamId, hadError)
  }
  socket.on('data', onData)
  socket.on('end', onEnded)
  socket.on('drain', onDrain)
  socket.on('error', onError)
  socket.on('close', onClose)
  const controller: StreamSocketController = {
    streamId,
    write(bytes) {
      if (socket.destroyed || !socket.writable) {
        return false
      }
      return socket.write(bytes)
    },
    end() {
      if (!socket.destroyed) {
        socket.end()
      }
    },
    destroy() {
      if (!socket.destroyed) {
        socket.destroy()
      }
    },
    isWritable() {
      return socket.writable && !socket.destroyed
    },
    isDestroyed() {
      return socket.destroyed
    },
    pauseSource() {
      if (!socket.destroyed) {
        socket.pause()
      }
    },
    resumeSource() {
      if (!socket.destroyed) {
        socket.resume()
      }
    }
  }
  return { streamId, socket, controller }
}

// Why: a single helper that destroys a socket and removes all listeners so a
// late event from the kernel cannot fire into a freed session. The session
// calls this on reset/close so no stream socket leaks its handlers.
export function teardownStreamSocket(installed: InstalledStreamSocket): void {
  try {
    installed.socket.destroy()
  } catch {
    // best-effort
  }
}
