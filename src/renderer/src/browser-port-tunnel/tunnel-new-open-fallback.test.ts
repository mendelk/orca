import { describe, it, expect } from 'vitest'
import { runNewOpenFallback } from './tunnel-new-open-fallback'
import { FakeBrowserPageStorePort, FakeRemoteBrowserFallbackPort, makePlan } from './test-harness'

describe('runNewOpenFallback — success creates one host-owned remote page', () => {
  it('returns fallback-to-remote with a unique generated page id', async () => {
    const store = new FakeBrowserPageStorePort()
    const fallback = new FakeRemoteBrowserFallbackPort()
    const result = await runNewOpenFallback({
      store,
      fallback,
      workspaceId: 'ws-1',
      worktreeId: 'repo::/srv/app',
      plan: makePlan(),
      failureReason: 'selected port occupied'
    })
    expect(result.outcome).toBe('fallback-to-remote')
    if (result.outcome === 'fallback-to-remote') {
      const page = store.getPage(result.pageId)
      expect(page).not.toBeNull()
      expect(page?.browserRuntimeEnvironmentId).toBe('env-1')
      expect(page?.workspaceId).toBe('ws-1')
      expect(page?.worktreeId).toBe('repo::/srv/app')
      expect(page?.portTunnelDescriptor).toBeDefined()
    }
    expect(fallback.calls).toHaveLength(1)
  })
})

describe('runNewOpenFallback — remote creation failure returns bounded result', () => {
  it('returns retained-with-error', async () => {
    const store = new FakeBrowserPageStorePort()
    const fallback = new FakeRemoteBrowserFallbackPort({ createFailure: 'no runtime browser' })
    const result = await runNewOpenFallback({
      store,
      fallback,
      workspaceId: 'ws-1',
      worktreeId: 'repo::/srv/app',
      plan: makePlan(),
      failureReason: 'selected port occupied'
    })
    expect(result.outcome).toBe('retained-with-error')
    if (result.outcome === 'retained-with-error') {
      expect(result.reason).toContain('selected port occupied')
      expect(result.reason).toContain('no runtime browser')
    }
  })
})

describe('runNewOpenFallback — store creation failure closes the orphan remote handle', () => {
  it('closes the orphan remote handle and returns retained-with-error', async () => {
    const store = new FakeBrowserPageStorePort({ hostOwnedCreateFailure: 'store error' })
    const fallback = new FakeRemoteBrowserFallbackPort()
    const result = await runNewOpenFallback({
      store,
      fallback,
      workspaceId: 'ws-1',
      worktreeId: 'repo::/srv/app',
      plan: makePlan(),
      failureReason: 'selected port occupied'
    })
    expect(result.outcome).toBe('retained-with-error')
    expect(fallback.closedHandles).toHaveLength(1)
  })
})

describe('runNewOpenFallback — acquire rejection is caught', () => {
  it('returns retained-with-error on acquire throw', async () => {
    const store = new FakeBrowserPageStorePort()
    const fallback = new FakeRemoteBrowserFallbackPort()
    fallback.createRemoteBrowserPage = async () => {
      throw new Error('IPC disconnected')
    }
    const result = await runNewOpenFallback({
      store,
      fallback,
      workspaceId: 'ws-1',
      worktreeId: 'repo::/srv/app',
      plan: makePlan(),
      failureReason: 'selected port occupied'
    })
    expect(result.outcome).toBe('retained-with-error')
    if (result.outcome === 'retained-with-error') {
      expect(result.reason).toContain('IPC disconnected')
    }
  })
})
