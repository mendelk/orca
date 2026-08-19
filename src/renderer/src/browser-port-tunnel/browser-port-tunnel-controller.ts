/* Why: Stage 2 direct-render controller. Thin orchestrator wiring dedup,
 *  new-open-fallback, dropped-status, fallback-flow, and operation-bodies
 *  modules. See sibling modules for the detailed semantics. */
import type { NormalizedOrigin } from '../../../shared/browser-port-tunnel-url'
import type { BrowserPortTunnelDescriptor } from '../../../shared/browser-workspace-types'
import type {
  OperationIdGenerator,
  RuntimePortTunnelClient,
  TunnelAcquireOutcome,
  TunnelEndpointPlanSet,
  TunnelReleaseFailure
} from './runtime-port-tunnel-client-port'
import type { BrowserPageStorePort } from './browser-page-store-port'
import type { RemoteBrowserFallbackPort } from './remote-browser-fallback-port'
import { TunnelLeaseState, type PageLease } from './tunnel-lease-state'
import { withDedup } from './tunnel-dedup'
import { planDroppedStatusAction } from './tunnel-dropped-status'
import { runControllerFallback } from './tunnel-fallback-flow'
import { runOpenBody, runRestoreBody, type OperationDeps } from './tunnel-operation-bodies'
import { buildLeaseSet, releaseLeaseSet as releaseLeaseSetHelper } from './tunnel-lease-helpers'
import { runNewOpenFallback } from './tunnel-new-open-fallback'
import { openFingerprint, restoreFingerprint } from './tunnel-fingerprint'

export type PortTunnelCapabilityVerdict = { available: true } | { available: false; reason: string }

export type CompanionWarning = {
  port: number
  protocol: string
  reason: string
}

export type OpenTunneledPageOutcome =
  | { outcome: 'direct'; pageId: string; companionWarnings: CompanionWarning[] }
  | { outcome: 'fallback-to-remote'; pageId: string }
  | { outcome: 'retained-with-error'; reason: string }

export type RestoreTunneledPageOutcome =
  | { outcome: 'direct'; pageId: string; companionWarnings: CompanionWarning[] }
  | { outcome: 'fallback'; pageId: string }
  | { outcome: 'retained-with-error'; pageId: string; reason: string }
  | { outcome: 'page-gone' }

const MAX_RELEASE_FAILURES = 64

export class BrowserPortTunnelController {
  private readonly leaseState = new TunnelLeaseState()
  private readonly releaseFailures: TunnelReleaseFailure[] = []
  private readonly releaseFailureSubscribers = new Set<(f: TunnelReleaseFailure) => void>()
  private disposed = false
  private unsubscribeStatus: (() => void) | null = null
  private unsubscribeReleaseFailure: (() => void) | null = null

  constructor(
    private readonly client: RuntimePortTunnelClient,
    private readonly store: BrowserPageStorePort,
    private readonly fallback: RemoteBrowserFallbackPort,
    private readonly ids: OperationIdGenerator
  ) {}

  start(): void {
    if (this.disposed || this.unsubscribeStatus) {
      return
    }
    this.unsubscribeStatus = this.client.onStatusChanged((event) => {
      if (event.status.state === 'dropped') {
        this.handleDroppedStatus(event.leaseId, event.status.reason).catch(() => {})
      }
    })
    this.unsubscribeReleaseFailure = this.client.onReleaseFailure((f) =>
      this.recordReleaseFailure(f)
    )
  }

  onReleaseFailure(cb: (failure: TunnelReleaseFailure) => void): () => void {
    this.releaseFailureSubscribers.add(cb)
    return () => {
      this.releaseFailureSubscribers.delete(cb)
    }
  }

  releaseFailuresList(): TunnelReleaseFailure[] {
    return [...this.releaseFailures]
  }

  async openTunneledPage(args: {
    capability: PortTunnelCapabilityVerdict
    workspaceId: string
    worktreeId: string
    plan: TunnelEndpointPlanSet
    operationKey?: string
  }): Promise<OpenTunneledPageOutcome> {
    if (this.disposed) {
      return { outcome: 'retained-with-error', reason: 'controller disposed' }
    }
    // Why: both direct and capability-fallback paths go through the same
    // fingerprinted dedup operation so concurrent retries with the same
    // operation key do not create duplicate remote pages.
    const opKey =
      args.operationKey ?? this.ids.operationKey({ workspaceId: args.workspaceId, plan: args.plan })
    const fingerprint = openFingerprint(args)
    return this.withOpenDedup(`pending::${opKey}`, fingerprint, () => {
      if (!args.capability.available) {
        return this.runNewOpenFallback(args, args.capability.reason)
      }
      return runOpenBody(this.operationDeps(), args, opKey)
    })
  }

  async restoreTunneledPage(args: {
    capability: PortTunnelCapabilityVerdict
    pageId: string
    plan: TunnelEndpointPlanSet
  }): Promise<RestoreTunneledPageOutcome> {
    if (this.disposed) {
      return { outcome: 'retained-with-error', pageId: args.pageId, reason: 'controller disposed' }
    }
    if (!this.store.getPage(args.pageId)) {
      return { outcome: 'page-gone' }
    }
    if (!args.capability.available) {
      return this.fallbackRestore(args.pageId, args.plan.descriptor, null, args.capability.reason)
    }
    return this.withRestoreDedup(args.pageId, restoreFingerprint(args), () =>
      runRestoreBody(this.operationDeps(), args)
    )
  }

  async releaseOnClose(pageId: string): Promise<void> {
    const leases = this.leaseState.dropPage(pageId)
    await this.releaseLeaseSet(leases)
  }

  async releaseOnEnvironmentRevision(pageId: string): Promise<void> {
    const leases = this.leaseState.dropPage(pageId)
    await this.releaseLeaseSet(leases)
  }

  async releaseOnOwnershipTransition(pageId: string): Promise<void> {
    const leases = this.leaseState.clearLeases(pageId)
    await this.releaseLeaseSet(leases)
  }

  async dispose(): Promise<void> {
    this.disposed = true
    if (this.unsubscribeStatus) {
      this.unsubscribeStatus()
      this.unsubscribeStatus = null
    }
    if (this.unsubscribeReleaseFailure) {
      this.unsubscribeReleaseFailure()
      this.unsubscribeReleaseFailure = null
    }
    const entries = this.leaseState.activeLeases()
    this.leaseState.clear()
    await Promise.all(entries.map((e) => this.releaseLeaseSet(e.leases)))
  }

  isInFlight(pageId: string): boolean {
    return this.leaseState.inFlightOf(pageId) !== null
  }

  activeLeaseIdsFor(pageId: string): string[] {
    return this.leaseState.leasesFor(pageId).map((l) => l.leaseId)
  }

  private operationDeps(): OperationDeps {
    return {
      client: this.client,
      store: this.store,
      fallback: this.fallback,
      ids: this.ids,
      leaseState: this.leaseState,
      safeRelease: (id) => this.safeRelease(id),
      recordLeaseSet: (pageId, descriptor, outcome, origin) =>
        this.recordLeaseSet(pageId, descriptor, outcome, origin),
      fallbackRestore: (pageId, descriptor, origin, reason) =>
        this.fallbackRestore(pageId, descriptor, origin, reason)
    }
  }

  /** Dedup wrapper for open operations. Catches dedup collision and returns
   *  a bounded retained-with-error instead of throwing to the caller.
   *  Stores the actual run promise so internal rejections are handled. */
  private async withOpenDedup(
    dedupKey: string,
    fingerprint: string,
    run: () => Promise<OpenTunneledPageOutcome>
  ): Promise<OpenTunneledPageOutcome> {
    try {
      return await withDedup(this.leaseState, dedupKey, fingerprint, run)
    } catch (error) {
      return {
        outcome: 'retained-with-error',
        reason: error instanceof Error ? error.message : String(error)
      }
    }
  }

  private async withRestoreDedup(
    dedupKey: string,
    fingerprint: string,
    run: () => Promise<RestoreTunneledPageOutcome>
  ): Promise<RestoreTunneledPageOutcome> {
    try {
      return await withDedup(this.leaseState, dedupKey, fingerprint, run)
    } catch (error) {
      return {
        outcome: 'retained-with-error',
        pageId: dedupKey,
        reason: error instanceof Error ? error.message : String(error)
      }
    }
  }

  private async runNewOpenFallback(
    args: { workspaceId: string; worktreeId: string; plan: TunnelEndpointPlanSet },
    reason: string
  ): Promise<OpenTunneledPageOutcome> {
    return runNewOpenFallback({
      store: this.store,
      fallback: this.fallback,
      workspaceId: args.workspaceId,
      worktreeId: args.worktreeId,
      plan: args.plan,
      failureReason: reason
    })
  }

  private async handleDroppedStatus(leaseId: string, reason: string): Promise<void> {
    const action = planDroppedStatusAction({
      leaseState: this.leaseState,
      leaseId,
      reason,
      runFallback: (pageId, descriptor, localOrigin, r) =>
        this.fallbackRestore(pageId, descriptor, localOrigin, r)
    })
    if (action.kind === 'companion-partial') {
      this.leaseState.removeCompanionLease(action.leaseId)
      await this.safeRelease(action.leaseId)
      return
    }
    if (action.kind === 'selected-fallback') {
      try {
        await action.fallbackPromise
      } finally {
        action.complete()
      }
    }
  }

  private async fallbackRestore(
    pageId: string,
    descriptor: BrowserPortTunnelDescriptor,
    localOrigin: NormalizedOrigin | null,
    reason: string
  ): Promise<RestoreTunneledPageOutcome> {
    const hadState = this.leaseState.has(pageId)
    const generation = this.leaseState.generationOf(pageId)
    const result = await runControllerFallback({
      store: this.store,
      fallback: this.fallback,
      pageId,
      descriptor,
      localOrigin,
      failureReason: reason,
      releaseLeases: (leases) => this.releaseLeaseSet(leases),
      clearLeases: () => this.leaseState.clearLeases(pageId),
      isStale: () => this.disposed || (hadState && this.leaseState.isStale(pageId, generation))
    })
    if (this.disposed || (hadState && this.leaseState.isStale(pageId, generation))) {
      return { outcome: 'page-gone' }
    }
    if (result.outcome === 'fallback') {
      return { outcome: 'fallback', pageId }
    }
    if (result.outcome === 'page-gone') {
      return { outcome: 'page-gone' }
    }
    return { outcome: 'retained-with-error', pageId, reason: result.reason ?? 'fallback failed' }
  }

  private recordReleaseFailure(failure: TunnelReleaseFailure): void {
    if (
      this.releaseFailures.some((f) => f.leaseId === failure.leaseId && f.reason === failure.reason)
    ) {
      return
    }
    this.releaseFailures.push(failure)
    if (this.releaseFailures.length > MAX_RELEASE_FAILURES) {
      this.releaseFailures.shift()
    }
    for (const cb of this.releaseFailureSubscribers) {
      try {
        cb(failure)
      } catch {
        // subscriber errors must not break release handling
      }
    }
  }

  private recordLeaseSet(
    pageId: string,
    descriptor: BrowserPortTunnelDescriptor,
    acquireOutcome: TunnelAcquireOutcome,
    localOrigin: NormalizedOrigin
  ): void {
    this.leaseState.recordLeases(pageId, descriptor, buildLeaseSet(acquireOutcome, localOrigin))
  }

  private async releaseLeaseSet(leases: PageLease[]): Promise<void> {
    await releaseLeaseSetHelper(leases, (id) => this.safeRelease(id))
  }

  private async safeRelease(leaseId: string): Promise<void> {
    try {
      await this.client.release({ leaseId })
    } catch (error) {
      this.recordReleaseFailure({
        leaseId,
        reason: error instanceof Error ? error.message : String(error)
      })
    }
  }
}
