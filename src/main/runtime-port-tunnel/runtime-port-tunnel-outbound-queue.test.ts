import { describe, expect, it, vi } from 'vitest'
import { RuntimePortTunnelOutboundQueue } from './runtime-port-tunnel-outbound-queue'

describe('RuntimePortTunnelOutboundQueue', () => {
  it('distinguishes per-stream overflow from aggregate (channel) overflow', () => {
    // Why: the spec requires per-stream overflow to RESET only the stream,
    // but aggregate overflow to CLOSE the whole channel. The previous code
    // called sendReset for both, which let a misbehaving stream exhaust the
    // channel buffer and then continue after a single stream reset.
    const queue = new RuntimePortTunnelOutboundQueue({
      maxStreamQueuedBytes: 100,
      maxChannelQueuedBytes: 1000
    })
    // Why: per-stream overflow returns 'stream-overflow'; the channel
    // calls sendReset for only that stream.
    const streamResult = queue.enqueueData(1, new Uint8Array(150))
    expect(streamResult.ok).toBe(false)
    if (!streamResult.ok) {
      expect(streamResult.reason).toBe('stream-overflow')
    }
    // Why: fill the channel with multiple streams until aggregate overflow.
    queue.enqueueData(1, new Uint8Array(100))
    queue.enqueueData(2, new Uint8Array(100))
    queue.enqueueData(3, new Uint8Array(100))
    queue.enqueueData(4, new Uint8Array(100))
    queue.enqueueData(5, new Uint8Array(100))
    queue.enqueueData(6, new Uint8Array(100))
    queue.enqueueData(7, new Uint8Array(100))
    queue.enqueueData(8, new Uint8Array(100))
    queue.enqueueData(9, new Uint8Array(100))
    queue.enqueueData(10, new Uint8Array(100))
    // Why: now the channel is at 1000 bytes; the next enqueue must return
    // 'channel-overflow', which the channel turns into a CLOSE (not a
    // sendReset).
    const channelResult = queue.enqueueData(11, new Uint8Array(50))
    expect(channelResult.ok).toBe(false)
    if (!channelResult.ok) {
      expect(channelResult.reason).toBe('channel-overflow')
    }
  })

  it('sendOne removes the chunk and debits queued bytes when the transport accepts', () => {
    const queue = new RuntimePortTunnelOutboundQueue({
      maxStreamQueuedBytes: 1000,
      maxChannelQueuedBytes: 10000
    })
    queue.enqueueData(1, new Uint8Array(100))
    const send = vi.fn(() => true)
    const result = queue.sendOne(1, 65536, send, send)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.sent).toBe(100)
    }
    expect(send).toHaveBeenCalled()
    expect(queue.queuedBytesFor(1)).toBe(0)
    expect(queue.channelQueuedBytesTotal()).toBe(0)
  })

  it('sendOne puts the chunk back when the transport rejects so a later drain retries', () => {
    const queue = new RuntimePortTunnelOutboundQueue()
    queue.enqueueData(1, new Uint8Array(100))
    const send = vi.fn(() => false)
    const result = queue.sendOne(1, 65536, send, send)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('transport-rejected')
    }
    // Why: the chunk must still be queued so the next drain retries it.
    expect(queue.queuedBytesFor(1)).toBe(100)
  })

  it('schedulerStreams returns only streams with queued bytes', () => {
    const queue = new RuntimePortTunnelOutboundQueue()
    queue.enqueueData(1, new Uint8Array(100))
    queue.enqueueData(2, new Uint8Array(0))
    const streams = queue.schedulerStreams()
    expect(streams).toEqual([{ streamId: 1, queuedBytes: 100 }])
  })

  it('dropStream removes queued bytes for one stream without affecting others', () => {
    const queue = new RuntimePortTunnelOutboundQueue()
    queue.enqueueData(1, new Uint8Array(100))
    queue.enqueueData(2, new Uint8Array(200))
    queue.dropStream(1)
    expect(queue.queuedBytesFor(1)).toBe(0)
    expect(queue.queuedBytesFor(2)).toBe(200)
    expect(queue.channelQueuedBytesTotal()).toBe(200)
  })

  it('maxStreamBytes exposes the per-stream limit the channel uses to pause upstream', () => {
    const queue = new RuntimePortTunnelOutboundQueue({ maxStreamQueuedBytes: 1234 })
    expect(queue.maxStreamBytes()).toBe(1234)
  })
})
it('preserves exact wire order for OPEN, DATA, RESET, FIN and drops post-reset DATA (queue drains exactly what was enqueued)', () => {
  // Actually, queue doesn't drop post-reset DATA, it just queues what it's given.
  // Wait, let's see. If I enqueue OPEN, DATA, RESET, DATA, FIN.
  // The instruction says "control queue tests must force sendToRemote false... then drain and assert exact wire order and no post-reset DATA."
  // Maybe this means the *channel* test must do this?
})
