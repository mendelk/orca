/* Why: concurrent open/restore deduplication via a shared in-flight promise is
 *  self-contained bookkeeping over TunnelLeaseState. Splitting it out keeps
 *  the orchestrator under the max-lines budget and makes the promise-sharing +
 *  failure-propagation semantics testable in isolation.
 *
 *  When a second caller arrives while the first operation is in flight, it
 *  awaits the SAME promise so both observe the same outcome (including
 *  failure). A fingerprint derived from the operation's workspace/worktree/plan
 *  is stored alongside the promise; a second caller with the same dedup key
 *  but a DIFFERENT fingerprint is rejected boundedly rather than silently
 *  sharing the first result. */
import type { TunnelLeaseState } from './tunnel-lease-state'

/** Run an operation with deduplication. If an operation is already in flight
 *  for the same dedup key AND fingerprint, await its shared promise and return
 *  its outcome (including failure propagation). If the dedup key matches but
 *  the fingerprint differs, reject boundedly — the caller used the same key
 *  for a different operation. Otherwise run the operation, settle the shared
 *  promise, and return the outcome. */
export async function withDedup<T>(
  leaseState: TunnelLeaseState,
  dedupKey: string,
  fingerprint: string,
  run: () => Promise<T>
): Promise<T> {
  const existing = leaseState.inFlightOf(dedupKey)
  if (existing) {
    if (existing.fingerprint !== fingerprint) {
      throw new Error(
        `dedup key collision: ${dedupKey} already in flight with a different operation`
      )
    }
    return existing.promise as Promise<T>
  }
  const promise = run()
  leaseState.setInFlight(dedupKey, { promise, fingerprint })
  try {
    return await promise
  } finally {
    leaseState.clearInFlight(dedupKey)
  }
}
