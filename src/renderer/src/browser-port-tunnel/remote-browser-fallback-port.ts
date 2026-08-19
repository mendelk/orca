/* Why: when the selected tunnel acquire fails (or an active lease drops), the
 *  controller must create or retain a host-owned remote screencast page so the
 *  user does not lose the tab. The controller must not import the runtime RPC
 *  client or browser.tabCreate wiring directly — those are unfinished desktop
 *  manager internals. Instead it calls a narrow remote browser fallback port
 *  that the future Ports-panel/restore wiring adapts to the real RPC.
 *
 *  Two distinct request types:
 *   - ExistingPageFallbackRequest: fallback for an EXISTING client-owned page
 *     that already has a pageId (dropped status, restore reacquire failure).
 *   - NewOpenFallbackRequest: new-open creation with NO fabricated pageId —
 *     carries workspaceId/worktreeId/descriptor/remoteUrl only. The store port
 *     is the sole generator of the new local page ID after remote handle
 *     creation. */
import type { RemoteBrowserPageHandle } from '../store/slices/browser-port-tunnel-actions'
import type { BrowserPortTunnelDescriptor } from '../../../shared/browser-workspace-types'

/** Request to create a host-owned remote page for an EXISTING client-owned
 *  page (dropped status, restore reacquire failure). The pageId is the existing
 *  local page id; the remote adapter does NOT use it to create a local page. */
export type ExistingPageFallbackRequest = {
  kind: 'existing-page'
  pageId: string
  descriptor: BrowserPortTunnelDescriptor
  remoteUrl: string
}

/** Request to create a host-owned remote page for a NEW open that never
 *  materialized a local page. Carries workspace selector and descriptor only —
 *  NO fabricated pageId. The store port generates the new local page ID after
 *  the remote handle is created. */
export type NewOpenFallbackRequest = {
  kind: 'new-open'
  workspaceId: string
  worktreeId: string
  descriptor: BrowserPortTunnelDescriptor
  remoteUrl: string
}

export type CreateRemoteBrowserPageRequest = ExistingPageFallbackRequest | NewOpenFallbackRequest

/** Outcome of creating a host-owned remote screencast page. On success the
 *  handle's environmentId must match the descriptor environmentId; the store
 *  port validates that before recording the transition. On failure the
 *  controller retains the page and sets a bounded load error instead of
 *  closing the tab. */
export type CreateRemoteBrowserPageOutcome =
  | { ok: true; handle: RemoteBrowserPageHandle }
  | { ok: false; reason: string }

/** Request to close an orphan remote handle. Used when the fallback
 *  transition fails (so the newly-created remote page does not leak) or when
 *  the page is closed/revisioned/disposed during a pending fallback. */
export type CloseRemoteBrowserPageRequest = {
  handle: RemoteBrowserPageHandle
}

/** Narrow port for creating/closing host-owned remote screencast pages. The
 *  real implementation calls browser.tabCreate / browser.tabClose on the owning
 *  runtime; tests supply a deterministic fake. */
export type RemoteBrowserFallbackPort = {
  createRemoteBrowserPage(
    request: CreateRemoteBrowserPageRequest
  ): Promise<CreateRemoteBrowserPageOutcome>
  closeRemoteBrowserPage(request: CloseRemoteBrowserPageRequest): Promise<void>
}
