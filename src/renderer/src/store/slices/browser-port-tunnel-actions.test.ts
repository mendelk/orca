import { describe, it, expect } from 'vitest'
import {
  createClientOwnedTunneledPage,
  identifyTunnelRestorePages,
  releaseTunnelLeaseIntentForClose,
  releaseTunnelLeaseIntentForOwnershipTransition,
  retainDescriptorForRetry,
  transitionPageToHostOwnedRemoteHandle,
  type RemoteBrowserPageHandle as TunnelRemoteHandle
} from './browser-port-tunnel-actions'
import { normalizeLocalOrigin } from '../../../../shared/browser-port-tunnel-url'
import type {
  BrowserPage,
  BrowserPortTunnelDescriptor
} from '../../../../shared/browser-workspace-types'

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

function basePage(overrides: Partial<BrowserPage> = {}): BrowserPage {
  return {
    id: 'page-1',
    workspaceId: 'ws-1',
    worktreeId: 'repo::/srv/app',
    url: 'http://127.0.0.1:5173/app?x=1#frag',
    title: 'App',
    loading: true,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 100,
    browserRuntimeEnvironmentId: null,
    portTunnelDescriptor: descriptor,
    ...overrides
  }
}

describe('createClientOwnedTunneledPage', () => {
  it('creates a client-owned page carrying the descriptor and a translated local URL', () => {
    const result = createClientOwnedTunneledPage({
      pageId: 'page-1',
      workspaceId: 'ws-1',
      worktreeId: 'repo::/srv/app',
      descriptor,
      remoteUrl: 'http://127.0.0.1:5173/app?x=1#frag',
      localOrigin
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.page.browserRuntimeEnvironmentId).toBe(null)
      expect(result.page.portTunnelDescriptor).toEqual(descriptor)
      expect(result.page.url).toBe('http://127.0.0.1:5173/app?x=1#frag')
      expect(result.page.worktreeId).toBe('repo::/srv/app')
    }
  })

  it('returns a bounded failure when the remote URL is on a different origin', () => {
    // Why: translation failure must NOT silently fall back to a bare local
    // origin; return a bounded failure so the caller surfaces the mismatch.
    const result = createClientOwnedTunneledPage({
      pageId: 'page-1',
      workspaceId: 'ws-1',
      worktreeId: 'repo::/srv/app',
      descriptor,
      remoteUrl: 'https://example.com:5173/app',
      localOrigin
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain('cannot translate')
    }
  })

  it('rejects a descriptor whose worktreeId does not match the page worktreeId', () => {
    const result = createClientOwnedTunneledPage({
      pageId: 'page-1',
      workspaceId: 'ws-1',
      worktreeId: 'different-wt',
      descriptor,
      remoteUrl: 'http://127.0.0.1:5173/',
      localOrigin
    })
    expect(result.ok).toBe(false)
  })

  it('rejects an invalid descriptor', () => {
    const result = createClientOwnedTunneledPage({
      pageId: 'page-1',
      workspaceId: 'ws-1',
      worktreeId: 'repo::/srv/app',
      descriptor: { ...descriptor, remotePort: 0 },
      remoteUrl: 'http://127.0.0.1:5173/',
      localOrigin
    })
    expect(result.ok).toBe(false)
  })

  it('preserves path/query/fragment through translation', () => {
    const result = createClientOwnedTunneledPage({
      pageId: 'page-1',
      workspaceId: 'ws-1',
      worktreeId: 'repo::/srv/app',
      descriptor,
      remoteUrl: 'http://127.0.0.1:5173/admin/users?page=2#top',
      localOrigin
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.page.url).toBe('http://127.0.0.1:5173/admin/users?page=2#top')
    }
  })

  it('preserves a custom loopback hostname from localOrigin', () => {
    const result = createClientOwnedTunneledPage({
      pageId: 'page-1',
      workspaceId: 'ws-1',
      worktreeId: 'repo::/srv/app',
      descriptor: customHostDescriptor,
      remoteUrl: 'https://local.getmontecarlo.com:3001/dashboard',
      localOrigin: customLocalOrigin
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      // Why: the local URL uses the custom hostname supplied by localOrigin,
      // not a hardcoded 127.0.0.1 — Host headers, cookies, and TLS SNI depend
      // on the correct hostname reaching the webview.
      expect(result.page.url).toBe('https://local.getmontecarlo.com:3001/dashboard')
    }
  })

  it('reports the effective port when the local origin omits a default port', () => {
    const defaultPortDescriptor: BrowserPortTunnelDescriptor = {
      ...descriptor,
      remoteOrigin: 'https://secure.local',
      remotePort: 443
    }
    const result = createClientOwnedTunneledPage({
      pageId: 'page-1',
      workspaceId: 'ws-1',
      worktreeId: descriptor.worktreeId,
      descriptor: defaultPortDescriptor,
      remoteUrl: 'https://secure.local/app',
      localOrigin: normalizeLocalOrigin('https://secure.local')!
    })
    expect(result.ok && result.localPort).toBe(443)
  })
})

describe('transitionPageToHostOwnedRemoteHandle', () => {
  it('atomically transitions to host-owned, retaining the descriptor for retry', () => {
    const handle: TunnelRemoteHandle = { environmentId: 'env-1', remotePageId: 'remote-1' }
    const result = transitionPageToHostOwnedRemoteHandle({
      page: basePage(),
      descriptor,
      localOrigin,
      remoteHandle: handle,
      remoteHandleError: null
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.page.browserRuntimeEnvironmentId).toBe('env-1')
      expect(result.page.portTunnelDescriptor).toEqual(descriptor)
      expect(result.page.url).toBe('http://127.0.0.1:5173/app?x=1#frag')
      expect(result.remoteUrl).toBe('http://127.0.0.1:5173/app?x=1#frag')
      expect(result.handle).toEqual(handle)
    }
  })

  it('fails without losing the tab when remote creation failed', () => {
    const original = basePage()
    const result = transitionPageToHostOwnedRemoteHandle({
      page: original,
      descriptor,
      localOrigin,
      remoteHandle: null,
      remoteHandleError: 'runtime browser unavailable'
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('runtime browser unavailable')
      expect(result.page).toBe(original)
    }
  })

  it('fails when the remote handle environmentId does not match the descriptor', () => {
    const result = transitionPageToHostOwnedRemoteHandle({
      page: basePage(),
      descriptor,
      localOrigin,
      remoteHandle: { environmentId: 'other-env', remotePageId: 'remote-1' },
      remoteHandleError: null
    })
    expect(result.ok).toBe(false)
  })

  it('uses the external URL verbatim when the page navigated away from the tunneled origin', () => {
    // Why: the design requires fallback to use the external URL verbatim when
    // the page navigated away, rather than failing and losing the tab.
    const externalUrl = 'https://example.com/other'
    const result = transitionPageToHostOwnedRemoteHandle({
      page: basePage({ url: externalUrl }),
      descriptor,
      localOrigin,
      remoteHandle: { environmentId: 'env-1', remotePageId: 'remote-1' },
      remoteHandleError: null
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.page.url).toBe(externalUrl)
      expect(result.remoteUrl).toBe(externalUrl)
      expect(result.page.portTunnelDescriptor).toEqual(descriptor)
    }
  })
})

describe('retainDescriptorForRetry', () => {
  it('returns a page with the descriptor retained', () => {
    const page = basePage({ portTunnelDescriptor: undefined })
    const result = retainDescriptorForRetry(page, descriptor)
    expect(result.portTunnelDescriptor).toEqual(descriptor)
  })

  it('overwrites an existing descriptor', () => {
    const page = basePage()
    const newDescriptor: BrowserPortTunnelDescriptor = { ...descriptor, remotePort: 6000 }
    const result = retainDescriptorForRetry(page, newDescriptor)
    expect(result.portTunnelDescriptor).toEqual(newDescriptor)
  })
})

describe('identifyTunnelRestorePages', () => {
  it('selects only client-owned pages with a descriptor', () => {
    const pages = [
      basePage({ id: 'client-owned', browserRuntimeEnvironmentId: null }),
      basePage({ id: 'host-owned', browserRuntimeEnvironmentId: 'env-1' }),
      basePage({ id: 'no-descriptor', portTunnelDescriptor: undefined }),
      basePage({
        id: 'legacy',
        browserRuntimeEnvironmentId: undefined,
        portTunnelDescriptor: undefined
      })
    ]
    const result = identifyTunnelRestorePages(pages)
    expect(result.map((p) => p.id)).toEqual(['client-owned'])
  })

  it('returns an empty list when no pages need reacquisition', () => {
    expect(identifyTunnelRestorePages([])).toEqual([])
  })
})

describe('release intents', () => {
  it('builds a close release intent for a client-owned tunneled page', () => {
    const intent = releaseTunnelLeaseIntentForClose(basePage())
    expect(intent?.reason).toBe('close')
    expect(intent?.pageId).toBe('page-1')
    expect(intent?.descriptor).toEqual(descriptor)
  })

  it('returns null for a page without a descriptor', () => {
    expect(
      releaseTunnelLeaseIntentForClose(basePage({ portTunnelDescriptor: undefined }))
    ).toBeNull()
  })

  it('suppresses close intent for a host-owned fallback page that retains the descriptor', () => {
    // Why: release intents must only be emitted for client-owned pages with an
    // active tunnel intent, not host-owned fallback pages that merely retain
    // the descriptor for retry.
    const hostOwned = basePage({ browserRuntimeEnvironmentId: 'env-1' })
    expect(releaseTunnelLeaseIntentForClose(hostOwned)).toBeNull()
  })

  it('builds an ownership-transition release intent for a client-owned tunneled page', () => {
    const intent = releaseTunnelLeaseIntentForOwnershipTransition(basePage())
    expect(intent?.reason).toBe('ownership-transition')
    expect(intent?.descriptor).toEqual(descriptor)
  })

  it('returns null for an ownership-transition intent when no descriptor', () => {
    expect(
      releaseTunnelLeaseIntentForOwnershipTransition(basePage({ portTunnelDescriptor: undefined }))
    ).toBeNull()
  })

  it('suppresses ownership-transition intent for a host-owned page', () => {
    const hostOwned = basePage({ browserRuntimeEnvironmentId: 'env-1' })
    expect(releaseTunnelLeaseIntentForOwnershipTransition(hostOwned)).toBeNull()
  })
})
