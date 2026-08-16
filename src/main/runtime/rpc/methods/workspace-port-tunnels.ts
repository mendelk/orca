import { defineMethod, type RpcMethod } from '../core'
import { WorkspacePortTunnelAuthorizeRequestSchema } from '../../../../shared/workspace-port-tunnel'
import { authorizeWorkspacePortTunnel } from '../../../runtime-port-tunnel/workspace-port-tunnel-authorizer'

export const WORKSPACE_PORT_TUNNEL_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'workspacePortTunnels.authorize',
    params: WorkspacePortTunnelAuthorizeRequestSchema,
    handler: async (params, ctx) => {
      if (ctx.clientKind !== 'runtime' || !ctx.clientId) {
        return {
          ok: false as const,
          error: 'runtime_scope_required' as const,
          message: 'A runtime-scoped paired device is required.'
        }
      }
      return authorizeWorkspacePortTunnel(params, {
        resolveWorktreeSelector: async (selector: string) => {
          const resolved = await ctx.runtime.resolveWorktreeSelector(selector)
          return { worktreeId: resolved.id, repoId: resolved.repoId }
        },
        scanWorkspacePorts: async (repoId, options) => {
          const scan = await ctx.runtime.scanWorkspacePorts(repoId, options)
          return scan.ports
        },
        grantStore: ctx.runtime.getWorkspacePortTunnelGrantStore(),
        deviceScope: ctx.clientKind,
        deviceToken: ctx.clientId,
        runtimeInstanceId: ctx.runtime.getRuntimeId(),
        enabled: process.env.ORCA_RUNTIME_PORT_TUNNEL !== '0'
      })
    }
  })
]
