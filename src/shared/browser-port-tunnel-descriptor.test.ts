import { describe, it, expect } from 'vitest'
import {
  browserPortTunnelDescriptorSchema,
  isClientOwnedTunneledPage,
  pageRequiresTunnelReacquisition,
  validateBrowserPortTunnelDescriptor
} from './browser-port-tunnel-descriptor'
import type { BrowserPortTunnelDescriptor } from './browser-workspace-types'

const validDescriptor: BrowserPortTunnelDescriptor = {
  environmentId: 'env-1',
  worktreeId: 'repo::/srv/app',
  remoteOrigin: 'http://127.0.0.1:5173',
  remotePort: 5173
}

describe('browserPortTunnelDescriptorSchema', () => {
  it('round-trips a valid descriptor', () => {
    const result = browserPortTunnelDescriptorSchema.safeParse(validDescriptor)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toEqual(validDescriptor)
    }
  })

  it('round-trips an https descriptor with a custom hostname', () => {
    const descriptor: BrowserPortTunnelDescriptor = {
      environmentId: 'env-1',
      worktreeId: 'wt-1',
      remoteOrigin: 'https://local.getmontecarlo.com:3001',
      remotePort: 3001
    }
    const result = browserPortTunnelDescriptorSchema.safeParse(descriptor)
    expect(result.success).toBe(true)
  })

  it('round-trips a default-port https origin', () => {
    const descriptor: BrowserPortTunnelDescriptor = {
      environmentId: 'env-1',
      worktreeId: 'wt-1',
      remoteOrigin: 'https://example.com',
      remotePort: 443
    }
    const result = browserPortTunnelDescriptorSchema.safeParse(descriptor)
    expect(result.success).toBe(true)
  })

  it('rejects an empty environmentId', () => {
    const result = browserPortTunnelDescriptorSchema.safeParse({
      ...validDescriptor,
      environmentId: ''
    })
    expect(result.success).toBe(false)
  })

  it('rejects an empty worktreeId', () => {
    const result = browserPortTunnelDescriptorSchema.safeParse({
      ...validDescriptor,
      worktreeId: ''
    })
    expect(result.success).toBe(false)
  })

  it('rejects a remoteOrigin with a path', () => {
    const result = browserPortTunnelDescriptorSchema.safeParse({
      ...validDescriptor,
      remoteOrigin: 'http://127.0.0.1:5173/app'
    })
    expect(result.success).toBe(false)
  })

  it('rejects a remoteOrigin with a query string', () => {
    const result = browserPortTunnelDescriptorSchema.safeParse({
      ...validDescriptor,
      remoteOrigin: 'http://127.0.0.1:5173?x=1'
    })
    expect(result.success).toBe(false)
  })

  it('rejects a non-http(s) remoteOrigin', () => {
    const result = browserPortTunnelDescriptorSchema.safeParse({
      ...validDescriptor,
      remoteOrigin: 'ftp://127.0.0.1:5173'
    })
    expect(result.success).toBe(false)
  })

  it('rejects a malformed remoteOrigin', () => {
    const result = browserPortTunnelDescriptorSchema.safeParse({
      ...validDescriptor,
      remoteOrigin: 'not-a-url'
    })
    expect(result.success).toBe(false)
  })

  it('rejects a remotePort out of TCP range', () => {
    expect(
      browserPortTunnelDescriptorSchema.safeParse({ ...validDescriptor, remotePort: 0 }).success
    ).toBe(false)
    expect(
      browserPortTunnelDescriptorSchema.safeParse({ ...validDescriptor, remotePort: 65_536 })
        .success
    ).toBe(false)
  })

  it('rejects a non-integer remotePort', () => {
    expect(
      browserPortTunnelDescriptorSchema.safeParse({ ...validDescriptor, remotePort: 5173.5 })
        .success
    ).toBe(false)
  })

  it('strips extra keys (strict) so lease/grant/socket data never persists', () => {
    const result = browserPortTunnelDescriptorSchema.safeParse({
      ...validDescriptor,
      leaseId: 'lease-1',
      grantId: 'grant-1',
      localSocketAddress: '127.0.0.1:5173'
    })
    expect(result.success).toBe(false)
  })

  it('rejects a non-string environmentId', () => {
    expect(
      browserPortTunnelDescriptorSchema.safeParse({ ...validDescriptor, environmentId: 123 })
        .success
    ).toBe(false)
  })

  it('rejects userinfo (credentials) in remoteOrigin', () => {
    expect(
      browserPortTunnelDescriptorSchema.safeParse({
        ...validDescriptor,
        remoteOrigin: 'http://user:pass@127.0.0.1:5173'
      }).success
    ).toBe(false)
  })

  it('rejects a username-only userinfo in remoteOrigin', () => {
    expect(
      browserPortTunnelDescriptorSchema.safeParse({
        ...validDescriptor,
        remoteOrigin: 'http://user@127.0.0.1:5173'
      }).success
    ).toBe(false)
  })

  it('rejects when remoteOrigin effective port differs from remotePort', () => {
    expect(
      browserPortTunnelDescriptorSchema.safeParse({
        ...validDescriptor,
        remoteOrigin: 'http://127.0.0.1:5173',
        remotePort: 8080
      }).success
    ).toBe(false)
  })

  it('rejects when remoteOrigin has default port 80 but remotePort is 3000', () => {
    expect(
      browserPortTunnelDescriptorSchema.safeParse({
        environmentId: 'env-1',
        worktreeId: 'wt-1',
        remoteOrigin: 'http://example.com',
        remotePort: 3000
      }).success
    ).toBe(false)
  })

  it('accepts when remoteOrigin has default https port and remotePort is 443', () => {
    const result = browserPortTunnelDescriptorSchema.safeParse({
      environmentId: 'env-1',
      worktreeId: 'wt-1',
      remoteOrigin: 'https://example.com',
      remotePort: 443
    })
    expect(result.success).toBe(true)
  })
})

describe('validateBrowserPortTunnelDescriptor', () => {
  it('returns the normalized descriptor on success', () => {
    const result = validateBrowserPortTunnelDescriptor(validDescriptor)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.descriptor.remoteOrigin).toBe('http://127.0.0.1:5173')
    }
  })

  it('returns a bounded reason on failure', () => {
    const result = validateBrowserPortTunnelDescriptor({ ...validDescriptor, remotePort: 'nope' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(typeof result.reason).toBe('string')
    }
  })

  it('trims whitespace in remoteOrigin', () => {
    const result = validateBrowserPortTunnelDescriptor({
      ...validDescriptor,
      remoteOrigin: '  http://127.0.0.1:5173  '
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.descriptor.remoteOrigin).toBe('http://127.0.0.1:5173')
    }
  })

  it('rejects credentials with a bounded reason', () => {
    const result = validateBrowserPortTunnelDescriptor({
      ...validDescriptor,
      remoteOrigin: 'http://user:pass@127.0.0.1:5173'
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain('userinfo')
    }
  })

  it('rejects origin/port mismatch with a bounded reason', () => {
    const result = validateBrowserPortTunnelDescriptor({
      environmentId: 'env-1',
      worktreeId: 'wt-1',
      remoteOrigin: 'http://127.0.0.1:5173',
      remotePort: 8080
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain('remotePort')
    }
  })
})

describe('ownership and restore identification', () => {
  it('identifies a client-owned tunneled page', () => {
    expect(isClientOwnedTunneledPage(null, validDescriptor)).toBe(true)
  })

  it('does not identify a host-owned page as client-owned tunneled', () => {
    expect(isClientOwnedTunneledPage('env-1', validDescriptor)).toBe(false)
  })

  it('does not identify a page without a descriptor', () => {
    expect(isClientOwnedTunneledPage(null, undefined)).toBe(false)
  })

  it('requires tunnel reacquisition only for client-owned tunneled pages', () => {
    expect(pageRequiresTunnelReacquisition(null, validDescriptor)).toBe(true)
    expect(pageRequiresTunnelReacquisition('env-1', validDescriptor)).toBe(false)
    expect(pageRequiresTunnelReacquisition(null, undefined)).toBe(false)
    expect(pageRequiresTunnelReacquisition(undefined, validDescriptor)).toBe(false)
  })

  it('treats an undefined browserRuntimeEnvironmentId as host-owned for restore', () => {
    // Why: undefined is the legacy/inferred-runtime case; the page is not
    // explicitly client-owned, so it must not enter the tunnel restore path.
    expect(pageRequiresTunnelReacquisition(undefined, validDescriptor)).toBe(false)
  })
})
