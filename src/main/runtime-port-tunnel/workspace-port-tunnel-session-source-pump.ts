import {
  WORKSPACE_PORT_TUNNEL_MAX_PAYLOAD_BYTES,
  WorkspacePortTunnelOpcode
} from '../../shared/workspace-port-tunnel-protocol'
import { chunkDataForEgress } from './workspace-port-tunnel-session-outbound'
import type { WorkspacePortTunnelEgressFlow } from './workspace-port-tunnel-session-egress-flow'

// Why: split from the session module to stay under the max-lines ratchet.
// Source socket → egress pipeline: takes a runtime TCP socket's data buffer,
// chunks it into ≤64 KiB DATA frames, consumes per-stream send credit BEFORE
// enqueuing, pauses the source at zero credit, and enqueues the remaining
// chunks onto the egress flow. Queue overflow is reported so the session can
// reset the stream (per-stream overflow) or close the channel (aggregate
// overflow). The earlier implementation truncated bytes over 64 KiB instead
// of chunking, dropping data; this module preserves exact byte equality.

export type SourceDataEnqueueResult =
  | { ok: true }
  | {
      ok: false
      overflow:
        | { kind: 'stream-overflow'; streamId: number; limit: number }
        | { kind: 'channel-overflow'; limit: number }
    }

export function enqueueSourceData(
  egress: WorkspacePortTunnelEgressFlow,
  streamId: number,
  bytes: Uint8Array<ArrayBufferLike>
): SourceDataEnqueueResult {
  if (bytes.byteLength === 0) {
    return { ok: true }
  }
  const chunks = chunkDataForEgress(streamId, bytes)
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!
    const credit = egress.getSendCredit(streamId)
    if (credit < chunk.payload.byteLength) {
      // Why: not enough credit for this chunk. Pause the source and enqueue
      // the remaining chunks (including this one) onto the egress queue so
      // the pump drains them after the next WINDOW_UPDATE. The pump consumes
      // credit as it sends; enqueueSourceData only checks credit to decide
      // whether to pause the source now.
      egress.setSourcePaused(streamId, true)
      for (let j = i; j < chunks.length; j++) {
        const r = egress.enqueue({ streamId, bytes: chunks[j]!.payload })
        if (!r.ok) {
          return { ok: false, overflow: r.overflow }
        }
      }
      return { ok: true }
    }
    // Why: enqueue the chunk; the pump consumes credit when it actually sends.
    const r = egress.enqueue({ streamId, bytes: chunk.payload })
    if (!r.ok) {
      return { ok: false, overflow: r.overflow }
    }
  }
  return { ok: true }
}

// Why: pump limit — a single drain pass sends at most this many frames with at
// most WORKSPACE_PORT_TUNNEL_MAX_PAYLOAD_BYTES bytes per stream, so a chatty
// stream cannot starve the others. The egress flow enforces round-robin
// across streams; this constant bounds the work per pump.
export const EGRESS_PUMP_MAX_FRAMES = 32
export const EGRESS_PUMP_MAX_BYTES_PER_STREAM = WORKSPACE_PORT_TUNNEL_MAX_PAYLOAD_BYTES

export function pumpEgress(
  egress: WorkspacePortTunnelEgressFlow,
  emitFrame: (frame: {
    streamId: number
    opcode: WorkspacePortTunnelOpcode.Data
    payload: Uint8Array<ArrayBufferLike>
  }) => void,
  emitFin: (streamId: number) => void,
  isTransportBlocked?: () => boolean
): void {
  if (isTransportBlocked?.()) {
    return
  }
  // Why: loop drain calls so a multi-chunk write fully drains across rounds.
  // Each drain respects the per-stream byte budget so round-robin fairness
  // holds within each round; the loop ensures all credit-available frames
  // eventually drain.
  for (let round = 0; round < 64; round++) {
    if (isTransportBlocked?.()) {
      return
    }
    const result = egress.drain({
      maxFrames: EGRESS_PUMP_MAX_FRAMES,
      maxBytesPerStream: EGRESS_PUMP_MAX_BYTES_PER_STREAM
    })
    for (const paused of result.pausedStreams) {
      egress.setSourcePaused(paused, true)
    }
    for (const frame of result.sent) {
      emitFrame({
        streamId: frame.streamId,
        opcode: WorkspacePortTunnelOpcode.Data,
        payload: frame.bytes
      })
      if (frame.finAfter) {
        emitFin(frame.streamId)
      }
    }
    if (result.sent.length === 0) {
      break
    }
  }
}
