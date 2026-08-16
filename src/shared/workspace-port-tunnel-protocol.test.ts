import { describe, expect, it } from 'vitest'
import {
  WORKSPACE_PORT_TUNNEL_AUTHORIZE_ERROR_PAYLOAD_BYTES,
  WORKSPACE_PORT_TUNNEL_HEADER_BYTES,
  WORKSPACE_PORT_TUNNEL_MAX_ACTIVE_STREAMS_PER_CHANNEL,
  WORKSPACE_PORT_TUNNEL_MAX_AUTHORIZED_ENDPOINT_IDS,
  WORKSPACE_PORT_TUNNEL_MAX_CHANNEL_QUEUED_BYTES,
  WORKSPACE_PORT_TUNNEL_MAX_GRANT_ID_BYTES,
  WORKSPACE_PORT_TUNNEL_MAX_PAYLOAD_BYTES,
  WORKSPACE_PORT_TUNNEL_MAX_STREAM_QUEUED_BYTES,
  WORKSPACE_PORT_TUNNEL_OPEN_ERROR_PAYLOAD_BYTES,
  WORKSPACE_PORT_TUNNEL_OPEN_PAYLOAD_BYTES,
  WORKSPACE_PORT_TUNNEL_OPENED_PAYLOAD_BYTES,
  WORKSPACE_PORT_TUNNEL_PROTOCOL_VERSION_1,
  WORKSPACE_PORT_TUNNEL_WINDOW_UPDATE_PAYLOAD_BYTES,
  WORKSPACE_PORT_TUNNEL_RUNTIME_CAPABILITY,
  WorkspacePortTunnelErrorCode,
  WorkspacePortTunnelOpcode,
  WorkspacePortTunnelStreamRegistry,
  decodeWorkspacePortTunnelAuthorizeErrorPayload,
  decodeWorkspacePortTunnelAuthorizePayload,
  decodeWorkspacePortTunnelAuthorizedPayload,
  decodeWorkspacePortTunnelEndpointId,
  decodeWorkspacePortTunnelFrame,
  decodeWorkspacePortTunnelFrameDetailed,
  decodeWorkspacePortTunnelOpenErrorPayload,
  decodeWorkspacePortTunnelWindowUpdatePayload,
  encodeWorkspacePortTunnelAuthorizeErrorPayload,
  encodeWorkspacePortTunnelAuthorizePayload,
  encodeWorkspacePortTunnelAuthorizedPayload,
  encodeWorkspacePortTunnelEndpointId,
  encodeWorkspacePortTunnelFrame,
  encodeWorkspacePortTunnelOpenErrorPayload,
  encodeWorkspacePortTunnelWindowUpdatePayload,
  workspacePortTunnelOpcodeDirection
} from './workspace-port-tunnel-protocol'
import { WORKSPACE_PORT_TUNNEL_RUNTIME_CAPABILITY as PROTO_CAP } from './protocol-version'

describe('workspace-port-tunnel-protocol capability', () => {
  it('exports the same capability string from protocol-version and the codec module', () => {
    expect(WORKSPACE_PORT_TUNNEL_RUNTIME_CAPABILITY).toBe('workspace-port-tunnel.v1')
    expect(PROTO_CAP).toBe(WORKSPACE_PORT_TUNNEL_RUNTIME_CAPABILITY)
  })
})

describe('workspace-port-tunnel-protocol frame codec', () => {
  it('round-trips a DATA frame with payload bytes', () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5])
    const encoded = encodeWorkspacePortTunnelFrame({
      opcode: WorkspacePortTunnelOpcode.Data,
      streamId: 42,
      payload
    })

    expect(encoded.byteLength).toBe(WORKSPACE_PORT_TUNNEL_HEADER_BYTES + payload.byteLength)

    const decoded = decodeWorkspacePortTunnelFrame(encoded)
    expect(decoded).not.toBeNull()
    expect(decoded?.version).toBe(WORKSPACE_PORT_TUNNEL_PROTOCOL_VERSION_1)
    expect(decoded?.opcode).toBe(WorkspacePortTunnelOpcode.Data)
    expect(decoded?.streamId).toBe(42)
    expect(decoded?.payload).toEqual(payload)
  })

  it('encodes the header using big-endian stream id and length', () => {
    const encoded = encodeWorkspacePortTunnelFrame({
      opcode: WorkspacePortTunnelOpcode.Data,
      streamId: 0x01020304,
      payload: new Uint8Array(4)
    })
    const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength)
    expect(view.getUint8(0)).toBe(WORKSPACE_PORT_TUNNEL_PROTOCOL_VERSION_1)
    expect(view.getUint8(1)).toBe(WorkspacePortTunnelOpcode.Data)
    expect(view.getUint32(2, false)).toBe(0x01020304)
    expect(view.getUint32(6, false)).toBe(4)
  })

  it('round-trips a zero-payload PING with stream id 0', () => {
    const encoded = encodeWorkspacePortTunnelFrame({
      opcode: WorkspacePortTunnelOpcode.Ping,
      streamId: 0,
      payload: new Uint8Array()
    })
    const decoded = decodeWorkspacePortTunnelFrame(encoded)
    expect(decoded?.opcode).toBe(WorkspacePortTunnelOpcode.Ping)
    expect(decoded?.streamId).toBe(0)
    expect(decoded?.payload.byteLength).toBe(0)
  })

  it('round-trips a FIN frame for half-close', () => {
    const encoded = encodeWorkspacePortTunnelFrame({
      opcode: WorkspacePortTunnelOpcode.Fin,
      streamId: 7,
      payload: new Uint8Array()
    })
    const decoded = decodeWorkspacePortTunnelFrame(encoded)
    expect(decoded?.opcode).toBe(WorkspacePortTunnelOpcode.Fin)
    expect(decoded?.streamId).toBe(7)
  })

  it('round-trips a RESET frame', () => {
    const encoded = encodeWorkspacePortTunnelFrame({
      opcode: WorkspacePortTunnelOpcode.Reset,
      streamId: 9,
      payload: new Uint8Array()
    })
    expect(decodeWorkspacePortTunnelFrame(encoded)?.opcode).toBe(WorkspacePortTunnelOpcode.Reset)
  })

  it('round-trips a WINDOW_UPDATE frame with a credit payload', () => {
    const payload = encodeWorkspacePortTunnelWindowUpdatePayload(64 * 1024)
    expect(payload.byteLength).toBe(WORKSPACE_PORT_TUNNEL_WINDOW_UPDATE_PAYLOAD_BYTES)
    const encoded = encodeWorkspacePortTunnelFrame({
      opcode: WorkspacePortTunnelOpcode.WindowUpdate,
      streamId: 3,
      payload
    })
    const decoded = decodeWorkspacePortTunnelFrame(encoded)
    expect(decoded?.opcode).toBe(WorkspacePortTunnelOpcode.WindowUpdate)
    expect(decodeWorkspacePortTunnelWindowUpdatePayload(decoded!.payload)).toBe(64 * 1024)
  })

  it('round-trips an OPEN frame carrying an endpoint id', () => {
    const payload = encodeWorkspacePortTunnelEndpointId(123)
    expect(payload.byteLength).toBe(WORKSPACE_PORT_TUNNEL_OPEN_PAYLOAD_BYTES)
    const encoded = encodeWorkspacePortTunnelFrame({
      opcode: WorkspacePortTunnelOpcode.Open,
      streamId: 5,
      payload
    })
    const decoded = decodeWorkspacePortTunnelFrame(encoded)
    expect(decoded?.opcode).toBe(WorkspacePortTunnelOpcode.Open)
    expect(decodeWorkspacePortTunnelEndpointId(decoded!.payload)).toBe(123)
  })

  it('round-trips an OPENED frame carrying an endpoint id', () => {
    const payload = encodeWorkspacePortTunnelEndpointId(123)
    expect(payload.byteLength).toBe(WORKSPACE_PORT_TUNNEL_OPENED_PAYLOAD_BYTES)
    const encoded = encodeWorkspacePortTunnelFrame({
      opcode: WorkspacePortTunnelOpcode.Opened,
      streamId: 5,
      payload
    })
    const decoded = decodeWorkspacePortTunnelFrame(encoded)
    expect(decodeWorkspacePortTunnelEndpointId(decoded!.payload)).toBe(123)
  })

  it('round-trips an OPEN_ERROR frame carrying endpoint id and error code', () => {
    const payload = encodeWorkspacePortTunnelOpenErrorPayload(
      7,
      WorkspacePortTunnelErrorCode.ConnectRefused
    )
    expect(payload.byteLength).toBe(WORKSPACE_PORT_TUNNEL_OPEN_ERROR_PAYLOAD_BYTES)
    const encoded = encodeWorkspacePortTunnelFrame({
      opcode: WorkspacePortTunnelOpcode.OpenError,
      streamId: 5,
      payload
    })
    const decoded = decodeWorkspacePortTunnelFrame(encoded)
    expect(decoded?.opcode).toBe(WorkspacePortTunnelOpcode.OpenError)
    expect(decodeWorkspacePortTunnelOpenErrorPayload(decoded!.payload)).toEqual({
      endpointId: 7,
      errorCode: WorkspacePortTunnelErrorCode.ConnectRefused
    })
  })

  it('round-trips AUTHORIZE / AUTHORIZED / AUTHORIZE_ERROR payloads', () => {
    const grantId = new Uint8Array([0xde, 0xad, 0xbe, 0xef])
    const authorize = encodeWorkspacePortTunnelFrame({
      opcode: WorkspacePortTunnelOpcode.Authorize,
      streamId: 0,
      payload: encodeWorkspacePortTunnelAuthorizePayload({ grantId })
    })
    const decodedAuthorize = decodeWorkspacePortTunnelFrame(authorize)
    expect(decodedAuthorize?.opcode).toBe(WorkspacePortTunnelOpcode.Authorize)
    expect(decodedAuthorize?.streamId).toBe(0)
    expect(decodeWorkspacePortTunnelAuthorizePayload(decodedAuthorize!.payload)).toEqual({
      grantId
    })

    const endpointIds = [1, 2, 3]
    const authorized = encodeWorkspacePortTunnelFrame({
      opcode: WorkspacePortTunnelOpcode.Authorized,
      streamId: 0,
      payload: encodeWorkspacePortTunnelAuthorizedPayload({ endpointIds })
    })
    const decodedAuthorized = decodeWorkspacePortTunnelFrame(authorized)
    expect(decodedAuthorized?.opcode).toBe(WorkspacePortTunnelOpcode.Authorized)
    expect(decodeWorkspacePortTunnelAuthorizedPayload(decodedAuthorized!.payload)).toEqual({
      endpointIds
    })

    const authorizeError = encodeWorkspacePortTunnelFrame({
      opcode: WorkspacePortTunnelOpcode.AuthorizeError,
      streamId: 0,
      payload: encodeWorkspacePortTunnelAuthorizeErrorPayload(
        WorkspacePortTunnelErrorCode.GrantExpired
      )
    })
    const decodedError = decodeWorkspacePortTunnelFrame(authorizeError)
    expect(decodedError?.opcode).toBe(WorkspacePortTunnelOpcode.AuthorizeError)
    expect(decodeWorkspacePortTunnelAuthorizeErrorPayload(decodedError!.payload)).toBe(
      WorkspacePortTunnelErrorCode.GrantExpired
    )
  })

  it('rejects a truncated frame shorter than the header', () => {
    const result = decodeWorkspacePortTunnelFrameDetailed(new Uint8Array([1, 7, 0, 0]))
    expect(result.ok).toBe(false)
    expect(result.ok ? null : result.failure.kind).toBe('truncated')
  })

  it('rejects an unsupported protocol version', () => {
    const encoded = encodeWorkspacePortTunnelFrame({
      opcode: WorkspacePortTunnelOpcode.Ping,
      streamId: 0,
      payload: new Uint8Array()
    })
    encoded[0] = 2
    const result = decodeWorkspacePortTunnelFrameDetailed(encoded)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.failure.kind).toBe('unsupported-version')
      expect((result.failure as { version: number }).version).toBe(2)
    }
  })

  it('rejects an unknown opcode', () => {
    const encoded = encodeWorkspacePortTunnelFrame({
      opcode: WorkspacePortTunnelOpcode.Ping,
      streamId: 0,
      payload: new Uint8Array()
    })
    encoded[1] = 99
    const result = decodeWorkspacePortTunnelFrameDetailed(encoded)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.failure.kind).toBe('unknown-opcode')
    }
  })

  it('rejects a declared payload length larger than the v1 maximum', () => {
    const encoded = new Uint8Array(WORKSPACE_PORT_TUNNEL_HEADER_BYTES)
    const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength)
    view.setUint8(0, WORKSPACE_PORT_TUNNEL_PROTOCOL_VERSION_1)
    view.setUint8(1, WorkspacePortTunnelOpcode.Data)
    view.setUint32(2, 1, false)
    view.setUint32(6, WORKSPACE_PORT_TUNNEL_MAX_PAYLOAD_BYTES + 1, false)
    const result = decodeWorkspacePortTunnelFrameDetailed(encoded)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.failure.kind).toBe('oversized-payload')
    }
  })

  it('rejects a declared payload length that exceeds the provided bytes', () => {
    const encoded = new Uint8Array(WORKSPACE_PORT_TUNNEL_HEADER_BYTES + 1)
    const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength)
    view.setUint8(0, WORKSPACE_PORT_TUNNEL_PROTOCOL_VERSION_1)
    view.setUint8(1, WorkspacePortTunnelOpcode.Data)
    view.setUint32(2, 1, false)
    view.setUint32(6, 10, false)
    const result = decodeWorkspacePortTunnelFrameDetailed(encoded)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.failure.kind).toBe('length-mismatch')
    }
  })

  it('rejects bytes trailing the declared payload', () => {
    const encoded = encodeWorkspacePortTunnelFrame({
      opcode: WorkspacePortTunnelOpcode.Data,
      streamId: 1,
      payload: new Uint8Array([1])
    })
    const padded = new Uint8Array(encoded.byteLength + 1)
    padded.set(encoded)
    const result = decodeWorkspacePortTunnelFrameDetailed(padded)
    expect(result.ok).toBe(false)
    expect(result.ok ? null : result.failure.kind).toBe('length-mismatch')
  })

  it('rejects a control frame carrying a nonzero stream id', () => {
    const encoded = encodeWorkspacePortTunnelFrame({
      opcode: WorkspacePortTunnelOpcode.Ping,
      streamId: 0,
      payload: new Uint8Array()
    })
    new DataView(encoded.buffer).setUint32(2, 1, false)
    const result = decodeWorkspacePortTunnelFrameDetailed(encoded)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.failure.kind).toBe('invalid-stream-id')
    }
  })

  it('rejects a per-stream frame carrying stream id 0', () => {
    const encoded = encodeWorkspacePortTunnelFrame({
      opcode: WorkspacePortTunnelOpcode.Open,
      streamId: 1,
      payload: encodeWorkspacePortTunnelEndpointId(1)
    })
    new DataView(encoded.buffer).setUint32(2, 0, false)
    const result = decodeWorkspacePortTunnelFrameDetailed(encoded)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.failure.kind).toBe('invalid-stream-id')
    }
  })

  it('rejects a fixed-size opcode with the wrong payload length', () => {
    const encoded = encodeWorkspacePortTunnelFrame({
      opcode: WorkspacePortTunnelOpcode.Data,
      streamId: 1,
      payload: new Uint8Array(2)
    })
    encoded[1] = WorkspacePortTunnelOpcode.WindowUpdate
    const result = decodeWorkspacePortTunnelFrameDetailed(encoded)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.failure.kind).toBe('invalid-payload-size')
    }
  })

  it('rejects a PING frame that carries a payload', () => {
    const encoded = encodeWorkspacePortTunnelFrame({
      opcode: WorkspacePortTunnelOpcode.Data,
      streamId: 1,
      payload: new Uint8Array(1)
    })
    encoded[1] = WorkspacePortTunnelOpcode.Ping
    new DataView(encoded.buffer).setUint32(2, 0, false)
    const result = decodeWorkspacePortTunnelFrameDetailed(encoded)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.failure.kind).toBe('invalid-payload-size')
    }
  })

  it('decodeWorkspacePortTunnelFrame returns null for any failure', () => {
    expect(decodeWorkspacePortTunnelFrame(new Uint8Array(4))).toBeNull()
    const bad = encodeWorkspacePortTunnelFrame({
      opcode: WorkspacePortTunnelOpcode.Ping,
      streamId: 0,
      payload: new Uint8Array()
    })
    bad[0] = 9
    expect(decodeWorkspacePortTunnelFrame(bad)).toBeNull()
  })

  it('encodeWorkspacePortTunnelFrame rejects an out-of-range stream id', () => {
    expect(() =>
      encodeWorkspacePortTunnelFrame({
        opcode: WorkspacePortTunnelOpcode.Ping,
        streamId: -1,
        payload: new Uint8Array()
      })
    ).toThrow(RangeError)
    expect(() =>
      encodeWorkspacePortTunnelFrame({
        opcode: WorkspacePortTunnelOpcode.Ping,
        streamId: 0x100000000,
        payload: new Uint8Array()
      })
    ).toThrow(RangeError)
  })

  it('encodeWorkspacePortTunnelFrame rejects an oversized payload', () => {
    expect(() =>
      encodeWorkspacePortTunnelFrame({
        opcode: WorkspacePortTunnelOpcode.Data,
        streamId: 1,
        payload: new Uint8Array(WORKSPACE_PORT_TUNNEL_MAX_PAYLOAD_BYTES + 1)
      })
    ).toThrow(RangeError)
  })

  it('encodeWorkspacePortTunnelFrame rejects opcode-specific invalid fields', () => {
    expect(() =>
      encodeWorkspacePortTunnelFrame({
        opcode: WorkspacePortTunnelOpcode.Ping,
        streamId: 1,
        payload: new Uint8Array()
      })
    ).toThrow(RangeError)
    expect(() =>
      encodeWorkspacePortTunnelFrame({
        opcode: WorkspacePortTunnelOpcode.WindowUpdate,
        streamId: 1,
        payload: new Uint8Array(2)
      })
    ).toThrow(RangeError)
  })

  it('exposes the documented opcode directions', () => {
    expect(workspacePortTunnelOpcodeDirection(WorkspacePortTunnelOpcode.Authorize)).toBe(
      'client-to-runtime'
    )
    expect(workspacePortTunnelOpcodeDirection(WorkspacePortTunnelOpcode.Authorized)).toBe(
      'runtime-to-client'
    )
    expect(workspacePortTunnelOpcodeDirection(WorkspacePortTunnelOpcode.Data)).toBe('both')
    expect(workspacePortTunnelOpcodeDirection(WorkspacePortTunnelOpcode.Pong)).toBe('both')
  })
})

describe('workspace-port-tunnel-protocol payload helpers', () => {
  it('round-trips an AUTHORIZE grant id at the size bound', () => {
    const grantId = new Uint8Array(WORKSPACE_PORT_TUNNEL_MAX_GRANT_ID_BYTES)
    const payload = encodeWorkspacePortTunnelAuthorizePayload({ grantId })
    expect(decodeWorkspacePortTunnelAuthorizePayload(payload)).toEqual({ grantId })
  })

  it('rejects an AUTHORIZE payload whose grant length exceeds the bound', () => {
    const tooLarge = new Uint8Array(4 + WORKSPACE_PORT_TUNNEL_MAX_GRANT_ID_BYTES + 1)
    new DataView(tooLarge.buffer).setUint32(0, WORKSPACE_PORT_TUNNEL_MAX_GRANT_ID_BYTES + 1, false)
    expect(decodeWorkspacePortTunnelAuthorizePayload(tooLarge)).toBeNull()
  })

  it('rejects an AUTHORIZE payload whose grant length does not match', () => {
    const payload = new Uint8Array(6)
    new DataView(payload.buffer).setUint32(0, 10, false)
    expect(decodeWorkspacePortTunnelAuthorizePayload(payload)).toBeNull()
  })

  it('rejects an empty AUTHORIZE grant id', () => {
    expect(() => encodeWorkspacePortTunnelAuthorizePayload({ grantId: new Uint8Array() })).toThrow(
      RangeError
    )
    expect(decodeWorkspacePortTunnelAuthorizePayload(new Uint8Array([0, 0, 0, 0]))).toBeNull()
  })

  it('round-trips an AUTHORIZED endpoint id list at the count bound', () => {
    const endpointIds = Array.from(
      { length: WORKSPACE_PORT_TUNNEL_MAX_AUTHORIZED_ENDPOINT_IDS },
      (_, i) => i + 1
    )
    const payload = encodeWorkspacePortTunnelAuthorizedPayload({ endpointIds })
    expect(decodeWorkspacePortTunnelAuthorizedPayload(payload)).toEqual({ endpointIds })
  })

  it('rejects an AUTHORIZED payload whose count exceeds the bound', () => {
    const tooLarge = new Uint8Array(4)
    new DataView(tooLarge.buffer).setUint32(
      0,
      WORKSPACE_PORT_TUNNEL_MAX_AUTHORIZED_ENDPOINT_IDS + 1,
      false
    )
    expect(decodeWorkspacePortTunnelAuthorizedPayload(tooLarge)).toBeNull()
  })

  it('rejects an AUTHORIZED payload with a trailing byte', () => {
    const payload = encodeWorkspacePortTunnelAuthorizedPayload({ endpointIds: [1] })
    const padded = new Uint8Array(payload.byteLength + 1)
    padded.set(payload, 0)
    expect(decodeWorkspacePortTunnelAuthorizedPayload(padded)).toBeNull()
  })

  it('encodeWorkspacePortTunnelAuthorizedPayload rejects out-of-range endpoint ids', () => {
    expect(() => encodeWorkspacePortTunnelAuthorizedPayload({ endpointIds: [-1] })).toThrow(
      RangeError
    )
    expect(() =>
      encodeWorkspacePortTunnelAuthorizedPayload({ endpointIds: [0x100000000] })
    ).toThrow(RangeError)
  })

  it('round-trips a WINDOW_UPDATE credit at the uint32 ceiling', () => {
    const payload = encodeWorkspacePortTunnelWindowUpdatePayload(0xffffffff)
    expect(decodeWorkspacePortTunnelWindowUpdatePayload(payload)).toBe(0xffffffff)
  })

  it('rejects zero, negative, or oversized WINDOW_UPDATE credit', () => {
    expect(() => encodeWorkspacePortTunnelWindowUpdatePayload(0)).toThrow(RangeError)
    expect(() => encodeWorkspacePortTunnelWindowUpdatePayload(-1)).toThrow(RangeError)
    expect(() => encodeWorkspacePortTunnelWindowUpdatePayload(0x100000000)).toThrow(RangeError)
    expect(decodeWorkspacePortTunnelWindowUpdatePayload(new Uint8Array(4))).toBeNull()
  })

  it('decodeWorkspacePortTunnelWindowUpdatePayload rejects wrong sizes', () => {
    expect(decodeWorkspacePortTunnelWindowUpdatePayload(new Uint8Array(0))).toBeNull()
    expect(decodeWorkspacePortTunnelWindowUpdatePayload(new Uint8Array(5))).toBeNull()
  })

  it('decodeWorkspacePortTunnelOpenErrorPayload rejects an invalid error code byte', () => {
    const payload = new Uint8Array(5)
    new DataView(payload.buffer).setUint32(0, 1, false)
    payload[4] = 99
    expect(decodeWorkspacePortTunnelOpenErrorPayload(payload)).toBeNull()
  })

  it('decodeWorkspacePortTunnelEndpointId rejects a wrong payload size', () => {
    expect(decodeWorkspacePortTunnelEndpointId(new Uint8Array(0))).toBeNull()
    expect(decodeWorkspacePortTunnelEndpointId(new Uint8Array(5))).toBeNull()
  })

  it('encodeWorkspacePortTunnelEndpointId rejects out-of-range ids', () => {
    expect(() => encodeWorkspacePortTunnelEndpointId(-1)).toThrow(RangeError)
    expect(() => encodeWorkspacePortTunnelEndpointId(0x100000000)).toThrow(RangeError)
  })

  it('round-trips an AUTHORIZE_ERROR code byte', () => {
    const payload = encodeWorkspacePortTunnelAuthorizeErrorPayload(
      WorkspacePortTunnelErrorCode.GrantReplayed
    )
    expect(payload.byteLength).toBe(WORKSPACE_PORT_TUNNEL_AUTHORIZE_ERROR_PAYLOAD_BYTES)
    expect(decodeWorkspacePortTunnelAuthorizeErrorPayload(payload)).toBe(
      WorkspacePortTunnelErrorCode.GrantReplayed
    )
  })

  it('decodeWorkspacePortTunnelAuthorizeErrorPayload rejects a wrong size or unknown code', () => {
    expect(decodeWorkspacePortTunnelAuthorizeErrorPayload(new Uint8Array(0))).toBeNull()
    expect(decodeWorkspacePortTunnelAuthorizeErrorPayload(new Uint8Array(2))).toBeNull()
    const bad = new Uint8Array(1)
    bad[0] = 99
    expect(decodeWorkspacePortTunnelAuthorizeErrorPayload(bad)).toBeNull()
  })

  it('encodeWorkspacePortTunnelAuthorizePayload rejects an oversized grant id', () => {
    expect(() =>
      encodeWorkspacePortTunnelAuthorizePayload({
        grantId: new Uint8Array(WORKSPACE_PORT_TUNNEL_MAX_GRANT_ID_BYTES + 1)
      })
    ).toThrow(RangeError)
  })

  it('encodeWorkspacePortTunnelAuthorizedPayload rejects an oversized endpoint list', () => {
    expect(() =>
      encodeWorkspacePortTunnelAuthorizedPayload({
        endpointIds: Array.from(
          { length: WORKSPACE_PORT_TUNNEL_MAX_AUTHORIZED_ENDPOINT_IDS + 1 },
          () => 1
        )
      })
    ).toThrow(RangeError)
  })
})

describe('WorkspacePortTunnelStreamRegistry', () => {
  it('opens a stream in the opening phase and marks it opened', () => {
    const registry = new WorkspacePortTunnelStreamRegistry()
    expect(registry.open(1, 100)).toEqual({ ok: true })
    expect(registry.get(1)?.phase).toBe('opening')
    expect(registry.get(1)?.endpointId).toBe(100)
    expect(registry.markOpened(1)).toEqual({ ok: true })
    expect(registry.get(1)?.phase).toBe('open')
  })

  it('refuses to exceed the active stream limit', () => {
    const registry = new WorkspacePortTunnelStreamRegistry({ maxActiveStreams: 2 })
    expect(registry.open(1, 10).ok).toBe(true)
    expect(registry.open(2, 11).ok).toBe(true)
    const result = registry.open(3, 12)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.kind).toBe('stream-limit-exceeded')
      expect((result.error as { limit: number }).limit).toBe(2)
    }
    expect(registry.size()).toBe(2)
    expect(WORKSPACE_PORT_TUNNEL_MAX_ACTIVE_STREAMS_PER_CHANNEL).toBe(64)
  })

  it('refuses duplicate stream ids', () => {
    const registry = new WorkspacePortTunnelStreamRegistry()
    expect(registry.open(1, 10).ok).toBe(true)
    const result = registry.open(1, 11)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.kind).toBe('duplicate-stream')
    }
  })

  it('marks an open error and removes the stream', () => {
    const registry = new WorkspacePortTunnelStreamRegistry()
    registry.open(1, 10)
    expect(registry.markOpenError(1, WorkspacePortTunnelErrorCode.ConnectRefused).ok).toBe(true)
    expect(registry.get(1)).toBeUndefined()
    expect(registry.size()).toBe(0)
  })

  it('half-closes each direction and closes when both sides close', () => {
    const registry = new WorkspacePortTunnelStreamRegistry()
    registry.open(1, 10)
    registry.markOpened(1)
    expect(registry.halfCloseLocal(1).ok).toBe(true)
    expect(registry.get(1)?.phase).toBe('half-closed-local')
    expect(registry.halfCloseRemote(1).ok).toBe(true)
    expect(registry.get(1)).toBeUndefined()
  })

  it('half-close in the other order also closes the stream', () => {
    const registry = new WorkspacePortTunnelStreamRegistry()
    registry.open(1, 10)
    registry.markOpened(1)
    expect(registry.halfCloseRemote(1).ok).toBe(true)
    expect(registry.get(1)?.phase).toBe('half-closed-remote')
    expect(registry.halfCloseLocal(1).ok).toBe(true)
    expect(registry.get(1)).toBeUndefined()
  })

  it('rejects an invalid half-close transition', () => {
    const registry = new WorkspacePortTunnelStreamRegistry()
    registry.open(1, 10)
    const result = registry.halfCloseLocal(1)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.kind).toBe('invalid-transition')
    }
  })

  it('resets a stream and releases its queued bytes', () => {
    const registry = new WorkspacePortTunnelStreamRegistry()
    registry.open(1, 10)
    registry.markOpened(1)
    registry.addQueuedBytes(1, 100)
    expect(registry.channelQueuedBytesTotal()).toBe(100)
    expect(registry.reset(1).ok).toBe(true)
    expect(registry.get(1)).toBeUndefined()
    expect(registry.channelQueuedBytesTotal()).toBe(0)
  })

  it('addQueuedBytes enforces the per-stream queue bound', () => {
    const registry = new WorkspacePortTunnelStreamRegistry({
      maxStreamQueuedBytes: 100,
      maxChannelQueuedBytes: 1000
    })
    registry.open(1, 10)
    registry.markOpened(1)
    expect(registry.addQueuedBytes(1, 50).ok).toBe(true)
    const result = registry.addQueuedBytes(1, 60)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.kind).toBe('stream-queue-overflow')
    }
    expect(WORKSPACE_PORT_TUNNEL_MAX_STREAM_QUEUED_BYTES).toBe(1024 * 1024)
  })

  it('addQueuedBytes enforces the channel queue bound', () => {
    const registry = new WorkspacePortTunnelStreamRegistry({
      maxStreamQueuedBytes: 1000,
      maxChannelQueuedBytes: 100
    })
    registry.open(1, 10)
    registry.markOpened(1)
    registry.addQueuedBytes(1, 60)
    const result = registry.addQueuedBytes(1, 50)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.kind).toBe('channel-queue-overflow')
    }
    expect(WORKSPACE_PORT_TUNNEL_MAX_CHANNEL_QUEUED_BYTES).toBe(16 * 1024 * 1024)
  })

  it('releaseQueuedBytes decrements stream and channel totals and clamps', () => {
    const registry = new WorkspacePortTunnelStreamRegistry()
    registry.open(1, 10)
    registry.markOpened(1)
    registry.addQueuedBytes(1, 100)
    expect(registry.releaseQueuedBytes(1, 40).ok).toBe(true)
    expect(registry.get(1)?.queuedBytes).toBe(60)
    expect(registry.channelQueuedBytesTotal()).toBe(60)
    expect(registry.releaseQueuedBytes(1, 1000).ok).toBe(true)
    expect(registry.get(1)?.queuedBytes).toBe(0)
    expect(registry.channelQueuedBytesTotal()).toBe(0)
  })

  it('applyWindowUpdate increases send credit capped at the uint32 ceiling', () => {
    const registry = new WorkspacePortTunnelStreamRegistry()
    registry.open(1, 10)
    const before = registry.get(1)?.sendCredit
    expect(before).toBe(256 * 1024)
    expect(registry.applyWindowUpdate(1, 100).ok).toBe(true)
    expect(registry.get(1)?.sendCredit).toBe(256 * 1024 + 100)
    expect(registry.applyWindowUpdate(1, 0xffffffff).ok).toBe(true)
    expect(registry.get(1)?.sendCredit).toBe(0xffffffff)
  })

  it('consumeSendCredit decrements credit and refuses underflow', () => {
    const registry = new WorkspacePortTunnelStreamRegistry()
    registry.open(1, 10)
    expect(registry.consumeSendCredit(1, 100).ok).toBe(true)
    expect(registry.get(1)?.sendCredit).toBe(256 * 1024 - 100)
    const result = registry.consumeSendCredit(1, 0xffffffff)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.kind).toBe('send-credit-exhausted')
    }
  })

  it('returns unknown-stream for operations on missing streams', () => {
    const registry = new WorkspacePortTunnelStreamRegistry()
    const cases = [
      registry.markOpened(99),
      registry.halfCloseLocal(99),
      registry.halfCloseRemote(99),
      registry.reset(99),
      registry.addQueuedBytes(99, 1),
      registry.releaseQueuedBytes(99, 1),
      registry.applyWindowUpdate(99, 1),
      registry.consumeSendCredit(99, 1)
    ]
    for (const result of cases) {
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.kind).toBe('unknown-stream')
      }
    }
  })
})
