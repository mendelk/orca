import { describe, it, expect } from 'vitest'
import { BrowserPortTunnelController } from './browser-port-tunnel-controller'
import {
  FakeBrowserPageStorePort,
  FakeRemoteBrowserFallbackPort,
  FakeRuntimePortTunnelClient,
  deterministicIdGenerator,
  makeClientOwnedPage,
  makePlan
} from './test-harness'
import { runtimeSupportsWorkspacePortTunnel } from './runtime-port-tunnel-client-port'
import type { TunnelAcquireOutcome } from './runtime-port-tunnel-client-port'
import { openFingerprint } from './tunnel-fingerprint'

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

describe('runtimeSupportsWorkspacePortTunnel', () => {
  it('gates on workspace-port-tunnel.v1', () => {
    expect(runtimeSupportsWorkspacePortTunnel(['workspace-port-tunnel.v1'])).toBe(true)
    expect(runtimeSupportsWorkspacePortTunnel(['other.v1'])).toBe(false)
    expect(runtimeSupportsWorkspacePortTunnel(undefined)).toBe(false)
  })
})
describe('no endpoint IDs across the renderer contract', () => {
  it('TunnelEndpointPlan has no endpointId field', async () => {
    const plan = makePlan()
    expect('endpointId' in plan.selected).toBe(false)
    expect('endpointId' in plan.companions[0]).toBe(false)
  })
  it('TunnelEndpointAcquireResult has no endpointId field', async () => {
    const { client, controller } = setup()
    await controller.openTunneledPage({
      capability: CAPABLE,
      workspaceId: 'ws-1',
      worktreeId: 'repo::/srv/app',
      plan: makePlan()
    })
    const call = client.calls[0]
    expect(call).toBeDefined()
    // Why: the plan passed to acquire also has no endpoint ids.
    expect('endpointId' in call.plan.selected).toBe(false)
  })
})

describe('openTunneledPage — capability absence follows remote screencast behavior', () => {
  it('creates a host-owned remote page without acquiring', async () => {
    const { client, store, controller } = setup()
    const r = await controller.openTunneledPage({
      capability: NOT_CAPABLE,
      workspaceId: 'ws-1',
      worktreeId: 'repo::/srv/app',
      plan: makePlan()
    })
    expect(r.outcome).toBe('fallback-to-remote')
    expect(client.calls).toHaveLength(0)
    if (r.outcome === 'fallback-to-remote') {
      expect(store.getPage(r.pageId)).not.toBeNull()
    }
  })
  it('returns retained-with-error when disposed', async () => {
    const { controller, client } = setup()
    await controller.dispose()
    const r = await controller.openTunneledPage({
      capability: CAPABLE,
      workspaceId: 'ws-1',
      worktreeId: 'repo::/srv/app',
      plan: makePlan()
    })
    expect(r.outcome).toBe('retained-with-error')
    expect(client.calls).toHaveLength(0)
  })
})

describe('openTunneledPage — selected success tracks the complete lease set', () => {
  it('records selected + companion leases and releases them all on close', async () => {
    const plan = makePlan({
      companions: [
        { port: 3001, protocol: 'http', advertisedUrl: 'http://127.0.0.1:3001' },
        { port: 3002, protocol: 'http', advertisedUrl: 'http://127.0.0.1:3002' }
      ]
    })
    const { client, controller } = setup()
    const r = await controller.openTunneledPage({
      capability: CAPABLE,
      workspaceId: 'ws-1',
      worktreeId: 'repo::/srv/app',
      plan
    })
    expect(r.outcome).toBe('direct')
    if (r.outcome !== 'direct') {
      throw new Error('expected direct')
    }
    const leases = controller.activeLeaseIdsFor(r.pageId)
    expect(leases.length).toBe(3)
    await controller.releaseOnClose(r.pageId)
    expect(client.releasedLeaseIds.sort()).toEqual([...leases].sort())
  })
  it('passes the actual local origin from acquisition to the store', async () => {
    const custom = 'http://local.getmontecarlo.com:5173'
    const client = new FakeRuntimePortTunnelClient({
      acquire: () => ({
        selected: { ok: true, leaseId: 'L1', localOrigin: custom },
        companions: []
      })
    })
    const { store, controller } = setup({ client })
    const r = await controller.openTunneledPage({
      capability: CAPABLE,
      workspaceId: 'ws-1',
      worktreeId: 'repo::/srv/app',
      plan: makePlan()
    })
    if (r.outcome !== 'direct') {
      throw new Error('expected direct')
    }
    expect(store.getPage(r.pageId)?.url.startsWith(custom)).toBe(true)
  })
  it('keeps persisted BrowserPage free of lease ids', async () => {
    const { store, controller } = setup()
    const r = await controller.openTunneledPage({
      capability: CAPABLE,
      workspaceId: 'ws-1',
      worktreeId: 'repo::/srv/app',
      plan: makePlan()
    })
    if (r.outcome !== 'direct') {
      throw new Error('expected direct')
    }
    const page = store.getPage(r.pageId)!
    expect(page.portTunnelDescriptor).toBeDefined()
    expect(JSON.stringify(page)).not.toMatch(/lease/i)
  })
  it('supports the explicit unknown protocol the eligibility contract permits', async () => {
    const plan = makePlan({
      selected: { port: 5173, protocol: 'unknown', advertisedUrl: 'http://127.0.0.1:5173' }
    })
    const { controller } = setup()
    const r = await controller.openTunneledPage({
      capability: CAPABLE,
      workspaceId: 'ws-1',
      worktreeId: 'repo::/srv/app',
      plan
    })
    expect(r.outcome).toBe('direct')
  })
})

describe('openTunneledPage — companion releases and partial state', () => {
  it('releases companion leases when the selected acquire fails', async () => {
    const plan = makePlan({
      companions: [
        { port: 3001, protocol: 'http', advertisedUrl: 'http://127.0.0.1:3001' },
        { port: 3002, protocol: 'http', advertisedUrl: 'http://127.0.0.1:3002' }
      ]
    })
    const client = new FakeRuntimePortTunnelClient({
      acquire: (_k, p) => ({
        selected: { ok: false, reason: 'selected port occupied' },
        companions: p.companions.map((c) => ({
          ok: true as const,
          leaseId: `comp-${c.port}`,
          localOrigin: `http://127.0.0.1:${c.port}`
        }))
      })
    })
    const { controller } = setup({ client })
    await controller.openTunneledPage({
      capability: CAPABLE,
      workspaceId: 'ws-1',
      worktreeId: 'repo::/srv/app',
      plan
    })
    expect(client.releasedLeaseIds.sort()).toEqual(['comp-3001', 'comp-3002'])
  })
  it('keeps direct render when a companion fails (partial warning, not blocking)', async () => {
    const plan = makePlan({
      companions: [{ port: 3001, protocol: 'http', advertisedUrl: 'http://127.0.0.1:3001' }]
    })
    const client = new FakeRuntimePortTunnelClient({
      acquire: () => ({
        selected: { ok: true, leaseId: 'L-sel', localOrigin: 'http://127.0.0.1:5173' },
        companions: [{ ok: false, reason: 'companion port occupied' }]
      })
    })
    const { controller } = setup({ client })
    const r = await controller.openTunneledPage({
      capability: CAPABLE,
      workspaceId: 'ws-1',
      worktreeId: 'repo::/srv/app',
      plan
    })
    expect(r.outcome).toBe('direct')
    if (r.outcome !== 'direct') {
      throw new Error('expected direct')
    }
    expect(controller.activeLeaseIdsFor(r.pageId)).toEqual(['L-sel'])
  })
})

describe('openTunneledPage — acquire-before-create ordering', () => {
  it('calls acquire before createClientOwnedTunneledPage', async () => {
    const order: string[] = []
    const client = new FakeRuntimePortTunnelClient({
      acquire: () => {
        order.push('acquire')
        return {
          selected: { ok: true, leaseId: 'L1', localOrigin: 'http://127.0.0.1:5173' },
          companions: []
        }
      }
    })
    const store = new FakeBrowserPageStorePort()
    const realCreate = store.createClientOwnedTunneledPage.bind(store)
    store.createClientOwnedTunneledPage = (args) => {
      order.push('create')
      return realCreate(args)
    }
    const { controller } = setup({ client, store })
    await controller.openTunneledPage({
      capability: CAPABLE,
      workspaceId: 'ws-1',
      worktreeId: 'repo::/srv/app',
      plan: makePlan()
    })
    expect(order).toEqual(['acquire', 'create'])
  })
})

describe('openTunneledPage — failed page creation releases leases and attempts remote fallback', () => {
  it('releases selected + companion leases and falls back to remote on create failure', async () => {
    const store = new FakeBrowserPageStorePort({ createFailure: 'descriptor mismatch' })
    const client = new FakeRuntimePortTunnelClient({
      acquire: () => ({
        selected: { ok: true, leaseId: 'L-sel', localOrigin: 'http://127.0.0.1:5173' },
        companions: [{ ok: true, leaseId: 'L-c1', localOrigin: 'http://127.0.0.1:3001' }]
      })
    })
    const fallback = new FakeRemoteBrowserFallbackPort()
    const { controller } = setup({ client, store, fallback })
    const r = await controller.openTunneledPage({
      capability: CAPABLE,
      workspaceId: 'ws-1',
      worktreeId: 'repo::/srv/app',
      plan: makePlan()
    })
    // Why: create failure now attempts new-open remote fallback, not just create-failed.
    expect(r.outcome).toBe('fallback-to-remote')
    expect(client.releasedLeaseIds.sort()).toEqual(['L-c1', 'L-sel'])
  })
})

describe('openTunneledPage — NEW open selected-acquire failure creates one host-owned remote page', () => {
  it('returns fallback-to-remote with a unique generated page id', async () => {
    const client = new FakeRuntimePortTunnelClient({
      acquire: () => ({ selected: { ok: false, reason: 'selected port occupied' }, companions: [] })
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
      expect(r.pageId).not.toBe('fallback::ws-1')
      expect(store.getPage(r.pageId)).not.toBeNull()
    }
  })
  it('returns retained-with-error when remote creation also fails', async () => {
    const client = new FakeRuntimePortTunnelClient({
      acquire: () => ({ selected: { ok: false, reason: 'selected port occupied' }, companions: [] })
    })
    const fallback = new FakeRemoteBrowserFallbackPort({ createFailure: 'no runtime browser' })
    const { controller } = setup({ client, fallback })
    const r = await controller.openTunneledPage({
      capability: CAPABLE,
      workspaceId: 'ws-1',
      worktreeId: 'repo::/srv/app',
      plan: makePlan()
    })
    expect(r.outcome).toBe('retained-with-error')
    if (r.outcome === 'retained-with-error') {
      expect(r.reason).toContain('selected port occupied')
      expect(r.reason).toContain('no runtime browser')
    }
  })
  it('closes the orphan remote handle when store creation fails', async () => {
    const client = new FakeRuntimePortTunnelClient({
      acquire: () => ({ selected: { ok: false, reason: 'selected port occupied' }, companions: [] })
    })
    const store = new FakeBrowserPageStorePort({ hostOwnedCreateFailure: 'store error' })
    const fallback = new FakeRemoteBrowserFallbackPort()
    const { controller } = setup({ client, store, fallback })
    await controller.openTunneledPage({
      capability: CAPABLE,
      workspaceId: 'ws-1',
      worktreeId: 'repo::/srv/app',
      plan: makePlan()
    })
    expect(fallback.closedHandles).toHaveLength(1)
  })
})

describe('openTunneledPage — concurrent open deduplication by operation key', () => {
  it('deduplicates concurrent opens for the same caller-supplied operation key', async () => {
    let resolveAcquire!: (o: TunnelAcquireOutcome) => void
    const client = new FakeRuntimePortTunnelClient({
      acquire: () => new Promise<TunnelAcquireOutcome>((r) => (resolveAcquire = r))
    })
    const { controller } = setup({ client })
    const first = controller.openTunneledPage({
      capability: CAPABLE,
      workspaceId: 'ws-1',
      worktreeId: 'repo::/srv/app',
      plan: makePlan(),
      operationKey: 'op-1'
    })
    const second = controller.openTunneledPage({
      capability: CAPABLE,
      workspaceId: 'ws-1',
      worktreeId: 'repo::/srv/app',
      plan: makePlan(),
      operationKey: 'op-1'
    })
    expect(client.calls).toHaveLength(1)
    resolveAcquire({
      selected: { ok: true, leaseId: 'L1', localOrigin: 'http://127.0.0.1:5173' },
      companions: []
    })
    const [a, b] = await Promise.all([first, second])
    expect(a).toEqual(b)
  })
  it('runs separate opens for different operation keys', async () => {
    const { client, controller } = setup()
    await Promise.all([
      controller.openTunneledPage({
        capability: CAPABLE,
        workspaceId: 'ws-1',
        worktreeId: 'repo::/srv/app',
        plan: makePlan(),
        operationKey: 'op-1'
      }),
      controller.openTunneledPage({
        capability: CAPABLE,
        workspaceId: 'ws-2',
        worktreeId: 'repo::/srv/app',
        plan: makePlan(),
        operationKey: 'op-2'
      })
    ])
    expect(client.calls).toHaveLength(2)
  })
})

describe('restoreTunneledPage — existing-page restore (no duplicate page id)', () => {
  it('materializes the existing page and returns the SAME pageId', async () => {
    const store = new FakeBrowserPageStorePort({ pages: { 'page-1': makeClientOwnedPage() } })
    const { controller } = setup({ store })
    const r = await controller.restoreTunneledPage({
      capability: CAPABLE,
      pageId: 'page-1',
      plan: makePlan()
    })
    expect(r.outcome).toBe('direct')
    if (r.outcome === 'direct') {
      expect(r.pageId).toBe('page-1')
      expect(store.materializedPageIds).toContain('page-1')
    }
  })
  it('does not call createClientOwnedTunneledPage on restore', async () => {
    const store = new FakeBrowserPageStorePort({ pages: { 'page-1': makeClientOwnedPage() } })
    let createCalls = 0
    const realCreate = store.createClientOwnedTunneledPage.bind(store)
    store.createClientOwnedTunneledPage = (args) => {
      createCalls++
      return realCreate(args)
    }
    const { controller } = setup({ store })
    await controller.restoreTunneledPage({
      capability: CAPABLE,
      pageId: 'page-1',
      plan: makePlan()
    })
    expect(createCalls).toBe(0)
  })
  it('returns page-gone when the page no longer exists', async () => {
    const { controller } = setup()
    const r = await controller.restoreTunneledPage({
      capability: CAPABLE,
      pageId: 'gone',
      plan: makePlan()
    })
    expect(r.outcome).toBe('page-gone')
  })
  it('reacquires before any webview navigation (acquire-before-materialize)', async () => {
    const order: string[] = []
    const client = new FakeRuntimePortTunnelClient({
      acquire: () => {
        order.push('acquire')
        return {
          selected: { ok: true, leaseId: 'L1', localOrigin: 'http://127.0.0.1:5173' },
          companions: []
        }
      }
    })
    const store = new FakeBrowserPageStorePort({ pages: { 'page-1': makeClientOwnedPage() } })
    const realMat = store.materializeExistingTunneledPage.bind(store)
    store.materializeExistingTunneledPage = (args) => {
      order.push('materialize')
      return realMat(args)
    }
    const { controller } = setup({ client, store })
    await controller.restoreTunneledPage({
      capability: CAPABLE,
      pageId: 'page-1',
      plan: makePlan()
    })
    expect(order).toEqual(['acquire', 'materialize'])
  })
})

describe('restoreTunneledPage — capability absence falls back preserving the last committed URL', () => {
  it('transitions to a host-owned remote handle and translates the URL', async () => {
    const store = new FakeBrowserPageStorePort({ pages: { 'page-1': makeClientOwnedPage() } })
    const fallback = new FakeRemoteBrowserFallbackPort()
    const { controller } = setup({ store, fallback })
    const r = await controller.restoreTunneledPage({
      capability: NOT_CAPABLE,
      pageId: 'page-1',
      plan: makePlan()
    })
    expect(r.outcome).toBe('fallback')
    expect(fallback.calls).toHaveLength(1)
    expect(fallback.calls[0]?.remoteUrl).toContain('127.0.0.1:5173')
  })
})

describe('restoreTunneledPage — selected reacquire failure falls back', () => {
  it('transitions to a host-owned remote handle without losing the tab', async () => {
    const client = new FakeRuntimePortTunnelClient({
      acquire: () => ({ selected: { ok: false, reason: 'no longer owned' }, companions: [] })
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
    expect(store.getPage('page-1')).not.toBeNull()
  })
})

describe('restoreTunneledPage — fallback failure retains the tab + descriptor', () => {
  it('keeps the page and descriptor with a bounded load error', async () => {
    const client = new FakeRuntimePortTunnelClient({
      acquire: () => ({ selected: { ok: false, reason: 'no' }, companions: [] })
    })
    const store = new FakeBrowserPageStorePort({ pages: { 'page-1': makeClientOwnedPage() } })
    const fallback = new FakeRemoteBrowserFallbackPort({ createFailure: 'no runtime browser' })
    const { controller } = setup({ client, store, fallback })
    const r = await controller.restoreTunneledPage({
      capability: CAPABLE,
      pageId: 'page-1',
      plan: makePlan()
    })
    expect(r.outcome).toBe('retained-with-error')
    expect(store.getPage('page-1')).not.toBeNull()
    expect(store.getPage('page-1')?.portTunnelDescriptor).toBeDefined()
    expect(store.loadErrors.some((e) => e.pageId === 'page-1')).toBe(true)
  })
})

describe('restoreTunneledPage — promise dedup with failure propagation', () => {
  it('deduplicates concurrent restores on the same page', async () => {
    let resolveAcquire!: (o: TunnelAcquireOutcome) => void
    const client = new FakeRuntimePortTunnelClient({
      acquire: () => new Promise<TunnelAcquireOutcome>((r) => (resolveAcquire = r))
    })
    const store = new FakeBrowserPageStorePort({ pages: { 'page-1': makeClientOwnedPage() } })
    const { controller } = setup({ client, store })
    const first = controller.restoreTunneledPage({
      capability: CAPABLE,
      pageId: 'page-1',
      plan: makePlan()
    })
    const second = controller.restoreTunneledPage({
      capability: CAPABLE,
      pageId: 'page-1',
      plan: makePlan()
    })
    expect(client.calls).toHaveLength(1)
    resolveAcquire({
      selected: { ok: true, leaseId: 'L1', localOrigin: 'http://127.0.0.1:5173' },
      companions: []
    })
    const [a, b] = await Promise.all([first, second])
    expect(a).toEqual(b)
  })
  it('propagates failure to all concurrent awaiters', async () => {
    let resolveAcquire!: (o: TunnelAcquireOutcome) => void
    const client = new FakeRuntimePortTunnelClient({
      acquire: () => new Promise<TunnelAcquireOutcome>((r) => (resolveAcquire = r))
    })
    const store = new FakeBrowserPageStorePort({
      pages: { 'page-1': makeClientOwnedPage() },
      materializeFailure: 'materialize failed'
    })
    const { controller } = setup({ client, store })
    const first = controller.restoreTunneledPage({
      capability: CAPABLE,
      pageId: 'page-1',
      plan: makePlan()
    })
    const second = controller.restoreTunneledPage({
      capability: CAPABLE,
      pageId: 'page-1',
      plan: makePlan()
    })
    resolveAcquire({
      selected: { ok: true, leaseId: 'L1', localOrigin: 'http://127.0.0.1:5173' },
      companions: []
    })
    const [a, b] = await Promise.all([first, second])
    // Why: materialize failure falls back to remote; both awaiters observe the same outcome.
    expect(a).toEqual(b)
  })
})

describe('new-open fallback — no fabricated page ID crosses the remote port', () => {
  it('two same-workspace new opens send new-open requests with no pageId', async () => {
    const client = new FakeRuntimePortTunnelClient({
      acquire: () => ({ selected: { ok: false, reason: 'occupied' }, companions: [] })
    })
    const { controller, fallback } = setup({ client })
    await controller.openTunneledPage({
      capability: CAPABLE,
      workspaceId: 'ws-1',
      worktreeId: 'repo::/srv/app',
      plan: makePlan(),
      operationKey: 'op-a'
    })
    await controller.openTunneledPage({
      capability: CAPABLE,
      workspaceId: 'ws-1',
      worktreeId: 'repo::/srv/app',
      plan: makePlan(),
      operationKey: 'op-b'
    })
    for (const call of fallback.calls) {
      expect(call.kind).toBe('new-open')
      expect(call.pageId).toBeNull()
    }
  })
})

describe('capability-unavailable open deduplicates under the same operation key', () => {
  it('concurrent capability-absent opens with the same key create one remote page', async () => {
    const { controller, fallback } = setup()
    const first = controller.openTunneledPage({
      capability: NOT_CAPABLE,
      workspaceId: 'ws-1',
      worktreeId: 'repo::/srv/app',
      plan: makePlan(),
      operationKey: 'op-cap'
    })
    const second = controller.openTunneledPage({
      capability: NOT_CAPABLE,
      workspaceId: 'ws-1',
      worktreeId: 'repo::/srv/app',
      plan: makePlan(),
      operationKey: 'op-cap'
    })
    const [a, b] = await Promise.all([first, second])
    expect(a).toEqual(b)
    expect(fallback.calls).toHaveLength(1)
  })
})

describe('collision-safe fingerprint', () => {
  it('differing protocol produces different fingerprints', () => {
    const plan1 = makePlan({
      selected: { port: 5173, protocol: 'http', advertisedUrl: 'http://127.0.0.1:5173' }
    })
    const plan2 = makePlan({
      selected: { port: 5173, protocol: 'https', advertisedUrl: 'https://127.0.0.1:5173' }
    })
    expect(openFingerprint({ workspaceId: 'ws-1', worktreeId: 'wt', plan: plan1 })).not.toBe(
      openFingerprint({ workspaceId: 'ws-1', worktreeId: 'wt', plan: plan2 })
    )
  })
  it('differing advertised URL produces different fingerprints', () => {
    const plan1 = makePlan({
      selected: { port: 5173, protocol: 'http', advertisedUrl: 'http://127.0.0.1:5173/a' }
    })
    const plan2 = makePlan({
      selected: { port: 5173, protocol: 'http', advertisedUrl: 'http://127.0.0.1:5173/b' }
    })
    expect(openFingerprint({ workspaceId: 'ws-1', worktreeId: 'wt', plan: plan1 })).not.toBe(
      openFingerprint({ workspaceId: 'ws-1', worktreeId: 'wt', plan: plan2 })
    )
  })
  it('differing remote origin produces different fingerprints', () => {
    const d1 = {
      environmentId: 'env-1',
      worktreeId: 'wt',
      remoteOrigin: 'http://a:1',
      remotePort: 1
    }
    const d2 = {
      environmentId: 'env-1',
      worktreeId: 'wt',
      remoteOrigin: 'http://b:1',
      remotePort: 1
    }
    expect(
      openFingerprint({ workspaceId: 'ws', worktreeId: 'wt', plan: makePlan({ descriptor: d1 }) })
    ).not.toBe(
      openFingerprint({ workspaceId: 'ws', worktreeId: 'wt', plan: makePlan({ descriptor: d2 }) })
    )
  })
  it('delimiter-like values in fields do not collide', () => {
    const a = openFingerprint({ workspaceId: 'ws|1', worktreeId: 'wt', plan: makePlan() })
    const b = openFingerprint({ workspaceId: 'ws', worktreeId: '1|wt', plan: makePlan() })
    expect(a).not.toBe(b)
  })
})

describe('dedup mismatch returns retained-with-error (no throw)', () => {
  it('open dedup mismatch returns retained-with-error', async () => {
    let resolveFirst!: () => void
    const firstPromise = new Promise<void>((r) => (resolveFirst = r))
    const client = new FakeRuntimePortTunnelClient({
      acquire: () =>
        firstPromise.then(() => ({
          selected: { ok: true, leaseId: 'L1', localOrigin: 'http://127.0.0.1:5173' },
          companions: []
        }))
    })
    const { controller } = setup({ client })
    const first = controller.openTunneledPage({
      capability: CAPABLE,
      workspaceId: 'ws-1',
      worktreeId: 'wt-a',
      plan: makePlan(),
      operationKey: 'op-x'
    })
    const second = controller.openTunneledPage({
      capability: CAPABLE,
      workspaceId: 'ws-1',
      worktreeId: 'wt-b',
      plan: makePlan(),
      operationKey: 'op-x'
    })
    const result = await second
    expect(result.outcome).toBe('retained-with-error')
    resolveFirst()
    await first
  })
})

describe('companion warnings on direct outcome', () => {
  it('direct open carries companion warnings for failed companions', async () => {
    const plan = makePlan({
      companions: [
        { port: 3001, protocol: 'http', advertisedUrl: 'http://127.0.0.1:3001' },
        { port: 3002, protocol: 'https', advertisedUrl: 'https://127.0.0.1:3002' }
      ]
    })
    const client = new FakeRuntimePortTunnelClient({
      acquire: () => ({
        selected: { ok: true, leaseId: 'L-sel', localOrigin: 'http://127.0.0.1:5173' },
        companions: [
          { ok: false, reason: 'port occupied' },
          { ok: true, leaseId: 'L-c2', localOrigin: 'https://127.0.0.1:3002' }
        ]
      })
    })
    const { controller } = setup({ client })
    const r = await controller.openTunneledPage({
      capability: CAPABLE,
      workspaceId: 'ws-1',
      worktreeId: 'repo::/srv/app',
      plan
    })
    expect(r.outcome).toBe('direct')
    if (r.outcome === 'direct') {
      expect(r.companionWarnings).toHaveLength(1)
      expect(r.companionWarnings[0]).toEqual({
        port: 3001,
        protocol: 'http',
        reason: 'port occupied'
      })
    }
  })
  it('direct restore carries companion warnings', async () => {
    const plan = makePlan({
      companions: [{ port: 3001, protocol: 'http', advertisedUrl: 'http://127.0.0.1:3001' }]
    })
    const client = new FakeRuntimePortTunnelClient({
      acquire: () => ({
        selected: { ok: true, leaseId: 'L-sel', localOrigin: 'http://127.0.0.1:5173' },
        companions: [{ ok: false, reason: 'companion down' }]
      })
    })
    const store = new FakeBrowserPageStorePort({ pages: { 'page-1': makeClientOwnedPage() } })
    const { controller } = setup({ client, store })
    const r = await controller.restoreTunneledPage({
      capability: CAPABLE,
      pageId: 'page-1',
      plan
    })
    expect(r.outcome).toBe('direct')
    if (r.outcome === 'direct') {
      expect(r.companionWarnings).toHaveLength(1)
      expect(r.companionWarnings[0]).toEqual({
        port: 3001,
        protocol: 'http',
        reason: 'companion down'
      })
    }
  })
  it('no companion warnings when all companions succeed', async () => {
    const { controller } = setup()
    const r = await controller.openTunneledPage({
      capability: CAPABLE,
      workspaceId: 'ws-1',
      worktreeId: 'repo::/srv/app',
      plan: makePlan()
    })
    expect(r.outcome).toBe('direct')
    if (r.outcome === 'direct') {
      expect(r.companionWarnings).toEqual([])
    }
  })
})
