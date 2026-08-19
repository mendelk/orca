import { describe, expect, it } from 'vitest'
import { RuntimePortTunnelScheduler } from './runtime-port-tunnel-scheduler'

describe('RuntimePortTunnelScheduler', () => {
  it('re-samples transport pressure before every sent frame and stops when saturated', () => {
    // Why: the previous scheduler sampled once before the loop and then
    // sent every queued frame even after the transport went silent. This
    // test forces canSend to flip false after exactly one frame.
    let canSendCalls = 0
    let sendCalls = 0
    const scheduler = new RuntimePortTunnelScheduler({
      transport: {
        canSend: () => {
          canSendCalls += 1
          return canSendCalls <= 1
        },
        send: () => {
          sendCalls += 1
          return true
        }
      }
    })
    const streams = [
      { streamId: 1, queuedBytes: 100 },
      { streamId: 2, queuedBytes: 100 }
    ]
    const sent = scheduler.drain(streams)
    // Why: only one frame is sent because canSend returned false on the
    // second call. The pass stops immediately.
    expect(sent).toBe(1)
    expect(sendCalls).toBe(1)
    expect(scheduler.isSaturated()).toBe(true)
  })

  it('does not flood the transport after the first frame when send returns false', () => {
    // Why: sendToRemote always returned true in the previous code, so the
    // scheduler kept pushing frames after the transport rejected them.
    let sendCalls = 0
    const scheduler = new RuntimePortTunnelScheduler({
      transport: {
        canSend: () => true,
        send: () => {
          sendCalls += 1
          // Why: accept exactly one frame, then reject everything else.
          return sendCalls <= 1
        }
      }
    })
    const streams = [
      { streamId: 1, queuedBytes: 100 },
      { streamId: 2, queuedBytes: 100 },
      { streamId: 3, queuedBytes: 100 }
    ]
    const sent = scheduler.drain(streams)
    // Why: only one frame is counted as sent; the second send call
    // returned false so the pass stopped immediately. send was called
    // twice (once accepted, once rejected) — that is the correct
    // behavior: the scheduler re-samples send before every frame and
    // stops as soon as send returns false.
    expect(sent).toBe(1)
    expect(sendCalls).toBe(2)
    expect(scheduler.isSaturated()).toBe(true)
  })

  it('persists a round-robin cursor across drain calls so one-frame windows do not starve later streams', () => {
    // Why: the previous drain always started order[0], so with a one-frame
    // transport window stream 1 starved stream 2. The cursor must persist
    // across drain calls so the next pass starts after the last stream that
    // made progress.
    const sentStreamIds: number[] = []
    const scheduler = new RuntimePortTunnelScheduler({
      transport: {
        canSend: () => true,
        send: (stream) => {
          sentStreamIds.push(stream.streamId)
          // Why: one frame per pass — the transport only accepts one frame
          // at a time. The next drain call must continue from the cursor.
          return true
        }
      },
      maxFramesPerPass: 1
    })
    const streams = [
      { streamId: 1, queuedBytes: 100 },
      { streamId: 2, queuedBytes: 100 }
    ]
    // Why: three drain calls with a one-frame cap must alternate streams
    // instead of always sending stream 1.
    scheduler.drain(streams)
    scheduler.drain(streams)
    scheduler.drain(streams)
    expect(sentStreamIds).toEqual([1, 2, 1])
  })

  it('the cursor starts after the last progressed stream, not at 0', () => {
    const sentStreamIds: number[] = []
    const scheduler = new RuntimePortTunnelScheduler({
      transport: {
        canSend: () => true,
        send: (stream) => {
          sentStreamIds.push(stream.streamId)
          return true
        }
      },
      maxFramesPerPass: 1
    })
    const streams = [
      { streamId: 10, queuedBytes: 100 },
      { streamId: 20, queuedBytes: 100 },
      { streamId: 30, queuedBytes: 100 }
    ]
    scheduler.drain(streams)
    scheduler.drain(streams)
    scheduler.drain(streams)
    // Why: 10 -> 20 -> 30, not 10 -> 10 -> 10.
    expect(sentStreamIds).toEqual([10, 20, 30])
  })

  it('invokes onTransportSaturated exactly once when the transport saturates', () => {
    let saturatedCalls = 0
    const scheduler = new RuntimePortTunnelScheduler({
      transport: {
        canSend: () => false,
        send: () => true
      },
      onTransportSaturated: () => {
        saturatedCalls += 1
      }
    })
    scheduler.drain([{ streamId: 1, queuedBytes: 100 }])
    expect(saturatedCalls).toBe(1)
    expect(scheduler.isSaturated()).toBe(true)
  })

  it('notifyTransportDrain clears the saturated flag so the next pass re-samples', () => {
    const scheduler = new RuntimePortTunnelScheduler({
      transport: {
        canSend: () => false,
        send: () => true
      }
    })
    scheduler.drain([{ streamId: 1, queuedBytes: 100 }])
    expect(scheduler.isSaturated()).toBe(true)
    // Why: the channel's transport-drain hook calls this when the transport
    // reports it is writable again, without waiting for an unrelated
    // DATA/WINDOW_UPDATE.
    scheduler.notifyTransportDrained()
    expect(scheduler.isSaturated()).toBe(false)
  })

  it('resetCursor clears both the cursor and the saturated flag on channel reset/drop', () => {
    const scheduler = new RuntimePortTunnelScheduler({
      transport: {
        canSend: () => false,
        send: () => true
      },
      maxFramesPerPass: 1
    })
    scheduler.drain([{ streamId: 5, queuedBytes: 100 }])
    expect(scheduler.getCursorStreamId()).toBe(null)
    expect(scheduler.isSaturated()).toBe(true)
    scheduler.resetCursor()
    expect(scheduler.isSaturated()).toBe(false)
  })

  it('returns 0 immediately when there are no streams to drain', () => {
    const scheduler = new RuntimePortTunnelScheduler({
      transport: {
        canSend: () => true,
        send: () => true
      }
    })
    expect(scheduler.drain([])).toBe(0)
  })

  it('skips streams with zero queued bytes', () => {
    const sentStreamIds: number[] = []
    const scheduler = new RuntimePortTunnelScheduler({
      transport: {
        canSend: () => true,
        send: (stream) => {
          sentStreamIds.push(stream.streamId)
          // Why: decrement queuedBytes so the scheduler doesn't loop
          // forever on a mock. In production the channel's sendOne does
          // this via the outbound queue.
          stream.queuedBytes = 0
          return true
        }
      }
    })
    const streams = [
      { streamId: 1, queuedBytes: 0 },
      { streamId: 2, queuedBytes: 100 }
    ]
    scheduler.drain(streams)
    expect(sentStreamIds).toEqual([2])
  })
})
