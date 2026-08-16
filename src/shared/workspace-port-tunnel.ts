import { z } from 'zod'

// Why: Stage 1 of the paired-runtime direct-browser design (see
// docs/superpowers/specs/2026-08-15-paired-runtime-direct-browser-design.md)
// introduces an authenticated raw-TCP tunnel from loopback listeners on the
// desktop client to workspace-attributed listeners on a paired runtime. The
// runtime authorizes a tunnel by issuing a short-lived, one-use grant bound to
// the authenticated device token, runtime instance, resolved workspace, and a
// bounded set of exact endpoints. This module holds the shared request/result
// types and validation schemas used by both the runtime grant store and the
// (later) RPC surface, without any socket or RPC wiring.

// Why: the spec caps a single grant at 16 endpoints (selected origin plus up
// to 15 companions). Keep the bound here so the schema, store, and tests share
// one source of truth.
export const WORKSPACE_PORT_TUNNEL_MAX_ENDPOINTS_PER_GRANT = 16

// Why: an unattached grant expires after 30 seconds so a leaked grant ID cannot
// be replayed later. Expiration limits replay, not a healthy attached session.
export const WORKSPACE_PORT_TUNNEL_GRANT_TTL_MS = 30_000

// Why: 64 authorized endpoints and 32 active browser leases per environment
// channel are the protocol bounds from the spec. The grant store caps in-flight
// grants per runtime so a misbehaving client cannot exhaust memory.
export const WORKSPACE_PORT_TUNNEL_MAX_GRANTS_PER_RUNTIME = 32

// Why: TCP port range; the runtime must reject anything outside it before
// resolving workspace attribution so a malformed request cannot reach the
// grant store.
const TcpPortSchema = z.number().int().min(1).max(65535)

const TunnelProtocolSchema = z.enum(['http', 'https', 'unknown'])

const EndpointIdSchema = z.number().int().positive()

export type WorkspacePortTunnelProtocol = z.infer<typeof TunnelProtocolSchema>

export const WorkspacePortTunnelAuthorizeEndpointSchema = z.object({
  port: TcpPortSchema,
  expectedProtocol: TunnelProtocolSchema
})

export const WorkspacePortTunnelAuthorizeRequestSchema = z
  .object({
    worktree: z.string().min(1).max(4096),
    endpoints: z
      .array(WorkspacePortTunnelAuthorizeEndpointSchema)
      .min(1)
      .max(WORKSPACE_PORT_TUNNEL_MAX_ENDPOINTS_PER_GRANT)
  })
  .strict()

export type WorkspacePortTunnelAuthorizeRequest = z.infer<
  typeof WorkspacePortTunnelAuthorizeRequestSchema
>

export type WorkspacePortTunnelAuthorizeEndpoint = z.infer<
  typeof WorkspacePortTunnelAuthorizeEndpointSchema
>

export const WorkspacePortTunnelGrantedEndpointSchema = z.object({
  endpointId: EndpointIdSchema,
  port: TcpPortSchema,
  connectHost: z.string().min(1).max(255),
  protocol: TunnelProtocolSchema
})

export const WorkspacePortTunnelGrantSchema = z.object({
  grantId: z.string().min(1).max(128),
  expiresAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  endpoints: z
    .array(WorkspacePortTunnelGrantedEndpointSchema)
    .min(1)
    .max(WORKSPACE_PORT_TUNNEL_MAX_ENDPOINTS_PER_GRANT)
})

export type WorkspacePortTunnelGrantedEndpoint = z.infer<
  typeof WorkspacePortTunnelGrantedEndpointSchema
>
export type WorkspacePortTunnelEndpointTarget = Omit<
  WorkspacePortTunnelGrantedEndpoint,
  'endpointId'
>

export type WorkspacePortTunnelGrant = z.infer<typeof WorkspacePortTunnelGrantSchema>

// Why: the runtime resolves the worktree selector itself and never trusts a
// renderer-supplied path, PID, or bind host. The grant store consumes this
// resolved identity, not the raw request.
export type WorkspacePortTunnelResolvedWorkspace = {
  worktreeId: string
  /** Stable runtime instance identity; the grant is bound to it. */
  runtimeInstanceId: string
}

export type WorkspacePortTunnelGrantError =
  | 'invalid_request'
  | 'workspace_not_found'
  | 'no_eligible_endpoints'
  | 'too_many_endpoints'
  | 'duplicate_endpoint'
  | 'grant_capacity_reached'
  | 'mobile_scope_denied'
  | 'grant_not_found'
  | 'grant_expired'
  | 'grant_already_consumed'
  | 'device_mismatch'
  | 'runtime_mismatch'
  | 'workspace_mismatch'
  | 'endpoint_not_authorized'
  | 'runtime_stopped'
  | 'device_unpaired'

export type WorkspacePortTunnelAuthorizeResult =
  | { ok: true; grant: WorkspacePortTunnelGrant }
  | { ok: false; error: WorkspacePortTunnelGrantError; message: string }

export type WorkspacePortTunnelConsumeResult =
  | { ok: true; grant: WorkspacePortTunnelGrant }
  | { ok: false; error: WorkspacePortTunnelGrantError; message: string }

export type WorkspacePortTunnelEndpointAccessResult =
  | { ok: true; endpoint: WorkspacePortTunnelGrantedEndpoint }
  | { ok: false; error: WorkspacePortTunnelGrantError; message: string }

export function parseWorkspacePortTunnelAuthorizeRequest(
  value: unknown
): WorkspacePortTunnelAuthorizeRequest {
  return WorkspacePortTunnelAuthorizeRequestSchema.parse(value)
}

export function safeParseWorkspacePortTunnelAuthorizeRequest(
  value: unknown
):
  | { ok: true; request: WorkspacePortTunnelAuthorizeRequest }
  | { ok: false; error: 'invalid_request'; message: string } {
  const parsed = WorkspacePortTunnelAuthorizeRequestSchema.safeParse(value)
  if (parsed.success) {
    return { ok: true, request: parsed.data }
  }
  // Why: collapse zod issues into one bounded message; never echo the raw input.
  const firstIssue = parsed.error.issues[0]
  const message = firstIssue
    ? `${firstIssue.path.join('.')}: ${firstIssue.message}`
    : 'Invalid workspace port tunnel authorize request.'
  return { ok: false, error: 'invalid_request', message }
}
