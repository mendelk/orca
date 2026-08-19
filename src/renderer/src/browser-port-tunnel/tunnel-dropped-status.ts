/* Why: the dropped-status handler decides between companion partial
 *  degradation and selected one-shot fallback, and enforces the one-shot
 *  semantics that prevent two events from creating two remote handles.
 *  Splitting it from the orchestrator keeps both under the max-lines budget
 *  and makes the one-shot + companion-drop semantics testable in isolation. */
import type { NormalizedOrigin } from '../../../shared/browser-port-tunnel-url'
import type { BrowserPortTunnelDescriptor } from '../../../shared/browser-workspace-types'
import type { TunnelLeaseState } from './tunnel-lease-state'
import type { RestoreTunneledPageOutcome } from './browser-port-tunnel-controller'

/** The action to take for a dropped-status event. `companion-partial` releases
 *  one companion lease and keeps the selected page direct (partial
 *  degradation). `selected-fallback` runs the one-shot fallback and carries a
 *  `complete` callback the caller MUST invoke in a finally block so one-shot
 *  state never remains pending forever. `ignore` is returned when the lease is
 *  unknown, already handled, or the fallback is already pending/done. */
export type DroppedStatusAction =
  | { kind: 'companion-partial'; leaseId: string }
  | {
      kind: 'selected-fallback'
      pageId: string
      descriptor: BrowserPortTunnelDescriptor
      localOrigin: NormalizedOrigin | null
      fallbackPromise: Promise<RestoreTunneledPageOutcome>
      /** Call in a finally block so completeFallback runs on success or
       *  failure, ensuring one-shot state never remains pending. */
      complete: () => void
    }
  | { kind: 'ignore' }

/** Decide what to do for a dropped-status event. Enforces one-shot semantics:
 *  a second event while a fallback is pending or done is ignored, so two
 *  events can never create two remote handles. Companion drops are partial
 *  degradation and do NOT trigger a selected fallback.
 *
 *  Why: beginFallback is checked BEFORE runFallback is called, so a second
 *  event never even creates a fallback promise (which would start executing).
 *  The returned `complete` callback settles the pending marker and marks the
 *  fallback done so one-shot state never remains pending. */
export function planDroppedStatusAction(args: {
  leaseState: TunnelLeaseState
  leaseId: string
  reason: string
  runFallback: (
    pageId: string,
    descriptor: BrowserPortTunnelDescriptor,
    localOrigin: NormalizedOrigin | null,
    reason: string
  ) => Promise<RestoreTunneledPageOutcome>
}): DroppedStatusAction {
  const pageId = args.leaseState.pageIdForLease(args.leaseId)
  if (!pageId) {
    return { kind: 'ignore' }
  }
  const kind = args.leaseState.leaseKindFor(args.leaseId)
  if (kind === 'companion') {
    return { kind: 'companion-partial', leaseId: args.leaseId }
  }
  if (kind !== 'selected') {
    return { kind: 'ignore' }
  }
  const descriptor = args.leaseState.descriptorFor(pageId)
  if (!descriptor) {
    return { kind: 'ignore' }
  }
  let resolvePending!: () => void
  const pendingPromise = new Promise<void>((r) => {
    resolvePending = r
  })
  if (!args.leaseState.beginFallback(pageId, pendingPromise)) {
    return { kind: 'ignore' }
  }
  const selectedLease = args.leaseState.selectedLeaseFor(pageId)
  const localOrigin = selectedLease?.localOrigin ?? null
  const complete = () => {
    resolvePending()
    args.leaseState.completeFallback(pageId)
  }
  const fallbackPromise = args
    .runFallback(pageId, descriptor, localOrigin, `tunnel dropped: ${args.reason}`)
    .then((outcome) => {
      resolvePending()
      return outcome
    })
  return { kind: 'selected-fallback', pageId, descriptor, localOrigin, fallbackPromise, complete }
}
