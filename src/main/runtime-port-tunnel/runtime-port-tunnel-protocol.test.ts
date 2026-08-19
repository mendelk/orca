import { describe, it, expect, vi } from 'vitest'
import { RuntimePortTunnelProtocol } from './runtime-port-tunnel-protocol'
import {
  WorkspacePortTunnelOpcode,
  encodeWorkspacePortTunnelFrame,
  encodeWorkspacePortTunnelEndpointId
} from '../../shared/workspace-port-tunnel-protocol'

describe('RuntimePortTunnelProtocol', () => {
  it('encodes OPEN and emits opened when the peer acknowledges', () => {
    const protocol = new RuntimePortTunnelProtocol()
    const onOpened = vi.fn()
    protocol.on('opened', onOpened)

    const openFrame = protocol.encodeOpen(1, 42)
    expect(openFrame).toBeDefined()
    expect(protocol.registry.get(1)?.phase).toBe('opening')

    const openedFrame = encodeWorkspacePortTunnelFrame({
      opcode: WorkspacePortTunnelOpcode.Opened,
      streamId: 1,
      payload: encodeWorkspacePortTunnelEndpointId(42)
    })
    protocol.handleIncomingData(openedFrame)
    expect(onOpened).toHaveBeenCalledWith({ streamId: 1, endpointId: 42 })
    expect(protocol.registry.get(1)?.phase).toBe('open')
  })

  describe('sendPing / sendPong zero-payload (v1 protocol-correct)', () => {
    // Why: v1 requires PING/PONG to carry zero payload. The previous
    // encoder accepted a payload argument even though the encoder throws
    // on non-zero payload, so callers would silently construct invalid
    // frames. The API must not accept a payload.
    it('encodePing produces a zero-payload PING frame', () => {
      const protocol = new RuntimePortTunnelProtocol()
      const frame = protocol.encodePing()
      const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
      expect(view.getUint8(1)).toBe(WorkspacePortTunnelOpcode.Ping)
      expect(view.getUint32(6, false)).toBe(0)
    })

    it('encodePong produces a zero-payload PONG frame', () => {
      const protocol = new RuntimePortTunnelProtocol()
      const frame = protocol.encodePong()
      const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
      expect(view.getUint8(1)).toBe(WorkspacePortTunnelOpcode.Pong)
      expect(view.getUint32(6, false)).toBe(0)
    })

    it('encodePing does not accept a payload argument (protocol-correct API)', () => {
      const protocol = new RuntimePortTunnelProtocol()
      // Why: the API takes no arguments; the previous code defaulted to an
      // empty payload but still allowed a caller to pass a non-empty one,
      // which the encoder would reject at runtime. The signature must
      // refuse any payload.
      // @ts-expect-error — encodePing takes no arguments
      protocol.encodePing(new Uint8Array([1, 2, 3]))
      // Why: even if a caller forces it through, the frame must still be
      // zero-payload because the encoder rejects non-zero payload. The
      // above call should fail to typecheck, proving the API is fixed.
      const frame = protocol.encodePing()
      expect(frame.byteLength).toBe(10)
    })

    it('emits ping with no payload when a zero-payload PING arrives', () => {
      const protocol = new RuntimePortTunnelProtocol()
      const onPing = vi.fn()
      protocol.on('ping', onPing)
      const pingFrame = encodeWorkspacePortTunnelFrame({
        opcode: WorkspacePortTunnelOpcode.Ping,
        streamId: 0,
        payload: new Uint8Array(0)
      })
      protocol.handleIncomingData(pingFrame)
      expect(onPing).toHaveBeenCalledOnce()
      // Why: the handler receives no payload argument; v1 PING is zero-payload.
      expect(onPing.mock.calls[0]).toHaveLength(0)
    })

    it('emits pong with no payload when a zero-payload PONG arrives', () => {
      const protocol = new RuntimePortTunnelProtocol()
      const onPong = vi.fn()
      protocol.on('pong', onPong)
      const pongFrame = encodeWorkspacePortTunnelFrame({
        opcode: WorkspacePortTunnelOpcode.Pong,
        streamId: 0,
        payload: new Uint8Array(0)
      })
      protocol.handleIncomingData(pongFrame)
      expect(onPong).toHaveBeenCalledOnce()
      expect(onPong.mock.calls[0]).toHaveLength(0)
    })
  })

  describe('DATA for unknown or invalid-phase streams emits resetStream', () => {
    // Why: the previous code silently dropped DATA for unknown or
    // remote-half-closed streams. The protocol contract requires a raw
    // RESET back instead of a silent drop.
    it('emits resetStream with reason unknown-stream when DATA arrives for an unknown stream', () => {
      const protocol = new RuntimePortTunnelProtocol()
      const onResetStream = vi.fn()
      protocol.on('resetStream', onResetStream)
      const dataFrame = encodeWorkspacePortTunnelFrame({
        opcode: WorkspacePortTunnelOpcode.Data,
        streamId: 99,
        payload: new Uint8Array([1, 2, 3])
      })
      protocol.handleIncomingData(dataFrame)
      expect(onResetStream).toHaveBeenCalledWith({
        streamId: 99,
        reason: 'unknown-stream'
      })
    })

    it('emits resetStream with reason invalid-phase when DATA arrives for a remote-half-closed stream', () => {
      const protocol = new RuntimePortTunnelProtocol()
      const onResetStream = vi.fn()
      protocol.on('resetStream', onResetStream)
      const onData = vi.fn()
      protocol.on('data', onData)
      // Why: open the stream then half-close remote (peer sent FIN); DATA
      // after that is a violation.
      protocol.encodeOpen(1, 42)
      const finFrame = encodeWorkspacePortTunnelFrame({
        opcode: WorkspacePortTunnelOpcode.Fin,
        streamId: 1,
        payload: new Uint8Array(0)
      })
      protocol.handleIncomingData(finFrame)
      const dataFrame = encodeWorkspacePortTunnelFrame({
        opcode: WorkspacePortTunnelOpcode.Data,
        streamId: 1,
        payload: new Uint8Array([1])
      })
      protocol.handleIncomingData(dataFrame)
      expect(onResetStream).toHaveBeenCalledWith({
        streamId: 1,
        reason: 'invalid-phase'
      })
      expect(onData).not.toHaveBeenCalled()
    })

    it('emits data normally for an open stream', () => {
      const protocol = new RuntimePortTunnelProtocol()
      const onData = vi.fn()
      const onResetStream = vi.fn()
      protocol.on('data', onData)
      protocol.on('resetStream', onResetStream)
      protocol.encodeOpen(1, 42)
      const openedFrame = encodeWorkspacePortTunnelFrame({
        opcode: WorkspacePortTunnelOpcode.Opened,
        streamId: 1,
        payload: encodeWorkspacePortTunnelEndpointId(42)
      })
      protocol.handleIncomingData(openedFrame)
      const dataFrame = encodeWorkspacePortTunnelFrame({
        opcode: WorkspacePortTunnelOpcode.Data,
        streamId: 1,
        payload: new Uint8Array([1, 2, 3])
      })
      protocol.handleIncomingData(dataFrame)
      expect(onData).toHaveBeenCalledWith({ streamId: 1, data: new Uint8Array([1, 2, 3]) })
      expect(onResetStream).not.toHaveBeenCalled()
    })

    it('encodeRawReset produces a RESET frame without touching the registry', () => {
      // Why: a raw RESET in response to a protocol violation must not
      // mutate the registry because the offending stream may already be
      // gone. encodeReset mutates; encodeRawReset does not.
      const protocol = new RuntimePortTunnelProtocol()
      protocol.encodeOpen(1, 42)
      expect(protocol.registry.get(1)?.phase).toBe('opening')
      const frame = protocol.encodeRawReset(1)
      // Why: registry still has the stream because encodeRawReset does not
      // touch it.
      expect(protocol.registry.get(1)?.phase).toBe('opening')
      const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
      expect(view.getUint8(1)).toBe(WorkspacePortTunnelOpcode.Reset)
    })

    it('encodeReset mutates the registry (graceful reset we initiate)', () => {
      const protocol = new RuntimePortTunnelProtocol()
      protocol.encodeOpen(1, 42)
      expect(protocol.registry.get(1)?.phase).toBe('opening')
      protocol.encodeReset(1)
      expect(protocol.registry.get(1)).toBeUndefined()
    })
  })
})
