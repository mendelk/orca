// Outbound drain scheduler for the workspace port tunnel channel.
//
// Companion to runtime-port-tunnel-channel.ts. That module owns sockets and
// frames; this one owns the *drain policy*: how queued outbound bytes are
// pushed onto the encrypted transport without flooding it or starving a
// concurrent stream.
//
// Why a dedicated scheduler: the previous single-shot drain sampled
// transport pressure once before the loop and then sent every queued frame
// in order[0]. With a transport that only accepts one frame per pass, stream
// 1 starved stream 2, and sendToRemote always returned true so the loop kept
// pushing after the first frame even when the transport had gone silent.
//
// The contract here is:
//   - drain() re-samples transport pressure before *every* sent frame and
//     stops the pass as soon as the transport reports it is not writable.
//   - The round-robin cursor is persisted across drain() calls so a one-frame
//     transport window cannot lock out a later stream.
//   - A transport-drain hook lets the channel resume queued data the moment
//     the transport reports it is writable again, without waiting for an
//     unrelated DATA/WINDOW_UPDATE to arrive.

export type RuntimePortTunnelSchedulerStream = {
  streamId: number
  /** Bytes currently queued for this stream waiting to be sent. */
  queuedBytes: number
}

export type RuntimePortTunnelSchedulerTransport = {
  /**
   * Re-sample transport pressure *at this moment*. Must be called before
   * every send because the transport's writable state and bufferedAmount can
   * change between frames. Returns true when at least one more frame may be
   * sent; false when the transport is saturated and the pass must stop.
   */
  canSend: () => boolean
  /** Send one frame for the given stream. Returns true when accepted. */
  send: (stream: RuntimePortTunnelSchedulerStream) => boolean
}

export type RuntimePortTunnelSchedulerOptions = {
  transport: RuntimePortTunnelSchedulerTransport
  /**
   * Called once after the transport reports it cannot accept another frame
   * during a drain pass. The channel registers a transport-drain callback
   * here so queued data resumes the moment the transport drains, without
   * waiting for an unrelated DATA/WINDOW_UPDATE.
   */
  onTransportSaturated?: () => void
  /** Per-pass frame cap; null means keep going until the transport stops. */
  maxFramesPerPass?: number
}

export class RuntimePortTunnelScheduler {
  private cursorStreamId: number | null = null
  private readonly transport: RuntimePortTunnelSchedulerTransport
  private readonly onTransportSaturated?: () => void
  private readonly maxFramesPerPass: number | null
  private saturated = false

  constructor(options: RuntimePortTunnelSchedulerOptions) {
    this.transport = options.transport
    this.onTransportSaturated = options.onTransportSaturated
    this.maxFramesPerPass = options.maxFramesPerPass ?? null
  }

  /**
   * Drain queued streams in round-robin order starting from the persisted
   * cursor. Stops the pass as soon as the transport reports it cannot accept
   * another frame (re-sampled before each send) or the per-pass frame cap is
   * reached. Returns the number of frames actually sent so the caller can
   * decide whether another pass is worthwhile.
   */
  drain(streams: readonly RuntimePortTunnelSchedulerStream[]): number {
    this.saturated = false
    if (streams.length === 0) {
      return 0
    }
    let sent = 0
    const cap = this.maxFramesPerPass
    let startIndex = this.startIndex(streams)
    let didProgress = true
    while (didProgress) {
      didProgress = false
      for (let offset = 0; offset < streams.length; offset += 1) {
        if (cap !== null && sent >= cap) {
          return sent
        }
        // Why: re-sample before every send. Sampling once before the loop let
        // the scheduler keep pushing frames after the transport went silent.
        if (!this.transport.canSend()) {
          this.markSaturated()
          return sent
        }
        const stream = streams[(startIndex + offset) % streams.length]!
        if (stream.queuedBytes <= 0) {
          continue
        }
        const accepted = this.transport.send(stream)
        if (!accepted) {
          this.markSaturated()
          return sent
        }
        sent += 1
        this.cursorStreamId = stream.streamId
        didProgress = true
      }
      // Why: recompute startIndex from the cursor so the next pass continues
      // after the last stream that made progress instead of restarting at 0.
      startIndex = this.startIndex(streams)
    }
    return sent
  }

  /** True when the last drain pass stopped because the transport saturated. */
  isSaturated(): boolean {
    return this.saturated
  }

  /**
   * Called by the channel's transport-drain hook when the transport reports
   * it is writable again. Resets the saturated flag so the next drain pass
   * re-samples from the current cursor instead of trusting a stale state.
   */
  notifyTransportDrained(): void {
    this.saturated = false
  }

  /** The cursor the next drain pass will start from. Exposed for tests. */
  getCursorStreamId(): number | null {
    return this.cursorStreamId
  }

  /** Reset the cursor; used on channel reset/drop. */
  resetCursor(): void {
    this.cursorStreamId = null
    this.saturated = false
  }

  private markSaturated(): void {
    this.saturated = true
    if (this.onTransportSaturated) {
      this.onTransportSaturated()
    }
  }

  private startIndex(streams: readonly RuntimePortTunnelSchedulerStream[]): number {
    if (this.cursorStreamId === null) {
      return 0
    }
    const idx = streams.findIndex((stream) => stream.streamId === this.cursorStreamId)
    if (idx === -1) {
      return 0
    }
    // Why: start *after* the cursor stream so a one-frame transport window
    // advances to the next stream on the next pass instead of re-sending the
    // same stream and starving everyone else.
    return (idx + 1) % streams.length
  }
}
