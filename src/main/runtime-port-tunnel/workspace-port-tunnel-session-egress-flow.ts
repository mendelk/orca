import {
  WORKSPACE_PORT_TUNNEL_INITIAL_STREAM_RECEIVE_WINDOW_BYTES,
  WORKSPACE_PORT_TUNNEL_MAX_CHANNEL_QUEUED_BYTES,
  WORKSPACE_PORT_TUNNEL_MAX_STREAM_QUEUED_BYTES
} from '../../shared/workspace-port-tunnel-protocol'

// Why: split from the session module to stay under the max-lines ratchet. Eg...

export type QueuedEgressFrame = {
  streamId: number
  bytes: Uint8Array<ArrayBufferLike>
  // Why: marks the final frame for this stream so the pump can emit FIN-after-...
  finAfter?: boolean
}

export type EgressQueueOverflow =
  | { kind: 'stream-overflow'; streamId: number; limit: number }
  | { kind: 'channel-overflow'; limit: number }

export type EgressQueueEnqueueResult = { ok: true } | { ok: false; overflow: EgressQueueOverflow }

type StreamQueue = {
  streamId: number
  frames: QueuedEgressFrame[]
  queuedBytes: number
  // Why: tracks whether the source paused (credit or queue full) so the sessio...
  sourcePaused: boolean
  finished: boolean
}

export type EgressFlowOptions = {
  maxStreamQueuedBytes?: number
  maxChannelQueuedBytes?: number
}

export type EgressFlowDrainResult = {
  // Why: the frames the pump was able to send (credit + writable budget). The ...
  sent: QueuedEgressFrame[]
  // Why: stream ids whose source should be paused because they hit credit or q...
  pausedStreams: number[]
}

export class WorkspacePortTunnelEgressFlow {
  private readonly streams = new Map<number, StreamQueue>()
  // Why: round-robin cursor: ordered stream ids; the pump resumes after the la...
  private rrOrder: number[] = []
  private rrCursor = 0
  private channelQueuedBytes = 0
  private readonly streamQueueLimit: number
  private readonly channelQueueLimit: number

  constructor(options: EgressFlowOptions = {}) {
    this.streamQueueLimit =
      options.maxStreamQueuedBytes ?? WORKSPACE_PORT_TUNNEL_MAX_STREAM_QUEUED_BYTES
    this.channelQueueLimit =
      options.maxChannelQueuedBytes ?? WORKSPACE_PORT_TUNNEL_MAX_CHANNEL_QUEUED_BYTES
  }

  // Why: send credit is per-stream and tracked here so the pump can check it a...
  private sendCredit = new Map<number, number>()

  registerStream(streamId: number): void {
    if (!this.streams.has(streamId)) {
      this.streams.set(streamId, {
        streamId,
        frames: [],
        queuedBytes: 0,
        sourcePaused: false,
        finished: false
      })
      this.rrOrder.push(streamId)
      this.sendCredit.set(streamId, WORKSPACE_PORT_TUNNEL_INITIAL_STREAM_RECEIVE_WINDOW_BYTES)
    }
  }

  hasStream(streamId: number): boolean {
    return this.streams.has(streamId)
  }

  setSourcePaused(streamId: number, paused: boolean): void {
    const sq = this.streams.get(streamId)
    if (sq) {
      sq.sourcePaused = paused
    }
  }

  isSourcePaused(streamId: number): boolean {
    return this.streams.get(streamId)?.sourcePaused ?? false
  }

  markFinished(streamId: number): void {
    const sq = this.streams.get(streamId)
    if (!sq) {
      return
    }
    sq.finished = true
    // Why: set finAfter on the last queued frame so the pump emits FIN after all...
    if (sq.frames.length > 0) {
      sq.frames.at(-1)!.finAfter = true
    } else {
      sq.frames.push({ streamId, bytes: new Uint8Array(), finAfter: true })
    }
  }

  applyWindowUpdate(streamId: number, credit: number): boolean {
    const current = this.sendCredit.get(streamId)
    if (current === undefined) {
      return false
    }
    // Why: cap at Number.MAX_SAFE_INTEGER; the wire carries uint32 but the sessi...
    this.sendCredit.set(streamId, Math.min(Number.MAX_SAFE_INTEGER, current + credit))
    return true
  }

  getSendCredit(streamId: number): number {
    return this.sendCredit.get(streamId) ?? 0
  }

  // Why: the session calls this when forwarding runtime→client bytes. Consumin...
  consumeSendCredit(streamId: number, bytes: number): boolean {
    const current = this.sendCredit.get(streamId)
    if (current === undefined || current < bytes) {
      return false
    }
    this.sendCredit.set(streamId, current - bytes)
    return true
  }

  enqueue(frame: QueuedEgressFrame): EgressQueueEnqueueResult {
    let sq = this.streams.get(frame.streamId)
    if (!sq) {
      sq = {
        streamId: frame.streamId,
        frames: [],
        queuedBytes: 0,
        sourcePaused: false,
        finished: false
      }
      this.streams.set(frame.streamId, sq)
      this.rrOrder.push(frame.streamId)
    }
    if (sq.queuedBytes + frame.bytes.byteLength > this.streamQueueLimit) {
      return {
        ok: false,
        overflow: {
          kind: 'stream-overflow',
          streamId: frame.streamId,
          limit: this.streamQueueLimit
        }
      }
    }
    if (this.channelQueuedBytes + frame.bytes.byteLength > this.channelQueueLimit) {
      return { ok: false, overflow: { kind: 'channel-overflow', limit: this.channelQueueLimit } }
    }
    sq.frames.push(frame)
    sq.queuedBytes += frame.bytes.byteLength
    this.channelQueuedBytes += frame.bytes.byteLength
    return { ok: true }
  }

  // Why: drains up to `maxFrames` total and `maxBytesPerStream` accumulated pe...
  drain(budget: { maxFrames: number; maxBytesPerStream: number }): EgressFlowDrainResult {
    const sent: QueuedEgressFrame[] = []
    const pausedStreams: number[] = []
    if (this.rrOrder.length === 0) {
      return { sent, pausedStreams }
    }
    let emitted = 0
    let passCount = 0
    // Why: track accumulated bytes emitted per stream THIS drain so the per-stre...
    const emittedBytesPerStream = new Map<number, number>()
    const maxPasses = this.rrOrder.length * budget.maxFrames + 1
    while (emitted < budget.maxFrames && passCount < maxPasses) {
      passCount++
      let progressed = false
      const startCursor = this.rrCursor
      do {
        if (this.rrOrder.length === 0) {
          return { sent, pausedStreams }
        }
        const streamId = this.rrOrder[this.rrCursor % this.rrOrder.length]!
        const sq = this.streams.get(streamId)
        this.rrCursor = (this.rrCursor + 1) % Math.max(1, this.rrOrder.length)
        if (!sq || sq.frames.length === 0) {
          continue
        }
        const frame = sq.frames[0]!
        // Why: a zero-byte FIN sentinel (finAfter, no payload) consumes no DATA cred...
        if (frame.bytes.byteLength === 0 && frame.finAfter) {
          sq.frames.shift()
          // Why: queuedBytes/channelQueuedBytes are unchanged (0 bytes).
          emittedBytesPerStream.set(streamId, emittedBytesPerStream.get(streamId) ?? 0)
          sent.push(frame)
          emitted++
          progressed = true
          if (sq.frames.length === 0 && sq.finished) {
            this.removeStream(streamId)
          }
          continue
        }
        const credit = this.sendCredit.get(streamId) ?? 0
        if (credit <= 0) {
          if (!sq.sourcePaused) {
            pausedStreams.push(streamId)
          }
          continue
        }
        const streamEmitted = emittedBytesPerStream.get(streamId) ?? 0
        // Why: check BOTH per-frame credit AND accumulated per-stream byte budget so...
        if (
          frame.bytes.byteLength > credit ||
          streamEmitted + frame.bytes.byteLength > budget.maxBytesPerStream
        ) {
          if (!sq.sourcePaused) {
            pausedStreams.push(streamId)
          }
          continue
        }
        sq.frames.shift()
        sq.queuedBytes -= frame.bytes.byteLength
        this.channelQueuedBytes -= frame.bytes.byteLength
        this.sendCredit.set(streamId, credit - frame.bytes.byteLength)
        emittedBytesPerStream.set(streamId, streamEmitted + frame.bytes.byteLength)
        sent.push(frame)
        emitted++
        progressed = true
        // Why: only remove the stream when all frames drained AND finished. If finis...
        if (sq.frames.length === 0 && sq.finished) {
          this.removeStream(streamId)
        }
      } while (this.rrCursor !== startCursor && emitted < budget.maxFrames)
      if (!progressed) {
        break
      }
    }
    return { sent, pausedStreams }
  }

  removeStream(streamId: number): void {
    const sq = this.streams.get(streamId)
    if (!sq) {
      return
    }
    this.channelQueuedBytes = Math.max(0, this.channelQueuedBytes - sq.queuedBytes)
    this.streams.delete(streamId)
    this.sendCredit.delete(streamId)
    const idx = this.rrOrder.indexOf(streamId)
    if (idx !== -1) {
      this.rrOrder.splice(idx, 1)
      this.rrCursor = this.rrOrder.length === 0 ? 0 : this.rrCursor % this.rrOrder.length
    }
  }

  channelQueuedBytesTotal(): number {
    return this.channelQueuedBytes
  }

  streamQueuedBytes(streamId: number): number {
    return this.streams.get(streamId)?.queuedBytes ?? 0
  }

  clear(): void {
    this.streams.clear()
    this.sendCredit.clear()
    this.rrOrder = []
    this.rrCursor = 0
    this.channelQueuedBytes = 0
  }
}
