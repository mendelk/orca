import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type {
  WorkspacePortTunnelGrant,
  WorkspacePortTunnelGrantedEndpoint,
  WorkspacePortTunnelGrantError,
  WorkspacePortTunnelResolvedWorkspace
} from '../../shared/workspace-port-tunnel'

// Why: split from workspace-port-tunnel-grant-store.ts to stay under the
// max-lines ratchet. Holds stored-grant shape, hashing helpers, and the
// shared fail() result used by every grant-store operation.

export const WORKSPACE_PORT_TUNNEL_GRANT_ID_BYTES = 32

export type DeviceScope = 'mobile' | 'runtime'

export type StoredGrant = {
  grant: WorkspacePortTunnelGrant
  deviceTokenHash: Buffer
  runtimeInstanceId: string
  worktreeId: string
  createdAt: number
  consumed: boolean
  consumedAt: number | null
  revoked: boolean
}

export type IssueArgs = {
  deviceToken: string
  deviceScope: DeviceScope
  runtimeInstanceId: string
  resolvedWorkspace: WorkspacePortTunnelResolvedWorkspace
  endpoints: WorkspacePortTunnelEndpointTarget[]
  now?: number
}

export type ConsumeArgs = {
  grantId: string
  deviceToken: string
  runtimeInstanceId: string
  now?: number
}

export type EndpointAccessArgs = {
  grantId: string
  endpointId: number
  deviceToken: string
  runtimeInstanceId: string
  now?: number
}

export type WorkspacePortTunnelEndpointTarget = Omit<
  WorkspacePortTunnelGrantedEndpoint,
  'endpointId'
>

export function fail<T extends WorkspacePortTunnelGrantError>(
  error: T,
  message: string
): { ok: false; error: T; message: string } {
  return { ok: false as const, error, message }
}

// Why: the store never stores or logs the raw device token. The token is a
// high-entropy secret; hashing it with sha256 (no salt) is sufficient for an
// equality key, and constant-time comparison prevents timing leakage.
export function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

export function constantTimeEqualHashes(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) {
    return false
  }
  return timingSafeEqual(a, b)
}

export function generateGrantId(): string {
  return randomBytes(WORKSPACE_PORT_TUNNEL_GRANT_ID_BYTES).toString('base64url')
}
