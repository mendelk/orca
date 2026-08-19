import type {
  ActiveStream,
  StreamLifecycleEmit,
  StreamLifecycleCallbacks
} from './workspace-port-tunnel-session-active-stream'
import { WorkspacePortTunnelErrorCode } from '../../shared/workspace-port-tunnel-payloads'
import {
  WORKSPACE_PORT_TUNNEL_MAX_ACTIVE_STREAMS_PER_CHANNEL,
  WorkspacePortTunnelOpcode
} from '../../shared/workspace-port-tunnel-protocol'
import type { NetSocketLike, NetSocketFactory } from './workspace-port-tunnel-session-sockets'
import {
  installStreamSocket,
  teardownStreamSocket,
  type StreamSocketEvents
} from './workspace-port-tunnel-session-stream-socket'
import {
  buildFinFrame,
  buildOpenedFrame,
  buildResetFrame
} from './workspace-port-tunnel-session-frame-decoder'
import {
  encodeOpenErrorFrame,
  encodeWindowUpdateFrame
} from './workspace-port-tunnel-session-outbound'
import type { WorkspacePortTunnelEgressFlow } from './workspace-port-tunnel-session-egress-flow'
import type { WorkspacePortTunnelIngressCredit } from './workspace-port-tunnel-session-ingress-credit'
import { enqueueSourceData, pumpEgress } from './workspace-port-tunnel-session-source-pump'

export class StreamLifecycle {
  private readonly streams = new Map<number, ActiveStream>()
  private readonly socketFactory: NetSocketFactory
  private readonly connectTimeoutMs: number
  private readonly egress: WorkspacePortTunnelEgressFlow
  private readonly ingress: WorkspacePortTunnelIngressCredit
  private readonly emit: StreamLifecycleEmit
  private readonly callbacks: StreamLifecycleCallbacks
  private readonly isTransportBlocked: () => boolean
  private closed = false

  constructor(args: {
    socketFactory: NetSocketFactory
    connectTimeoutMs: number
    egress: WorkspacePortTunnelEgressFlow
    ingress: WorkspacePortTunnelIngressCredit
    emit: StreamLifecycleEmit
    callbacks: StreamLifecycleCallbacks
    isTransportBlocked: () => boolean
  }) {
    this.socketFactory = args.socketFactory
    this.connectTimeoutMs = args.connectTimeoutMs
    this.egress = args.egress
    this.ingress = args.ingress
    this.emit = args.emit
    this.callbacks = args.callbacks
    this.isTransportBlocked = args.isTransportBlocked
  }

  markClosed(): void {
    this.closed = true
  }

  has(streamId: number): boolean {
    return this.streams.has(streamId)
  }

  size(): number {
    return this.streams.size
  }

  open(streamId: number, host: string, port: number, endpointId: number): void {
    if (this.streams.size >= WORKSPACE_PORT_TUNNEL_MAX_ACTIVE_STREAMS_PER_CHANNEL) {
      this.callbacks.onStreamCapExceeded(streamId, endpointId)
      return
    }
    const stream: ActiveStream = {
      streamId,
      endpointId,
      installed: null,
      connectHandle: null,
      halfClosedRemote: false,
      halfClosedLocal: false,
      cleanedUp: false,
      finEmitted: false
    }
    this.streams.set(streamId, stream)
    stream.connectHandle = this.socketFactory.connect(
      { host, port, connectTimeoutMs: this.connectTimeoutMs },
      {
        onConnected: (socket) => this.onConnected(stream, socket),
        onRefused: () =>
          this.onConnectFailed(stream, endpointId, WorkspacePortTunnelErrorCode.ConnectRefused),
        onTimeout: () =>
          this.onConnectFailed(stream, endpointId, WorkspacePortTunnelErrorCode.ConnectTimeout),
        onError: () =>
          this.onConnectFailed(stream, endpointId, WorkspacePortTunnelErrorCode.InternalError)
      }
    )
  }

  handleClientData(streamId: number, payload: Uint8Array): void {
    const stream = this.streams.get(streamId)
    if (!stream || !stream.installed || !stream.installed.controller.isWritable()) {
      this.emit(buildResetFrame(streamId))
      return
    }
    if (this.ingress.remainingWindow(streamId) < payload.byteLength) {
      this.resetStream(streamId, true)
      return
    }
    const accepted = stream.installed.controller.write(payload)
    if (payload.byteLength > 0) {
      this.returnIngressCredit(streamId, payload.byteLength, accepted)
    }
  }

  handleOutboundFinSent(streamId: number): void {
    const stream = this.streams.get(streamId)
    if (stream) {
      stream.finEmitted = true
      if (stream.halfClosedRemote) {
        this.removeStream(streamId)
      }
    }
  }

  handleFin(streamId: number): void {
    const stream = this.streams.get(streamId)
    if (!stream) {
      this.emit(buildResetFrame(streamId))
      return
    }
    stream.halfClosedRemote = true
    stream.installed?.controller.end()
    // Why: only remove if local half is also closed AND the FIN was actually emi...
    if (stream.halfClosedLocal && stream.finEmitted) {
      this.removeStream(streamId)
    }
  }

  handleReset(streamId: number): void {
    this.resetStream(streamId, false)
  }

  notifyWritable(): void {
    if (this.closed) {
      return
    }
    this.syncSourcePauseResume()
    this.pump()
  }

  handleWindowUpdate(streamId: number, credit: number): void {
    if (!this.egress.hasStream(streamId)) {
      this.emit(buildResetFrame(streamId))
      return
    }
    this.egress.applyWindowUpdate(streamId, credit)
    this.egress.setSourcePaused(streamId, false)
    this.streams.get(streamId)?.installed?.controller.resumeSource()
    this.pump()
  }

  teardownAll(): void {
    for (const stream of this.streams.values()) {
      stream.connectHandle?.cancel()
      stream.connectHandle = null
      if (stream.installed) {
        teardownStreamSocket(stream.installed)
      }
    }
    this.streams.clear()
  }

  private onConnected(stream: ActiveStream, socket: NetSocketLike): void {
    if (this.closed) {
      try {
        socket.destroy()
      } catch {
        /* best-effort */
      }
      this.streams.delete(stream.streamId)
      return
    }
    stream.connectHandle = null
    const events: StreamSocketEvents = {
      onData: (sid, bytes) => this.onSourceData(sid, bytes),
      onEnded: (sid) => this.onSourceEnded(sid),
      onError: (sid) => this.onSourceError(sid),
      onClose: (sid, hadError) => this.onSourceClose(sid, hadError),
      onDrain: (sid) => this.onSourceDrain(sid)
    }
    stream.installed = installStreamSocket(stream.streamId, socket, events)
    this.egress.registerStream(stream.streamId)
    this.ingress.registerStream(stream.streamId)
    this.emit(buildOpenedFrame(stream.streamId, stream.endpointId))
  }

  private onConnectFailed(
    stream: ActiveStream,
    endpointId: number,
    code: WorkspacePortTunnelErrorCode
  ): void {
    stream.connectHandle = null
    this.streams.delete(stream.streamId)
    this.emit(encodeOpenErrorFrame(stream.streamId, endpointId, code))
  }

  private onSourceData(streamId: number, bytes: Uint8Array<ArrayBufferLike>): void {
    if (this.closed || !this.streams.has(streamId)) {
      return
    }
    const r = enqueueSourceData(this.egress, streamId, bytes)
    if (!r.ok) {
      this.callbacks.onEgressOverflow(streamId, r.overflow)
      return
    }
    // Why: if the source was paused due to zero credit, pause the TCP socket so ...
    if (this.egress.isSourcePaused(streamId)) {
      this.streams.get(streamId)?.installed?.controller.pauseSource()
    }
    this.pump()
  }

  private onSourceEnded(streamId: number): void {
    const stream = this.streams.get(streamId)
    if (!stream) {
      return
    }
    stream.halfClosedLocal = true
    // Why: mark the egress flow finished so the last queued frame gets finAfter ...
    this.egress.markFinished(streamId)
    this.pump()
    // Why: if remote already half-closed AND all egress drained, remove. Otherwi...
    if (stream.halfClosedRemote && stream.finEmitted) {
      this.removeStream(streamId)
    }
  }

  private onSourceError(streamId: number): void {
    this.resetStream(streamId, true)
  }

  private onSourceClose(streamId: number, hadError: boolean): void {
    const stream = this.streams.get(streamId)
    if (!stream || stream.cleanedUp) {
      return
    }
    if (hadError) {
      this.resetStream(streamId, true)
      return
    }
    // Why: a normal close with queued DATA/FIN must NOT remove the stream — the ...
    if (!stream.halfClosedLocal) {
      stream.halfClosedLocal = true
      this.egress.markFinished(streamId)
      this.pump()
    }
    if (stream.halfClosedRemote && stream.finEmitted) {
      this.removeStream(streamId)
    }
  }

  private onSourceDrain(streamId: number): void {
    // Why: destination accepted the bytes that write() returned false for. Retur...
    const result = this.ingress.recordDrain(streamId)
    if (result.ok && result.creditToReturn > 0) {
      this.emit(encodeWindowUpdateFrame(streamId, result.creditToReturn))
    }
  }

  private pump(): void {
    if (this.closed) {
      return
    }
    pumpEgress(
      this.egress,
      (frame) =>
        this.emit({
          streamId: frame.streamId,
          opcode: WorkspacePortTunnelOpcode.Data,
          payload: frame.payload
        }),
      (streamId) => {
        this.emit(buildFinFrame(streamId))
      },
      this.isTransportBlocked
    )
    this.syncSourcePauseResume()
  }

  // Why: pause the TCP source when the stream has no credit or hit the queue l...
  private syncSourcePauseResume(): void {
    for (const [streamId, stream] of this.streams) {
      if (!stream.installed) {
        continue
      }
      if (this.egress.isSourcePaused(streamId)) {
        stream.installed.controller.pauseSource()
      } else {
        stream.installed.controller.resumeSource()
      }
    }
  }

  private returnIngressCredit(streamId: number, bytes: number, accepted: boolean): void {
    const result = accepted
      ? this.ingress.recordAccepted(streamId, bytes)
      : this.ingress.recordPending(streamId, bytes)
    if (!result.ok && result.reason === 'window-exceeded') {
      this.resetStream(streamId, true)
      return
    }
    if (result.ok && result.creditToReturn > 0) {
      this.emit(encodeWindowUpdateFrame(streamId, result.creditToReturn))
    }
  }

  private resetStream(streamId: number, sendReset: boolean): void {
    const stream = this.streams.get(streamId)
    if (!stream || stream.cleanedUp) {
      return
    }
    stream.cleanedUp = true
    stream.connectHandle?.cancel()
    stream.connectHandle = null
    if (stream.installed) {
      teardownStreamSocket(stream.installed)
    }
    this.streams.delete(streamId)
    this.egress.removeStream(streamId)
    this.ingress.removeStream(streamId)
    if (sendReset && !this.closed) {
      this.emit(buildResetFrame(streamId))
    }
    this.callbacks.onStreamRemoved(streamId)
  }

  private removeStream(streamId: number): void {
    const stream = this.streams.get(streamId)
    if (!stream || stream.cleanedUp) {
      return
    }
    stream.cleanedUp = true
    if (stream.installed) {
      teardownStreamSocket(stream.installed)
    }
    this.streams.delete(streamId)
    this.egress.removeStream(streamId)
    this.ingress.removeStream(streamId)
    this.callbacks.onStreamRemoved(streamId)
  }
}
