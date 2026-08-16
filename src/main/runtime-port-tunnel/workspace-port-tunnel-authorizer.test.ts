import { describe, expect, it, vi } from 'vitest'
import type { WorkspacePort } from '../../shared/workspace-ports'
import {
  authorizeWorkspacePortTunnel,
  type TunnelAuthorizationContext
} from './workspace-port-tunnel-authorizer'
import { WorkspacePortTunnelGrantStore } from './workspace-port-tunnel-grant-store'
import type { WorkspacePortTunnelAuthorizeRequest } from '../../shared/workspace-port-tunnel'

describe('authorizeWorkspacePortTunnel', () => {
  const createMockContext = (
    overrides?: Partial<TunnelAuthorizationContext>
  ): TunnelAuthorizationContext => ({
    resolveWorktreeSelector: vi
      .fn()
      .mockResolvedValue({ worktreeId: 'wt-123', repoId: 'repo-abc' }),
    scanWorkspacePorts: vi.fn().mockResolvedValue([
      {
        id: 'port-1',
        kind: 'workspace',
        port: 3000,
        bindHost: '127.0.0.1',
        connectHost: '127.0.0.1',
        protocol: 'http',
        owner: {
          worktreeId: 'wt-123',
          repoId: 'repo-abc',
          displayName: 'test',
          path: '/test',
          confidence: 'cwd'
        },
        pid: 999
      } satisfies WorkspacePort
    ]),
    grantStore: new WorkspacePortTunnelGrantStore(),
    deviceScope: 'runtime',
    deviceToken: 'device-token-123',
    runtimeInstanceId: 'runtime-inst-1',
    enabled: true,
    ...overrides
  })

  it('authorizes valid endpoints and issues a grant', async () => {
    const ctx = createMockContext()
    const req: WorkspacePortTunnelAuthorizeRequest = {
      worktree: 'my-worktree',
      endpoints: [{ port: 3000, expectedProtocol: 'http' }]
    }

    const result = await authorizeWorkspacePortTunnel(req, ctx)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.grant.endpoints).toHaveLength(1)
      expect(result.grant.endpoints[0]?.port).toBe(3000)
      expect(result.grant.endpoints[0]?.connectHost).toBe('127.0.0.1')
    }
  })

  it('rejects mobile scope', async () => {
    const ctx = createMockContext({ deviceScope: 'mobile' })
    const req: WorkspacePortTunnelAuthorizeRequest = {
      worktree: 'my-worktree',
      endpoints: [{ port: 3000, expectedProtocol: 'http' }]
    }

    const result = await authorizeWorkspacePortTunnel(req, ctx)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('runtime_scope_required')
    }
  })

  it('rejects requests with more than 16 endpoints', async () => {
    const ctx = createMockContext()
    const endpoints = Array.from({ length: 17 }, (_, i) => ({
      port: 3000 + i,
      expectedProtocol: 'http' as const
    }))
    const req: WorkspacePortTunnelAuthorizeRequest = { worktree: 'my-worktree', endpoints }

    const result = await authorizeWorkspacePortTunnel(req, ctx)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('too_many_endpoints')
    }
  })

  it('rejects duplicate endpoints', async () => {
    const ctx = createMockContext()
    const req: WorkspacePortTunnelAuthorizeRequest = {
      worktree: 'my-worktree',
      endpoints: [
        { port: 3000, expectedProtocol: 'http' },
        { port: 3000, expectedProtocol: 'https' }
      ]
    }

    const result = await authorizeWorkspacePortTunnel(req, ctx)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('duplicate_endpoint')
    }
  })

  it('rejects if workspace cannot be resolved', async () => {
    const ctx = createMockContext({
      resolveWorktreeSelector: vi.fn().mockRejectedValue(new Error('selector_not_found'))
    })
    const req: WorkspacePortTunnelAuthorizeRequest = {
      worktree: 'unknown-wt',
      endpoints: [{ port: 3000, expectedProtocol: 'http' }]
    }

    const result = await authorizeWorkspacePortTunnel(req, ctx)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('workspace_not_found')
    }
  })

  it('drops stale ports and returns no_eligible_endpoints if empty', async () => {
    const ctx = createMockContext({
      scanWorkspacePorts: vi.fn().mockResolvedValue([
        {
          id: 'port-2',
          kind: 'workspace',
          port: 3000, // owned by someone else
          bindHost: '127.0.0.1',
          connectHost: '127.0.0.1',
          protocol: 'http',
          owner: {
            worktreeId: 'other-wt',
            repoId: 'repo-abc',
            displayName: 'test2',
            path: '/test2',
            confidence: 'cwd'
          },
          pid: 999
        } satisfies WorkspacePort
      ])
    })
    const req: WorkspacePortTunnelAuthorizeRequest = {
      worktree: 'my-worktree',
      endpoints: [
        { port: 3000, expectedProtocol: 'http' },
        { port: 4000, expectedProtocol: 'http' }
      ] // 4000 is stale/missing
    }

    const result = await authorizeWorkspacePortTunnel(req, ctx)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('no_eligible_endpoints')
    }
  })

  it('requires metadata on the fresh scan', async () => {
    const scanWorkspacePorts = vi.fn().mockResolvedValue([])
    await authorizeWorkspacePortTunnel(
      { worktree: 'my-worktree', endpoints: [{ port: 3000, expectedProtocol: 'http' }] },
      createMockContext({ scanWorkspacePorts })
    )
    expect(scanWorkspacePorts).toHaveBeenCalledWith('repo-abc', { requireMetadata: true })
  })

  it('returns a bounded scanner error', async () => {
    const result = await authorizeWorkspacePortTunnel(
      { worktree: 'my-worktree', endpoints: [{ port: 3000, expectedProtocol: 'http' }] },
      createMockContext({ scanWorkspacePorts: vi.fn().mockRejectedValue(new Error('failed')) })
    )
    expect(result.ok ? null : result.error).toBe('scan_unavailable')
  })

  it('does not authorize a stale protocol assumption', async () => {
    const result = await authorizeWorkspacePortTunnel(
      { worktree: 'my-worktree', endpoints: [{ port: 3000, expectedProtocol: 'https' }] },
      createMockContext()
    )
    expect(result.ok ? null : result.error).toBe('no_eligible_endpoints')
  })

  it('preserves unknown protocol metadata', async () => {
    const context = createMockContext()
    const ports = await context.scanWorkspacePorts('repo-abc', { requireMetadata: true })
    context.scanWorkspacePorts = vi
      .fn()
      .mockResolvedValue(ports.map((port) => ({ ...port, protocol: 'unknown' as const })))
    const result = await authorizeWorkspacePortTunnel(
      { worktree: 'my-worktree', endpoints: [{ port: 3000, expectedProtocol: 'unknown' }] },
      context
    )
    expect(result.ok && result.grant.endpoints[0]?.protocol).toBe('unknown')
  })

  it('honors the runtime kill switch', async () => {
    const result = await authorizeWorkspacePortTunnel(
      { worktree: 'my-worktree', endpoints: [{ port: 3000, expectedProtocol: 'http' }] },
      createMockContext({ enabled: false })
    )
    expect(result.ok ? null : result.error).toBe('feature_disabled')
  })
})
