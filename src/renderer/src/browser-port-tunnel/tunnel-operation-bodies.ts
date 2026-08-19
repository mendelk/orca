/* Why: the open and restore operation bodies are split out of the orchestrator
 *  to keep it under the max-lines budget. Each body acquires, validates, and
 *  materializes/updates a page, delegating fallback to the new-open-fallback or
 *  controller-fallback modules. Exception-safe: acquire rejections are caught
 *  and routed to fallback with a bounded reason. */
import { normalizeLocalOrigin } from '../../../shared/browser-port-tunnel-url'
import type { BrowserPortTunnelDescriptor } from '../../../shared/browser-workspace-types'
import type {
  OperationIdGenerator,
  RuntimePortTunnelClient,
  TunnelAcquireOutcome,
  TunnelEndpointPlanSet
} from './runtime-port-tunnel-client-port'
import type { BrowserPageStorePort } from './browser-page-store-port'
import type { RemoteBrowserFallbackPort } from './remote-browser-fallback-port'
import type { TunnelLeaseState } from './tunnel-lease-state'
import { releaseAcquired } from './tunnel-lease-helpers'
import { runNewOpenFallback } from './tunnel-new-open-fallback'
import type { NormalizedOrigin } from '../../../shared/browser-port-tunnel-url'
import type {
  CompanionWarning,
  OpenTunneledPageOutcome,
  RestoreTunneledPageOutcome
} from './browser-port-tunnel-controller'

/** Build companion warnings from an acquire outcome, mapping planned
 *  companion port and protocol to failure reason. */
function companionWarnings(
  plan: TunnelEndpointPlanSet,
  outcome: TunnelAcquireOutcome
): CompanionWarning[] {
  return outcome.companions
    .map((c, i): CompanionWarning | null => {
      const planned = plan.companions[i]
      if (!planned || c.ok) {
        return null
      }
      return { port: planned.port, protocol: planned.protocol, reason: c.reason }
    })
    .filter((w): w is CompanionWarning => w !== null)
}

/** Shared dependencies injected into the operation bodies. */
export type OperationDeps = {
  client: RuntimePortTunnelClient
  store: BrowserPageStorePort
  fallback: RemoteBrowserFallbackPort
  ids: OperationIdGenerator
  leaseState: TunnelLeaseState
  safeRelease: (leaseId: string) => Promise<void>
  recordLeaseSet: (
    pageId: string,
    descriptor: BrowserPortTunnelDescriptor,
    acquireOutcome: TunnelAcquireOutcome,
    localOrigin: NormalizedOrigin
  ) => void
  fallbackRestore: (
    pageId: string,
    descriptor: BrowserPortTunnelDescriptor,
    localOrigin: NormalizedOrigin | null,
    reason: string
  ) => Promise<RestoreTunneledPageOutcome>
}

export async function runOpenBody(
  deps: OperationDeps,
  args: { workspaceId: string; worktreeId: string; plan: TunnelEndpointPlanSet },
  opKey: string
): Promise<OpenTunneledPageOutcome> {
  const pendingId = `pending::${opKey}`
  const generation = deps.leaseState.nextGeneration(pendingId)
  const acquireOperationId = deps.ids.acquireOperationId({ pageId: pendingId, generation })
  let acquireOutcome: TunnelAcquireOutcome
  try {
    acquireOutcome = await deps.client.acquire({
      operationKey: acquireOperationId,
      plan: args.plan
    })
  } catch (error) {
    deps.leaseState.dropPage(pendingId)
    return runNewOpenFallback({
      store: deps.store,
      fallback: deps.fallback,
      workspaceId: args.workspaceId,
      worktreeId: args.worktreeId,
      plan: args.plan,
      failureReason: error instanceof Error ? error.message : String(error)
    })
  }
  if (deps.leaseState.isStale(pendingId, generation)) {
    await releaseAcquired(acquireOutcome, deps.safeRelease)
    deps.leaseState.dropPage(pendingId)
    return { outcome: 'retained-with-error', reason: 'stale' }
  }
  if (!acquireOutcome.selected.ok) {
    await releaseAcquired(acquireOutcome, deps.safeRelease)
    deps.leaseState.dropPage(pendingId)
    return runNewOpenFallback({
      store: deps.store,
      fallback: deps.fallback,
      workspaceId: args.workspaceId,
      worktreeId: args.worktreeId,
      plan: args.plan,
      failureReason: acquireOutcome.selected.reason
    })
  }
  const localOrigin = normalizeLocalOrigin(acquireOutcome.selected.localOrigin)
  if (!localOrigin) {
    await releaseAcquired(acquireOutcome, deps.safeRelease)
    deps.leaseState.dropPage(pendingId)
    return runNewOpenFallback({
      store: deps.store,
      fallback: deps.fallback,
      workspaceId: args.workspaceId,
      worktreeId: args.worktreeId,
      plan: args.plan,
      failureReason: 'tunnel returned an invalid local origin'
    })
  }
  let createOutcome: ReturnType<BrowserPageStorePort['createClientOwnedTunneledPage']>
  try {
    createOutcome = deps.store.createClientOwnedTunneledPage({
      workspaceId: args.workspaceId,
      worktreeId: args.worktreeId,
      plan: args.plan,
      localOrigin
    })
  } catch (error) {
    await releaseAcquired(acquireOutcome, deps.safeRelease)
    deps.leaseState.dropPage(pendingId)
    return runNewOpenFallback({
      store: deps.store,
      fallback: deps.fallback,
      workspaceId: args.workspaceId,
      worktreeId: args.worktreeId,
      plan: args.plan,
      failureReason: error instanceof Error ? error.message : String(error)
    })
  }
  if (!createOutcome.ok) {
    await releaseAcquired(acquireOutcome, deps.safeRelease)
    deps.leaseState.dropPage(pendingId)
    return runNewOpenFallback({
      store: deps.store,
      fallback: deps.fallback,
      workspaceId: args.workspaceId,
      worktreeId: args.worktreeId,
      plan: args.plan,
      failureReason: createOutcome.reason
    })
  }
  deps.recordLeaseSet(createOutcome.pageId, createOutcome.descriptor, acquireOutcome, localOrigin)
  deps.leaseState.dropPage(pendingId)
  return {
    outcome: 'direct',
    pageId: createOutcome.pageId,
    companionWarnings: companionWarnings(args.plan, acquireOutcome)
  }
}

export async function runRestoreBody(
  deps: OperationDeps,
  args: { pageId: string; plan: TunnelEndpointPlanSet }
): Promise<RestoreTunneledPageOutcome> {
  const generation = deps.leaseState.nextGeneration(args.pageId)
  const acquireOperationId = deps.ids.acquireOperationId({ pageId: args.pageId, generation })
  let acquireOutcome: TunnelAcquireOutcome
  try {
    acquireOutcome = await deps.client.acquire({
      operationKey: acquireOperationId,
      plan: args.plan
    })
  } catch (error) {
    return deps.fallbackRestore(
      args.pageId,
      args.plan.descriptor,
      null,
      error instanceof Error ? error.message : String(error)
    )
  }
  if (deps.leaseState.isStale(args.pageId, generation)) {
    await releaseAcquired(acquireOutcome, deps.safeRelease)
    return { outcome: 'retained-with-error', pageId: args.pageId, reason: 'stale' }
  }
  if (!acquireOutcome.selected.ok) {
    await releaseAcquired(acquireOutcome, deps.safeRelease)
    return deps.fallbackRestore(
      args.pageId,
      args.plan.descriptor,
      null,
      acquireOutcome.selected.reason
    )
  }
  const localOrigin = normalizeLocalOrigin(acquireOutcome.selected.localOrigin)
  if (!localOrigin) {
    await releaseAcquired(acquireOutcome, deps.safeRelease)
    return deps.fallbackRestore(
      args.pageId,
      args.plan.descriptor,
      null,
      'tunnel returned an invalid local origin'
    )
  }
  let materialize: ReturnType<BrowserPageStorePort['materializeExistingTunneledPage']>
  try {
    materialize = deps.store.materializeExistingTunneledPage({
      pageId: args.pageId,
      plan: args.plan,
      localOrigin
    })
  } catch (error) {
    await releaseAcquired(acquireOutcome, deps.safeRelease)
    return deps.fallbackRestore(
      args.pageId,
      args.plan.descriptor,
      null,
      error instanceof Error ? error.message : String(error)
    )
  }
  if (!materialize.ok) {
    await releaseAcquired(acquireOutcome, deps.safeRelease)
    return deps.fallbackRestore(args.pageId, args.plan.descriptor, null, materialize.reason)
  }
  deps.recordLeaseSet(materialize.pageId, materialize.descriptor, acquireOutcome, localOrigin)
  return {
    outcome: 'direct',
    pageId: materialize.pageId,
    companionWarnings: companionWarnings(args.plan, acquireOutcome)
  }
}
