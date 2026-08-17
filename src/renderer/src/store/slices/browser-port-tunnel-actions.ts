/* Why: Stage 2 client-owned tunneled browser page pure actions.
 *
 * Focused, side-effect-free operations on BrowserPage records for the
 * direct-rendering lifecycle. They operate on plain BrowserPage objects and
 * return the next page (or a result) so the future controller seam can apply
 * them inside its store without introducing a second source of truth. They
 * never touch the Stage 1 tunnel manager, preload IPC, or live socket state —
 * only persisted intent (the descriptor) and the remote handle that already
 * exists for host-owned screencast pages.
 *
 * The actions cover the transitions the spec calls out:
 *   - create a client-owned tunneled page after acquisition
 *   - atomically transition an existing page to a host-owned remote handle
 *     without losing the tab on failure
 *   - retain the descriptor for explicit retry after fallback
 *   - identify restore pages that must reacquire before webview navigation
 */
import type {
  BrowserPage,
  BrowserPortTunnelDescriptor
} from '../../../../shared/browser-workspace-types'
import {
  pageRequiresTunnelReacquisition,
  validateBrowserPortTunnelDescriptor
} from '../../../../shared/browser-port-tunnel-descriptor'
import {
  effectiveOriginPort,
  translateLocalUrlToRemote,
  translateRemoteUrlToLocal,
  type NormalizedOrigin
} from '../../../../shared/browser-port-tunnel-url'

/** The remote handle returned by `browser.tabCreate` on the owning runtime. */
export type RemoteBrowserPageHandle = {
  environmentId: string
  remotePageId: string
}

/** Result of creating a client-owned tunneled page after tunnel acquisition.
 *  `localUrl` is what the webview should navigate to once the lease is active. */
export type CreateTunneledPageResult =
  | {
      ok: true
      page: BrowserPage
      localUrl: string
      localPort: number
      descriptor: BrowserPortTunnelDescriptor
    }
  | { ok: false; reason: string }

/** Create a client-owned BrowserPage carrying a tunnel descriptor. The page
 *  is explicitly client-owned (browserRuntimeEnvironmentId: null) so the
 *  local browser session-profile host is selected and the local webview path
 *  is used, even when the containing worktree belongs to a paired runtime.
 *
 *  `localOrigin` is the actual local origin the Stage 1 tunnel listener bound
 *  (supplied by acquisition), preserving custom loopback hostnames needed
 *  for Host headers, cookies, and TLS SNI. `remoteUrl` is the origin-hint URL
 *  the user opened (from the port scan); it is translated to the local tunnel
 *  origin so path/query/fragment are preserved. When translation fails (e.g.
 *  the remote URL is on a different origin than the descriptor) the function
 *  returns a bounded failure rather than silently falling back to a bare
 *  local origin. */
export function createClientOwnedTunneledPage(args: {
  pageId: string
  workspaceId: string
  worktreeId: string
  descriptor: BrowserPortTunnelDescriptor
  remoteUrl: string
  localOrigin: NormalizedOrigin
}): CreateTunneledPageResult {
  const validation = validateBrowserPortTunnelDescriptor(args.descriptor)
  if (!validation.ok) {
    return { ok: false, reason: validation.reason }
  }
  const descriptor = validation.descriptor
  if (descriptor.worktreeId !== args.worktreeId) {
    return {
      ok: false,
      reason: 'tunnel descriptor worktreeId does not match the page worktreeId'
    }
  }
  if (descriptor.environmentId.trim() === '') {
    return { ok: false, reason: 'tunnel descriptor environmentId is empty' }
  }
  // Why: return a bounded failure when the remote URL cannot be translated
  // (e.g. origin-hint on a different host). Silently falling back to a bare
  // local origin would hide the mismatch and load an empty page.
  const localUrl = translateRemoteUrlToLocal(args.remoteUrl, descriptor, args.localOrigin)
  if (!localUrl) {
    return {
      ok: false,
      reason: 'remote URL does not match the tunnel descriptor origin; cannot translate'
    }
  }
  const page: BrowserPage = {
    id: args.pageId,
    workspaceId: args.workspaceId,
    worktreeId: args.worktreeId,
    url: localUrl,
    title: 'New Tab',
    loading: true,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: Date.now(),
    browserRuntimeEnvironmentId: null,
    portTunnelDescriptor: descriptor
  }
  return { ok: true, page, localUrl, localPort: effectiveOriginPort(args.localOrigin), descriptor }
}

/** Result of atomically transitioning a client-owned tunneled page to a
 *  host-owned remote handle (fallback). The descriptor is retained on the
 *  page so the user can retry explicit direct rendering later. */
export type TransitionToHostOwnedResult =
  | {
      ok: true
      page: BrowserPage
      remoteUrl: string
      handle: RemoteBrowserPageHandle
    }
  | { ok: false; reason: string; page: BrowserPage }

/** Atomically transition an existing client-owned tunneled page to a
 *  host-owned remote handle without losing the tab on failure. The caller
 *  supplies the `browser.tabCreate` result from the owning runtime; this
 *  function computes the remote URL to navigate the remote page to by
 *  translating the page's current local URL back to the descriptor's remote
 *  origin. On success the page's `browserRuntimeEnvironmentId` is set to the
 *  environment id, the remote handle is recorded, and the descriptor is
 *  RETAINED so the user can retry direct rendering explicitly. The lease
 *  release intent is surfaced separately (see releaseTunnelLeaseIntent).
 *
 *  When the page has navigated away from the tunneled origin (cross-site
 *  navigation), translation returns null; the design requires fallback to use
 *  that external URL verbatim so the remote page loads the same site the user
 *  is looking at, rather than failing.
 *
 *  On failure (no descriptor, or remote creation failed) the page is
 *  returned unchanged so the tab is kept and the existing load-error surface
 *  explains both failure causes. */
export function transitionPageToHostOwnedRemoteHandle(args: {
  page: BrowserPage
  descriptor: BrowserPortTunnelDescriptor
  localOrigin: NormalizedOrigin
  remoteHandle: RemoteBrowserPageHandle | null
  remoteHandleError: string | null
}): TransitionToHostOwnedResult {
  const { page, descriptor, localOrigin } = args
  if (args.remoteHandleError || !args.remoteHandle) {
    return {
      ok: false,
      reason: args.remoteHandleError ?? 'remote browser creation failed',
      page
    }
  }
  if (args.remoteHandle.environmentId !== descriptor.environmentId) {
    return {
      ok: false,
      reason: 'remote handle environmentId does not match the tunnel descriptor',
      page
    }
  }
  // Why: try translating the local URL back to the remote origin. When the
  // page navigated away from the tunneled origin, translation returns null;
  // the design requires fallback to use that external URL verbatim so the
  // remote page loads the same site the user is viewing, rather than failing.
  const remoteUrl = translateLocalUrlToRemote(page.url, descriptor, localOrigin)
  const resolvedRemoteUrl = remoteUrl ?? page.url
  const nextPage: BrowserPage = {
    ...page,
    // Why: host-owned means the runtime renders this page via screencast.
    browserRuntimeEnvironmentId: descriptor.environmentId,
    // Why: retained for explicit retry — do not clear portTunnelDescriptor.
    // BrowserPane selects RemoteBrowserPagePane because environment id is set.
    url: resolvedRemoteUrl,
    loading: true
  }
  return { ok: true, page: nextPage, remoteUrl: resolvedRemoteUrl, handle: args.remoteHandle }
}

/** The lease release intent for a page that is closing, transitioning to
 *  host-owned, or whose environment revision changed. The store surfaces
 *  this so the Stage 1 tunnel manager can release the lease. Pure data —
 *  no side effect. */
export type TunnelLeaseReleaseIntent = {
  pageId: string
  descriptor: BrowserPortTunnelDescriptor
  reason: 'close' | 'ownership-transition' | 'environment-revision'
}

/** Build a release intent for a page close. Returns null when the page has
 *  no descriptor OR the page is host-owned (browserRuntimeEnvironmentId is
 *  non-null). Release intents are only meaningful for client-owned pages with
 *  an active tunnel intent — a host-owned fallback page merely retains the
 *  descriptor for retry and has no lease to release. */
export function releaseTunnelLeaseIntentForClose(
  page: BrowserPage
): TunnelLeaseReleaseIntent | null {
  if (
    !page.portTunnelDescriptor ||
    !pageRequiresTunnelReacquisition(page.browserRuntimeEnvironmentId, page.portTunnelDescriptor)
  ) {
    return null
  }
  return {
    pageId: page.id,
    descriptor: page.portTunnelDescriptor,
    reason: 'close'
  }
}

/** Build a release intent for an ownership transition (fallback to
 *  host-owned). Returns null when the page has no descriptor OR the page is
 *  already host-owned (no active lease). */
export function releaseTunnelLeaseIntentForOwnershipTransition(
  page: BrowserPage
): TunnelLeaseReleaseIntent | null {
  if (
    !page.portTunnelDescriptor ||
    !pageRequiresTunnelReacquisition(page.browserRuntimeEnvironmentId, page.portTunnelDescriptor)
  ) {
    return null
  }
  return {
    pageId: page.id,
    descriptor: page.portTunnelDescriptor,
    reason: 'ownership-transition'
  }
}

/** Identify the subset of restored pages that must reacquire a tunnel before
 *  their webview navigates. A page qualifies when it is client-owned
 *  (browserRuntimeEnvironmentId === null) AND carries a descriptor. Pages
 *  with a descriptor but a non-null environment id are host-owned and do not
 *  need tunnel reacquisition (the descriptor is retained for retry). */
export function identifyTunnelRestorePages(pages: BrowserPage[]): BrowserPage[] {
  return pages.filter((page) =>
    pageRequiresTunnelReacquisition(page.browserRuntimeEnvironmentId, page.portTunnelDescriptor)
  )
}

/** Retain the descriptor on a page for explicit retry after fallback. This
 *  is a no-op when the page already has a descriptor; it is used by the
 *  ownership-transition path to make the retention explicit and testable. */
export function retainDescriptorForRetry(
  page: BrowserPage,
  descriptor: BrowserPortTunnelDescriptor
): BrowserPage {
  return { ...page, portTunnelDescriptor: descriptor }
}
