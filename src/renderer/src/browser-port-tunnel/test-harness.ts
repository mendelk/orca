/* Why: deterministic fakes for the injected ports, shared across the
 *  controller test files. Fixtures live in test-fixtures.ts. The fake store
 *  obeys the exact production port contract: transition is existing-page-only
 *  (never invents pages), createHostOwnedRemotePage creates a new page
 *  atomically, no hardcoded workspace IDs, no Date.now/Math.random. */
import type {
  BrowserLoadError,
  BrowserPage,
  BrowserPortTunnelDescriptor
} from '../../../shared/browser-workspace-types'
import type { RemoteBrowserPageHandle } from '../store/slices/browser-port-tunnel-actions'
import {
  normalizeLocalOrigin,
  type NormalizedOrigin
} from '../../../shared/browser-port-tunnel-url'
import { createClientOwnedTunneledPage } from '../store/slices/browser-port-tunnel-actions'
import { transitionPageToHostOwnedRemoteHandle } from '../store/slices/browser-port-tunnel-actions'
import type { BrowserPageStorePort, MaterializeOutcome } from './browser-page-store-port'
import type {
  RuntimePortTunnelClient,
  TunnelAcquireOutcome,
  TunnelEndpointPlanSet,
  TunnelReleaseFailure,
  TunnelStatusEvent
} from './runtime-port-tunnel-client-port'

export type FakeTunnelClientCalls = {
  operationKey: string
  plan: TunnelEndpointPlanSet
}[]

export type FakeTunnelClientOptions = {
  acquire?: (
    operationKey: string,
    plan: TunnelEndpointPlanSet
  ) => TunnelAcquireOutcome | Promise<TunnelAcquireOutcome>
  releaseError?: Error
  releaseFailures?: TunnelReleaseFailure[]
}

export class FakeRuntimePortTunnelClient implements RuntimePortTunnelClient {
  readonly calls: FakeTunnelClientCalls = []
  readonly releasedLeaseIds: string[] = []
  private readonly statusCallbacks = new Set<(event: TunnelStatusEvent) => void>()
  private readonly releaseFailureCallbacks = new Set<(f: TunnelReleaseFailure) => void>()
  private readonly options: FakeTunnelClientOptions
  private leaseCounter = 0

  constructor(options: FakeTunnelClientOptions = {}) {
    this.options = options
  }

  async acquire(args: {
    operationKey: string
    plan: TunnelEndpointPlanSet
  }): Promise<TunnelAcquireOutcome> {
    this.calls.push({ operationKey: args.operationKey, plan: args.plan })
    if (this.options.acquire) {
      return await this.options.acquire(args.operationKey, args.plan)
    }
    return this.defaultAcquireSuccess(args.plan)
  }

  private defaultAcquireSuccess(plan: TunnelEndpointPlanSet): TunnelAcquireOutcome {
    const proto = plan.selected.protocol === 'unknown' ? 'http' : plan.selected.protocol
    const localOrigin = `${proto}://127.0.0.1:${plan.selected.port}`
    return {
      selected: {
        ok: true,
        leaseId: `lease-selected-${plan.selected.port}-${this.leaseCounter++}`,
        localOrigin
      },
      companions: plan.companions.map((c) => ({
        ok: true as const,
        leaseId: `lease-companion-${c.port}-${this.leaseCounter++}`,
        localOrigin: `${c.protocol === 'unknown' ? 'http' : c.protocol}://127.0.0.1:${c.port}`
      }))
    }
  }

  async release(args: { leaseId: string }): Promise<void> {
    if (this.options.releaseError) {
      throw this.options.releaseError
    }
    this.releasedLeaseIds.push(args.leaseId)
  }

  onStatusChanged(callback: (event: TunnelStatusEvent) => void): () => void {
    this.statusCallbacks.add(callback)
    return () => {
      this.statusCallbacks.delete(callback)
    }
  }

  onReleaseFailure(callback: (f: TunnelReleaseFailure) => void): () => void {
    this.releaseFailureCallbacks.add(callback)
    return () => {
      this.releaseFailureCallbacks.delete(callback)
    }
  }

  emitDropped(leaseId: string, reason = 'channel closed'): void {
    for (const cb of this.statusCallbacks) {
      cb({ leaseId, status: { state: 'dropped', reason } })
    }
  }

  emitReleaseFailure(failure: TunnelReleaseFailure): void {
    for (const cb of this.releaseFailureCallbacks) {
      cb(failure)
    }
  }
}

export type FakeStoreOptions = {
  pages?: Record<string, BrowserPage>
  createFailure?: string
  materializeFailure?: string
  transitionFailure?: string
  hostOwnedCreateFailure?: string
}

export class FakeBrowserPageStorePort implements BrowserPageStorePort {
  readonly pages: Map<string, BrowserPage>
  readonly loadErrors: { pageId: string; error: BrowserLoadError }[] = []
  readonly materializedPageIds: string[] = []
  readonly hostOwnedPageIds: string[] = []
  private nextIdCounter = 0
  private readonly options: FakeStoreOptions

  constructor(options: FakeStoreOptions = {}) {
    this.pages = new Map(Object.entries(options.pages ?? {}))
    this.options = options
  }

  getPage(pageId: string): BrowserPage | null {
    return this.pages.get(pageId) ?? null
  }

  createClientOwnedTunneledPage(args: {
    workspaceId: string
    worktreeId: string
    plan: TunnelEndpointPlanSet
    localOrigin: NormalizedOrigin
  }): MaterializeOutcome {
    if (this.options.createFailure) {
      return { ok: false, reason: this.options.createFailure }
    }
    const pageId = `page-${args.workspaceId}-${this.nextIdCounter++}`
    return this.materialize(pageId, args.workspaceId, args.worktreeId, args.plan, args.localOrigin)
  }

  materializeExistingTunneledPage(args: {
    pageId: string
    plan: TunnelEndpointPlanSet
    localOrigin: NormalizedOrigin
  }): MaterializeOutcome {
    if (this.options.materializeFailure) {
      return { ok: false, reason: this.options.materializeFailure }
    }
    const existing = this.pages.get(args.pageId)
    if (!existing) {
      return { ok: false, reason: 'page gone' }
    }
    const result = createClientOwnedTunneledPage({
      pageId: args.pageId,
      workspaceId: existing.workspaceId,
      worktreeId: existing.worktreeId,
      descriptor: args.plan.descriptor,
      remoteUrl: args.plan.selected.advertisedUrl,
      localOrigin: args.localOrigin
    })
    if (!result.ok) {
      return { ok: false, reason: result.reason }
    }
    this.pages.set(args.pageId, result.page)
    this.materializedPageIds.push(args.pageId)
    return {
      ok: true,
      pageId: args.pageId,
      localUrl: result.localUrl,
      localPort: result.localPort,
      descriptor: result.descriptor
    }
  }

  createHostOwnedRemotePage(args: {
    workspaceId: string
    worktreeId: string
    descriptor: BrowserPortTunnelDescriptor
    remoteUrl: string
    handle: RemoteBrowserPageHandle
  }): { ok: true; pageId: string } | { ok: false; reason: string } {
    if (this.options.hostOwnedCreateFailure) {
      return { ok: false, reason: this.options.hostOwnedCreateFailure }
    }
    const pageId = `host-owned-${args.workspaceId}-${this.nextIdCounter++}`
    const page: BrowserPage = {
      id: pageId,
      workspaceId: args.workspaceId,
      worktreeId: args.worktreeId,
      url: args.remoteUrl,
      title: 'Remote Tab',
      loading: true,
      faviconUrl: null,
      canGoBack: false,
      canGoForward: false,
      loadError: null,
      createdAt: 0,
      browserRuntimeEnvironmentId: args.handle.environmentId,
      portTunnelDescriptor: args.descriptor
    }
    this.pages.set(pageId, page)
    this.hostOwnedPageIds.push(pageId)
    return { ok: true, pageId }
  }

  transitionPageToHostOwnedRemoteHandle(args: {
    pageId: string
    remoteHandle: RemoteBrowserPageHandle | null
    remoteHandleError: string | null
  }):
    | { ok: true; handle: RemoteBrowserPageHandle; remoteUrl: string }
    | { ok: false; reason: string } {
    if (this.options.transitionFailure) {
      return { ok: false, reason: this.options.transitionFailure }
    }
    // Why: transition is EXISTING-PAGE-ONLY. Do NOT invent a page when the
    // page is missing — that masks production failures. Return an error.
    const page = this.pages.get(args.pageId)
    if (!page) {
      return { ok: false, reason: 'page missing' }
    }
    if (!page.portTunnelDescriptor) {
      return { ok: false, reason: 'page has no descriptor' }
    }
    if (args.remoteHandleError || !args.remoteHandle) {
      return { ok: false, reason: args.remoteHandleError ?? 'remote browser creation failed' }
    }
    const result = transitionPageToHostOwnedRemoteHandle({
      page,
      descriptor: page.portTunnelDescriptor,
      localOrigin:
        normalizeLocalOrigin(
          `${page.portTunnelDescriptor.remoteOrigin.split('://')[0]}://127.0.0.1:${page.portTunnelDescriptor.remotePort}`
        ) ?? normalizeLocalOrigin(page.portTunnelDescriptor.remoteOrigin)!,
      remoteHandle: args.remoteHandle,
      remoteHandleError: null
    })
    if (!result.ok) {
      return { ok: false, reason: result.reason }
    }
    this.pages.set(args.pageId, result.page)
    return { ok: true, handle: result.handle, remoteUrl: result.remoteUrl }
  }

  setPageLoadError(pageId: string, error: BrowserLoadError): void {
    this.loadErrors.push({ pageId, error })
  }

  private materialize(
    pageId: string,
    workspaceId: string,
    worktreeId: string,
    plan: TunnelEndpointPlanSet,
    localOrigin: NormalizedOrigin
  ): MaterializeOutcome {
    const result = createClientOwnedTunneledPage({
      pageId,
      workspaceId,
      worktreeId,
      descriptor: plan.descriptor,
      remoteUrl: plan.selected.advertisedUrl,
      localOrigin
    })
    if (!result.ok) {
      return { ok: false, reason: result.reason }
    }
    this.pages.set(pageId, result.page)
    this.materializedPageIds.push(pageId)
    return {
      ok: true,
      pageId,
      localUrl: result.localUrl,
      localPort: result.localPort,
      descriptor: result.descriptor
    }
  }
}

export {
  FakeRemoteBrowserFallbackPort,
  type FakeFallbackCall,
  type FakeFallbackOptions
} from './test-fake-fallback'
export { makePlan, makeClientOwnedPage, deterministicIdGenerator } from './test-fixtures'
