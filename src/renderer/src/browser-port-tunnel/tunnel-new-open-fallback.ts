/* Why: the NEW-open selected-acquire-failure path creates ONE host-owned
 *  remote screencast page and returns its page id, or retains an actionable
 *  bounded result on failure. Uses createHostOwnedRemotePage (NOT transition)
 *  because the page did not exist before. The remote port receives a
 *  new-open request with NO fabricated pageId — the store port is the sole
 *  generator of the new local page ID after remote handle creation. */
import type { TunnelEndpointPlanSet } from './runtime-port-tunnel-client-port'
import type { BrowserPageStorePort } from './browser-page-store-port'
import type {
  CreateRemoteBrowserPageOutcome,
  RemoteBrowserFallbackPort
} from './remote-browser-fallback-port'
import type { RemoteBrowserPageHandle } from '../store/slices/browser-port-tunnel-actions'

export type NewOpenFallbackOutcome =
  | { outcome: 'fallback-to-remote'; pageId: string }
  | { outcome: 'retained-with-error'; reason: string }

/** Run the NEW-open fallback: create one host-owned remote page for the
 *  workspace and return its page id, or a bounded retained-with-error result.
 *  The remote port receives a new-open request with NO fabricated pageId. */
export async function runNewOpenFallback(args: {
  store: BrowserPageStorePort
  fallback: RemoteBrowserFallbackPort
  workspaceId: string
  worktreeId: string
  plan: TunnelEndpointPlanSet
  failureReason: string
}): Promise<NewOpenFallbackOutcome> {
  const remoteUrl = args.plan.selected.advertisedUrl
  let remoteOutcome: CreateRemoteBrowserPageOutcome
  try {
    remoteOutcome = await args.fallback.createRemoteBrowserPage({
      kind: 'new-open',
      workspaceId: args.workspaceId,
      worktreeId: args.worktreeId,
      descriptor: args.plan.descriptor,
      remoteUrl
    })
  } catch (error) {
    return {
      outcome: 'retained-with-error',
      reason: `${args.failureReason}; ${error instanceof Error ? error.message : String(error)}`
    }
  }
  if (!remoteOutcome.ok) {
    return {
      outcome: 'retained-with-error',
      reason: `${args.failureReason}; ${remoteOutcome.reason}`
    }
  }
  let createOutcome: { ok: true; pageId: string } | { ok: false; reason: string }
  try {
    createOutcome = args.store.createHostOwnedRemotePage({
      workspaceId: args.workspaceId,
      worktreeId: args.worktreeId,
      descriptor: args.plan.descriptor,
      remoteUrl,
      handle: remoteOutcome.handle
    })
  } catch (error) {
    await closeBestEffort(args.fallback, remoteOutcome.handle)
    return {
      outcome: 'retained-with-error',
      reason: `${args.failureReason}; ${error instanceof Error ? error.message : String(error)}`
    }
  }
  if (!createOutcome.ok) {
    await closeBestEffort(args.fallback, remoteOutcome.handle)
    return {
      outcome: 'retained-with-error',
      reason: `${args.failureReason}; ${createOutcome.reason}`
    }
  }
  return { outcome: 'fallback-to-remote', pageId: createOutcome.pageId }
}

async function closeBestEffort(
  fallback: RemoteBrowserFallbackPort,
  handle: RemoteBrowserPageHandle
): Promise<void> {
  try {
    await fallback.closeRemoteBrowserPage({ handle })
  } catch {
    // best-effort cleanup; the handle is already orphaned
  }
}
