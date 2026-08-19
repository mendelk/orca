/* Why: helpers that build a PageLease[] from an acquire outcome and release a
 *  lease set, split out of the orchestrator to keep it under the max-lines
 *  budget. These are pure transformations over the lease state and the client
 *  port; the controller injects its safeRelease so release failures stay
 *  observable through the controller's sink. */
import type { NormalizedOrigin } from '../../../shared/browser-port-tunnel-url'
import type { PageLease } from './tunnel-lease-state'

/** The resolved acquire outcome type, used by helpers that build/release lease
 *  sets from an acquire result. */
type AcquireOutcome = {
  selected: { ok: true; leaseId: string; localOrigin: string } | { ok: false; reason: string }
  companions: ({ ok: true; leaseId: string; localOrigin: string } | { ok: false; reason: string })[]
}

/** Build the complete selected+companion lease set from an acquire outcome.
 *  Companions that failed acquisition are omitted (partial). The selected
 *  lease carries the actual local origin returned by acquisition so URL
 *  translation later uses the real origin, not a reconstructed 127.0.0.1. */
export function buildLeaseSet(
  acquireOutcome: AcquireOutcome,
  localOrigin: NormalizedOrigin
): PageLease[] {
  const leases: PageLease[] = []
  if (acquireOutcome.selected.ok) {
    leases.push({ leaseId: acquireOutcome.selected.leaseId, localOrigin, kind: 'selected' })
  }
  for (const c of acquireOutcome.companions) {
    if (c.ok) {
      leases.push({ leaseId: c.leaseId, localOrigin, kind: 'companion' })
    }
  }
  return leases
}

/** Release every lease in a set, propagating each release through the
 *  supplied safeRelease (which the controller routes through its observable
 *  failure sink). Returns when all releases have settled. */
export async function releaseLeaseSet(
  leases: PageLease[],
  safeRelease: (leaseId: string) => Promise<void>
): Promise<void> {
  await Promise.all(leases.map((l) => safeRelease(l.leaseId)))
}

/** Release the selected + successful-companion leases from an acquire outcome
 *  (used when the page is not materialized and there is no lease set to clear
 *  from state). Routes through safeRelease for observable failures. */
export async function releaseAcquired(
  outcome: AcquireOutcome,
  safeRelease: (leaseId: string) => Promise<void>
): Promise<void> {
  const releases: string[] = []
  if (outcome.selected.ok) {
    releases.push(outcome.selected.leaseId)
  }
  for (const c of outcome.companions) {
    if (c.ok) {
      releases.push(c.leaseId)
    }
  }
  await Promise.all(releases.map((id) => safeRelease(id)))
}
