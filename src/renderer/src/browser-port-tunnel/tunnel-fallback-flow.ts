/* Why: the fallback flow (translate last committed URL using the ACTUAL stored
 *  local origin → create one remote handle → atomically update ownership →
 *  release the dead lease set exactly once → close orphan remote handle on
 *  transition failure → never auto-promote) is a self-contained sequence over
 *  the store, remote-fallback, and cleanup ports. Splitting it from the
 *  orchestrator keeps both under the max-lines budget and makes the one-shot
 *  fallback semantics testable in isolation.
 *
 *  Critical fix: URL translation uses the localOrigin returned by acquisition
 *  and stored in lease state, NOT a reconstructed 127.0.0.1 origin — the latter
 *  breaks custom hostnames needed for Host headers, cookies, and TLS SNI. */
import {
  translateLocalUrlToRemote,
  normalizeLocalOrigin
} from '../../../shared/browser-port-tunnel-url'
import type {
  BrowserPage,
  BrowserPortTunnelDescriptor
} from '../../../shared/browser-workspace-types'
import type { NormalizedOrigin } from '../../../shared/browser-port-tunnel-url'
import type { BrowserPageStorePort, FallbackRemoteHandleOutcome } from './browser-page-store-port'
import type {
  CreateRemoteBrowserPageOutcome,
  RemoteBrowserFallbackPort
} from './remote-browser-fallback-port'
import type { RemoteBrowserPageHandle } from '../store/slices/browser-port-tunnel-actions'
import type { PageLease } from './tunnel-lease-state'

/** Outcome of a one-shot fallback. `transitioned` means the page is now
 *  host-owned and the caller must release the dead lease set once.
 *  `retained-with-error` means remote creation or the transition failed; the
 *  page stays with a bounded load error and the descriptor is retained for
 *  retry. `page-gone` means the page vanished mid-fallback. */
export type FallbackFlowOutcome =
  | { outcome: 'transitioned'; pageId: string }
  | { outcome: 'retained-with-error'; pageId: string; reason: string }
  | { outcome: 'page-gone' }

/** Run the one-shot fallback for a page: translate the last committed URL
 *  using the ACTUAL stored local origin, create one remote handle, atomically
 *  transition ownership, and surface a bounded load error on failure. Never
 *  auto-promote — the caller releases the dead lease set once after a
 *  successful transition AND once after a failure (the lease is dead either
 *  way; failing to release it on a failed fallback leaks the lease).
 *
 *  `failureReason` explains why fallback was triggered (acquire failure,
 *  dropped status, etc.) and is folded into the retained load error so the
 *  existing load-error surface explains both causes.
 *
 *  `localOrigin` is the actual origin returned by acquisition and stored in
 *  lease state. When null (e.g. restore from a mixed-version session with no
 *  stored origin), translation falls back to the page URL verbatim — this is
 *  correct for external navigation and for the rare no-stored-origin case. */
export async function runFallbackFlow(args: {
  store: BrowserPageStorePort
  fallback: RemoteBrowserFallbackPort
  pageId: string
  descriptor: BrowserPortTunnelDescriptor
  localOrigin: NormalizedOrigin | null
  failureReason: string
  isStale?: () => boolean
}): Promise<FallbackFlowOutcome> {
  let page: BrowserPage | null
  try {
    page = args.store.getPage(args.pageId)
  } catch {
    return { outcome: 'page-gone' }
  }
  if (!page) {
    return { outcome: 'page-gone' }
  }
  const remoteUrl = translateLastCommittedUrl(page.url, args.descriptor, args.localOrigin)
  let remoteOutcome: CreateRemoteBrowserPageOutcome
  try {
    remoteOutcome = await args.fallback.createRemoteBrowserPage({
      kind: 'existing-page',
      pageId: args.pageId,
      descriptor: args.descriptor,
      remoteUrl
    })
  } catch (error) {
    trySetPageLoadError(
      args.store,
      args.pageId,
      `${args.failureReason}; ${error instanceof Error ? error.message : String(error)}`,
      page.url
    )
    return {
      outcome: 'retained-with-error',
      pageId: args.pageId,
      reason: error instanceof Error ? error.message : String(error)
    }
  }
  if (!remoteOutcome.ok) {
    trySetPageLoadError(
      args.store,
      args.pageId,
      `${args.failureReason}; ${remoteOutcome.reason}`,
      page.url
    )
    return { outcome: 'retained-with-error', pageId: args.pageId, reason: remoteOutcome.reason }
  }
  if (args.isStale?.()) {
    await closeBestEffort(args.fallback, remoteOutcome.handle)
    return { outcome: 'page-gone' }
  }
  let transition: FallbackRemoteHandleOutcome
  try {
    transition = args.store.transitionPageToHostOwnedRemoteHandle({
      pageId: args.pageId,
      remoteHandle: remoteOutcome.handle,
      remoteHandleError: null
    })
  } catch (error) {
    await closeBestEffort(args.fallback, remoteOutcome.handle)
    trySetPageLoadError(
      args.store,
      args.pageId,
      `${args.failureReason}; ${error instanceof Error ? error.message : String(error)}`,
      page.url
    )
    return {
      outcome: 'retained-with-error',
      pageId: args.pageId,
      reason: error instanceof Error ? error.message : String(error)
    }
  }
  if (!transition.ok) {
    await closeBestEffort(args.fallback, remoteOutcome.handle)
    trySetPageLoadError(
      args.store,
      args.pageId,
      `${args.failureReason}; ${transition.reason}`,
      page.url
    )
    return { outcome: 'retained-with-error', pageId: args.pageId, reason: transition.reason }
  }
  return { outcome: 'transitioned', pageId: args.pageId }
}

/** Translate the page's last committed URL back to the descriptor's remote
 *  origin. When `localOrigin` is null (restore capability absence with no
 *  ephemeral stored origin), derive a same-port loopback origin from the
 *  descriptor so persisted loopback/custom URLs still translate correctly.
 *  When the page navigated away from the tunneled origin, translation returns
 *  null and the external URL is used verbatim. */
export function translateLastCommittedUrl(
  pageUrl: string,
  descriptor: BrowserPortTunnelDescriptor,
  localOrigin: NormalizedOrigin | null
): string {
  const origin = localOrigin ?? descriptorLoopbackOrigin(descriptor)
  if (!origin) {
    return pageUrl
  }
  return translateLocalUrlToRemote(pageUrl, descriptor, origin) ?? pageUrl
}

/** Derive a same-port 127.0.0.1 origin from the descriptor's remote origin
 *  and port. Used when no ephemeral localOrigin was stored (capability
 *  absence on restore). Preserves the protocol from the remote origin. */
function descriptorLoopbackOrigin(
  descriptor: BrowserPortTunnelDescriptor
): NormalizedOrigin | null {
  const protocol = descriptor.remoteOrigin.split('://')[0]
  return normalizeLocalOrigin(`${protocol}://127.0.0.1:${descriptor.remotePort}`)
}

/** Build the complete lease set to release after a fallback, regardless of
 *  success or failure. The dead selected + companion leases are released
 *  exactly once; the caller passes the stored lease set. */
export function leasesToRelease(leases: PageLease[]): string[] {
  return leases.map((l) => l.leaseId)
}

/** Higher-level controller fallback: run the one-shot fallback flow, then
 *  release the dead lease set exactly once (whether the fallback succeeded
 *  or failed — the lease is dead either way), and report the restore outcome.
 *  Returns `page-gone` when the page vanished mid-fallback. */
export async function runControllerFallback(args: {
  store: BrowserPageStorePort
  fallback: RemoteBrowserFallbackPort
  pageId: string
  descriptor: BrowserPortTunnelDescriptor
  localOrigin: NormalizedOrigin | null
  failureReason: string
  releaseLeases: (leases: PageLease[]) => Promise<void>
  clearLeases: () => PageLease[]
  isStale?: () => boolean
}): Promise<{ outcome: 'fallback' | 'retained-with-error' | 'page-gone'; reason?: string }> {
  // Why: always release the dead lease set exactly once in finally, even when
  // runFallbackFlow throws (store callback, cleanup, etc.). The lease is dead
  // either way; failing to release it leaks the lease.
  let result: FallbackFlowOutcome
  try {
    result = await runFallbackFlow({
      store: args.store,
      fallback: args.fallback,
      pageId: args.pageId,
      descriptor: args.descriptor,
      localOrigin: args.localOrigin,
      failureReason: args.failureReason,
      isStale: args.isStale
    })
  } catch (error) {
    const leases = args.clearLeases()
    await args.releaseLeases(leases)
    return {
      outcome: 'retained-with-error',
      reason: error instanceof Error ? error.message : String(error)
    }
  }
  const leases = args.clearLeases()
  await args.releaseLeases(leases)
  if (result.outcome === 'transitioned') {
    return { outcome: 'fallback' }
  }
  if (result.outcome === 'page-gone') {
    return { outcome: 'page-gone' }
  }
  return { outcome: 'retained-with-error', reason: result.reason }
}

function tunnelLoadError(reason: string, validatedUrl: string) {
  return { code: 0, description: reason, validatedUrl }
}

function trySetPageLoadError(
  store: BrowserPageStorePort,
  pageId: string,
  reason: string,
  validatedUrl: string
): void {
  try {
    store.setPageLoadError(pageId, tunnelLoadError(reason, validatedUrl))
  } catch {
    // Why: best-effort; the page is retained with whatever state it has.
  }
}

async function closeBestEffort(
  fallback: RemoteBrowserFallbackPort,
  handle: RemoteBrowserPageHandle
): Promise<void> {
  try {
    await fallback.closeRemoteBrowserPage({ handle })
  } catch {
    // Why: best-effort cleanup; the handle is already orphaned.
  }
}
