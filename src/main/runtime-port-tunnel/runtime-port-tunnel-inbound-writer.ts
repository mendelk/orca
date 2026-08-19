// Inbound DATA writer for the workspace port tunnel channel.
//
// Companion to runtime-port-tunnel-channel.ts. The channel receives DATA
// frames from the peer and writes them to the local TCP socket bound to the
// forwarded port. This module tracks the peer's *remaining receive window*
// so a malicious or buggy peer cannot exceed the 256 KiB initial window
// before sending a WINDOW_UPDATE.
//
// Why a dedicated writer: the previous channel wrote inbound DATA straight
// to the socket and emitted a WINDOW_UPDATE for every accepted chunk, but it
// never tracked how much credit it had actually granted the peer. A peer
// that ignored the window and kept sending DATA could push 256 KiB + N more
// bytes through before the next WINDOW_UPDATE was due. The credit here is
// decremented by the number of bytes actually accepted by write/drain, and
// only replenished when a WINDOW_UPDATE is sent back to the peer.

import { WORKSPACE_PORT_TUNNEL_INITIAL_STREAM_RECEIVE_WINDOW_BYTES } from '../../shared/workspace-port-tunnel-protocol'

export type RuntimePortTunnelInboundWriterOptions = {
  /** Called with inbound bytes that passed the window check. Returns true if drained, false if buffered. */
  write: (data: Uint8Array) => boolean
  /**
   * Called when the channel should send a WINDOW_UPDATE to the peer. The
   * channel supplies the stream id and the writer supplies the credit it
   * actually wants to replenish (never more than was accepted).
   */
  sendWindowUpdate: (credit: number) => void
  /** Initial per-stream receive window; defaults to the protocol value. */
  initialWindow?: number
  /**
   * Optional high-watermark: when remaining credit drops at or below this
   * threshold, the writer proactively asks the channel to emit a
   * WINDOW_UPDATE instead of waiting for the next drain tick.
   */
  refillThreshold?: number
}

export type RuntimePortTunnelInboundWriteResult =
  | { ok: true; accepted: number }
  | {
      ok: false
      reason: 'credit-violation'
      streamId: number
      attempted: number
      available: number
    }

export class RuntimePortTunnelInboundWriter {
  private remaining: number
  private readonly initialWindow: number
  private readonly write: (data: Uint8Array) => boolean
  private readonly sendWindowUpdate: (credit: number) => void
  private readonly refillThreshold: number
  private streamId: number | null = null
  private creditReplenished = 0
  private pendingBytes = 0

  constructor(options: RuntimePortTunnelInboundWriterOptions) {
    this.initialWindow =
      options.initialWindow ?? WORKSPACE_PORT_TUNNEL_INITIAL_STREAM_RECEIVE_WINDOW_BYTES
    this.remaining = this.initialWindow
    this.write = options.write
    this.sendWindowUpdate = options.sendWindowUpdate
    this.refillThreshold = options.refillThreshold ?? Math.floor(this.initialWindow / 2)
  }

  /** Bind the writer to a stream id; called once when the stream opens. */
  bindStream(streamId: number): void {
    this.streamId = streamId
    this.remaining = this.initialWindow
    this.creditReplenished = 0
    this.pendingBytes = 0
  }

  /**
   * Accept inbound bytes for the bound stream. Rejects when the peer has
   * exceeded the remaining receive window — the channel must RESET the
   * stream in that case, not silently drop the bytes. Only the bytes the
   * underlying write actually accepted count against credit.
   */
  writeData(data: Uint8Array): RuntimePortTunnelInboundWriteResult {
    if (this.streamId === null) {
      return {
        ok: false,
        reason: 'credit-violation',
        streamId: -1,
        attempted: data.byteLength,
        available: 0
      }
    }
    if (data.byteLength > this.remaining) {
      // Why: a peer that exceeds the window is violating the protocol; the
      // channel resets the stream rather than dropping the frame silently.
      return {
        ok: false,
        reason: 'credit-violation',
        streamId: this.streamId,
        attempted: data.byteLength,
        available: this.remaining
      }
    }
    const drained = this.write(data)
    this.remaining -= data.byteLength
    if (drained) {
      this.creditReplenished += data.byteLength
      if (this.remaining <= this.refillThreshold) {
        this.refill()
      }
    } else {
      this.pendingBytes += data.byteLength
    }
    return { ok: true, accepted: data.byteLength }
  }

  notifyDrained(): void {
    if (this.pendingBytes > 0) {
      this.creditReplenished += this.pendingBytes
      this.pendingBytes = 0
      if (this.remaining <= this.refillThreshold) {
        this.refill()
      }
    }
  }

  /**
   * Replenish credit by sending a WINDOW_UPDATE for the bytes actually
   * accepted since the last refill. Called automatically when remaining
   * credit drops to the threshold, and may be called explicitly on drain.
   */
  refill(): void {
    if (this.creditReplenished <= 0) {
      return
    }
    this.sendWindowUpdate(this.creditReplenished)
    this.remaining += this.creditReplenished
    this.creditReplenished = 0
  }

  /** Bytes the peer may still send before a WINDOW_UPDATE is required. */
  remainingCredit(): number {
    return this.remaining
  }

  /** True when the bound stream is over its credit budget. Exposed for tests. */
  isOverBudget(attempted: number): boolean {
    return attempted > this.remaining
  }

  /** Called when a stream resets/closes so the writer can drop state. */
  unbindStream(): void {
    this.streamId = null
    this.remaining = this.initialWindow
    this.creditReplenished = 0
    this.pendingBytes = 0
  }
}
