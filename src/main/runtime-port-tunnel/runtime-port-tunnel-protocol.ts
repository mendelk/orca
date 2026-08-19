import { EventEmitter } from 'node:events'
import {
  decodeWorkspacePortTunnelFrameDetailed,
  encodeWorkspacePortTunnelFrame,
  WorkspacePortTunnelOpcode,
  WorkspacePortTunnelStreamRegistry,
  decodeWorkspacePortTunnelAuthorizedPayload,
  decodeWorkspacePortTunnelEndpointId,
  decodeWorkspacePortTunnelOpenErrorPayload,
  decodeWorkspacePortTunnelWindowUpdatePayload,
  encodeWorkspacePortTunnelAuthorizePayload,
  encodeWorkspacePortTunnelEndpointId,
  encodeWorkspacePortTunnelWindowUpdatePayload
} from '../../shared/workspace-port-tunnel-protocol'
import type { WorkspacePortTunnelStreamPhase } from '../../shared/workspace-port-tunnel-stream-registry'

export type RuntimePortTunnelProtocolEvent =
  | { type: 'authorized'; endpointIds: number[] }
  | { type: 'authorizeError'; errorCode: number }
  | { type: 'opened'; streamId: number; endpointId: number }
  | { type: 'openError'; streamId: number; endpointId: number; errorCode: number }
  | { type: 'data'; streamId: number; data: Uint8Array }
  | { type: 'fin'; streamId: number }
  | { type: 'reset'; streamId: number }
  | { type: 'windowUpdate'; streamId: number; credit: number }
  | { type: 'ping' }
  | { type: 'pong' }
  | { type: 'protocolError'; failure: unknown }
  /**
   * Emitted when a DATA frame arrives for an unknown stream, a remote-half-
   * closed stream, or a stream whose phase cannot accept DATA. The channel
   * must send a raw RESET back instead of silently dropping the frame.
   */
  | { type: 'resetStream'; streamId: number; reason: 'unknown-stream' | 'invalid-phase' }

export class RuntimePortTunnelProtocol extends EventEmitter {
  public readonly registry = new WorkspacePortTunnelStreamRegistry()

  constructor() {
    super()
  }

  handleIncomingData(data: Uint8Array): void {
    const result = decodeWorkspacePortTunnelFrameDetailed(data)
    if (!result.ok) {
      this.emit('protocolError', result.failure)
      return
    }

    const { frame } = result
    switch (frame.opcode) {
      case WorkspacePortTunnelOpcode.Authorized: {
        const payload = decodeWorkspacePortTunnelAuthorizedPayload(frame.payload)
        if (payload) {
          this.emit('authorized', payload)
        } else {
          this.emit('protocolError', { kind: 'invalid-payload', opcode: frame.opcode })
        }
        break
      }
      case WorkspacePortTunnelOpcode.AuthorizeError: {
        this.emit('authorizeError', frame.payload[0]) // Simplistic
        break
      }
      case WorkspacePortTunnelOpcode.Opened: {
        const endpointId = decodeWorkspacePortTunnelEndpointId(frame.payload)
        if (endpointId !== null) {
          this.registry.markOpened(frame.streamId)
          this.emit('opened', { streamId: frame.streamId, endpointId })
        } else {
          this.emit('protocolError', { kind: 'invalid-payload', opcode: frame.opcode })
        }
        break
      }
      case WorkspacePortTunnelOpcode.OpenError: {
        const payload = decodeWorkspacePortTunnelOpenErrorPayload(frame.payload)
        if (payload) {
          this.registry.markOpenError(frame.streamId, payload.errorCode)
          this.emit('openError', { streamId: frame.streamId, ...payload })
        } else {
          this.emit('protocolError', { kind: 'invalid-payload', opcode: frame.opcode })
        }
        break
      }
      case WorkspacePortTunnelOpcode.Data: {
        const phase = this.registry.get(frame.streamId)?.phase ?? null
        if (phase === null) {
          // Why: DATA for an unknown stream is a protocol violation. The
          // channel must send a raw RESET back instead of silently dropping.
          this.emit('resetStream', { streamId: frame.streamId, reason: 'unknown-stream' })
          return
        }
        if (!canAcceptData(phase)) {
          // Why: DATA for a remote-half-closed or closed stream is also a
          // violation; the channel resets the offending stream.
          this.emit('resetStream', { streamId: frame.streamId, reason: 'invalid-phase' })
          return
        }
        this.emit('data', { streamId: frame.streamId, data: frame.payload })
        break
      }
      case WorkspacePortTunnelOpcode.Fin: {
        const result = this.registry.halfCloseRemote(frame.streamId)
        if (!result.ok) {
          if (
            result.error.kind === 'unknown-stream' ||
            result.error.kind === 'invalid-transition'
          ) {
            this.emit('resetStream', {
              streamId: frame.streamId,
              reason: result.error.kind === 'unknown-stream' ? 'unknown-stream' : 'invalid-phase'
            })
            return
          }
        }
        this.emit('fin', { streamId: frame.streamId })
        break
      }
      case WorkspacePortTunnelOpcode.Reset: {
        this.registry.reset(frame.streamId)
        this.emit('reset', { streamId: frame.streamId })
        break
      }
      case WorkspacePortTunnelOpcode.WindowUpdate: {
        const credit = decodeWorkspacePortTunnelWindowUpdatePayload(frame.payload)
        if (credit !== null) {
          const result = this.registry.applyWindowUpdate(frame.streamId, credit)
          if (!result.ok) {
            if (result.error.kind === 'unknown-stream') {
              this.emit('resetStream', { streamId: frame.streamId, reason: 'unknown-stream' })
              return
            }
          }
          this.emit('windowUpdate', { streamId: frame.streamId, credit })
        } else {
          this.emit('protocolError', { kind: 'invalid-payload', opcode: frame.opcode })
        }
        break
      }
      case WorkspacePortTunnelOpcode.Ping: {
        // Why: v1 requires zero payload; the decoder rejects non-zero. The
        // channel responds with a zero-payload PONG.
        this.emit('ping')
        break
      }
      case WorkspacePortTunnelOpcode.Pong: {
        this.emit('pong')
        break
      }
      case WorkspacePortTunnelOpcode.Authorize:
      case WorkspacePortTunnelOpcode.Open: {
        // Why: client-to-runtime opcodes. The client side never receives
        // these; the runtime side handles them in its own session handler.
        // Receiving one here is a protocol violation.
        this.emit('protocolError', { kind: 'unknown-opcode', opcode: frame.opcode })
        break
      }
    }
  }

  encodeAuthorize(grantId: Uint8Array): Uint8Array {
    return encodeWorkspacePortTunnelFrame({
      opcode: WorkspacePortTunnelOpcode.Authorize,
      streamId: 0,
      payload: encodeWorkspacePortTunnelAuthorizePayload({ grantId })
    })
  }

  encodeOpen(streamId: number, endpointId: number): Uint8Array {
    this.registry.open(streamId, endpointId)
    return encodeWorkspacePortTunnelFrame({
      opcode: WorkspacePortTunnelOpcode.Open,
      streamId,
      payload: encodeWorkspacePortTunnelEndpointId(endpointId)
    })
  }

  encodeData(streamId: number, data: Uint8Array): Uint8Array {
    return encodeWorkspacePortTunnelFrame({
      opcode: WorkspacePortTunnelOpcode.Data,
      streamId,
      payload: data
    })
  }

  encodeFin(streamId: number): Uint8Array {
    this.registry.halfCloseLocal(streamId)
    return encodeWorkspacePortTunnelFrame({
      opcode: WorkspacePortTunnelOpcode.Fin,
      streamId,
      payload: new Uint8Array(0)
    })
  }

  encodeReset(streamId: number): Uint8Array {
    // Why: a graceful RESET we initiate mutates the registry to drop the
    // stream state. Callers use encodeRawReset when responding to a peer
    // violation on a stream that may already be gone.
    this.registry.reset(streamId)
    return encodeWorkspacePortTunnelFrame({
      opcode: WorkspacePortTunnelOpcode.Reset,
      streamId,
      payload: new Uint8Array(0)
    })
  }

  encodeRawReset(streamId: number): Uint8Array {
    // Why: a raw RESET in response to a protocol violation must not touch
    // the registry; the offending stream may already be gone. The decoder
    // has already rejected unknown-stream DATA before this is called.
    return encodeWorkspacePortTunnelFrame({
      opcode: WorkspacePortTunnelOpcode.Reset,
      streamId,
      payload: new Uint8Array(0)
    })
  }

  encodeWindowUpdate(streamId: number, credit: number): Uint8Array {
    return encodeWorkspacePortTunnelFrame({
      opcode: WorkspacePortTunnelOpcode.WindowUpdate,
      streamId,
      payload: encodeWorkspacePortTunnelWindowUpdatePayload(credit)
    })
  }

  // Why: v1 requires PING/PONG to carry zero payload. The encoder throws on
  // non-zero payload, so accepting a payload argument was a protocol bug:
  // callers would silently construct invalid frames. Force zero payload.
  encodePing(): Uint8Array {
    return encodeWorkspacePortTunnelFrame({
      opcode: WorkspacePortTunnelOpcode.Ping,
      streamId: 0,
      payload: new Uint8Array(0)
    })
  }

  encodePong(): Uint8Array {
    return encodeWorkspacePortTunnelFrame({
      opcode: WorkspacePortTunnelOpcode.Pong,
      streamId: 0,
      payload: new Uint8Array(0)
    })
  }
}

function canAcceptData(phase: WorkspacePortTunnelStreamPhase): boolean {
  // Why: DATA is valid only on an open or half-closed-local stream. The peer
  // may still send bytes after we've half-closed locally; we must not accept
  // DATA after the remote half-closed (FIN) or after a full close.
  return phase === 'open' || phase === 'half-closed-local'
}
