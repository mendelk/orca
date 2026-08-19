import {
  encodeWorkspacePortTunnelFrame,
  WORKSPACE_PORT_TUNNEL_MAX_CHANNEL_QUEUED_BYTES,
  WORKSPACE_PORT_TUNNEL_MAX_PAYLOAD_BYTES,
  WorkspacePortTunnelOpcode
} from '../../shared/workspace-port-tunnel-protocol'
import {
  encodeWorkspacePortTunnelOpenErrorPayload,
  encodeWorkspacePortTunnelWindowUpdatePayload,
  type WorkspacePortTunnelErrorCode
} from '../../shared/workspace-port-tunnel-payloads'

// Why: split from the session module to stay under the max-lines ratchet. Ou...

export type SendFrameFn = (bytes: Uint8Array<ArrayBufferLike>) => boolean

// Why: a queued outbound frame carries its stream id, opcode, and payload so...
export type QueuedOutboundFrame = {
  streamId: number
  opcode: WorkspacePortTunnelOpcode
  payload: Uint8Array<ArrayBufferLike>
}

// Why: distinguishes DATA/FIN (per-stream, reset on overflow) from control f...
export function isStreamDataFrame(frame: QueuedOutboundFrame): boolean {
  return (
    frame.opcode === WorkspacePortTunnelOpcode.Data ||
    frame.opcode === WorkspacePortTunnelOpcode.Fin
  )
}

export function encodeFrame(frame: QueuedOutboundFrame): Uint8Array<ArrayBufferLike> {
  return encodeWorkspacePortTunnelFrame({
    opcode: frame.opcode,
    streamId: frame.streamId,
    payload: frame.payload
  })
}

// Why: chunk a source buffer into MAX_PAYLOAD_BYTES_V1 DATA payloads. Byte e...
export function chunkDataForEgress(
  streamId: number,
  bytes: Uint8Array<ArrayBufferLike>
): QueuedOutboundFrame[] {
  const frames: QueuedOutboundFrame[] = []
  for (
    let offset = 0;
    offset < bytes.byteLength;
    offset += WORKSPACE_PORT_TUNNEL_MAX_PAYLOAD_BYTES
  ) {
    const end = Math.min(offset + WORKSPACE_PORT_TUNNEL_MAX_PAYLOAD_BYTES, bytes.byteLength)
    frames.push({
      streamId,
      opcode: WorkspacePortTunnelOpcode.Data,
      payload: bytes.subarray(offset, end)
    })
  }
  return frames
}

// Why: overflow kinds the session acts on. DATA/FIN overflow for a stream re...
export type OutboundOverflow =
  | { kind: 'stream-overflow'; streamId: number }
  | { kind: 'channel-overflow' }
  | { kind: 'control-overflow'; frame: QueuedOutboundFrame }

export type OutboundRetryQueueOptions = {
  maxQueuedBytes?: number
  maxQueuedFrames?: number
  // Why: returns the egress flow's current queued bytes so the retry queue acc...
  currentEgressBytes?: () => number
  onSent?: (frame: QueuedOutboundFrame) => void
}

export class OutboundRetryQueue {
  private readonly queue: QueuedOutboundFrame[] = []
  private readonly send: SendFrameFn
  private readonly onOverflow: (overflow: OutboundOverflow) => void
  private readonly maxQueuedBytes: number
  private readonly maxQueuedFrames: number
  private readonly currentEgressBytes: () => number
  private readonly onSent?: (frame: QueuedOutboundFrame) => void
  private queuedBytes = 0
  private blocked = false

  constructor(
    send: SendFrameFn,
    onOverflow: (overflow: OutboundOverflow) => void,
    options?: OutboundRetryQueueOptions
  ) {
    this.send = send
    this.onOverflow = onOverflow
    this.maxQueuedBytes = options?.maxQueuedBytes ?? WORKSPACE_PORT_TUNNEL_MAX_CHANNEL_QUEUED_BYTES
    this.maxQueuedFrames = options?.maxQueuedFrames ?? 1024
    this.currentEgressBytes = options?.currentEgressBytes ?? (() => 0)
    this.onSent = options?.onSent
  }

  // Why: true when the transport is backpressured (last send returned false). ...
  isBlocked(): boolean {
    return this.blocked
  }

  // Why: aggregate budget = egress queued + retry queued. The session reads th...
  private totalChannelBytes(): number {
    return this.currentEgressBytes() + this.queuedBytes
  }

  enqueueOrSend(frame: QueuedOutboundFrame): boolean {
    if (this.queue.length > 0) {
      if (
        this.totalChannelBytes() + frame.payload.byteLength > this.maxQueuedBytes ||
        this.queue.length >= this.maxQueuedFrames
      ) {
        this.reportOverflow(frame)
        return false
      }
      this.queue.push(frame)
      this.queuedBytes += frame.payload.byteLength
      return false
    }
    if (this.send(encodeFrame(frame))) {
      this.blocked = false
      this.onSent?.(frame)
      return true
    }
    this.blocked = true
    if (this.totalChannelBytes() + frame.payload.byteLength > this.maxQueuedBytes) {
      this.reportOverflow(frame)
      return false
    }
    this.queue.push(frame)
    this.queuedBytes += frame.payload.byteLength
    return false
  }

  drain(): number {
    let sent = 0
    while (this.queue.length > 0) {
      const next = this.queue[0]!
      if (!this.send(encodeFrame(next))) {
        this.blocked = true
        break
      }
      this.queue.shift()
      this.queuedBytes -= next.payload.byteLength
      sent++
      this.onSent?.(next)
    }
    if (this.queue.length === 0) {
      this.blocked = false
    }
    return sent
  }

  // Why: remove all queued frames for a reset stream so DATA/FIN never transmi...
  dropStream(streamId: number): number {
    let dropped = 0
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.queue[i]!.streamId === streamId) {
        this.queuedBytes -= this.queue[i]!.payload.byteLength
        this.queue.splice(i, 1)
        dropped++
      }
    }
    if (this.queue.length === 0) {
      this.blocked = false
    }
    return dropped
  }

  dropAll(): number {
    const dropped = this.queue.length
    this.queue.length = 0
    this.queuedBytes = 0
    this.blocked = false
    return dropped
  }

  pending(): number {
    return this.queue.length
  }

  queuedBytesTotal(): number {
    return this.queuedBytes
  }

  // Why: DATA/FIN overflow for a stream → reset that stream. Control-frame or ...
  private reportOverflow(frame: QueuedOutboundFrame): void {
    if (isStreamDataFrame(frame) && this.totalChannelBytes() <= this.maxQueuedBytes) {
      this.onOverflow({ kind: 'stream-overflow', streamId: frame.streamId })
    } else if (isStreamDataFrame(frame)) {
      this.onOverflow({ kind: 'channel-overflow' })
    } else {
      this.onOverflow({ kind: 'control-overflow', frame })
    }
  }
}

export function encodeWindowUpdateFrame(streamId: number, credit: number): QueuedOutboundFrame {
  return {
    streamId,
    opcode: WorkspacePortTunnelOpcode.WindowUpdate,
    payload: encodeWorkspacePortTunnelWindowUpdatePayload(credit)
  }
}

export function encodeOpenErrorFrame(
  streamId: number,
  endpointId: number,
  errorCode: WorkspacePortTunnelErrorCode
): QueuedOutboundFrame {
  return {
    streamId,
    opcode: WorkspacePortTunnelOpcode.OpenError,
    payload: encodeWorkspacePortTunnelOpenErrorPayload(endpointId, errorCode)
  }
}
