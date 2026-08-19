import {
  WORKSPACE_PORT_TUNNEL_INITIAL_STREAM_RECEIVE_WINDOW_BYTES,
  WORKSPACE_PORT_TUNNEL_MAX_STREAM_ID
} from '../../shared/workspace-port-tunnel-protocol'

// Why: split from the session module to stay under the max-lines ratchet.
// Ingress flow control: the client sends DATA frames to the runtime; the
// runtime writes them to the loopback socket. The spec gives the client an
// initial 256 KiB receive window per stream and expects the runtime to return
// credit via WINDOW_UPDATE only after the destination socket accepts the bytes
// (write returned true) or after a drain event. The earlier implementation
// never returned WINDOW_UPDATE, so desktop credit permanently exhausted after
// 256 KiB per stream. This module tracks receive credit consumed, produces
// the credit increment to send back, and enforces the 256 KiB receive window
// — a peer that exceeds it gets its stream reset.

export type IngressCreditResult =
  | { ok: true; creditToReturn: number }
  | { ok: false; reason: 'unknown-stream' | 'invalid-byte-count' | 'window-exceeded' }

export type WorkspacePortTunnelIngressCreditOptions = {
  // Why: the runtime caps how much credit it returns per WINDOW_UPDATE so a
  // slow drain does not hand the client an unbounded window. The spec's
  // receive window is per-stream and bounded; we return credit in increments
  // that match what the destination actually accepted.
  maxCreditIncrement?: number
  // Why: the advertised receive window. The client may send up to this many
  // bytes before receiving a WINDOW_UPDATE. Bytes that write() returned false
  // for are tracked as "pending" until drain; they count against the window
  // until credited back.
  receiveWindowBytes?: number
}

type StreamCredit = {
  // Why: total bytes received from the client (counted against the window).
  received: number
  // Why: bytes already credited back to the client via WINDOW_UPDATE.
  credited: number
  // Why: bytes write() returned false for — still in the destination's
  // userland buffer. Tracked so drain can credit them back.
  pendingDrain: number
}

export class WorkspacePortTunnelIngressCredit {
  private readonly streams = new Map<number, StreamCredit>()
  private readonly maxCreditIncrement: number
  private readonly receiveWindowBytes: number

  constructor(options: WorkspacePortTunnelIngressCreditOptions = {}) {
    this.maxCreditIncrement = options.maxCreditIncrement ?? WORKSPACE_PORT_TUNNEL_MAX_STREAM_ID
    this.receiveWindowBytes =
      options.receiveWindowBytes ?? WORKSPACE_PORT_TUNNEL_INITIAL_STREAM_RECEIVE_WINDOW_BYTES
  }

  registerStream(streamId: number): void {
    if (!this.streams.has(streamId)) {
      this.streams.set(streamId, { received: 0, credited: 0, pendingDrain: 0 })
    }
  }

  hasStream(streamId: number): boolean {
    return this.streams.has(streamId)
  }

  // Why: called when the destination socket.write() accepted `bytes` (returned
  // true). The runtime returns credit immediately for accepted writes.
  recordAccepted(streamId: number, bytes: number): IngressCreditResult {
    const sc = this.streams.get(streamId)
    if (!sc) {
      return { ok: false, reason: 'unknown-stream' }
    }
    if (!Number.isInteger(bytes) || bytes <= 0) {
      return { ok: false, reason: 'invalid-byte-count' }
    }
    sc.received += bytes
    // Why: check window BEFORE crediting — a peer that exceeds the advertised
    // receive window gets its stream reset, not more credit.
    if (sc.received - sc.credited > this.receiveWindowBytes) {
      return { ok: false, reason: 'window-exceeded' }
    }
    const credit = Math.min(bytes, this.maxCreditIncrement)
    sc.credited += credit
    return { ok: true, creditToReturn: credit }
  }

  // Why: called when write() returned false — the bytes are buffered in the
  // destination's userland kernel queue. Track them as pending so a later
  // drain can credit them back. Also counts against the receive window.
  recordPending(streamId: number, bytes: number): IngressCreditResult {
    const sc = this.streams.get(streamId)
    if (!sc) {
      return { ok: false, reason: 'unknown-stream' }
    }
    if (!Number.isInteger(bytes) || bytes <= 0) {
      return { ok: false, reason: 'invalid-byte-count' }
    }
    sc.received += bytes
    sc.pendingDrain += bytes
    if (sc.received - sc.credited > this.receiveWindowBytes) {
      return { ok: false, reason: 'window-exceeded' }
    }
    // Why: no credit returned yet — the destination has not accepted these
    // bytes. Credit comes on drain.
    return { ok: true, creditToReturn: 0 }
  }

  // Why: called on destination 'drain' event. Credits back all pending bytes
  // that write() returned false for, returning the credit to send via
  // WINDOW_UPDATE.
  recordDrain(streamId: number): IngressCreditResult {
    const sc = this.streams.get(streamId)
    if (!sc) {
      return { ok: false, reason: 'unknown-stream' }
    }
    if (sc.pendingDrain <= 0) {
      return { ok: true, creditToReturn: 0 }
    }
    const credit = Math.min(sc.pendingDrain, this.maxCreditIncrement)
    sc.credited += credit
    sc.pendingDrain -= credit
    return { ok: true, creditToReturn: credit }
  }

  // Why: returns the number of bytes the client can still send before
  // exceeding the receive window. Used by the session to check before
  // accepting more DATA.
  remainingWindow(streamId: number): number {
    const sc = this.streams.get(streamId)
    if (!sc) {
      return 0
    }
    return Math.max(0, this.receiveWindowBytes - (sc.received - sc.credited))
  }

  removeStream(streamId: number): void {
    this.streams.delete(streamId)
  }

  clear(): void {
    this.streams.clear()
  }

  consumedBytes(streamId: number): number {
    return this.streams.get(streamId)?.received ?? 0
  }

  pendingDrainBytes(streamId: number): number {
    return this.streams.get(streamId)?.pendingDrain ?? 0
  }

  creditedBytes(streamId: number): number {
    return this.streams.get(streamId)?.credited ?? 0
  }
}
