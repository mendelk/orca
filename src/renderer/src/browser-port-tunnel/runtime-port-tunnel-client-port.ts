/* Why: the Stage 2 controller must not import unfinished desktop tunnel-manager
 * internals (Stage 1). It talks to a narrow acquire/release contract injected
 * by the future preload seam. Keeping the contract in its own file lets the
 * controller tests supply a deterministic fake without any IPC, socket, or
 * grant wiring, and the real preload binding can be added later without
 * touching the controller.
 *
 * Security contract: the renderer receives OPAQUE LEASE IDS ONLY — never
 * pairing tokens, grant IDs, runtime grant endpoint IDs, local socket
 * addresses, or live connection state. Those live in main and never cross the
 * preload boundary. The plan therefore carries only the workspace selector,
 * port, protocol (including the explicit 'unknown' the committed eligibility
 * contract permits), and the advertised URL; main performs authorization
 * internally and never echoes endpoint IDs back. */
import type { BrowserPortTunnelDescriptor } from '../../../shared/browser-workspace-types'

/** The protocol the listener advertises, including the explicit 'unknown'
 *  value the committed eligibility contract permits when the user explicitly
 *  opens a listener the scanner could not classify. */
export type TunnelEndpointProtocol = 'http' | 'https' | 'unknown'

/** One workspace-attributed endpoint in an already-validated open/restore plan.
 *  Contains NO runtime grant endpoint id — main performs authorization
 *  internally and the renderer never sees grant IDs. The selected endpoint is
 *  always present; companions are best-effort and may fail without blocking
 *  direct render. */
export type TunnelEndpointPlan = {
  port: number
  protocol: TunnelEndpointProtocol
  /** Origin-hint URL advertised by the port scan; path/query/fragment preserved. */
  advertisedUrl: string
}

/** Already-validated plan for one open/restore operation. The caller (Ports
 *  panel open action or restore gate) validates workspace attribution and
 *  eligibility before handing the plan to the controller — the controller
 *  never re-validates ownership, it only acquires reachability. */
export type TunnelEndpointPlanSet = {
  descriptor: BrowserPortTunnelDescriptor
  selected: TunnelEndpointPlan
  companions: TunnelEndpointPlan[]
}

/** Reachability result for one endpoint. The selected endpoint carries the
 *  actual local origin the tunnel listener bound (which may use a custom
 *  loopback hostname for Host headers, cookies, and TLS SNI). Companions carry
 *  only a lease id (their local origin is not needed by the renderer). */
export type TunnelEndpointAcquireResult = {
  ok: true
  leaseId: string
  localOrigin: string
}
export type TunnelEndpointAcquireFailure = {
  ok: false
  reason: string
}

export type TunnelAcquireOutcome = {
  selected: TunnelEndpointAcquireResult | TunnelEndpointAcquireFailure
  companions: (TunnelEndpointAcquireResult | TunnelEndpointAcquireFailure)[]
}

/** Live status of one lease, observed via status events. `dropped` means the
 *  tunnel transport disconnected and the controller must fall back the
 *  affected page. `active` means the lease is still usable. */
export type TunnelLeaseStatus = { state: 'active' } | { state: 'dropped'; reason: string }

/** Status event for one lease. The controller subscribes via onStatusChanged
 *  and reacts to `dropped` by triggering a one-shot fallback. */
export type TunnelStatusEvent = {
  leaseId: string
  status: TunnelLeaseStatus
}

/** A release failure recorded for an observer callback. Exposed so the
 *  future preload seam can surface bounded release failures to telemetry
 *  rather than hiding them in a private array the controller cannot read. */
export type TunnelReleaseFailure = {
  leaseId: string
  reason: string
}

/** Narrow acquire/release contract injected into the controller. The real
 *  implementation is wired by the future preload seam; tests supply a
 *  deterministic fake. All methods are async because they cross IPC.
 *
 *  acquire is idempotent for one operation key (caller-supplied, so concurrent
 *  opens for the same logical operation deduplicate) and returns only after
 *  the selected listener is bound. The controller passes a generation-scoped
 *  operation key so a stale completion after page close or environment revision
 *  is ignored. */
export type RuntimePortTunnelClient = {
  acquire(args: {
    operationKey: string
    plan: TunnelEndpointPlanSet
  }): Promise<TunnelAcquireOutcome>
  release(args: { leaseId: string }): Promise<void>
  onStatusChanged(callback: (event: TunnelStatusEvent) => void): () => void
  /** Subscribe to bounded release-failure notifications. Returns an
   *  unsubscribe function. Used so release failures are observable rather
   *  than swallowed. */
  onReleaseFailure(callback: (failure: TunnelReleaseFailure) => void): () => void
}

/** True when the runtime advertising these capabilities supports
 *  workspace-port-tunnel.v1. Used as the capability gate before any acquire. */
export function runtimeSupportsWorkspacePortTunnel(
  capabilities: readonly string[] | undefined
): boolean {
  return Boolean(capabilities?.includes('workspace-port-tunnel.v1'))
}

/** Factory for operation keys and acquire operation ids. Injected so tests
 *  can supply deterministic values and the controller never calls Date.now or
 *  Math.random directly (which would make concurrent-open dedup
 *  non-deterministic and tests flaky). */
export type OperationIdGenerator = {
  /** A caller-supplied operation key for deduplication. The controller uses
   *  this as the dedup key for concurrent opens of the same logical operation;
   *  when absent, a fresh key is generated. */
  operationKey(args: { workspaceId: string; plan: TunnelEndpointPlanSet }): string
  /** A fresh acquire operation id scoped to one generation. Passed to acquire
   *  so main can idempotently deduplicate a retried acquire for the same
   *  operation. */
  acquireOperationId(args: { pageId: string; generation: number }): string
}
