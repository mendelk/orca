import {
  WORKSPACE_PORT_TUNNEL_GRANT_TTL_MS,
  WORKSPACE_PORT_TUNNEL_MAX_ENDPOINTS_PER_GRANT,
  WORKSPACE_PORT_TUNNEL_MAX_GRANTS_PER_RUNTIME,
  type WorkspacePortTunnelConsumeResult,
  type WorkspacePortTunnelEndpointAccessResult,
  type WorkspacePortTunnelGrant,
  type WorkspacePortTunnelGrantedEndpoint,
  type WorkspacePortTunnelGrantError
} from '../../shared/workspace-port-tunnel'
import {
  constantTimeEqualHashes,
  fail,
  generateGrantId,
  sha256,
  type ConsumeArgs,
  type EndpointAccessArgs,
  type IssueArgs,
  type StoredGrant,
  WORKSPACE_PORT_TUNNEL_GRANT_ID_BYTES
} from './workspace-port-tunnel-grant-store-types'

export { WORKSPACE_PORT_TUNNEL_GRANT_ID_BYTES }
export type {
  DeviceScope,
  IssueArgs,
  ConsumeArgs,
  EndpointAccessArgs,
  StoredGrant
} from './workspace-port-tunnel-grant-store-types'
export type { WorkspacePortTunnelEndpointTarget } from '../../shared/workspace-port-tunnel'

// Why: bound the stored grant map per runtime so a misbehaving or noisy client
// cannot exhaust runtime memory. The spec caps active browser leases at 32 per
// environment channel; unattached grants are short-lived and pruned on access.
const MAX_STORED_GRANTS = WORKSPACE_PORT_TUNNEL_MAX_GRANTS_PER_RUNTIME

// Why: a narrow revocation request — release the grants attached to a specific
// channel (identified by the consumed grant ids the session installed) without
// touching unrelated device grants. Used by tunnel-session close cleanup so a
// closing channel does not revoke a parallel RPC connection's grants.
export type ReleaseGrantsForChannelArgs = {
  grantIds: readonly string[]
}

export class WorkspacePortTunnelGrantStore {
  private readonly grants = new Map<string, StoredGrant>()
  private readonly order: string[] = []
  private readonly now: () => number
  private nextEndpointId = 1

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? (() => Date.now())
  }

  issue(
    args: IssueArgs
  ):
    | { ok: true; grant: WorkspacePortTunnelGrant }
    | { ok: false; error: WorkspacePortTunnelGrantError; message: string } {
    if (args.deviceScope === 'mobile') {
      return fail(
        'mobile_scope_denied',
        'Mobile-scoped devices cannot authorize workspace port tunnels.'
      )
    }
    if (args.endpoints.length === 0) {
      return fail('no_eligible_endpoints', 'No eligible endpoints resolved for the workspace.')
    }
    if (args.endpoints.length > WORKSPACE_PORT_TUNNEL_MAX_ENDPOINTS_PER_GRANT) {
      return fail(
        'too_many_endpoints',
        `A grant allows at most ${WORKSPACE_PORT_TUNNEL_MAX_ENDPOINTS_PER_GRANT} endpoints.`
      )
    }
    if (!args.deviceToken || !args.runtimeInstanceId) {
      return fail('invalid_request', 'Device and runtime identities are required.')
    }
    if (
      args.resolvedWorkspace.runtimeInstanceId !== args.runtimeInstanceId ||
      args.resolvedWorkspace.worktreeId.length === 0
    ) {
      return fail('workspace_not_found', 'Resolved workspace does not match the runtime instance.')
    }
    const endpointKeys = new Set<string>()
    for (const endpoint of args.endpoints) {
      const key = `${endpoint.connectHost}\u0000${endpoint.port}`
      if (endpointKeys.has(key)) {
        return fail('duplicate_endpoint', 'A grant cannot contain duplicate endpoints.')
      }
      endpointKeys.add(key)
    }
    const now = args.now ?? this.now()
    this.evictExpired(now)
    if (!this.makeRoomForGrant()) {
      return fail(
        'grant_capacity_reached',
        'The runtime has reached its active tunnel grant limit.'
      )
    }
    const normalized: WorkspacePortTunnelGrantedEndpoint[] = args.endpoints.map((endpoint) => {
      return { ...endpoint, endpointId: this.allocateEndpointId() }
    })
    let grantId = generateGrantId()
    while (this.grants.has(grantId)) {
      grantId = generateGrantId()
    }
    const grant: WorkspacePortTunnelGrant = {
      grantId,
      expiresAt: now + WORKSPACE_PORT_TUNNEL_GRANT_TTL_MS,
      endpoints: normalized
    }
    this.grants.set(grantId, {
      grant,
      deviceTokenHash: sha256(args.deviceToken),
      runtimeInstanceId: args.runtimeInstanceId,
      worktreeId: args.resolvedWorkspace.worktreeId,
      createdAt: now,
      consumed: false,
      consumedAt: null,
      revoked: false
    })
    this.order.push(grantId)
    return { ok: true, grant }
  }

  consume(args: ConsumeArgs): WorkspacePortTunnelConsumeResult {
    const now = args.now ?? this.now()
    const stored = this.grants.get(args.grantId)
    if (!stored || stored.revoked) {
      return fail('grant_not_found', 'Grant is unknown or has been revoked.')
    }
    if (stored.grant.expiresAt <= now) {
      this.grants.delete(args.grantId)
      this.removeFromOrder(args.grantId)
      return fail('grant_expired', 'Grant expired before the data channel attached.')
    }
    if (!constantTimeEqualHashes(stored.deviceTokenHash, sha256(args.deviceToken))) {
      return fail('device_mismatch', 'Grant was issued to a different device token.')
    }
    if (stored.runtimeInstanceId !== args.runtimeInstanceId) {
      return fail('runtime_mismatch', 'Grant was issued to a different runtime instance.')
    }
    if (stored.consumed) {
      return fail('grant_already_consumed', 'Grant has already been consumed by a data channel.')
    }
    stored.consumed = true
    stored.consumedAt = now
    return { ok: true, grant: stored.grant }
  }

  authorizeEndpoint(args: EndpointAccessArgs): WorkspacePortTunnelEndpointAccessResult {
    const now = args.now ?? this.now()
    const stored = this.grants.get(args.grantId)
    if (!stored || stored.revoked) {
      return fail('grant_not_found', 'Grant is unknown or has been revoked.')
    }
    // Why: an attached channel may remain alive past expiresAt; expiration
    // limits replay, not a healthy session. Endpoint access checks the
    // consumed flag, not expiry, once attached.
    if (!stored.consumed) {
      if (stored.grant.expiresAt <= now) {
        this.grants.delete(args.grantId)
        this.removeFromOrder(args.grantId)
        return fail('grant_expired', 'Grant expired before the data channel attached.')
      }
      return fail('grant_not_found', 'Grant has not been consumed by a data channel.')
    }
    if (!constantTimeEqualHashes(stored.deviceTokenHash, sha256(args.deviceToken))) {
      return fail('device_mismatch', 'Grant was issued to a different device token.')
    }
    if (stored.runtimeInstanceId !== args.runtimeInstanceId) {
      return fail('runtime_mismatch', 'Grant was issued to a different runtime instance.')
    }
    const endpoint = stored.grant.endpoints.find((entry) => entry.endpointId === args.endpointId)
    if (!endpoint) {
      return fail('endpoint_not_authorized', `Endpoint id ${args.endpointId} is not in the grant.`)
    }
    return { ok: true, endpoint }
  }

  revokeGrant(grantId: string): boolean {
    const stored = this.grants.get(grantId)
    if (!stored) {
      return false
    }
    this.grants.delete(grantId)
    this.removeFromOrder(grantId)
    return true
  }

  // Why: narrow channel close revocation. Releases only the grants the closing
  // channel consumed (one or more AUTHORIZE frames on the same channel) without
  // touching a parallel RPC connection's grants. Unknown ids are no-ops so a
  // double-close is safe. Returns the number actually removed.
  releaseGrantsForChannel(args: ReleaseGrantsForChannelArgs): number {
    let removed = 0
    for (const grantId of args.grantIds) {
      if (this.grants.delete(grantId)) {
        removed++
      }
    }
    if (removed > 0) {
      this.rebuildOrder()
    }
    return removed
  }

  revokeForDevice(deviceToken: string): number {
    const hash = sha256(deviceToken)
    let removed = 0
    for (const [grantId, stored] of this.grants) {
      if (constantTimeEqualHashes(stored.deviceTokenHash, hash)) {
        this.grants.delete(grantId)
        removed++
      }
    }
    this.rebuildOrder()
    return removed
  }

  revokeForRuntime(runtimeInstanceId: string): number {
    let removed = 0
    for (const [, stored] of this.grants) {
      if (stored.runtimeInstanceId === runtimeInstanceId) {
        this.grants.delete(stored.grant.grantId)
        removed++
      }
    }
    this.rebuildOrder()
    return removed
  }

  revokeForWorkspace(runtimeInstanceId: string, worktreeId: string): number {
    let removed = 0
    for (const [, stored] of this.grants) {
      if (stored.runtimeInstanceId === runtimeInstanceId && stored.worktreeId === worktreeId) {
        this.grants.delete(stored.grant.grantId)
        removed++
      }
    }
    this.rebuildOrder()
    return removed
  }

  shutdown(): void {
    this.grants.clear()
    this.order.length = 0
  }

  size(): number {
    return this.grants.size
  }

  activeGrantCount(): number {
    let count = 0
    for (const stored of this.grants.values()) {
      if (stored.consumed && !stored.revoked) {
        count++
      }
    }
    return count
  }

  // Why: expose whether a specific grant is currently consumed so tests and the
  // channel layer can assert one-use behavior without re-consuming.
  isConsumed(grantId: string): boolean {
    return this.grants.get(grantId)?.consumed ?? false
  }

  private evictExpired(now: number): void {
    for (const [grantId, stored] of this.grants) {
      if (!stored.consumed && stored.grant.expiresAt <= now) {
        this.grants.delete(grantId)
        this.removeFromOrder(grantId)
      }
    }
  }

  private makeRoomForGrant(): boolean {
    if (this.grants.size < MAX_STORED_GRANTS) {
      return true
    }
    const oldestUnattached = this.order.find((id) => {
      const stored = this.grants.get(id)
      return stored && !stored.consumed
    })
    if (!oldestUnattached) {
      return false
    }
    this.grants.delete(oldestUnattached)
    this.removeFromOrder(oldestUnattached)
    return true
  }

  private allocateEndpointId(): number {
    const used = new Set<number>()
    for (const stored of this.grants.values()) {
      for (const endpoint of stored.grant.endpoints) {
        used.add(endpoint.endpointId)
      }
    }
    for (let attempts = 0; attempts < 0xffffffff; attempts += 1) {
      const candidate = this.nextEndpointId
      this.nextEndpointId = this.nextEndpointId === 0xffffffff ? 1 : this.nextEndpointId + 1
      if (!used.has(candidate)) {
        return candidate
      }
    }
    throw new Error('Workspace port tunnel endpoint id space exhausted')
  }

  private removeFromOrder(grantId: string): void {
    const index = this.order.indexOf(grantId)
    if (index !== -1) {
      this.order.splice(index, 1)
    }
  }

  private rebuildOrder(): void {
    this.order.length = 0
    for (const grantId of this.grants.keys()) {
      this.order.push(grantId)
    }
  }
}
