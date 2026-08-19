/* Why: the controller's per-page state (generation, in-flight promise, active
 * lease set, one-shot fallback state, actual local origin) is pure bookkeeping
 * with no dependency on the injected ports. Splitting it out keeps the
 * orchestrator under the max-lines budget and lets the generation/dedup/
 * release-tracking/fallback-suppression semantics be tested in isolation.
 *
 * Invariants enforced here:
 *   - the full selected+companion lease set is tracked per page so every
 *     lease is released exactly once on close/revision/dispose/transition;
 *   - the actual local origin returned by acquisition is stored and used for
 *     URL translation (never reconstructed from 127.0.0.1, which would break
 *     custom hostnames/TLS SNI);
 *   - a one-shot fallback promise per page suppresses repeated dropped-status
 *     events so two events can never create two remote handles;
 *   - the in-flight acquire/restore promise is shared so concurrent callers
 *     deduplicate and failure propagates to all. */
import type { BrowserPortTunnelDescriptor } from '../../../shared/browser-workspace-types'
import type { NormalizedOrigin } from '../../../shared/browser-port-tunnel-url'

/** One active lease for a page. The selected lease carries the local origin
 *  returned by acquisition; companions carry only a lease id. */
export type PageLease = {
  leaseId: string
  localOrigin: NormalizedOrigin
  kind: 'selected' | 'companion'
}

/** The in-flight operation promise shared with concurrent callers so they
 *  deduplicate and the outcome propagates to all. The fingerprint is a stable
 *  string derived from the operation's workspace/worktree/plan so a second
 *  caller with the same dedup key but a DIFFERENT operation is rejected
 *  boundedly rather than silently sharing the first result. */
export type InFlightOperation<T> = {
  promise: Promise<T>
  fingerprint: string
}

/** One-shot fallback state for a page. `pending` means a fallback is in
 *  flight; repeated dropped-status events while pending are suppressed so
 *  two events can never create two remote handles. `done` means the one-shot
 *  fallback has completed and no further auto-fallback is allowed (never
 *  auto-promote). */
export type FallbackState =
  | { state: 'idle' }
  | { state: 'pending'; promise: Promise<void> }
  | { state: 'done' }

type PageState = {
  /** Monotonic per-page generation. Bumped on close, environment revision, and
   *  before each operation so a stale async result can be detected. */
  generation: number
  /** The shared in-flight operation promise, or null when no operation is in
   *  flight. Deduplicates concurrent open/restore calls and propagates
   *  failure to all awaiters. */
  inFlight: InFlightOperation<unknown> | null
  /** The complete selected+companion lease set for the page. Every lease is
   *  released exactly once on close/revision/dispose/transition. */
  leases: PageLease[]
  /** The descriptor for the active leases, retained so the dropped-status
   *  handler can translate the last committed URL back to the remote origin. */
  descriptor: BrowserPortTunnelDescriptor | null
  /** One-shot fallback state. Suppresses repeated dropped-status events and
   *  prevents auto-promotion after a completed fallback. */
  fallback: FallbackState
}

/** Pure per-page lease/generation/fallback state. The controller owns one
 *  instance; all mutations go through these methods so the invariants live in
 *  one place. */
export class TunnelLeaseState {
  private readonly pages = new Map<string, PageState>()

  has(pageId: string): boolean {
    return this.pages.has(pageId)
  }

  /** Ensure an entry exists and return its generation. */
  private ensure(pageId: string): PageState {
    const state = this.pages.get(pageId)
    if (state) {
      return state
    }
    const fresh: PageState = {
      generation: 0,
      inFlight: null,
      leases: [],
      descriptor: null,
      fallback: { state: 'idle' }
    }
    this.pages.set(pageId, fresh)
    return fresh
  }

  /** Bump the generation and return the new value. A caller captures the
   *  generation before an async operation and uses isStale to detect whether
   *  the page was closed/revisioned while the operation was in flight. */
  nextGeneration(pageId: string): number {
    const state = this.ensure(pageId)
    state.generation++
    return state.generation
  }

  isStale(pageId: string, generation: number): boolean {
    const state = this.pages.get(pageId)
    return !state || state.generation !== generation
  }

  generationOf(pageId: string): number {
    return this.pages.get(pageId)?.generation ?? 0
  }

  /** The shared in-flight operation promise, or null. Concurrent callers
   *  await the same promise so they deduplicate and the outcome propagates. */
  inFlightOf(pageId: string): InFlightOperation<unknown> | null {
    return this.pages.get(pageId)?.inFlight ?? null
  }

  /** Record an in-flight operation promise for deduplication. The caller
   *  supplies the resolver pair so it can settle the shared promise. */
  setInFlight<T>(pageId: string, op: InFlightOperation<T>): void {
    const state = this.ensure(pageId)
    state.inFlight = op as InFlightOperation<unknown>
  }

  /** Clear the in-flight operation (called in a finally block). */
  clearInFlight(pageId: string): void {
    const state = this.pages.get(pageId)
    if (state) {
      state.inFlight = null
    }
  }

  /** The complete lease set for a page (selected + companions). */
  leasesFor(pageId: string): PageLease[] {
    return this.pages.get(pageId)?.leases ?? []
  }

  /** The selected lease for a page, or null. */
  selectedLeaseFor(pageId: string): PageLease | null {
    return this.leasesFor(pageId).find((l) => l.kind === 'selected') ?? null
  }

  /** Companion leases for a page. */
  companionLeasesFor(pageId: string): PageLease[] {
    return this.leasesFor(pageId).filter((l) => l.kind === 'companion')
  }

  descriptorFor(pageId: string): BrowserPortTunnelDescriptor | null {
    return this.pages.get(pageId)?.descriptor ?? null
  }

  /** Record the complete selected+companion lease set for a page after a
   *  successful acquire+create. Stores the actual local origin returned by
   *  acquisition so URL translation uses the real origin, not 127.0.0.1. */
  recordLeases(pageId: string, descriptor: BrowserPortTunnelDescriptor, leases: PageLease[]): void {
    const state = this.ensure(pageId)
    state.leases = leases
    state.descriptor = descriptor
  }

  /** Find the page id for an active lease id (used by the dropped-status
   *  handler to map a status event back to a page). Searches both selected
   *  and companion leases. */
  pageIdForLease(leaseId: string): string | null {
    for (const [pageId, state] of this.pages) {
      if (state.leases.some((l) => l.leaseId === leaseId)) {
        return pageId
      }
    }
    return null
  }

  /** The kind of a lease id ('selected' | 'companion'), or null. Used by the
   *  dropped-status handler to decide whether a drop is a selected-origin
   *  fallback (transition to remote) or a companion partial degradation. */
  leaseKindFor(leaseId: string): 'selected' | 'companion' | null {
    for (const state of this.pages.values()) {
      const lease = state.leases.find((l) => l.leaseId === leaseId)
      if (lease) {
        return lease.kind
      }
    }
    return null
  }

  /** Drop a page entirely and bump its generation so any in-flight async
   *  result is stale. Returns the released lease set (selected + companions),
   *  or [] when there were no active leases. Used by close and
   *  environment-revision release paths. */
  dropPage(pageId: string): PageLease[] {
    const state = this.pages.get(pageId)
    if (!state) {
      return []
    }
    state.generation++
    state.inFlight = null
    const leases = state.leases
    state.leases = []
    state.descriptor = null
    state.fallback = { state: 'idle' }
    this.pages.delete(pageId)
    return leases
  }

  /** Clear the active leases for a page (without bumping the generation). Used
   *  by the ownership-transition release path where the page persists. Returns
   *  the released lease set, or [] when there were no active leases. */
  clearLeases(pageId: string): PageLease[] {
    const state = this.pages.get(pageId)
    if (!state) {
      return []
    }
    const leases = state.leases
    state.leases = []
    return leases
  }

  /** Remove a single companion lease from the active set after a companion
   *  drop (partial degradation — the selected page stays direct). Returns
   *  the removed lease, or null when the lease id is not an active companion. */
  removeCompanionLease(leaseId: string): PageLease | null {
    for (const state of this.pages.values()) {
      const idx = state.leases.findIndex((l) => l.leaseId === leaseId && l.kind === 'companion')
      if (idx !== -1) {
        const [removed] = state.leases.splice(idx, 1)
        return removed
      }
    }
    return null
  }

  /** Snapshot all active leases (pageId, leases). Used by dispose to release
   *  every active lease on renderer disposal. */
  activeLeases(): { pageId: string; leases: PageLease[] }[] {
    const result: { pageId: string; leases: PageLease[] }[] = []
    for (const [pageId, state] of this.pages) {
      if (state.leases.length > 0) {
        result.push({ pageId, leases: state.leases })
      }
    }
    return result
  }

  /** The one-shot fallback state for a page. */
  fallbackState(pageId: string): FallbackState {
    return this.pages.get(pageId)?.fallback ?? { state: 'idle' }
  }

  /** Mark a fallback as in-flight and record its promise. Returns false when
   *  a fallback is already pending or done — the caller must NOT start a
   *  second fallback in that case (one-shot semantics). */
  beginFallback(pageId: string, promise: Promise<void>): boolean {
    const state = this.ensure(pageId)
    if (state.fallback.state !== 'idle') {
      return false
    }
    state.fallback = { state: 'pending', promise }
    return true
  }

  /** Mark the one-shot fallback as done. After this, no further auto-fallback
   *  is allowed (never auto-promote). */
  completeFallback(pageId: string): void {
    const state = this.pages.get(pageId)
    if (state) {
      state.fallback = { state: 'done' }
    }
  }

  /** Clear all state without releasing leases. Used after dispose has released. */
  clear(): void {
    this.pages.clear()
  }
}
