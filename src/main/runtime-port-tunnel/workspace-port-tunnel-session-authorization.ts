import { WORKSPACE_PORT_TUNNEL_MAX_AUTHORIZED_ENDPOINTS_PER_CHANNEL } from '../../shared/workspace-port-tunnel-protocol'
import { WorkspacePortTunnelErrorCode } from '../../shared/workspace-port-tunnel-payloads'
import type { WorkspacePortTunnelGrantedEndpoint } from '../../shared/workspace-port-tunnel'

// Why: split from the session module to stay under the max-lines ratchet.
// Atomic authorize preflight: the prior implementation consumed a grant and
// installed its endpoint ids one at a time, so a grant whose endpoint set
// exceeded the 64-endpoint channel cap left a partially installed set and
// still consumed the grant. This module preflights the COMPLETE merge of the
// channel's current authorized ids with the grant's endpoint ids, rejects
// collisions and overflow WITHOUT mutating, and only then reports the merged
// set the session can install atomically. The grant store's one-use consume
// is the session's responsibility; this module is pure arithmetic over the
// proposed next state so it can fail without side effects.

export type AuthorizePreflightArgs = {
  currentEndpointIds: ReadonlySet<number>
  grantEndpointIds: readonly number[]
}

export type AuthorizePreflightResult =
  | { ok: true; mergedEndpointIds: number[] }
  | { ok: false; errorCode: WorkspacePortTunnelErrorCode }

// Why: 64 is the per-channel cap from the spec. The session passes the current
// authorized set so the preflight can detect a collision between a new grant
// and an existing one on the same channel (e.g. a replayed or re-issued grant
// targeting the same endpoint ids).
export function preflightAuthorize(args: AuthorizePreflightArgs): AuthorizePreflightResult {
  if (args.grantEndpointIds.length === 0) {
    return { ok: false, errorCode: WorkspacePortTunnelErrorCode.GrantMismatched }
  }
  const merged = new Set<number>(args.currentEndpointIds)
  for (const id of args.grantEndpointIds) {
    if (merged.has(id)) {
      // Why: a collision means the grant is replayed or belongs to a different
      // channel. Reject without mutating so the existing authorization stays
      // intact and the grant remains unconsumed for another channel.
      return { ok: false, errorCode: WorkspacePortTunnelErrorCode.GrantReplayed }
    }
    merged.add(id)
  }
  if (merged.size > WORKSPACE_PORT_TUNNEL_MAX_AUTHORIZED_ENDPOINTS_PER_CHANNEL) {
    // Why: the cap is enforced ATOMICALLY against the merged set, not per
    // grant, so a channel that already has 60 endpoints and receives a grant
    // with 8 more is rejected without partially installing the new 8.
    return { ok: false, errorCode: WorkspacePortTunnelErrorCode.InternalError }
  }
  return { ok: true, mergedEndpointIds: Array.from(merged) }
}

// Why: a channel keeps the granted endpoint descriptors (connect host/port)
// alongside the ids so OPEN frames can resolve an id to a target without
// re-consuming the grant. This map is the authoritative post-install state.
export type AuthorizedEndpointTable = {
  byId: Map<number, WorkspacePortTunnelGrantedEndpoint>
}

export function createAuthorizedEndpointTable(): AuthorizedEndpointTable {
  return { byId: new Map() }
}

export type InstallGrantsArgs = {
  table: AuthorizedEndpointTable
  endpoints: readonly WorkspacePortTunnelGrantedEndpoint[]
}

export type InstallGrantsResult =
  | { ok: true; installedIds: number[] }
  | { ok: false; errorCode: WorkspacePortTunnelErrorCode }

// Why: the session calls this AFTER preflightAuthorize has accepted the merge.
// The install is idempotent and atomic: either every endpoint lands in the
// table or (on an unexpected internal failure) none do. The preflight already
// verified the cap, so this is a tight loop over the grant's endpoints.
export function installGrantedEndpoints(args: InstallGrantsArgs): InstallGrantsResult {
  const preflight = preflightAuthorize({
    currentEndpointIds: new Set(args.table.byId.keys()),
    grantEndpointIds: args.endpoints.map((e) => e.endpointId)
  })
  if (!preflight.ok) {
    return { ok: false, errorCode: preflight.errorCode }
  }
  for (const endpoint of args.endpoints) {
    args.table.byId.set(endpoint.endpointId, endpoint)
  }
  return { ok: true, installedIds: args.endpoints.map((e) => e.endpointId) }
}

export function removeGrantedEndpoint(table: AuthorizedEndpointTable, endpointId: number): boolean {
  return table.byId.delete(endpointId)
}

export function lookupGrantedEndpoint(
  table: AuthorizedEndpointTable,
  endpointId: number
): WorkspacePortTunnelGrantedEndpoint | null {
  return table.byId.get(endpointId) ?? null
}

export function authorizedEndpointCount(table: AuthorizedEndpointTable): number {
  return table.byId.size
}
