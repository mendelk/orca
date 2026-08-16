// Workspace port tunnel payload helpers — Stage 1.
//
// Companion to workspace-port-tunnel-protocol.ts. That file holds the binary
// frame codec, opcodes, and bounds; this file holds the typed payload
// encoders/decoders for the variable and fixed-size opcodes (AUTHORIZE,
// AUTHORIZED, AUTHORIZE_ERROR, OPEN, OPENED, OPEN_ERROR, WINDOW_UPDATE).
//
// See docs/superpowers/specs/2026-08-15-paired-runtime-direct-browser-design.md.

import {
  WORKSPACE_PORT_TUNNEL_MAX_AUTHORIZED_ENDPOINT_IDS,
  WORKSPACE_PORT_TUNNEL_MAX_GRANT_ID_BYTES,
  WORKSPACE_PORT_TUNNEL_MAX_STREAM_ID,
  WORKSPACE_PORT_TUNNEL_OPEN_ERROR_PAYLOAD_BYTES
} from './workspace-port-tunnel-protocol'

const STREAM_ID_BYTES = 4
const LENGTH_BYTES = 4

// Bounded, content-free error codes for OPEN_ERROR and AUTHORIZE_ERROR.
export enum WorkspacePortTunnelErrorCode {
  // OPEN_ERROR codes (runtime -> client).
  ConnectRefused = 1,
  ConnectTimeout = 2,
  EndpointUnknown = 3,
  EndpointNotAuthorized = 4,
  // AUTHORIZE_ERROR codes (runtime -> client).
  GrantExpired = 5,
  GrantReplayed = 6,
  GrantMismatched = 7,
  // Shared.
  InternalError = 8,
  ChannelClosed = 9
}

export function isWorkspacePortTunnelErrorCode(
  value: number
): value is WorkspacePortTunnelErrorCode {
  switch (value) {
    case WorkspacePortTunnelErrorCode.ConnectRefused:
    case WorkspacePortTunnelErrorCode.ConnectTimeout:
    case WorkspacePortTunnelErrorCode.EndpointUnknown:
    case WorkspacePortTunnelErrorCode.EndpointNotAuthorized:
    case WorkspacePortTunnelErrorCode.GrantExpired:
    case WorkspacePortTunnelErrorCode.GrantReplayed:
    case WorkspacePortTunnelErrorCode.GrantMismatched:
    case WorkspacePortTunnelErrorCode.InternalError:
    case WorkspacePortTunnelErrorCode.ChannelClosed:
      return true
    default:
      return false
  }
}

export type WorkspacePortTunnelAuthorizePayload = {
  grantId: Uint8Array
}

export function encodeWorkspacePortTunnelAuthorizePayload(
  payload: WorkspacePortTunnelAuthorizePayload
): Uint8Array {
  if (
    payload.grantId.byteLength === 0 ||
    payload.grantId.byteLength > WORKSPACE_PORT_TUNNEL_MAX_GRANT_ID_BYTES
  ) {
    throw new RangeError('workspace port tunnel grant id exceeds bound')
  }
  const out = new Uint8Array(STREAM_ID_BYTES + payload.grantId.byteLength)
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
  view.setUint32(0, payload.grantId.byteLength, false)
  if (payload.grantId.byteLength > 0) {
    out.set(payload.grantId, STREAM_ID_BYTES)
  }
  return out
}

export function decodeWorkspacePortTunnelAuthorizePayload(
  payload: Uint8Array
): WorkspacePortTunnelAuthorizePayload | null {
  if (payload.byteLength < STREAM_ID_BYTES) {
    return null
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  const grantLength = view.getUint32(0, false)
  if (grantLength === 0 || grantLength > WORKSPACE_PORT_TUNNEL_MAX_GRANT_ID_BYTES) {
    return null
  }
  if (STREAM_ID_BYTES + grantLength !== payload.byteLength) {
    return null
  }
  return { grantId: payload.subarray(STREAM_ID_BYTES, STREAM_ID_BYTES + grantLength) }
}

export type WorkspacePortTunnelAuthorizedPayload = {
  endpointIds: number[]
}

export function encodeWorkspacePortTunnelAuthorizedPayload(
  payload: WorkspacePortTunnelAuthorizedPayload
): Uint8Array {
  if (payload.endpointIds.length > WORKSPACE_PORT_TUNNEL_MAX_AUTHORIZED_ENDPOINT_IDS) {
    throw new RangeError('workspace port tunnel authorized endpoint count exceeds bound')
  }
  const out = new Uint8Array(STREAM_ID_BYTES + payload.endpointIds.length * STREAM_ID_BYTES)
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
  view.setUint32(0, payload.endpointIds.length, false)
  for (let i = 0; i < payload.endpointIds.length; i += 1) {
    const id = payload.endpointIds[i]
    if (!Number.isInteger(id) || id < 0 || id > WORKSPACE_PORT_TUNNEL_MAX_STREAM_ID) {
      throw new RangeError('workspace port tunnel endpoint id out of range')
    }
    view.setUint32(STREAM_ID_BYTES + i * STREAM_ID_BYTES, id, false)
  }
  return out
}

export function decodeWorkspacePortTunnelAuthorizedPayload(
  payload: Uint8Array
): WorkspacePortTunnelAuthorizedPayload | null {
  if (payload.byteLength < STREAM_ID_BYTES) {
    return null
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  const count = view.getUint32(0, false)
  if (count > WORKSPACE_PORT_TUNNEL_MAX_AUTHORIZED_ENDPOINT_IDS) {
    return null
  }
  const expected = STREAM_ID_BYTES + count * STREAM_ID_BYTES
  if (expected !== payload.byteLength) {
    return null
  }
  const endpointIds: number[] = []
  for (let i = 0; i < count; i += 1) {
    endpointIds.push(view.getUint32(STREAM_ID_BYTES + i * STREAM_ID_BYTES, false))
  }
  return { endpointIds }
}

export function encodeWorkspacePortTunnelEndpointId(endpointId: number): Uint8Array {
  if (
    !Number.isInteger(endpointId) ||
    endpointId < 0 ||
    endpointId > WORKSPACE_PORT_TUNNEL_MAX_STREAM_ID
  ) {
    throw new RangeError('workspace port tunnel endpoint id out of range')
  }
  const out = new Uint8Array(STREAM_ID_BYTES)
  new DataView(out.buffer, out.byteOffset, out.byteLength).setUint32(0, endpointId, false)
  return out
}

export function decodeWorkspacePortTunnelEndpointId(payload: Uint8Array): number | null {
  if (payload.byteLength !== STREAM_ID_BYTES) {
    return null
  }
  return new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(0, false)
}

export function encodeWorkspacePortTunnelOpenErrorPayload(
  endpointId: number,
  errorCode: WorkspacePortTunnelErrorCode
): Uint8Array {
  const endpointBytes = encodeWorkspacePortTunnelEndpointId(endpointId)
  const out = new Uint8Array(endpointBytes.byteLength + 1)
  out.set(endpointBytes, 0)
  out[endpointBytes.byteLength] = errorCode
  return out
}

export function decodeWorkspacePortTunnelOpenErrorPayload(
  payload: Uint8Array
): { endpointId: number; errorCode: WorkspacePortTunnelErrorCode } | null {
  if (payload.byteLength !== WORKSPACE_PORT_TUNNEL_OPEN_ERROR_PAYLOAD_BYTES) {
    return null
  }
  const endpointId = decodeWorkspacePortTunnelEndpointId(payload.subarray(0, STREAM_ID_BYTES))
  if (endpointId === null) {
    return null
  }
  const errorCodeByte = payload[STREAM_ID_BYTES]
  if (!isWorkspacePortTunnelErrorCode(errorCodeByte)) {
    return null
  }
  return { endpointId, errorCode: errorCodeByte }
}

export function encodeWorkspacePortTunnelAuthorizeErrorPayload(
  errorCode: WorkspacePortTunnelErrorCode
): Uint8Array {
  const out = new Uint8Array(1)
  out[0] = errorCode
  return out
}

export function decodeWorkspacePortTunnelAuthorizeErrorPayload(
  payload: Uint8Array
): WorkspacePortTunnelErrorCode | null {
  if (payload.byteLength !== 1) {
    return null
  }
  const code = payload[0]
  return isWorkspacePortTunnelErrorCode(code) ? code : null
}

export function encodeWorkspacePortTunnelWindowUpdatePayload(creditBytes: number): Uint8Array {
  if (
    !Number.isInteger(creditBytes) ||
    creditBytes <= 0 ||
    creditBytes > WORKSPACE_PORT_TUNNEL_MAX_STREAM_ID
  ) {
    throw new RangeError('workspace port tunnel window update credit out of range')
  }
  const out = new Uint8Array(LENGTH_BYTES)
  new DataView(out.buffer, out.byteOffset, out.byteLength).setUint32(0, creditBytes, false)
  return out
}

export function decodeWorkspacePortTunnelWindowUpdatePayload(payload: Uint8Array): number | null {
  if (payload.byteLength !== LENGTH_BYTES) {
    return null
  }
  const credit = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(
    0,
    false
  )
  return credit === 0 ? null : credit
}
