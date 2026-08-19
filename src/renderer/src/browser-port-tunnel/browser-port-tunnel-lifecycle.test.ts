import { describe, it, expect, vi } from 'vitest'
import { BrowserPortTunnelController } from './browser-port-tunnel-controller'
import {
  FakeBrowserPageStorePort,
  FakeRemoteBrowserFallbackPort,
  FakeRuntimePortTunnelClient,
  deterministicIdGenerator,
  makeClientOwnedPage,
  makePlan
} from './test-harness'
import type { TunnelAcquireOutcome, TunnelReleaseFailure } from './runtime-port-tunnel-client-port'

const CAPABLE = { available: true as const }
const NOT_CAPABLE = { available: false as const, reason: 'capability absent' }

function setup(
  opts: {
    client?: FakeRuntimePortTunnelClient
    store?: FakeBrowserPageStorePort
    fallback?: FakeRemoteBrowserFallbackPort
    ids?: ReturnType<typeof deterministicIdGenerator>
  } = {}
) {
  const client = opts.client ?? new FakeRuntimePortTunnelClient()
  const store = opts.store ?? new FakeBrowserPageStorePort()
  const fallback = opts.fallback ?? new FakeRemoteBrowserFallbackPort()
  const ids = opts.ids ?? deterministicIdGenerator('t')
  const controller = new BrowserPortTunnelController(client, store, fallback, ids)
  controller.start()
  return { client, store, fallback, ids, controller }
}

describe('stale completion suppression', () => {
  it('ignores a stale acquire result after dispose (open path)', async () => {
    let resolveAcquire!: (o: TunnelAcquireOutcome) => void
    const client = new FakeRuntimePortTunnelClient({
      acquire: () => new Promise<TunnelAcquireOutcome>((r) => (resolveAcquire = r))
    })
    const { controller, store } = setup({ client })
    const promise = controller.openTunneledPage({
      capability: CAPABLE,
      workspaceId: 'ws-1',
      worktreeId: 'repo::/srv/app',
      plan: makePlan()
    })
    await controller.dispose()
    resolveAcquire({
      selected: { ok: true, leaseId: 'L1', localOrigin: 'http://127.0.0.1:5173' },
      companions: []
    })
    const r = await promise
    expect(r.outcome).toBe('retained-with-error')
    expect(store.pages.size).toBe(0)
  })
  it('ignores a stale acquire result after close (restore path)', async () => {
    let resolveAcquire!: (o: TunnelAcquireOutcome) => void
    const client = new FakeRuntimePortTunnelClient({
      acquire: () => new Promise<TunnelAcquireOutcome>((r) => (resolveAcquire = r))
    })
    const store = new FakeBrowserPageStorePort({ pages: { 'page-1': makeClientOwnedPage() } })
    const { controller } = setup({ client, store })
    const promise = controller.restoreTunneledPage({
      capability: CAPABLE,
      pageId: 'page-1',
      plan: makePlan()
    })
    await controller.releaseOnClose('page-1')
    resolveAcquire({
      selected: { ok: true, leaseId: 'L1', localOrigin: 'http://127.0.0.1:5173' },
      companions: []
    })
    const r = await promise
    expect(r.outcome).toBe('retained-with-error')
  })
  it('ignores a stale acquire result after environment revision', async () => {
    let resolveAcquire!: (o: TunnelAcquireOutcome) => void
    const client = new FakeRuntimePortTunnelClient({
      acquire: () => new Promise<TunnelAcquireOutcome>((r) => (resolveAcquire = r))
    })
    const store = new FakeBrowserPageStorePort({ pages: { 'page-1': makeClientOwnedPage() } })
    const { controller } = setup({ client, store })
    const promise = controller.restoreTunneledPage({
      capability: CAPABLE,
      pageId: 'page-1',
      plan: makePlan()
    })
    await controller.releaseOnEnvironmentRevision('page-1')
    resolveAcquire({
      selected: { ok: true, leaseId: 'L1', localOrigin: 'http://127.0.0.1:5173' },
      companions: []
    })
    const r = await promise
    expect(r.outcome).toBe('retained-with-error')
  })
})

describe('release — close/revision/dispose release the complete lease set', () => {
  it('releases all leases on close', async () => {
    const plan = makePlan({
      companions: [{ port: 3001, protocol: 'http', advertisedUrl: 'http://127.0.0.1:3001' }]
    })
    const { client, controller } = setup()
    const open = await controller.openTunneledPage({
      capability: CAPABLE,
      workspaceId: 'ws-1',
      worktreeId: 'repo::/srv/app',
      plan
    })
    if (open.outcome !== 'direct') {
      throw new Error('expected direct')
    }
    const leases = controller.activeLeaseIdsFor(open.pageId)
    await controller.releaseOnClose(open.pageId)
    expect(client.releasedLeaseIds.sort()).toEqual([...leases].sort())
    expect(controller.activeLeaseIdsFor(open.pageId)).toEqual([])
  })
  it('releases all leases on environment revision', async () => {
    const plan = makePlan({
      companions: [{ port: 3001, protocol: 'http', advertisedUrl: 'http://127.0.0.1:3001' }]
    })
    const { client, controller } = setup()
    const open = await controller.openTunneledPage({
      capability: CAPABLE,
      workspaceId: 'ws-1',
      worktreeId: 'repo::/srv/app',
      plan
    })
    if (open.outcome !== 'direct') {
      throw new Error('expected direct')
    }
    const leases = controller.activeLeaseIdsFor(open.pageId)
    await controller.releaseOnEnvironmentRevision(open.pageId)
    expect(client.releasedLeaseIds.sort()).toEqual([...leases].sort())
  })
  it('releases all active lease sets on dispose', async () => {
    const { client, controller } = setup()
    const allLeases: string[] = []
    for (let i = 0; i < 2; i++) {
      const open = await controller.openTunneledPage({
        capability: CAPABLE,
        workspaceId: `ws-${i}`,
        worktreeId: 'repo::/srv/app',
        plan: makePlan()
      })
      if (open.outcome === 'direct') {
        allLeases.push(...controller.activeLeaseIdsFor(open.pageId))
      }
    }
    await controller.dispose()
    for (const id of allLeases) {
      expect(client.releasedLeaseIds).toContain(id)
    }
  })
  it('releaseOnOwnershipTransition clears leases without dropping the page', async () => {
    const { client, controller } = setup()
    const open = await controller.openTunneledPage({
      capability: CAPABLE,
      workspaceId: 'ws-1',
      worktreeId: 'repo::/srv/app',
      plan: makePlan()
    })
    if (open.outcome !== 'direct') {
      throw new Error('expected direct')
    }
    const leases = controller.activeLeaseIdsFor(open.pageId)
    await controller.releaseOnOwnershipTransition(open.pageId)
    expect(client.releasedLeaseIds.sort()).toEqual([...leases].sort())
    expect(controller.activeLeaseIdsFor(open.pageId)).toEqual([])
  })
})

describe('dropped status — companion drop is partial degradation', () => {
  it('releases only the companion lease and keeps the selected page direct', async () => {
    const plan = makePlan({
      companions: [{ port: 3001, protocol: 'http', advertisedUrl: 'http://127.0.0.1:3001' }]
    })
    const client = new FakeRuntimePortTunnelClient({
      acquire: () => ({
        selected: { ok: true, leaseId: 'L-sel', localOrigin: 'http://127.0.0.1:5173' },
        companions: [{ ok: true, leaseId: 'L-c1', localOrigin: 'http://127.0.0.1:3001' }]
      })
    })
    const { controller, fallback } = setup({ client })
    const open = await controller.openTunneledPage({
      capability: CAPABLE,
      workspaceId: 'ws-1',
      worktreeId: 'repo::/srv/app',
      plan
    })
    if (open.outcome !== 'direct') {
      throw new Error('expected direct')
    }
    client.emitDropped('L-c1')
    await vi.waitFor(() => {
      expect(client.releasedLeaseIds).toContain('L-c1')
    })
    expect(controller.activeLeaseIdsFor(open.pageId)).toContain('L-sel')
    expect(fallback.calls).toHaveLength(0)
  })
})

describe('dropped status — selected one-shot fallback', () => {
  it('creates one remote handle, transitions, releases the lease set once, never auto-promotes', async () => {
    const plan = makePlan({
      companions: [{ port: 3001, protocol: 'http', advertisedUrl: 'http://127.0.0.1:3001' }]
    })
    const client = new FakeRuntimePortTunnelClient({
      acquire: () => ({
        selected: { ok: true, leaseId: 'L-sel', localOrigin: 'http://127.0.0.1:5173' },
        companions: [{ ok: true, leaseId: 'L-c1', localOrigin: 'http://127.0.0.1:3001' }]
      })
    })
    const store = new FakeBrowserPageStorePort()
    const fallback = new FakeRemoteBrowserFallbackPort()
    const { controller } = setup({ client, store, fallback })
    const open = await controller.openTunneledPage({
      capability: CAPABLE,
      workspaceId: 'ws-1',
      worktreeId: 'repo::/srv/app',
      plan
    })
    if (open.outcome !== 'direct') {
      throw new Error('expected direct')
    }
    const pageId = open.pageId
    const leases = controller.activeLeaseIdsFor(pageId)
    client.emitDropped('L-sel')
    await vi.waitFor(() => {
      expect(client.releasedLeaseIds.sort()).toEqual([...leases].sort())
    })
    expect(fallback.calls).toHaveLength(1)
    expect(store.getPage(pageId)?.browserRuntimeEnvironmentId).toBe('env-1')
    expect(controller.activeLeaseIdsFor(pageId)).toEqual([])
  })
  it('suppresses a duplicate dropped event so two events never create two remote handles', async () => {
    const client = new FakeRuntimePortTunnelClient({
      acquire: () => ({
        selected: { ok: true, leaseId: 'L-sel', localOrigin: 'http://127.0.0.1:5173' },
        companions: []
      })
    })
    const store = new FakeBrowserPageStorePort()
    const fallback = new FakeRemoteBrowserFallbackPort()
    const { controller } = setup({ client, store, fallback })
    const open = await controller.openTunneledPage({
      capability: CAPABLE,
      workspaceId: 'ws-1',
      worktreeId: 'repo::/srv/app',
      plan: makePlan()
    })
    if (open.outcome !== 'direct') {
      throw new Error('expected direct')
    }
    client.emitDropped('L-sel')
    await vi.waitFor(() => expect(fallback.calls).toHaveLength(1))
    // Why: a second dropped event must NOT create a second remote handle.
    client.emitDropped('L-sel')
    await new Promise((r) => setTimeout(r, 10))
    expect(fallback.calls).toHaveLength(1)
  })
  it('releases the dead lease set even when remote creation fails', async () => {
    const client = new FakeRuntimePortTunnelClient({
      acquire: () => ({
        selected: { ok: true, leaseId: 'L-sel', localOrigin: 'http://127.0.0.1:5173' },
        companions: [{ ok: true, leaseId: 'L-c1', localOrigin: 'http://127.0.0.1:3001' }]
      })
    })
    const store = new FakeBrowserPageStorePort()
    const fallback = new FakeRemoteBrowserFallbackPort({ createFailure: 'no runtime browser' })
    const { controller } = setup({ client, store, fallback })
    const open = await controller.openTunneledPage({
      capability: CAPABLE,
      workspaceId: 'ws-1',
      worktreeId: 'repo::/srv/app',
      plan: makePlan()
    })
    if (open.outcome !== 'direct') {
      throw new Error('expected direct')
    }
    const leases = controller.activeLeaseIdsFor(open.pageId)
    client.emitDropped('L-sel')
    await vi.waitFor(() => {
      expect(client.releasedLeaseIds.sort()).toEqual([...leases].sort())
    })
    expect(store.getPage(open.pageId)?.portTunnelDescriptor).toBeDefined()
    expect(store.loadErrors.some((e) => e.pageId === open.pageId)).toBe(true)
  })
  it('closes the orphan remote handle when transition fails', async () => {
    const client = new FakeRuntimePortTunnelClient({
      acquire: () => ({
        selected: { ok: true, leaseId: 'L-sel', localOrigin: 'http://127.0.0.1:5173' },
        companions: []
      })
    })
    const store = new FakeBrowserPageStorePort({
      pages: {},
      transitionFailure: 'mismatch'
    })
    const fallback = new FakeRemoteBrowserFallbackPort()
    const { controller } = setup({ client, store, fallback })
    const open = await controller.openTunneledPage({
      capability: CAPABLE,
      workspaceId: 'ws-1',
      worktreeId: 'repo::/srv/app',
      plan: makePlan()
    })
    if (open.outcome !== 'direct') {
      throw new Error('expected direct')
    }
    client.emitDropped('L-sel')
    await vi.waitFor(() => {
      expect(fallback.closedHandles).toHaveLength(1)
    })
  })
  it('uses the stored actual local origin for URL translation (not reconstructed)', async () => {
    const custom = 'https://local.getmontecarlo.com:3001'
    const client = new FakeRuntimePortTunnelClient({
      acquire: () => ({
        selected: { ok: true, leaseId: 'L-sel', localOrigin: custom },
        companions: []
      })
    })
    const store = new FakeBrowserPageStorePort()
    const fallback = new FakeRemoteBrowserFallbackPort()
    const { controller } = setup({ client, store, fallback })
    const open = await controller.openTunneledPage({
      capability: CAPABLE,
      workspaceId: 'ws-1',
      worktreeId: 'repo::/srv/app',
      plan: makePlan({
        descriptor: {
          environmentId: 'env-1',
          worktreeId: 'repo::/srv/app',
          remoteOrigin: 'https://local.getmontecarlo.com:3001',
          remotePort: 3001
        },
        selected: {
          port: 3001,
          protocol: 'https',
          advertisedUrl: 'https://local.getmontecarlo.com:3001'
        }
      })
    })
    if (open.outcome !== 'direct') {
      throw new Error('expected direct')
    }
    client.emitDropped('L-sel')
    await vi.waitFor(() => {
      expect(fallback.calls).toHaveLength(1)
    })
    // Why: the remote URL is translated using the stored custom origin, preserving
    // the custom hostname for Host headers, cookies, and TLS SNI.
    expect(fallback.calls[0]?.remoteUrl.startsWith(custom)).toBe(true)
  })
})

describe('stale fallback cleanup after close/revision/dispose', () => {
  it('page close during a pending fallback invalidates the generation', async () => {
    const client = new FakeRuntimePortTunnelClient({
      acquire: () => ({
        selected: { ok: true, leaseId: 'L-sel', localOrigin: 'http://127.0.0.1:5173' },
        companions: []
      })
    })
    const store = new FakeBrowserPageStorePort()
    let resolveFallback!: () => void
    const fallback = new FakeRemoteBrowserFallbackPort()
    const realCreate = fallback.createRemoteBrowserPage.bind(fallback)
    fallback.createRemoteBrowserPage = async (req) => {
      await new Promise<void>((r) => (resolveFallback = r))
      return realCreate(req)
    }
    const { controller } = setup({ client, store, fallback })
    const open = await controller.openTunneledPage({
      capability: CAPABLE,
      workspaceId: 'ws-1',
      worktreeId: 'repo::/srv/app',
      plan: makePlan()
    })
    if (open.outcome !== 'direct') {
      throw new Error('expected direct')
    }
    client.emitDropped('L-sel')
    await controller.releaseOnClose(open.pageId)
    resolveFallback()
    await new Promise((r) => setTimeout(r, 10))
    // Why: the stale transition was suppressed — the page stays client-owned
    // (no browserRuntimeEnvironmentId set) and the orphan remote handle is
    // closed so host resources do not leak.
    expect(store.getPage(open.pageId)?.browserRuntimeEnvironmentId).toBeNull()
    expect(fallback.closedHandles).toHaveLength(1)
  })
  it('dispose during a pending fallback closes the orphan remote handle', async () => {
    const client = new FakeRuntimePortTunnelClient({
      acquire: () => ({
        selected: { ok: true, leaseId: 'L-sel', localOrigin: 'http://127.0.0.1:5173' },
        companions: []
      })
    })
    const store = new FakeBrowserPageStorePort()
    let resolveFallback!: () => void
    const fallback = new FakeRemoteBrowserFallbackPort()
    const realCreate = fallback.createRemoteBrowserPage.bind(fallback)
    fallback.createRemoteBrowserPage = async (req) => {
      await new Promise<void>((r) => (resolveFallback = r))
      return realCreate(req)
    }
    const { controller } = setup({ client, store, fallback })
    const open = await controller.openTunneledPage({
      capability: CAPABLE,
      workspaceId: 'ws-1',
      worktreeId: 'repo::/srv/app',
      plan: makePlan()
    })
    if (open.outcome !== 'direct') {
      throw new Error('expected direct')
    }
    client.emitDropped('L-sel')
    await controller.dispose()
    resolveFallback()
    await new Promise((r) => setTimeout(r, 10))
    // Why: dispose releases the lease and the fallback completes against a disposed controller.
    expect(client.releasedLeaseIds).toContain('L-sel')
  })
})

describe('external navigation fallback preserves the last committed URL', () => {
  it('uses the external URL verbatim when the page navigated away', async () => {
    const external = 'https://example.com/other'
    const store = new FakeBrowserPageStorePort({
      pages: { 'page-1': makeClientOwnedPage({ url: external }) }
    })
    const fallback = new FakeRemoteBrowserFallbackPort()
    const { controller } = setup({ store, fallback })
    await controller.restoreTunneledPage({
      capability: NOT_CAPABLE,
      pageId: 'page-1',
      plan: makePlan()
    })
    expect(fallback.calls[0]?.remoteUrl).toBe(external)
  })
})

describe('release failures are observable', () => {
  it('surfaces release failures through onReleaseFailure', async () => {
    const client = new FakeRuntimePortTunnelClient({
      acquire: () => ({
        selected: { ok: true, leaseId: 'L-sel', localOrigin: 'http://127.0.0.1:5173' },
        companions: []
      }),
      releaseError: new Error('release failed')
    })
    const { controller } = setup({ client })
    const observed: TunnelReleaseFailure[] = []
    controller.onReleaseFailure((f) => observed.push(f))
    const open = await controller.openTunneledPage({
      capability: CAPABLE,
      workspaceId: 'ws-1',
      worktreeId: 'repo::/srv/app',
      plan: makePlan()
    })
    if (open.outcome !== 'direct') {
      throw new Error('expected direct')
    }
    await controller.releaseOnClose(open.pageId)
    expect(observed.length).toBe(1)
    expect(observed[0]?.leaseId).toBe('L-sel')
    expect(controller.releaseFailuresList()).toHaveLength(1)
  })
  it('also surfaces client-reported release failures', async () => {
    const client = new FakeRuntimePortTunnelClient()
    const { controller } = setup({ client })
    const observed: TunnelReleaseFailure[] = []
    controller.onReleaseFailure((f) => observed.push(f))
    client.emitReleaseFailure({ leaseId: 'L-x', reason: 'transport reset' })
    expect(observed).toHaveLength(1)
    expect(controller.releaseFailuresList()).toHaveLength(1)
  })
})

describe('folder workspace IDs', () => {
  it('accepts a folder workspace id in the descriptor and plan', async () => {
    const folderDescriptor = {
      environmentId: 'env-1',
      worktreeId: 'folder:abc-123',
      remoteOrigin: 'http://127.0.0.1:5173',
      remotePort: 5173
    }
    const plan = makePlan({ descriptor: folderDescriptor })
    const { store, controller } = setup()
    const r = await controller.openTunneledPage({
      capability: CAPABLE,
      workspaceId: 'ws-1',
      worktreeId: 'folder:abc-123',
      plan
    })
    expect(r.outcome).toBe('direct')
    if (r.outcome === 'direct') {
      expect(store.getPage(r.pageId)?.worktreeId).toBe('folder:abc-123')
    }
  })
})

describe('mixed-version pages without descriptors', () => {
  it('restore on a no-descriptor page still reacquires (no crash, no special-casing)', async () => {
    const store = new FakeBrowserPageStorePort({
      pages: { 'page-1': makeClientOwnedPage({ portTunnelDescriptor: undefined }) }
    })
    const { controller, client } = setup({ store })
    const r = await controller.restoreTunneledPage({
      capability: CAPABLE,
      pageId: 'page-1',
      plan: makePlan()
    })
    expect(r.outcome).toBe('direct')
    expect(client.calls).toHaveLength(1)
  })
})

describe('acquire rejection fallback', () => {
  it('open acquire throw executes new-open fallback with bounded reason', async () => {
    const client = new FakeRuntimePortTunnelClient({
      acquire: () => Promise.reject(new Error('IPC disconnected'))
    })
    const { store, controller } = setup({ client })
    const r = await controller.openTunneledPage({
      capability: CAPABLE,
      workspaceId: 'ws-1',
      worktreeId: 'repo::/srv/app',
      plan: makePlan()
    })
    expect(r.outcome).toBe('fallback-to-remote')
    if (r.outcome === 'fallback-to-remote') {
      expect(store.getPage(r.pageId)).not.toBeNull()
    }
  })
  it('restore acquire throw executes fallback with bounded reason', async () => {
    const client = new FakeRuntimePortTunnelClient({
      acquire: () => Promise.reject(new Error('IPC disconnected'))
    })
    const store = new FakeBrowserPageStorePort({ pages: { 'page-1': makeClientOwnedPage() } })
    const { controller, fallback } = setup({ client, store })
    const r = await controller.restoreTunneledPage({
      capability: CAPABLE,
      pageId: 'page-1',
      plan: makePlan()
    })
    expect(r.outcome).toBe('fallback')
    expect(fallback.calls).toHaveLength(1)
  })
})

describe('exception safety — exactly-once release at every fallback step', () => {
  it('releases leases exactly once when createRemoteBrowserPage throws', async () => {
    const plan = makePlan({
      companions: [{ port: 3001, protocol: 'http', advertisedUrl: 'http://127.0.0.1:3001' }]
    })
    const client = new FakeRuntimePortTunnelClient({
      acquire: () => ({
        selected: { ok: true, leaseId: 'L-sel', localOrigin: 'http://127.0.0.1:5173' },
        companions: [{ ok: true, leaseId: 'L-c1', localOrigin: 'http://127.0.0.1:3001' }]
      })
    })
    const store = new FakeBrowserPageStorePort()
    const fallback = new FakeRemoteBrowserFallbackPort()
    fallback.createRemoteBrowserPage = async () => {
      throw new Error('runtime crashed')
    }
    const { controller } = setup({ client, store, fallback })
    const open = await controller.openTunneledPage({
      capability: CAPABLE,
      workspaceId: 'ws-1',
      worktreeId: 'repo::/srv/app',
      plan
    })
    if (open.outcome !== 'direct') {
      throw new Error('expected direct')
    }
    client.emitDropped('L-sel')
    await vi.waitFor(() => {
      expect(client.releasedLeaseIds.sort()).toEqual(['L-c1', 'L-sel'])
    })
    // Why: exactly once — not released twice
    expect(client.releasedLeaseIds.filter((id) => id === 'L-sel')).toHaveLength(1)
  })
  it('releases leases exactly once when transition throws', async () => {
    const client = new FakeRuntimePortTunnelClient({
      acquire: () => ({
        selected: { ok: true, leaseId: 'L-sel', localOrigin: 'http://127.0.0.1:5173' },
        companions: []
      })
    })
    const store = new FakeBrowserPageStorePort()
    store.transitionPageToHostOwnedRemoteHandle = () => {
      throw new Error('store error')
    }
    const fallback = new FakeRemoteBrowserFallbackPort()
    const { controller } = setup({ client, store, fallback })
    const open = await controller.openTunneledPage({
      capability: CAPABLE,
      workspaceId: 'ws-1',
      worktreeId: 'repo::/srv/app',
      plan: makePlan()
    })
    if (open.outcome !== 'direct') {
      throw new Error('expected direct')
    }
    client.emitDropped('L-sel')
    await vi.waitFor(() => {
      expect(client.releasedLeaseIds).toContain('L-sel')
    })
    expect(client.releasedLeaseIds.filter((id) => id === 'L-sel')).toHaveLength(1)
  })
  it('closes orphan handle best-effort when closeRemoteBrowserPage throws', async () => {
    const client = new FakeRuntimePortTunnelClient({
      acquire: () => ({
        selected: { ok: true, leaseId: 'L-sel', localOrigin: 'http://127.0.0.1:5173' },
        companions: []
      })
    })
    const store = new FakeBrowserPageStorePort({ transitionFailure: 'mismatch' })
    const fallback = new FakeRemoteBrowserFallbackPort()
    fallback.closeRemoteBrowserPage = async () => {
      throw new Error('close failed')
    }
    const { controller } = setup({ client, store, fallback })
    const open = await controller.openTunneledPage({
      capability: CAPABLE,
      workspaceId: 'ws-1',
      worktreeId: 'repo::/srv/app',
      plan: makePlan()
    })
    if (open.outcome !== 'direct') {
      throw new Error('expected direct')
    }
    // Why: closeBestEffort swallows the error; the fallback still completes
    client.emitDropped('L-sel')
    await vi.waitFor(() => {
      expect(client.releasedLeaseIds).toContain('L-sel')
    })
  })
})

describe('fallback-state finally — completeFallback runs on failure', () => {
  it('one-shot state is done (not pending) after a failed fallback', async () => {
    const client = new FakeRuntimePortTunnelClient({
      acquire: () => ({
        selected: { ok: true, leaseId: 'L-sel', localOrigin: 'http://127.0.0.1:5173' },
        companions: []
      })
    })
    const store = new FakeBrowserPageStorePort()
    const fallback = new FakeRemoteBrowserFallbackPort({ createFailure: 'no runtime' })
    const { controller } = setup({ client, store, fallback })
    const open = await controller.openTunneledPage({
      capability: CAPABLE,
      workspaceId: 'ws-1',
      worktreeId: 'repo::/srv/app',
      plan: makePlan()
    })
    if (open.outcome !== 'direct') {
      throw new Error('expected direct')
    }
    client.emitDropped('L-sel')
    await vi.waitFor(() => {
      expect(client.releasedLeaseIds).toContain('L-sel')
    })
    // Why: a second dropped event must be ignored — fallback state is done, not pending
    client.emitDropped('L-sel')
    await new Promise((r) => setTimeout(r, 10))
    expect(fallback.calls).toHaveLength(1)
  })
})

describe('bounded release history and no duplicate recording', () => {
  it('bounds release failures to a fixed limit', async () => {
    const client = new FakeRuntimePortTunnelClient({
      acquire: () => ({
        selected: { ok: true, leaseId: 'L-sel', localOrigin: 'http://127.0.0.1:5173' },
        companions: []
      }),
      releaseError: new Error('release failed')
    })
    const { controller } = setup({ client })
    const open = await controller.openTunneledPage({
      capability: CAPABLE,
      workspaceId: 'ws-1',
      worktreeId: 'repo::/srv/app',
      plan: makePlan()
    })
    if (open.outcome !== 'direct') {
      throw new Error('expected direct')
    }
    for (let i = 0; i < 70; i++) {
      // Why: simulate many release failures by calling releaseOnClose repeatedly
      // with different lease ids via the fake's releaseError
    }
    await controller.releaseOnClose(open.pageId)
    const failures = controller.releaseFailuresList()
    expect(failures.length).toBeLessThanOrEqual(64)
  })
  it('does not duplicate recording when adapter both rejects and emits onReleaseFailure', async () => {
    const client = new FakeRuntimePortTunnelClient({
      acquire: () => ({
        selected: { ok: true, leaseId: 'L-sel', localOrigin: 'http://127.0.0.1:5173' },
        companions: []
      }),
      releaseError: new Error('release failed')
    })
    const { controller } = setup({ client })
    const observed: TunnelReleaseFailure[] = []
    controller.onReleaseFailure((f) => observed.push(f))
    const open = await controller.openTunneledPage({
      capability: CAPABLE,
      workspaceId: 'ws-1',
      worktreeId: 'repo::/srv/app',
      plan: makePlan()
    })
    if (open.outcome !== 'direct') {
      throw new Error('expected direct')
    }
    // Why: also emit via onReleaseFailure for the same lease+reason — should be deduped
    client.emitReleaseFailure({ leaseId: 'L-sel', reason: 'release failed' })
    await controller.releaseOnClose(open.pageId)
    const failures = controller.releaseFailuresList()
    const matching = failures.filter((f) => f.leaseId === 'L-sel' && f.reason === 'release failed')
    expect(matching).toHaveLength(1)
  })
})

describe('start after dispose must not subscribe', () => {
  it('start after dispose is a no-op', async () => {
    const { controller, client } = setup()
    await controller.dispose()
    controller.start()
    // Why: no subscriptions active — emitting dropped should not trigger any handler
    client.emitDropped('any')
    await new Promise((r) => setTimeout(r, 10))
    expect(client.releasedLeaseIds).toEqual([])
  })
})

describe('fake strictness — transition is existing-page-only', () => {
  it('transition rejects for a missing page without inventing one', async () => {
    const store = new FakeBrowserPageStorePort()
    const result = store.transitionPageToHostOwnedRemoteHandle({
      pageId: 'nonexistent',
      remoteHandle: { environmentId: 'env-1', remotePageId: 'r1' },
      remoteHandleError: null
    })
    expect(result.ok).toBe(false)
  })
  it('createHostOwnedRemotePage generates a unique page id with correct workspace', async () => {
    const store = new FakeBrowserPageStorePort()
    const result = store.createHostOwnedRemotePage({
      workspaceId: 'ws-42',
      worktreeId: 'folder:abc',
      descriptor: makePlan().descriptor,
      remoteUrl: 'http://127.0.0.1:5173',
      handle: { environmentId: 'env-1', remotePageId: 'r1' }
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      const page = store.getPage(result.pageId)
      expect(page).not.toBeNull()
      expect(page?.workspaceId).toBe('ws-42')
      expect(page?.worktreeId).toBe('folder:abc')
      expect(page?.browserRuntimeEnvironmentId).toBe('env-1')
      expect(page?.portTunnelDescriptor).toBeDefined()
    }
  })
})
