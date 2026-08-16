import { describe, expect, it, vi } from 'vitest'
import { WORKSPACE_PORT_TUNNEL_METHODS } from './workspace-port-tunnels'
import type {
  WorkspacePortTunnelAuthorizeRequest,
  WorkspacePortTunnelAuthorizeResult
} from '../../../../shared/workspace-port-tunnel'
import { WorkspacePortTunnelGrantStore } from '../../../runtime-port-tunnel/workspace-port-tunnel-grant-store'
import type { RpcContext } from '../core'

describe('workspacePortTunnels RPC', () => {
  it('registers workspacePortTunnels.authorize', () => {
    expect(WORKSPACE_PORT_TUNNEL_METHODS).toHaveLength(1)
    expect(WORKSPACE_PORT_TUNNEL_METHODS[0].name).toBe('workspacePortTunnels.authorize')
  })

  it('wires handler properly', async () => {
    const handler = WORKSPACE_PORT_TUNNEL_METHODS[0].handler
    const store = new WorkspacePortTunnelGrantStore()

    const ctx = {
      runtime: {
        resolveWorktreeSelector: vi.fn().mockResolvedValue({ id: 'wt-1', repoId: 'repo-1' }),
        scanWorkspacePorts: vi.fn().mockResolvedValue({ ports: [] }),
        getWorkspacePortTunnelGrantStore: vi.fn().mockReturnValue(store),
        getRuntimeId: vi.fn().mockReturnValue('runtime-1')
      },
      clientKind: 'runtime',
      clientId: 'device-1'
    } as unknown as RpcContext

    const req: WorkspacePortTunnelAuthorizeRequest = {
      worktree: 'my-worktree',
      endpoints: [{ port: 8080, expectedProtocol: 'http' }]
    }

    const result = (await handler(req, ctx)) as WorkspacePortTunnelAuthorizeResult
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('no_eligible_endpoints')
    }
  })

  it('rejects unauthenticated and mobile callers before scanning', async () => {
    const handler = WORKSPACE_PORT_TUNNEL_METHODS[0].handler
    const scanWorkspacePorts = vi.fn()
    const runtime = { scanWorkspacePorts } as unknown as RpcContext['runtime']
    const request: WorkspacePortTunnelAuthorizeRequest = {
      worktree: 'my-worktree',
      endpoints: [{ port: 8080, expectedProtocol: 'http' }]
    }
    const result = (await handler(request, {
      runtime,
      clientKind: 'mobile',
      clientId: 'phone'
    })) as WorkspacePortTunnelAuthorizeResult
    expect(result.ok ? null : result.error).toBe('runtime_scope_required')
    expect(scanWorkspacePorts).not.toHaveBeenCalled()
  })
})
