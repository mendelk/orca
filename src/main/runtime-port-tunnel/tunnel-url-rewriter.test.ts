import { describe, expect, it, vi } from 'vitest'
import {
  rewriteTunnelUrl,
  rewriteTunnelUrlWithLookup,
  translateLocalUrlToRemote,
  type DnsProbe
} from './tunnel-url-rewriter'

const stubDns = (addresses: string[] | Error): DnsProbe => ({
  resolveAll: vi.fn(async () => {
    if (addresses instanceof Error) {
      throw addresses
    }
    return addresses
  })
})

describe('rewriteTunnelUrl — wildcard and loopback', () => {
  it('rewrites 0.0.0.0 origin to 127.0.0.1 same port, preserving path/query/fragment', async () => {
    const result = await rewriteTunnelUrl('http://0.0.0.0:5173/app?x=1#frag', 5173, stubDns([]))
    expect(result).toEqual({
      ok: true,
      localUrl: 'http://127.0.0.1:5173/app?x=1#frag',
      bindHost: '127.0.0.1',
      urlHost: '127.0.0.1'
    })
  })
  it('rewrites localhost origin preserving https and path', async () => {
    const result = await rewriteTunnelUrl('https://localhost:3000/api/v1', 3000, stubDns([]))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.localUrl).toBe('https://127.0.0.1:3000/api/v1')
      expect(result.bindHost).toBe('127.0.0.1')
      expect(result.urlHost).toBe('127.0.0.1')
    }
  })
  it('rewrites :: wildcard', async () => {
    const result = await rewriteTunnelUrl('http://[::]:8080/', 8080, stubDns([]))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.localUrl).toBe('http://127.0.0.1:8080/')
    }
  })
  it('keeps explicit 127.0.0.1 origin on same port', async () => {
    const result = await rewriteTunnelUrl('http://127.0.0.1:4173/', 4173, stubDns([]))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.localUrl).toBe('http://127.0.0.1:4173/')
    }
  })
  it('uses the scanned remote port when the URL omits one', async () => {
    const result = await rewriteTunnelUrl('https://0.0.0.0/path', 8443, stubDns([]))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.localUrl).toBe('https://127.0.0.1:8443/path')
      expect(result.bindHost).toBe('127.0.0.1')
    }
  })
  it('uses the scanned remote port instead of a stale advertised port', async () => {
    const result = await rewriteTunnelUrl('http://localhost:3000/', 5173, stubDns([]))
    expect(result.ok && result.localUrl).toBe('http://127.0.0.1:5173/')
  })
})

describe('rewriteTunnelUrl — custom DNS hostname', () => {
  it('preserves hostname when DNS resolves exclusively to 127.0.0.1', async () => {
    const result = await rewriteTunnelUrlWithLookup(
      'http://dev.local:5173/',
      5173,
      async () => ['127.0.0.1']
    )
    expect(result).toEqual({
      ok: true,
      localUrl: 'http://dev.local:5173/',
      bindHost: '127.0.0.1',
      urlHost: 'dev.local'
    })
  })
  it('rejects ::1-only resolution because the listener binds IPv4', async () => {
    const result = await rewriteTunnelUrlWithLookup(
      'http://dev.local:5173/',
      5173,
      async () => ['::1']
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('non-loopback-dns')
    }
  })
  it('rejects when DNS resolves to a mix of loopback and non-loopback', async () => {
    const result = await rewriteTunnelUrlWithLookup(
      'http://dev.local:5173/',
      5173,
      async () => ['127.0.0.1', '10.0.0.1']
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('non-loopback-dns')
    }
  })
  it('rejects when DNS resolves to non-loopback only', async () => {
    const result = await rewriteTunnelUrlWithLookup(
      'http://dev.local:5173/',
      5173,
      async () => ['10.0.0.1']
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('non-loopback-dns')
    }
  })
  it('rejects when DNS returns no addresses', async () => {
    const result = await rewriteTunnelUrlWithLookup(
      'http://dev.local:5173/',
      5173,
      async () => []
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('non-loopback-dns')
    }
  })
  it('rejects when DNS lookup throws', async () => {
    const result = await rewriteTunnelUrlWithLookup(
      'http://dev.local:5173/',
      5173,
      async () => {
        throw new Error('ENOTFOUND')
      }
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('non-loopback-dns')
      expect(result.detail).toContain('ENOTFOUND')
    }
  })
})

describe('rewriteTunnelUrl — IP literal rejection', () => {
  it('rejects private IPv4 literal', async () => {
    const result = await rewriteTunnelUrl('http://10.0.0.1:5173/', 5173, stubDns([]))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('private-or-public-ip-literal')
    }
  })
  it('rejects public IPv4 literal', async () => {
    const result = await rewriteTunnelUrl('http://8.8.8.8:5173/', 5173, stubDns([]))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('private-or-public-ip-literal')
    }
  })
  it('rejects non-loopback IPv6 literal', async () => {
    const result = await rewriteTunnelUrl('http://[fe80::1]:5173/', 5173, stubDns([]))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('private-or-public-ip-literal')
    }
  })
})

describe('rewriteTunnelUrl — invalid input', () => {
  it('rejects an invalid URL', async () => {
    const result = await rewriteTunnelUrl('not-a-url', 5173, stubDns([]))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('invalid-url')
    }
  })
  it('rejects an unsupported protocol', async () => {
    const result = await rewriteTunnelUrl('ftp://0.0.0.0:5173/', 5173, stubDns([]))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('unsupported-protocol')
    }
  })
  it('rejects an out-of-range port', async () => {
    const result = await rewriteTunnelUrl('http://0.0.0.0:99999/', 99999, stubDns([]))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('missing-port')
    }
  })
})

describe('translateLocalUrlToRemote', () => {
  it('preserves path/query/fragment when translating back to remote origin', () => {
    const remote = translateLocalUrlToRemote(
      'http://127.0.0.1:5173/app?x=1#frag',
      'http://0.0.0.0:5173/'
    )
    expect(remote).toBe('http://0.0.0.0:5173/app?x=1#frag')
  })
  it('preserves https remote origin', () => {
    const remote = translateLocalUrlToRemote(
      'https://dev.local:3000/api?token=abc',
      'https://0.0.0.0:3000/'
    )
    expect(remote).toBe('https://0.0.0.0:3000/api?token=abc')
  })
  it('returns null for an invalid local URL', () => {
    expect(translateLocalUrlToRemote('not-a-url', 'http://0.0.0.0:5173/')).toBeNull()
  })
  it('returns null for an invalid remote origin', () => {
    expect(translateLocalUrlToRemote('http://127.0.0.1:5173/', 'not-a-url')).toBeNull()
  })
})
