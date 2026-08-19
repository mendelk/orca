/* Why: the controller must not reach into the full zustand BrowserSlice. It
 *  needs a tiny port to materialize/update/transition a client-owned page and
 *  to look up a page by id. Isolating this lets the controller run in tests
 *  against a deterministic in-memory store and lets the future BrowserPane/
 *  Ports-panel wiring adapt the real slice to this port without the controller
 *  taking a dependency on AppState.
 *
 * Two distinct materialize operations:
 *   - createClientOwnedTunneledPage: NEW page after a NEW open acquire.
 *   - materializeExistingTunneledPage: UPDATE the existing descriptor page
 *     after a restore reacquire. Returns the original pageId so restore can
 *     never create a duplicate tab/page ID. */
import type {
  BrowserLoadError,
  BrowserPage,
  BrowserPortTunnelDescriptor
} from '../../../shared/browser-workspace-types'
import type { RemoteBrowserPageHandle } from '../store/slices/browser-port-tunnel-actions'
import type { NormalizedOrigin } from '../../../shared/browser-port-tunnel-url'
import type { TunnelEndpointPlanSet } from './runtime-port-tunnel-client-port'

/** Result of creating/materializing the client-owned page after acquisition.
 *  Carries the page id only; the store port owns the actual BrowserPage record. */
export type MaterializedTunneledPage = {
  pageId: string
  localUrl: string
  localPort: number
  descriptor: BrowserPortTunnelDescriptor
}

export type MaterializeFailure = { ok: false; reason: string }
export type MaterializeOutcome = ({ ok: true } & MaterializedTunneledPage) | MaterializeFailure

/** Result of atomically transitioning an existing page to a host-owned remote
 *  handle. The remote handle is recorded against the page id so BrowserPane
 *  mounts RemoteBrowserPagePane. `remoteUrl` is the URL the remote page
 *  navigates to. */
export type FallbackRemoteHandleOutcome =
  | { ok: true; handle: RemoteBrowserPageHandle; remoteUrl: string }
  | { ok: false; reason: string }

/** Read/write port the controller uses against the browser store. The store
 *  keeps the BrowserPage records; the controller never holds page state beyond
 *  the scope of one operation. */
export type BrowserPageStorePort = {
  /** Look up a page by id. Returns null when the page is gone (closed). */
  getPage(pageId: string): BrowserPage | null
  /** Create a NEW client-owned tunneled page after a NEW open acquire. The
   *  store applies the pure createClientOwnedTunneledPage action and persists
   *  the result. Generates a fresh page id. */
  createClientOwnedTunneledPage(args: {
    workspaceId: string
    worktreeId: string
    plan: TunnelEndpointPlanSet
    localOrigin: NormalizedOrigin
  }): MaterializeOutcome
  /** Materialize/UPDATE the EXISTING descriptor page after a restore
   *  reacquire. Returns the SAME pageId so restore never creates a duplicate
   *  tab/page. No webview navigation happens before acquisition — the caller
   *  acquires first, then the store updates the existing page's url/descriptor
   *  in place. */
  materializeExistingTunneledPage(args: {
    pageId: string
    plan: TunnelEndpointPlanSet
    localOrigin: NormalizedOrigin
  }): MaterializeOutcome
  /** Create a NEW host-owned remote screencast page atomically from the
   *  workspace selector, descriptor, remote URL, and handle. Used by new-open
   *  fallback when direct render fails — the page did not exist before, so
   *  transitionPageToHostOwnedRemoteHandle (existing-page-only) is wrong.
   *  Returns the generated page id. */
  createHostOwnedRemotePage(args: {
    workspaceId: string
    worktreeId: string
    descriptor: BrowserPortTunnelDescriptor
    remoteUrl: string
    handle: RemoteBrowserPageHandle
  }): { ok: true; pageId: string } | { ok: false; reason: string }
  /** Atomically transition an EXISTING page to a host-owned remote handle.
   *  Records the remote handle, sets browserRuntimeEnvironmentId, retains the
   *  descriptor for explicit retry, and returns the remote URL to navigate.
   *  Existing-page-only — do NOT use for new-open fallback. */
  transitionPageToHostOwnedRemoteHandle(args: {
    pageId: string
    remoteHandle: RemoteBrowserPageHandle | null
    remoteHandleError: string | null
  }): FallbackRemoteHandleOutcome
  /** Set a bounded load error on a retained page when fallback creation also
   *  fails, so the existing load-error surface explains both causes without
   *  closing the tab. */
  setPageLoadError(pageId: string, error: BrowserLoadError): void
}
