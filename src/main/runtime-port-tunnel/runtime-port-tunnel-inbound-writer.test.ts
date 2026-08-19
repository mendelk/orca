import { describe, expect, it, vi } from 'vitest'
import {
  RuntimePortTunnelInboundWriter,
  type RuntimePortTunnelInboundWriterOptions
} from './runtime-port-tunnel-inbound-writer'
import { WORKSPACE_PORT_TUNNEL_INITIAL_STREAM_RECEIVE_WINDOW_BYTES } from '../../shared/workspace-port-tunnel-protocol'

function makeWriter(overrides: Partial<RuntimePortTunnelInboundWriterOptions> = {}): {
  writer: RuntimePortTunnelInboundWriter
  write: ReturnType<typeof vi.fn>
  sendWindowUpdate: ReturnType<typeof vi.fn>
} {
  const write = vi.fn((_data: Uint8Array) => true)
  const sendWindowUpdate = vi.fn()
  const writer = new RuntimePortTunnelInboundWriter({
    write,
    sendWindowUpdate,
    ...overrides
  })
  return { writer, write, sendWindowUpdate }
}

describe('RuntimePortTunnelInboundWriter', () => {
  it('rejects DATA that exceeds the peer receive window', () => {
    const { writer } = makeWriter({ initialWindow: 100 })
    writer.bindStream(7)
    const result = writer.writeData(new Uint8Array(150))
    expect(result.ok).toBe(false)
  })

  it('only debits credit for bytes the underlying write actually accepted', () => {
    // Why: a buffered write does not replenish credit immediately.
    const write = vi.fn((_data: Uint8Array) => false)
    const sendWindowUpdate = vi.fn()
    const writer = new RuntimePortTunnelInboundWriter({
      write,
      sendWindowUpdate,
      initialWindow: 100,
      refillThreshold: 10
    })
    writer.bindStream(1)
    const result = writer.writeData(new Uint8Array(80))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.accepted).toBe(80)
    }
    expect(writer.remainingCredit()).toBe(20) // Credit is debited
    expect(sendWindowUpdate).not.toHaveBeenCalled() // But not replenished
  })

  it('replenishes credit only for bytes actually accepted by write/drain', () => {
    const write = vi.fn((_data: Uint8Array) => true)
    const sendWindowUpdate = vi.fn()
    const writer = new RuntimePortTunnelInboundWriter({
      write,
      sendWindowUpdate,
      initialWindow: 1000,
      refillThreshold: 400
    })
    writer.bindStream(1)
    writer.writeData(new Uint8Array(600))
    expect(sendWindowUpdate).toHaveBeenCalledWith(600)
    expect(writer.remainingCredit()).toBe(1000)
  })

  it('does not replenish credit when the underlying write buffers, but does on drain', () => {
    const write = vi.fn(() => false)
    const sendWindowUpdate = vi.fn()
    const writer = new RuntimePortTunnelInboundWriter({
      write,
      sendWindowUpdate,
      initialWindow: 100,
      refillThreshold: 10
    })
    writer.bindStream(1)
    const result = writer.writeData(new Uint8Array(95))
    expect(result.ok).toBe(true)
    expect(writer.remainingCredit()).toBe(5)
    expect(sendWindowUpdate).not.toHaveBeenCalled()
    writer.notifyDrained()
    expect(sendWindowUpdate).toHaveBeenCalledWith(95)
    expect(writer.remainingCredit()).toBe(100)
  })

  it('defaults to the protocol initial receive window', () => {
    const { writer } = makeWriter()
    writer.bindStream(1)
    expect(writer.remainingCredit()).toBe(WORKSPACE_PORT_TUNNEL_INITIAL_STREAM_RECEIVE_WINDOW_BYTES)
  })

  it('isOverBudget reports whether an attempted write would violate the window', () => {
    const { writer } = makeWriter({ initialWindow: 100 })
    writer.bindStream(1)
    expect(writer.isOverBudget(50)).toBe(false)
    expect(writer.isOverBudget(101)).toBe(true)
  })

  it('unbindStream resets credit so the writer can be reused for a new stream', () => {
    const { writer } = makeWriter({ initialWindow: 100, refillThreshold: 10 })
    writer.bindStream(1)
    writer.writeData(new Uint8Array(50))
    expect(writer.remainingCredit()).toBe(50)
    writer.unbindStream()
    expect(writer.remainingCredit()).toBe(100)
  })

  it('rejects DATA when no stream is bound', () => {
    const { writer } = makeWriter()
    const result = writer.writeData(new Uint8Array(10))
    expect(result.ok).toBe(false)
  })

  it('refill does nothing when no bytes have been accepted since the last refill', () => {
    const { writer, sendWindowUpdate } = makeWriter({ initialWindow: 100 })
    writer.bindStream(1)
    writer.refill()
    expect(sendWindowUpdate).not.toHaveBeenCalled()
  })
})
