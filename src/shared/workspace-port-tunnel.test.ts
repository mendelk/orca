import { describe, expect, it } from 'vitest'
import {
  WORKSPACE_PORT_TUNNEL_GRANT_TTL_MS,
  WORKSPACE_PORT_TUNNEL_MAX_ENDPOINTS_PER_GRANT,
  safeParseWorkspacePortTunnelAuthorizeRequest,
  WorkspacePortTunnelAuthorizeRequestSchema,
  WorkspacePortTunnelGrantSchema
} from './workspace-port-tunnel'

const validRequest = {
  worktree: 'wt-123',
  endpoints: [{ port: 3000, expectedProtocol: 'http' as const }]
}

describe('workspace-port-tunnel shared types', () => {
  it('caps endpoints at the spec limit of 16', () => {
    expect(WORKSPACE_PORT_TUNNEL_MAX_ENDPOINTS_PER_GRANT).toBe(16)
  })

  it('uses a 30-second unattached grant ttl', () => {
    expect(WORKSPACE_PORT_TUNNEL_GRANT_TTL_MS).toBe(30_000)
  })

  it('accepts a valid authorize request', () => {
    expect(() => WorkspacePortTunnelAuthorizeRequestSchema.parse(validRequest)).not.toThrow()
  })

  it('rejects an empty worktree selector', () => {
    const result = safeParseWorkspacePortTunnelAuthorizeRequest({ ...validRequest, worktree: '' })
    expect(result.ok).toBe(false)
  })

  it('rejects more than 16 endpoints', () => {
    const endpoints = Array.from({ length: 17 }, (_, i) => ({
      port: 3000 + i,
      expectedProtocol: 'http' as const
    }))
    const result = safeParseWorkspacePortTunnelAuthorizeRequest({ worktree: 'wt', endpoints })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toBe('invalid_request')
  })

  it('rejects out-of-range ports', () => {
    const result = safeParseWorkspacePortTunnelAuthorizeRequest({
      worktree: 'wt',
      endpoints: [{ port: 99999, expectedProtocol: 'http' }]
    })
    expect(result.ok).toBe(false)
  })

  it('rejects unknown protocol values', () => {
    const result = safeParseWorkspacePortTunnelAuthorizeRequest({
      worktree: 'wt',
      endpoints: [{ port: 3000, expectedProtocol: 'ftp' }]
    })
    expect(result.ok).toBe(false)
  })

  it('rejects extra fields under strict parsing', () => {
    expect(() =>
      WorkspacePortTunnelAuthorizeRequestSchema.parse({ ...validRequest, bindHost: '127.0.0.1' })
    ).toThrow()
  })

  it('accepts a valid grant shape', () => {
    const grant = {
      grantId: 'g-1',
      expiresAt: Date.now() + 30_000,
      endpoints: [
        { endpointId: 1, port: 3000, connectHost: '127.0.0.1', protocol: 'http' as const }
      ]
    }
    expect(() => WorkspacePortTunnelGrantSchema.parse(grant)).not.toThrow()
  })

  it('rejects a grant with more than 16 endpoints', () => {
    const grant = {
      grantId: 'g-1',
      expiresAt: Date.now() + 30_000,
      endpoints: Array.from({ length: 17 }, (_, i) => ({
        endpointId: i,
        port: 3000 + i,
        connectHost: '127.0.0.1',
        protocol: 'http' as const
      }))
    }
    expect(() => WorkspacePortTunnelGrantSchema.parse(grant)).toThrow()
  })
})
