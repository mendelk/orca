import type { RuntimePortTunnelSchedulerStream } from './runtime-port-tunnel-scheduler'
import {
  WORKSPACE_PORT_TUNNEL_MAX_CHANNEL_QUEUED_BYTES,
  WORKSPACE_PORT_TUNNEL_MAX_STREAM_QUEUED_BYTES
} from '../../shared/workspace-port-tunnel-protocol'

export type RuntimePortTunnelOutboundQueueOptions = {
  maxStreamQueuedBytes?: number
  maxChannelQueuedBytes?: number
}

export type RuntimePortTunnelOutboundEnqueueResult =
  | { ok: true }
  | { ok: false; reason: 'stream-overflow' }
  | { ok: false; reason: 'channel-overflow' }
  | { ok: false; reason: 'unknown-stream' }

export type RuntimePortTunnelOutboundSendResult =
  | { ok: true; sent: number }
  | { ok: false; reason: 'transport-rejected' }
  | { ok: false; reason: 'unknown-stream' }

/**
 * Per-stream and aggregate queued-byte accounting for outbound tunnel DATA.
 *
 * Why a dedicated queue: the channel used to keep pending chunks inline
 * and walk them in order[0]. That made round-robin scheduling impossible
 * and conflated per-stream overflow (RESET the stream) with aggregate
 * overflow (CLOSE the channel). This module enforces both limits and
 * exposes the per-stream snapshot the scheduler needs.
 *
 * Overflow policy (spec):
 *   - newStreamQueued > maxStreamQueuedBytes -> stream-overflow. The channel
 *     RESETs only that stream and keeps the channel alive.
 *   - channelQueued + bytes > maxChannelQueuedBytes -> channel-overflow.
 *     The channel CLOSES; calling sendReset would let a misbehaving stream
 *     exhaust the channel and continue.
 */
type OutboundItem =
  | { type: 'data'; bytes: Uint8Array }
  | { type: 'control'; frame: Uint8Array; onSent?: () => void }

export class RuntimePortTunnelOutboundQueue {
  private readonly streamQueued = new Map<number, number>()
  private readonly items = new Map<number, OutboundItem[]>()
  private channelQueuedBytes = 0
  private readonly maxStreamQueuedBytes: number
  private readonly maxChannelQueuedBytes: number

  constructor(options?: RuntimePortTunnelOutboundQueueOptions) {
    this.maxStreamQueuedBytes =
      options?.maxStreamQueuedBytes ?? WORKSPACE_PORT_TUNNEL_MAX_STREAM_QUEUED_BYTES
    this.maxChannelQueuedBytes =
      options?.maxChannelQueuedBytes ?? WORKSPACE_PORT_TUNNEL_MAX_CHANNEL_QUEUED_BYTES
  }

  enqueueData(streamId: number, data: Uint8Array): RuntimePortTunnelOutboundEnqueueResult {
    const current = this.streamQueued.get(streamId) ?? 0
    if (current + data.byteLength > this.maxStreamQueuedBytes) {
      return { ok: false, reason: 'stream-overflow' }
    }
    if (this.channelQueuedBytes + data.byteLength > this.maxChannelQueuedBytes) {
      return { ok: false, reason: 'channel-overflow' }
    }
    this.streamQueued.set(streamId, current + data.byteLength)
    this.channelQueuedBytes += data.byteLength
    const list = this.items.get(streamId) ?? []
    list.push({ type: 'data', bytes: data })
    this.items.set(streamId, list)
    return { ok: true }
  }

  enqueueControl(
    streamId: number,
    frame: Uint8Array,
    onSent?: () => void
  ): RuntimePortTunnelOutboundEnqueueResult {
    const current = this.streamQueued.get(streamId) ?? 0
    if (current + frame.byteLength > this.maxStreamQueuedBytes && streamId !== 0) {
      return { ok: false, reason: 'stream-overflow' }
    }
    if (this.channelQueuedBytes + frame.byteLength > this.maxChannelQueuedBytes) {
      return { ok: false, reason: 'channel-overflow' }
    }
    this.streamQueued.set(streamId, current + frame.byteLength)
    this.channelQueuedBytes += frame.byteLength
    const list = this.items.get(streamId) ?? []
    list.push({ type: 'control', frame, onSent })
    this.items.set(streamId, list)
    return { ok: true }
  }

  sendOne(
    streamId: number,
    maxDataBytes: number,
    sendData: (data: Uint8Array) => boolean,
    sendControl: (frame: Uint8Array) => boolean
  ): RuntimePortTunnelOutboundSendResult {
    const list = this.items.get(streamId)
    if (!list || list.length === 0) {
      return { ok: false, reason: 'unknown-stream' }
    }
    const item = list[0]!

    if (item.type === 'control') {
      const accepted = sendControl(item.frame)
      if (!accepted) {
        return { ok: false, reason: 'transport-rejected' }
      }
      list.shift()
      this.streamQueued.set(
        streamId,
        (this.streamQueued.get(streamId) ?? 0) - item.frame.byteLength
      )
      this.channelQueuedBytes -= item.frame.byteLength
      if (list.length === 0) {
        this.items.delete(streamId)
      }
      if (item.onSent) {
        item.onSent()
      }
      return { ok: true, sent: 0 } // controls don't consume stream credit
    }

    // Data item
    let toSend = item.bytes
    let tail: Uint8Array | null = null
    if (toSend.byteLength > maxDataBytes) {
      tail = toSend.subarray(maxDataBytes)
      toSend = toSend.subarray(0, maxDataBytes)
    }
    const accepted = sendData(toSend)
    if (!accepted) {
      return { ok: false, reason: 'transport-rejected' }
    }
    if (tail) {
      list[0] = { type: 'data', bytes: tail }
      this.streamQueued.set(streamId, (this.streamQueued.get(streamId) ?? 0) - toSend.byteLength)
      this.channelQueuedBytes -= toSend.byteLength
    } else {
      list.shift()
      this.streamQueued.set(streamId, (this.streamQueued.get(streamId) ?? 0) - toSend.byteLength)
      this.channelQueuedBytes -= toSend.byteLength
      if (list.length === 0) {
        this.items.delete(streamId)
      }
    }
    return { ok: true, sent: toSend.byteLength }
  }

  /** Snapshot of streams with queued bytes, for the scheduler. */
  schedulerStreams(): RuntimePortTunnelSchedulerStream[] {
    const out: RuntimePortTunnelSchedulerStream[] = []
    for (const [streamId, queuedBytes] of this.streamQueued) {
      if (queuedBytes > 0) {
        out.push({ streamId, queuedBytes })
      }
    }
    return out
  }

  peekNextType(streamId: number): 'data' | 'control' | null {
    const list = this.items.get(streamId)
    if (!list || list.length === 0) {
      return null
    }
    return list[0].type
  }

  queuedBytesFor(streamId: number): number {
    return this.streamQueued.get(streamId) ?? 0
  }

  /** Per-stream queue limit; exposed so the channel can pause upstream at
   *  the same threshold the queue uses to reject enqueue. */
  maxStreamBytes(): number {
    return this.maxStreamQueuedBytes
  }

  channelQueuedBytesTotal(): number {
    return this.channelQueuedBytes
  }

  /** Drop all queued bytes for a stream (used on reset/close). */
  dropStream(streamId: number): void {
    const queued = this.streamQueued.get(streamId) ?? 0
    this.channelQueuedBytes = Math.max(0, this.channelQueuedBytes - queued)
    this.streamQueued.delete(streamId)
    this.items.delete(streamId)
  }

  clear(): void {
    this.streamQueued.clear()
    this.items.clear()
    this.channelQueuedBytes = 0
  }

  /** Total streams with any queued bytes. Exposed for tests. */
  streamsQueued(): number {
    let count = 0
    for (const queued of this.streamQueued.values()) {
      if (queued > 0) {
        count += 1
      }
    }
    return count
  }
}
