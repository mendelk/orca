import type { WorkspacePort } from '../../shared/workspace-ports'
import type {
  WorkspacePortTunnelAuthorizeRequest,
  WorkspacePortTunnelAuthorizeResult,
  WorkspacePortTunnelEndpointTarget
} from '../../shared/workspace-port-tunnel'
import type { WorkspacePortTunnelGrantStore } from './workspace-port-tunnel-grant-store'
import { isLoopbackLiteral, isWildcardHost } from './tunnel-host-classification'
import { WORKSPACE_PORT_TUNNEL_MAX_ENDPOINTS_PER_GRANT } from '../../shared/workspace-port-tunnel'

type TunnelPortScanOptions = { requireMetadata: true }

export type TunnelAuthorizationContext = {
  resolveWorktreeSelector(selector: string): Promise<{ worktreeId: string; repoId: string } | null>
  scanWorkspacePorts(
    repoId: string,
    options: TunnelPortScanOptions
  ): Promise<readonly WorkspacePort[]>
  grantStore: WorkspacePortTunnelGrantStore
  deviceScope: 'mobile' | 'runtime'
  deviceToken: string
  runtimeInstanceId: string
  enabled: boolean
}

export async function authorizeWorkspacePortTunnel(
  request: WorkspacePortTunnelAuthorizeRequest,
  context: TunnelAuthorizationContext
): Promise<WorkspacePortTunnelAuthorizeResult> {
  if (!context.enabled) {
    return {
      ok: false,
      error: 'feature_disabled',
      message: 'Workspace port tunnels are disabled on this runtime.'
    }
  }
  if (context.deviceScope !== 'runtime' || !context.deviceToken) {
    return {
      ok: false,
      error: 'runtime_scope_required',
      message: 'A runtime-scoped paired device is required.'
    }
  }

  if (request.endpoints.length > WORKSPACE_PORT_TUNNEL_MAX_ENDPOINTS_PER_GRANT) {
    return {
      ok: false,
      error: 'too_many_endpoints',
      message: `Requested endpoints exceed the maximum of ${WORKSPACE_PORT_TUNNEL_MAX_ENDPOINTS_PER_GRANT}.`
    }
  }

  const seenPorts = new Set<number>()
  for (const ep of request.endpoints) {
    if (seenPorts.has(ep.port)) {
      return {
        ok: false,
        error: 'duplicate_endpoint',
        message: `Duplicate port ${ep.port} requested.`
      }
    }
    seenPorts.add(ep.port)
  }

  let resolved: { worktreeId: string; repoId: string } | null = null
  try {
    resolved = await context.resolveWorktreeSelector(request.worktree)
  } catch {
    return {
      ok: false,
      error: 'workspace_not_found',
      message: `Could not resolve workspace selector: ${request.worktree}`
    }
  }

  if (!resolved) {
    return {
      ok: false,
      error: 'workspace_not_found',
      message: `Could not resolve workspace selector: ${request.worktree}`
    }
  }

  const { worktreeId, repoId } = resolved
  let freshScanPorts: readonly WorkspacePort[]
  try {
    freshScanPorts = await context.scanWorkspacePorts(repoId, { requireMetadata: true })
  } catch {
    return {
      ok: false,
      error: 'scan_unavailable',
      message: 'Workspace listener metadata is unavailable.'
    }
  }

  const workspaceRows = freshScanPorts.filter(
    (port): port is Extract<WorkspacePort, { kind: 'workspace' }> =>
      port.kind === 'workspace' && port.owner.worktreeId === worktreeId
  )

  const grantedEndpoints: WorkspacePortTunnelEndpointTarget[] = []

  for (const requestedEndpoint of request.endpoints) {
    const row = workspaceRows.find((r) => r.port === requestedEndpoint.port)
    if (!row) {
      continue
    }
    if (
      requestedEndpoint.expectedProtocol !== 'unknown' &&
      row.protocol !== requestedEndpoint.expectedProtocol
    ) {
      continue
    }
    if (!isWildcardHost(row.bindHost) && !isLoopbackLiteral(row.bindHost)) {
      continue
    }
    grantedEndpoints.push({
      port: row.port,
      connectHost: runtimeLoopbackConnectHost(row.bindHost),
      protocol: row.protocol
    })
  }

  if (grantedEndpoints.length === 0) {
    return {
      ok: false,
      error: 'no_eligible_endpoints',
      message:
        'None of the requested endpoints are eligible for tunneling or owned by the workspace.'
    }
  }

  return context.grantStore.issue({
    deviceToken: context.deviceToken,
    deviceScope: context.deviceScope,
    runtimeInstanceId: context.runtimeInstanceId,
    resolvedWorkspace: {
      worktreeId,
      runtimeInstanceId: context.runtimeInstanceId
    },
    endpoints: grantedEndpoints
  })
}

function runtimeLoopbackConnectHost(bindHost: string): string {
  const normalized = bindHost
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
  if (normalized === '::' || normalized === '::1') {
    return '::1'
  }
  return '127.0.0.1'
}
