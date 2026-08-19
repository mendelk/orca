import {
  decodeWorkspacePortTunnelAuthorizePayload,
  decodeWorkspacePortTunnelEndpointId,
  decodeWorkspacePortTunnelWindowUpdatePayload,
  encodeWorkspacePortTunnelAuthorizeErrorPayload,
  encodeWorkspacePortTunnelAuthorizedPayload,
  encodeWorkspacePortTunnelEndpointId,
  WorkspacePortTunnelOpcode,
  type WorkspacePortTunnelFrame
} from '../../shared/workspace-port-tunnel-protocol'
import { WorkspacePortTunnelErrorCode } from '../../shared/workspace-port-tunnel-payloads'
import {
  encodeOpenErrorFrame,
  encodeWindowUpdateFrame,
  type QueuedOutboundFrame
} from './workspace-port-tunnel-session-outbound'

// Why: split from the session module to stay under the max-lines ratchet.
// Frame decoding helpers and the per-opcode result type. The session keeps
// the policy; this module turns wire bytes into typed decisions the session
// can act on without re-decoding payloads.

export type DecodedClientFrame =
  | { kind: 'authorize'; grantId: string }
  | { kind: 'open'; streamId: number; endpointId: number }
  | { kind: 'data'; streamId: number; payload: Uint8Array }
  | { kind: 'fin'; streamId: number }
  | { kind: 'reset'; streamId: number }
  | { kind: 'window-update'; streamId: number; credit: number }
  | { kind: 'ping' }
  | { kind: 'pong' }
  | { kind: 'runtime-to-client-only'; opcode: WorkspacePortTunnelOpcode }
  | { kind: 'invalid-payload'; opcode: WorkspacePortTunnelOpcode }

export function decodeClientFrame(frame: WorkspacePortTunnelFrame): DecodedClientFrame {
  switch (frame.opcode) {
    case WorkspacePortTunnelOpcode.Authorize: {
      const authorize = decodeWorkspacePortTunnelAuthorizePayload(frame.payload)
      if (!authorize) {
        return { kind: 'invalid-payload', opcode: frame.opcode }
      }
      return { kind: 'authorize', grantId: Buffer.from(authorize.grantId).toString('utf8') }
    }
    case WorkspacePortTunnelOpcode.Open: {
      const endpointId = decodeWorkspacePortTunnelEndpointId(frame.payload)
      if (endpointId === null) {
        return { kind: 'invalid-payload', opcode: frame.opcode }
      }
      return { kind: 'open', streamId: frame.streamId, endpointId }
    }
    case WorkspacePortTunnelOpcode.Data:
      return { kind: 'data', streamId: frame.streamId, payload: frame.payload }
    case WorkspacePortTunnelOpcode.Fin:
      return { kind: 'fin', streamId: frame.streamId }
    case WorkspacePortTunnelOpcode.Reset:
      return { kind: 'reset', streamId: frame.streamId }
    case WorkspacePortTunnelOpcode.WindowUpdate: {
      const credit = decodeWorkspacePortTunnelWindowUpdatePayload(frame.payload)
      if (credit === null) {
        return { kind: 'invalid-payload', opcode: frame.opcode }
      }
      return { kind: 'window-update', streamId: frame.streamId, credit }
    }
    case WorkspacePortTunnelOpcode.Ping:
      return { kind: 'ping' }
    case WorkspacePortTunnelOpcode.Pong:
      return { kind: 'pong' }
    case WorkspacePortTunnelOpcode.Opened:
    case WorkspacePortTunnelOpcode.OpenError:
    case WorkspacePortTunnelOpcode.Authorized:
    case WorkspacePortTunnelOpcode.AuthorizeError:
      return { kind: 'runtime-to-client-only', opcode: frame.opcode }
  }
}

export type GrantErrorKind =
  | 'grant_not_found'
  | 'grant_expired'
  | 'grant_already_consumed'
  | 'device_mismatch'
  | 'runtime_mismatch'
  | 'workspace_mismatch'
  | 'endpoint_not_authorized'
  | 'invalid_request'
  | 'workspace_not_found'
  | 'no_eligible_endpoints'
  | 'too_many_endpoints'
  | 'duplicate_endpoint'
  | 'grant_capacity_reached'
  | 'mobile_scope_denied'
  | 'runtime_scope_required'
  | 'feature_disabled'
  | 'scan_unavailable'
  | 'runtime_stopped'
  | 'device_unpaired'

export function mapGrantErrorToAuthorizeErrorCode(
  error: GrantErrorKind
): WorkspacePortTunnelErrorCode {
  switch (error) {
    case 'grant_not_found':
    case 'grant_expired':
      return WorkspacePortTunnelErrorCode.GrantExpired
    case 'grant_already_consumed':
      return WorkspacePortTunnelErrorCode.GrantReplayed
    case 'device_mismatch':
    case 'runtime_mismatch':
    case 'workspace_mismatch':
    case 'device_unpaired':
    case 'duplicate_endpoint':
    case 'endpoint_not_authorized':
    case 'feature_disabled':
    case 'grant_capacity_reached':
    case 'invalid_request':
    case 'mobile_scope_denied':
    case 'no_eligible_endpoints':
    case 'runtime_scope_required':
    case 'runtime_stopped':
    case 'scan_unavailable':
    case 'too_many_endpoints':
    case 'workspace_not_found':
      return WorkspacePortTunnelErrorCode.GrantMismatched
  }
}

export function buildAuthorizeErrorFrame(
  errorCode: WorkspacePortTunnelErrorCode
): QueuedOutboundFrame {
  return {
    streamId: 0,
    opcode: WorkspacePortTunnelOpcode.AuthorizeError,
    payload: encodeWorkspacePortTunnelAuthorizeErrorPayload(errorCode)
  }
}

export function buildAuthorizedFrame(mergedEndpointIds: number[]): QueuedOutboundFrame {
  return {
    streamId: 0,
    opcode: WorkspacePortTunnelOpcode.Authorized,
    payload: encodeWorkspacePortTunnelAuthorizedPayload({ endpointIds: mergedEndpointIds })
  }
}

export function buildOpenedFrame(streamId: number, endpointId: number): QueuedOutboundFrame {
  return {
    streamId,
    opcode: WorkspacePortTunnelOpcode.Opened,
    payload: encodeWorkspacePortTunnelEndpointId(endpointId)
  }
}

export function buildResetFrame(streamId: number): QueuedOutboundFrame {
  return { streamId, opcode: WorkspacePortTunnelOpcode.Reset, payload: new Uint8Array() }
}

export function buildFinFrame(streamId: number): QueuedOutboundFrame {
  return { streamId, opcode: WorkspacePortTunnelOpcode.Fin, payload: new Uint8Array() }
}

export function buildPongFrame(): QueuedOutboundFrame {
  return { streamId: 0, opcode: WorkspacePortTunnelOpcode.Pong, payload: new Uint8Array() }
}

export { encodeOpenErrorFrame, encodeWindowUpdateFrame }
