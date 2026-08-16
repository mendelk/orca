// Workspace port tunnel binary protocol — Stage 1 shared codec and state
// primitives. See
// docs/superpowers/specs/2026-08-15-paired-runtime-direct-browser-design.md.
//
// This is a separate capability-gated E2EE channel, not a terminal stream
// opcode: it does not bump RUNTIME_PROTOCOL_VERSION and is only used after the
// runtime advertises WORKSPACE_PORT_TUNNEL_RUNTIME_CAPABILITY. Opcode numbers
// are permanent (see remote-wire-compatibility.md Rule 2): a shipped number
// cannot be reused even if the feature behind it is removed.

export { WORKSPACE_PORT_TUNNEL_RUNTIME_CAPABILITY } from './protocol-version'

// Header layout (10 bytes):
//   byte 0      protocol version (1)
//   byte 1      opcode
//   bytes 2-5   unsigned stream id, big endian
//   bytes 6-9   payload length, big endian
//   bytes 10..  payload
const WORKSPACE_PORT_TUNNEL_PROTOCOL_VERSION = 1
const HEADER_BYTES = 10
const MAX_PAYLOAD_BYTES_V1 = 64 * 1024
const MAX_STREAM_ID = 0xffffffff

// Permanent v1 opcodes. Numbers are part of the wire contract and must not be
// reused or renumbered.
export enum WorkspacePortTunnelOpcode {
  Authorize = 1,
  Authorized = 2,
  AuthorizeError = 3,
  Open = 4,
  Opened = 5,
  OpenError = 6,
  Data = 7,
  Fin = 8,
  Reset = 9,
  WindowUpdate = 10,
  Ping = 11,
  Pong = 12
}

export type WorkspacePortTunnelOpcodeDirection = 'client-to-runtime' | 'runtime-to-client' | 'both'

const OPCODE_DIRECTION: Record<WorkspacePortTunnelOpcode, WorkspacePortTunnelOpcodeDirection> = {
  [WorkspacePortTunnelOpcode.Authorize]: 'client-to-runtime',
  [WorkspacePortTunnelOpcode.Authorized]: 'runtime-to-client',
  [WorkspacePortTunnelOpcode.AuthorizeError]: 'runtime-to-client',
  [WorkspacePortTunnelOpcode.Open]: 'client-to-runtime',
  [WorkspacePortTunnelOpcode.Opened]: 'runtime-to-client',
  [WorkspacePortTunnelOpcode.OpenError]: 'runtime-to-client',
  [WorkspacePortTunnelOpcode.Data]: 'both',
  [WorkspacePortTunnelOpcode.Fin]: 'both',
  [WorkspacePortTunnelOpcode.Reset]: 'both',
  [WorkspacePortTunnelOpcode.WindowUpdate]: 'both',
  [WorkspacePortTunnelOpcode.Ping]: 'both',
  [WorkspacePortTunnelOpcode.Pong]: 'both'
}

const OPCODES_REQUIRING_VALID_STREAM_ID = new Set<WorkspacePortTunnelOpcode>([
  WorkspacePortTunnelOpcode.Open,
  WorkspacePortTunnelOpcode.Opened,
  WorkspacePortTunnelOpcode.OpenError,
  WorkspacePortTunnelOpcode.Data,
  WorkspacePortTunnelOpcode.Fin,
  WorkspacePortTunnelOpcode.Reset,
  WorkspacePortTunnelOpcode.WindowUpdate
])

const OPCODES_USING_STREAM_ID_ZERO = new Set<WorkspacePortTunnelOpcode>([
  WorkspacePortTunnelOpcode.Authorize,
  WorkspacePortTunnelOpcode.Authorized,
  WorkspacePortTunnelOpcode.AuthorizeError,
  WorkspacePortTunnelOpcode.Ping,
  WorkspacePortTunnelOpcode.Pong
])

// Protocol bounds exported for runtime/desktop handlers and tests.
export const WORKSPACE_PORT_TUNNEL_HEADER_BYTES = HEADER_BYTES
export const WORKSPACE_PORT_TUNNEL_PROTOCOL_VERSION_1 = WORKSPACE_PORT_TUNNEL_PROTOCOL_VERSION
export const WORKSPACE_PORT_TUNNEL_MAX_PAYLOAD_BYTES = MAX_PAYLOAD_BYTES_V1
export const WORKSPACE_PORT_TUNNEL_MAX_STREAM_ID = MAX_STREAM_ID
export const WORKSPACE_PORT_TUNNEL_MAX_ACTIVE_STREAMS_PER_CHANNEL = 64
export const WORKSPACE_PORT_TUNNEL_MAX_AUTHORIZED_ENDPOINTS_PER_CHANNEL = 64
export const WORKSPACE_PORT_TUNNEL_MAX_ACTIVE_BROWSER_LEASES_PER_CHANNEL = 32
export const WORKSPACE_PORT_TUNNEL_INITIAL_STREAM_RECEIVE_WINDOW_BYTES = 256 * 1024
export const WORKSPACE_PORT_TUNNEL_MAX_CHANNEL_QUEUED_BYTES = 16 * 1024 * 1024
export const WORKSPACE_PORT_TUNNEL_MAX_STREAM_QUEUED_BYTES = 1024 * 1024
// WINDOW_UPDATE payload is a single big-endian uint32 credit increment.
export const WORKSPACE_PORT_TUNNEL_WINDOW_UPDATE_PAYLOAD_BYTES = 4
// OPEN / OPENED carry a single big-endian uint32 endpoint id. OPENED reuses the
// endpoint id field; OPEN_ERROR carries a 1-byte error code.
export const WORKSPACE_PORT_TUNNEL_OPEN_PAYLOAD_BYTES = 4
export const WORKSPACE_PORT_TUNNEL_OPENED_PAYLOAD_BYTES = 4
export const WORKSPACE_PORT_TUNNEL_OPEN_ERROR_PAYLOAD_BYTES = 5
// AUTHORIZE carries a big-endian uint32 grant-length followed by the opaque
// grant id bytes. AUTHORIZED carries a big-endian uint32 count followed by that
// many big-endian uint32 endpoint ids. AUTHORIZE_ERROR carries a 1-byte code.
export const WORKSPACE_PORT_TUNNEL_AUTHORIZE_ERROR_PAYLOAD_BYTES = 1
export const WORKSPACE_PORT_TUNNEL_MAX_GRANT_ID_BYTES = 256
export const WORKSPACE_PORT_TUNNEL_MAX_AUTHORIZED_ENDPOINT_IDS =
  WORKSPACE_PORT_TUNNEL_MAX_AUTHORIZED_ENDPOINTS_PER_CHANNEL

export type WorkspacePortTunnelFrame = {
  version: number
  opcode: WorkspacePortTunnelOpcode
  streamId: number
  payload: Uint8Array
}

export type WorkspacePortTunnelDecodeFailure =
  | { kind: 'truncated' }
  | { kind: 'unsupported-version'; version: number }
  | { kind: 'unknown-opcode'; opcode: number }
  | { kind: 'oversized-payload'; declared: number }
  | { kind: 'length-mismatch'; declared: number; actual: number }
  | { kind: 'invalid-stream-id'; opcode: WorkspacePortTunnelOpcode; streamId: number }
  | { kind: 'invalid-payload-size'; opcode: WorkspacePortTunnelOpcode; declared: number }

export type WorkspacePortTunnelDecodeResult =
  | { ok: true; frame: WorkspacePortTunnelFrame }
  | { ok: false; failure: WorkspacePortTunnelDecodeFailure }

export function encodeWorkspacePortTunnelFrame(frame: {
  opcode: WorkspacePortTunnelOpcode
  streamId: number
  payload: Uint8Array
}): Uint8Array {
  if (!Number.isInteger(frame.streamId) || frame.streamId < 0 || frame.streamId > MAX_STREAM_ID) {
    throw new RangeError('workspace port tunnel stream id out of range')
  }
  if (frame.payload.byteLength > MAX_PAYLOAD_BYTES_V1) {
    throw new RangeError('workspace port tunnel payload exceeds v1 maximum')
  }
  if (!isWorkspacePortTunnelOpcode(frame.opcode)) {
    throw new RangeError('workspace port tunnel opcode is unknown')
  }
  if (validateStreamIdForOpcode(frame.opcode, frame.streamId)) {
    throw new RangeError('workspace port tunnel stream id is invalid for opcode')
  }
  if (validatePayloadSizeForOpcode(frame.opcode, frame.payload.byteLength)) {
    throw new RangeError('workspace port tunnel payload size is invalid for opcode')
  }
  const out = new Uint8Array(HEADER_BYTES + frame.payload.byteLength)
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
  view.setUint8(0, WORKSPACE_PORT_TUNNEL_PROTOCOL_VERSION)
  view.setUint8(1, frame.opcode)
  view.setUint32(2, frame.streamId, false)
  view.setUint32(6, frame.payload.byteLength, false)
  if (frame.payload.byteLength > 0) {
    out.set(frame.payload, HEADER_BYTES)
  }
  return out
}

export function decodeWorkspacePortTunnelFrame(bytes: Uint8Array): WorkspacePortTunnelFrame | null {
  const result = decodeWorkspacePortTunnelFrameDetailed(bytes)
  return result.ok ? result.frame : null
}

// Detailed decoder used by channel handlers to apply the spec's per-failure
// policy: invalid framing / unsupported version / unknown opcode close the
// whole channel; an unknown endpoint or invalid state transitions reset only
// the offending stream. The simple `decodeWorkspacePortTunnelFrame` keeps the
// round-trip ergonomics of the existing terminal-stream codec.
export function decodeWorkspacePortTunnelFrameDetailed(
  bytes: Uint8Array
): WorkspacePortTunnelDecodeResult {
  if (bytes.byteLength < HEADER_BYTES) {
    return { ok: false, failure: { kind: 'truncated' } }
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const version = view.getUint8(0)
  if (version !== WORKSPACE_PORT_TUNNEL_PROTOCOL_VERSION) {
    return { ok: false, failure: { kind: 'unsupported-version', version } }
  }
  const opcodeByte = view.getUint8(1)
  if (!isWorkspacePortTunnelOpcode(opcodeByte)) {
    return { ok: false, failure: { kind: 'unknown-opcode', opcode: opcodeByte } }
  }
  const opcode = opcodeByte as WorkspacePortTunnelOpcode
  const streamId = view.getUint32(2, false)
  const declared = view.getUint32(6, false)
  if (declared > MAX_PAYLOAD_BYTES_V1) {
    return { ok: false, failure: { kind: 'oversized-payload', declared } }
  }
  const actual = bytes.byteLength - HEADER_BYTES
  if (declared !== actual) {
    return { ok: false, failure: { kind: 'length-mismatch', declared, actual } }
  }
  const payload = bytes.subarray(HEADER_BYTES, HEADER_BYTES + declared)
  const streamIdFailure = validateStreamIdForOpcode(opcode, streamId)
  if (streamIdFailure) {
    return { ok: false, failure: streamIdFailure }
  }
  const payloadSizeFailure = validatePayloadSizeForOpcode(opcode, declared)
  if (payloadSizeFailure) {
    return { ok: false, failure: payloadSizeFailure }
  }
  return {
    ok: true,
    frame: { version, opcode, streamId, payload }
  }
}

function validateStreamIdForOpcode(
  opcode: WorkspacePortTunnelOpcode,
  streamId: number
): WorkspacePortTunnelDecodeFailure | null {
  if (OPCODES_REQUIRING_VALID_STREAM_ID.has(opcode)) {
    if (streamId === 0) {
      return { kind: 'invalid-stream-id', opcode, streamId }
    }
    return null
  }
  if (OPCODES_USING_STREAM_ID_ZERO.has(opcode)) {
    if (streamId !== 0) {
      return { kind: 'invalid-stream-id', opcode, streamId }
    }
    return null
  }
  return null
}

function validatePayloadSizeForOpcode(
  opcode: WorkspacePortTunnelOpcode,
  declared: number
): WorkspacePortTunnelDecodeFailure | null {
  switch (opcode) {
    case WorkspacePortTunnelOpcode.WindowUpdate:
      if (declared !== WORKSPACE_PORT_TUNNEL_WINDOW_UPDATE_PAYLOAD_BYTES) {
        return { kind: 'invalid-payload-size', opcode, declared }
      }
      return null
    case WorkspacePortTunnelOpcode.Open:
      if (declared !== WORKSPACE_PORT_TUNNEL_OPEN_PAYLOAD_BYTES) {
        return { kind: 'invalid-payload-size', opcode, declared }
      }
      return null
    case WorkspacePortTunnelOpcode.Opened:
      if (declared !== WORKSPACE_PORT_TUNNEL_OPENED_PAYLOAD_BYTES) {
        return { kind: 'invalid-payload-size', opcode, declared }
      }
      return null
    case WorkspacePortTunnelOpcode.OpenError:
      if (declared !== WORKSPACE_PORT_TUNNEL_OPEN_ERROR_PAYLOAD_BYTES) {
        return { kind: 'invalid-payload-size', opcode, declared }
      }
      return null
    case WorkspacePortTunnelOpcode.AuthorizeError:
      if (declared !== WORKSPACE_PORT_TUNNEL_AUTHORIZE_ERROR_PAYLOAD_BYTES) {
        return { kind: 'invalid-payload-size', opcode, declared }
      }
      return null
    case WorkspacePortTunnelOpcode.Ping:
    case WorkspacePortTunnelOpcode.Pong:
    case WorkspacePortTunnelOpcode.Fin:
    case WorkspacePortTunnelOpcode.Reset:
      if (declared !== 0) {
        return { kind: 'invalid-payload-size', opcode, declared }
      }
      return null
    case WorkspacePortTunnelOpcode.Data:
      // DATA may carry 0..MAX_PAYLOAD_BYTES_V1 bytes (a zero-length DATA is
      // odd but harmless and stays within bounds).
      if (declared > MAX_PAYLOAD_BYTES_V1) {
        return { kind: 'oversized-payload', declared }
      }
      return null
    case WorkspacePortTunnelOpcode.Authorize:
    case WorkspacePortTunnelOpcode.Authorized:
      // Variable-length; bounded by MAX_PAYLOAD_BYTES_V1 and decoded by the
      // dedicated helpers below.
      return null
  }
}

function isWorkspacePortTunnelOpcode(value: number): value is WorkspacePortTunnelOpcode {
  switch (value) {
    case WorkspacePortTunnelOpcode.Authorize:
    case WorkspacePortTunnelOpcode.Authorized:
    case WorkspacePortTunnelOpcode.AuthorizeError:
    case WorkspacePortTunnelOpcode.Open:
    case WorkspacePortTunnelOpcode.Opened:
    case WorkspacePortTunnelOpcode.OpenError:
    case WorkspacePortTunnelOpcode.Data:
    case WorkspacePortTunnelOpcode.Fin:
    case WorkspacePortTunnelOpcode.Reset:
    case WorkspacePortTunnelOpcode.WindowUpdate:
    case WorkspacePortTunnelOpcode.Ping:
    case WorkspacePortTunnelOpcode.Pong:
      return true
    default:
      return false
  }
}

export function workspacePortTunnelOpcodeDirection(
  opcode: WorkspacePortTunnelOpcode
): WorkspacePortTunnelOpcodeDirection {
  return OPCODE_DIRECTION[opcode]
}

// Payload helpers, error codes, and stream state primitives live in companion
// modules so this codec file stays under the max-lines ratchet. Re-exported
// here for a single import surface.
export {
  WorkspacePortTunnelErrorCode,
  decodeWorkspacePortTunnelAuthorizeErrorPayload,
  decodeWorkspacePortTunnelAuthorizePayload,
  decodeWorkspacePortTunnelAuthorizedPayload,
  decodeWorkspacePortTunnelEndpointId,
  decodeWorkspacePortTunnelOpenErrorPayload,
  decodeWorkspacePortTunnelWindowUpdatePayload,
  encodeWorkspacePortTunnelAuthorizeErrorPayload,
  encodeWorkspacePortTunnelAuthorizePayload,
  encodeWorkspacePortTunnelAuthorizedPayload,
  encodeWorkspacePortTunnelEndpointId,
  encodeWorkspacePortTunnelOpenErrorPayload,
  encodeWorkspacePortTunnelWindowUpdatePayload,
  isWorkspacePortTunnelErrorCode,
  type WorkspacePortTunnelAuthorizePayload,
  type WorkspacePortTunnelAuthorizedPayload
} from './workspace-port-tunnel-payloads'
export {
  WorkspacePortTunnelStreamRegistry,
  type WorkspacePortTunnelStreamPhase,
  type WorkspacePortTunnelStreamRegistryMutationResult,
  type WorkspacePortTunnelStreamRegistryOverflow,
  type WorkspacePortTunnelStreamState
} from './workspace-port-tunnel-stream-registry'
