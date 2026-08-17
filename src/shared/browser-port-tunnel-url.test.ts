import { describe, it, expect } from 'vitest'
import {
  isSameTunnelOrigin,
  normalizeLocalOrigin,
  normalizeOrigin,
  remoteOriginForDescriptor,
  translateLocalUrlToRemote,
  translateRemoteUrlToLocal
} from './browser-port-tunnel-url'
import type { BrowserPortTunnelDescriptor } from './browser-workspace-types'

const descriptor: BrowserPortTunnelDescriptor = {
  environmentId: 'env-1',
  worktreeId: 'repo::/srv/app',
  remoteOrigin: 'http://127.0.0.1:5173',
  remotePort: 5173
}

const customHostDescriptor: BrowserPortTunnelDescriptor = {
  environmentId: 'env-1',
  worktreeId: 'repo::/srv/app',
  remoteOrigin: 'https://local.getmontecarlo.com:3001',
  remotePort: 3001
}

const localOrigin = normalizeLocalOrigin('http://127.0.0.1:5173')!
const customLocalOrigin = normalizeLocalOrigin('https://local.getmontecarlo.com:3001')!

describe('normalizeOrigin', () => {
  it('parses an http origin', () => {
    expect(normalizeOrigin('http://127.0.0.1:5173')?.origin).toBe('http://127.0.0.1:5173')
  })

  it('parses an https origin with default port', () => {
    const origin = normalizeOrigin('https://example.com')
    expect(origin?.protocol).toBe('https:')
    expect(origin?.port).toBe('')
  })

  it('returns null for non-http(s)', () => {
    expect(normalizeOrigin('ftp://127.0.0.1:21')).toBeNull()
  })

  it('returns null for invalid input', () => {
    expect(normalizeOrigin('not-a-url')).toBeNull()
  })
})

describe('normalizeLocalOrigin', () => {
  it('parses a loopback local origin', () => {
    const origin = normalizeLocalOrigin('http://127.0.0.1:5173')
    expect(origin?.hostname).toBe('127.0.0.1')
    expect(origin?.port).toBe('5173')
  })

  it('preserves a custom loopback hostname for Host headers/cookies/TLS SNI', () => {
    const origin = normalizeLocalOrigin('https://local.getmontecarlo.com:3001')
    expect(origin?.hostname).toBe('local.getmontecarlo.com')
    expect(origin?.origin).toBe('https://local.getmontecarlo.com:3001')
  })

  it('returns null for invalid input', () => {
    expect(normalizeLocalOrigin('not-a-url')).toBeNull()
  })
})

describe('remoteOriginForDescriptor', () => {
  it('builds the remote origin with explicit port', () => {
    const origin = remoteOriginForDescriptor(descriptor)
    expect(origin.origin).toBe('http://127.0.0.1:5173')
    expect(origin.port).toBe('5173')
  })

  it('preserves a custom hostname', () => {
    const origin = remoteOriginForDescriptor(customHostDescriptor)
    expect(origin.hostname).toBe('local.getmontecarlo.com')
    expect(origin.origin).toBe('https://local.getmontecarlo.com:3001')
  })

  it('uses the descriptor remotePort when the origin omits the port', () => {
    const defaultPortDescriptor: BrowserPortTunnelDescriptor = {
      environmentId: 'env-1',
      worktreeId: 'wt-1',
      remoteOrigin: 'https://example.com',
      remotePort: 443
    }
    const origin = remoteOriginForDescriptor(defaultPortDescriptor)
    expect(origin.port).toBe('443')
    expect(origin.origin).toBe('https://example.com:443')
  })
})

describe('translateLocalUrlToRemote', () => {
  it('translates a local tunnel URL back to the remote origin, preserving path/query/fragment', () => {
    const remote = translateLocalUrlToRemote(
      'http://127.0.0.1:5173/app/page?x=1#frag',
      descriptor,
      localOrigin
    )
    expect(remote).toBe('http://127.0.0.1:5173/app/page?x=1#frag')
  })

  it('translates a localhost alias of the tunnel origin', () => {
    const remote = translateLocalUrlToRemote('http://localhost:5173/?q=1', descriptor, localOrigin)
    expect(remote).toBe('http://127.0.0.1:5173/?q=1')
  })

  it('preserves an empty path as a trailing slash', () => {
    const remote = translateLocalUrlToRemote('http://127.0.0.1:5173/', descriptor, localOrigin)
    expect(remote).toBe('http://127.0.0.1:5173/')
  })

  it('returns null when the URL is on a different origin (cross-site navigation)', () => {
    expect(
      translateLocalUrlToRemote('https://example.com/path', descriptor, localOrigin)
    ).toBeNull()
  })

  it('returns null when the local port does not match the tunnel listener', () => {
    expect(
      translateLocalUrlToRemote('http://127.0.0.1:6000/app', descriptor, localOrigin)
    ).toBeNull()
  })

  it('returns null for an invalid URL', () => {
    expect(translateLocalUrlToRemote('not-a-url', descriptor, localOrigin)).toBeNull()
  })

  it('translates a custom-hostname descriptor back to the custom hostname', () => {
    const remote = translateLocalUrlToRemote(
      'https://local.getmontecarlo.com:3001/admin?tab=1',
      customHostDescriptor,
      customLocalOrigin
    )
    expect(remote).toBe('https://local.getmontecarlo.com:3001/admin?tab=1')
  })

  it('preserves a custom loopback hostname from localOrigin through translation', () => {
    // Why: the local tunnel bound a custom hostname; the local URL carries
    // that hostname and must still translate back to the remote origin.
    const customLocal = normalizeLocalOrigin('https://local.getmontecarlo.com:3001')!
    const remote = translateLocalUrlToRemote(
      'https://local.getmontecarlo.com:3001/dashboard',
      customHostDescriptor,
      customLocal
    )
    expect(remote).toBe('https://local.getmontecarlo.com:3001/dashboard')
  })
})

describe('translateRemoteUrlToLocal', () => {
  it('translates a remote URL to the local tunnel origin, preserving path/query/fragment', () => {
    const local = translateRemoteUrlToLocal(
      'http://127.0.0.1:5173/app?x=1#frag',
      descriptor,
      localOrigin
    )
    expect(local).toBe('http://127.0.0.1:5173/app?x=1#frag')
  })

  it('translates a custom-hostname remote URL to the custom-hostname local origin', () => {
    const local = translateRemoteUrlToLocal(
      'https://local.getmontecarlo.com:3001/admin',
      customHostDescriptor,
      customLocalOrigin
    )
    expect(local).toBe('https://local.getmontecarlo.com:3001/admin')
  })

  it('returns null when the remote URL is on a different origin', () => {
    expect(
      translateRemoteUrlToLocal('https://example.com:5173/', descriptor, localOrigin)
    ).toBeNull()
  })

  it('returns null when the remote port does not match the descriptor', () => {
    expect(translateRemoteUrlToLocal('http://127.0.0.1:6000/', descriptor, localOrigin)).toBeNull()
  })

  it('returns null for an invalid URL', () => {
    expect(translateRemoteUrlToLocal('not-a-url', descriptor, localOrigin)).toBeNull()
  })

  it('matches a default-port remote URL when the descriptor uses that default port', () => {
    const defaultPortDescriptor: BrowserPortTunnelDescriptor = {
      environmentId: 'env-1',
      worktreeId: 'wt-1',
      remoteOrigin: 'https://example.com',
      remotePort: 443
    }
    // Why: URL.origin normalizes away the default port, so the local origin
    // string omits :443; translation preserves the localOrigin.origin form.
    const defaultLocalOrigin = normalizeLocalOrigin('https://127.0.0.1')!
    const local = translateRemoteUrlToLocal(
      'https://example.com/path',
      defaultPortDescriptor,
      defaultLocalOrigin
    )
    expect(local).toBe('https://127.0.0.1/path')
  })
})

describe('isSameTunnelOrigin', () => {
  it('matches equivalent origins', () => {
    const a = normalizeOrigin('http://127.0.0.1:5173')
    const b = normalizeOrigin('http://127.0.0.1:5173')
    expect(isSameTunnelOrigin(a, b)).toBe(true)
  })

  it('distinguishes different ports', () => {
    const a = normalizeOrigin('http://127.0.0.1:5173')
    const b = normalizeOrigin('http://127.0.0.1:6000')
    expect(isSameTunnelOrigin(a, b)).toBe(false)
  })

  it('treats null origins as non-matching', () => {
    expect(isSameTunnelOrigin(null, normalizeOrigin('http://127.0.0.1:5173'))).toBe(false)
  })
})
