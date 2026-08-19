import { describe, it, expect } from 'vitest'
import {
  runFallbackFlow,
  runControllerFallback,
  translateLastCommittedUrl
} from './tunnel-fallback-flow'
import {
  FakeBrowserPageStorePort,
  FakeRemoteBrowserFallbackPort,
  makeClientOwnedPage
} from './test-harness'
import type { BrowserPortTunnelDescriptor } from '../../../shared/browser-workspace-types'
import type { NormalizedOrigin } from '../../../shared/browser-port-tunnel-url'
import type { PageLease } from './tunnel-lease-state'

const descriptor: BrowserPortTunnelDescriptor = {
  environmentId: 'env-1',
  worktreeId: 'repo::/srv/app',
  remoteOrigin: 'http://127.0.0.1:5173',
  remotePort: 5173
}

const customDescriptor: BrowserPortTunnelDescriptor = {
  environmentId: 'env-1',
  worktreeId: 'repo::/srv/app',
  remoteOrigin: 'https://local.getmontecarlo.com:3001',
  remotePort: 3001
}

const storedLocalOrigin: NormalizedOrigin = {
  protocol: 'http:',
  hostname: '127.0.0.1',
  port: '5173',
  origin: 'http://127.0.0.1:5173'
}

const customStoredLocalOrigin: NormalizedOrigin = {
  protocol: 'https:',
  hostname: 'local.getmontecarlo.com',
  port: '3001',
  origin: 'https://local.getmontecarlo.com:3001'
}

describe('translateLastCommittedUrl — uses the ACTUAL stored local origin', () => {
  it('translates a local tunnel URL back to the remote origin using the stored origin', () => {
    const url = translateLastCommittedUrl(
      'http://127.0.0.1:5173/app?x=1#frag',
      descriptor,
      storedLocalOrigin
    )
    expect(url).toBe('http://127.0.0.1:5173/app?x=1#frag')
  })
  it('preserves a custom hostname (never reconstructs 127.0.0.1)', () => {
    const url = translateLastCommittedUrl(
      'https://local.getmontecarlo.com:3001/admin',
      customDescriptor,
      customStoredLocalOrigin
    )
    expect(url).toBe('https://local.getmontecarlo.com:3001/admin')
  })
  it('uses the external URL verbatim when the page navigated away', () => {
    const external = 'https://example.com/other'
    expect(translateLastCommittedUrl(external, descriptor, storedLocalOrigin)).toBe(external)
  })
  it('uses the page URL verbatim when localOrigin is null (no stored origin)', () => {
    expect(translateLastCommittedUrl('http://127.0.0.1:5173/', descriptor, null)).toBe(
      'http://127.0.0.1:5173/'
    )
  })
})

describe('runFallbackFlow — success', () => {
  it('creates one remote handle and transitions ownership', async () => {
    const store = new FakeBrowserPageStorePort({ pages: { p1: makeClientOwnedPage() } })
    const fallback = new FakeRemoteBrowserFallbackPort()
    const result = await runFallbackFlow({
      store,
      fallback,
      pageId: 'p1',
      descriptor,
      localOrigin: storedLocalOrigin,
      failureReason: 'dropped'
    })
    expect(result.outcome).toBe('transitioned')
    expect(fallback.calls).toHaveLength(1)
    expect(store.getPage('p1')?.browserRuntimeEnvironmentId).toBe('env-1')
  })
  it('uses the stored custom local origin for URL translation', async () => {
    const store = new FakeBrowserPageStorePort({
      pages: { p1: makeClientOwnedPage({ url: 'https://local.getmontecarlo.com:3001/admin' }) }
    })
    const fallback = new FakeRemoteBrowserFallbackPort()
    await runFallbackFlow({
      store,
      fallback,
      pageId: 'p1',
      descriptor: customDescriptor,
      localOrigin: customStoredLocalOrigin,
      failureReason: 'dropped'
    })
    expect(fallback.calls[0]?.remoteUrl).toBe('https://local.getmontecarlo.com:3001/admin')
  })
})

describe('runFallbackFlow — page gone', () => {
  it('returns page-gone when the page vanished mid-fallback', async () => {
    const store = new FakeBrowserPageStorePort()
    const fallback = new FakeRemoteBrowserFallbackPort()
    const result = await runFallbackFlow({
      store,
      fallback,
      pageId: 'gone',
      descriptor,
      localOrigin: storedLocalOrigin,
      failureReason: 'dropped'
    })
    expect(result.outcome).toBe('page-gone')
    expect(fallback.calls).toHaveLength(0)
  })
})

describe('runFallbackFlow — remote creation failure', () => {
  it('retains the tab + descriptor with a bounded load error', async () => {
    const store = new FakeBrowserPageStorePort({ pages: { p1: makeClientOwnedPage() } })
    const fallback = new FakeRemoteBrowserFallbackPort({ createFailure: 'no runtime browser' })
    const result = await runFallbackFlow({
      store,
      fallback,
      pageId: 'p1',
      descriptor,
      localOrigin: storedLocalOrigin,
      failureReason: 'dropped'
    })
    expect(result.outcome).toBe('retained-with-error')
    expect(store.getPage('p1')).not.toBeNull()
    expect(store.getPage('p1')?.portTunnelDescriptor).toBeDefined()
    expect(store.loadErrors.some((e) => e.pageId === 'p1')).toBe(true)
  })
})

describe('runFallbackFlow — transition failure closes the orphan remote handle', () => {
  it('closes the newly-created remote handle so host resources do not leak', async () => {
    const store = new FakeBrowserPageStorePort({
      pages: { p1: makeClientOwnedPage() },
      transitionFailure: 'environment mismatch'
    })
    const fallback = new FakeRemoteBrowserFallbackPort()
    const result = await runFallbackFlow({
      store,
      fallback,
      pageId: 'p1',
      descriptor,
      localOrigin: storedLocalOrigin,
      failureReason: 'dropped'
    })
    expect(result.outcome).toBe('retained-with-error')
    expect(fallback.closedHandles).toHaveLength(1)
    expect(store.loadErrors.some((e) => e.pageId === 'p1')).toBe(true)
  })
})

describe('runControllerFallback — releases the dead lease set exactly once on every path', () => {
  const leases: PageLease[] = [
    { leaseId: 'L-sel', localOrigin: storedLocalOrigin, kind: 'selected' },
    { leaseId: 'L-c1', localOrigin: storedLocalOrigin, kind: 'companion' }
  ]

  it('releases selected + companion leases after a successful transition', async () => {
    const store = new FakeBrowserPageStorePort({ pages: { p1: makeClientOwnedPage() } })
    const fallback = new FakeRemoteBrowserFallbackPort()
    const released: string[] = []
    const result = await runControllerFallback({
      store,
      fallback,
      pageId: 'p1',
      descriptor,
      localOrigin: storedLocalOrigin,
      failureReason: 'dropped',
      releaseLeases: async (l) => {
        for (const x of l) {
          released.push(x.leaseId)
        }
      },
      clearLeases: () => leases
    })
    expect(result.outcome).toBe('fallback')
    expect(released).toEqual(['L-sel', 'L-c1'])
  })
  it('releases the dead lease set even when remote creation fails', async () => {
    const store = new FakeBrowserPageStorePort({ pages: { p1: makeClientOwnedPage() } })
    const fallback = new FakeRemoteBrowserFallbackPort({ createFailure: 'no runtime' })
    const released: string[] = []
    const result = await runControllerFallback({
      store,
      fallback,
      pageId: 'p1',
      descriptor,
      localOrigin: storedLocalOrigin,
      failureReason: 'dropped',
      releaseLeases: async (l) => {
        for (const x of l) {
          released.push(x.leaseId)
        }
      },
      clearLeases: () => leases
    })
    expect(result.outcome).toBe('retained-with-error')
    expect(released).toEqual(['L-sel', 'L-c1'])
  })
  it('releases the dead lease set even when transition fails', async () => {
    const store = new FakeBrowserPageStorePort({
      pages: { p1: makeClientOwnedPage() },
      transitionFailure: 'mismatch'
    })
    const fallback = new FakeRemoteBrowserFallbackPort()
    const released: string[] = []
    const result = await runControllerFallback({
      store,
      fallback,
      pageId: 'p1',
      descriptor,
      localOrigin: storedLocalOrigin,
      failureReason: 'dropped',
      releaseLeases: async (l) => {
        for (const x of l) {
          released.push(x.leaseId)
        }
      },
      clearLeases: () => leases
    })
    expect(result.outcome).toBe('retained-with-error')
    expect(released).toEqual(['L-sel', 'L-c1'])
  })
})
