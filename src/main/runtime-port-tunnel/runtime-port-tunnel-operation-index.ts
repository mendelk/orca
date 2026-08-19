// Operation index for runtime port tunnel acquire idempotency.
//
// Why a dedicated index: the spec requires acquire to be idempotent for one
// renderer operation ID. The previous manager kept a single operationId ->
// leaseId mapping but never removed it after release, so a repeated same
// operation created an untracked duplicate lease because recordOperationId
// refused to replace the retained id. The index here:
//   - tracks inflight acquires separately from completed leases so a
//     concurrent second caller for the same operation joins the inflight
//     promise instead of starting a second bind.
//   - atomically removes the mapping on release so a repeated same operation
//     after release deterministically replays a fresh acquire.
//   - validates selected and all args for concurrent inflight collisions,
//     not only completed leases.
//   - uses collision-safe operation keying so two operations that happen to
//     share an id but target different endpoints cannot silently reuse one
//     another's lease.

export type RuntimePortTunnelOperationKey = string

export type RuntimePortTunnelOperationEntry = {
  rendererOwnerId: string
  operationId: string
  environmentId: string
  remotePort: number
  endpointId: number
  role: 'selected' | 'companion'
}

export type RuntimePortTunnelOperationLookup =
  | {
      ok: true
      kind: 'inflight'
      inflight: Promise<unknown>
    }
  | { ok: true; kind: 'completed'; leaseId: string; entry: RuntimePortTunnelOperationEntry }
  | { ok: false; reason: 'not-found' }
  | {
      ok: false
      reason: 'collision'
      existing: RuntimePortTunnelOperationEntry
      attempted: RuntimePortTunnelOperationEntry
    }

export function makeOperationKey(
  entry: RuntimePortTunnelOperationEntry
): RuntimePortTunnelOperationKey {
  return JSON.stringify([
    entry.rendererOwnerId,
    entry.operationId,
    entry.environmentId,
    entry.remotePort,
    entry.endpointId,
    entry.role
  ])
}

export function keyToEntry(key: string): RuntimePortTunnelOperationEntry | null {
  try {
    const parts = JSON.parse(key)
    if (Array.isArray(parts) && parts.length === 6) {
      if (
        typeof parts[0] === 'string' &&
        typeof parts[1] === 'string' &&
        typeof parts[2] === 'string' &&
        typeof parts[3] === 'number' &&
        typeof parts[4] === 'number' &&
        (parts[5] === 'selected' || parts[5] === 'companion')
      ) {
        return {
          rendererOwnerId: parts[0],
          operationId: parts[1],
          environmentId: parts[2],
          remotePort: parts[3],
          endpointId: parts[4],
          role: parts[5]
        }
      }
    }
  } catch {}
  return null
}

export class RuntimePortTunnelOperationIndex {
  private readonly inflight = new Map<
    RuntimePortTunnelOperationKey,
    { promise: Promise<unknown>; entry: RuntimePortTunnelOperationEntry }
  >()
  private readonly completed = new Map<
    RuntimePortTunnelOperationKey,
    { leaseId: string; entry: RuntimePortTunnelOperationEntry }
  >()
  private readonly operationIdToKey = new Map<string, RuntimePortTunnelOperationKey>()

  private getScopedOperationId(rendererOwnerId: string, operationId: string): string {
    return JSON.stringify([rendererOwnerId, operationId])
  }

  lookup(entry: RuntimePortTunnelOperationEntry): RuntimePortTunnelOperationLookup {
    if (
      typeof entry.rendererOwnerId !== 'string' ||
      typeof entry.operationId !== 'string' ||
      typeof entry.environmentId !== 'string' ||
      typeof entry.remotePort !== 'number' ||
      typeof entry.endpointId !== 'number' ||
      (entry.role !== 'selected' && entry.role !== 'companion')
    ) {
      return { ok: false, reason: 'not-found' }
    }
    const key = makeOperationKey(entry)
    const existingInflight = this.inflight.get(key)
    if (existingInflight) {
      return { ok: true, kind: 'inflight', inflight: existingInflight.promise }
    }
    const existingCompleted = this.completed.get(key)
    if (existingCompleted) {
      return {
        ok: true,
        kind: 'completed',
        leaseId: existingCompleted.leaseId,
        entry: existingCompleted.entry
      }
    }

    const scopedOperationId = this.getScopedOperationId(entry.rendererOwnerId, entry.operationId)
    const previousKey = this.operationIdToKey.get(scopedOperationId)
    if (previousKey && previousKey !== key) {
      const previousCompleted = this.completed.get(previousKey)
      if (previousCompleted) {
        return {
          ok: false,
          reason: 'collision',
          existing: previousCompleted.entry,
          attempted: entry
        }
      }
      const previousInflight = this.inflight.get(previousKey)
      if (previousInflight) {
        return {
          ok: false,
          reason: 'collision',
          existing: previousInflight.entry,
          attempted: entry
        }
      }
    }
    return { ok: false, reason: 'not-found' }
  }

  registerInflight(entry: RuntimePortTunnelOperationEntry, promise: Promise<unknown>): boolean {
    const key = makeOperationKey(entry)
    if (this.inflight.has(key) || this.completed.has(key)) {
      return false
    }
    this.inflight.set(key, { promise, entry })
    const scopedOperationId = this.getScopedOperationId(entry.rendererOwnerId, entry.operationId)
    this.operationIdToKey.set(scopedOperationId, key)
    return true
  }

  completeInflight(entry: RuntimePortTunnelOperationEntry, leaseId: string): void {
    const key = makeOperationKey(entry)
    this.inflight.delete(key)
    this.completed.set(key, { leaseId, entry })
    const scopedOperationId = this.getScopedOperationId(entry.rendererOwnerId, entry.operationId)
    this.operationIdToKey.set(scopedOperationId, key)
  }

  release(entry: RuntimePortTunnelOperationEntry): void {
    const key = makeOperationKey(entry)
    this.inflight.delete(key)
    this.completed.delete(key)
    const scopedOperationId = this.getScopedOperationId(entry.rendererOwnerId, entry.operationId)
    if (this.operationIdToKey.get(scopedOperationId) === key) {
      this.operationIdToKey.delete(scopedOperationId)
    }
  }

  releaseEnvironment(environmentId: string): RuntimePortTunnelOperationEntry[] {
    const dropped: RuntimePortTunnelOperationEntry[] = []
    for (const [key, value] of this.completed) {
      if (value.entry.environmentId === environmentId) {
        dropped.push(value.entry)
        this.completed.delete(key)
        const scopedOperationId = this.getScopedOperationId(
          value.entry.rendererOwnerId,
          value.entry.operationId
        )
        if (this.operationIdToKey.get(scopedOperationId) === key) {
          this.operationIdToKey.delete(scopedOperationId)
        }
      }
    }
    const inflightToDrop: string[] = []
    for (const [key, value] of this.inflight) {
      if (value.entry.environmentId === environmentId) {
        inflightToDrop.push(key)
        dropped.push(value.entry)
      }
    }
    for (const key of inflightToDrop) {
      const value = this.inflight.get(key)
      this.inflight.delete(key)
      if (value) {
        const scopedOperationId = this.getScopedOperationId(
          value.entry.rendererOwnerId,
          value.entry.operationId
        )
        if (this.operationIdToKey.get(scopedOperationId) === key) {
          this.operationIdToKey.delete(scopedOperationId)
        }
      }
    }
    return dropped
  }

  inflightCount(): number {
    return this.inflight.size
  }

  hasInflightForEnvironment(environmentId: string): boolean {
    for (const value of this.inflight.values()) {
      if (value.entry.environmentId === environmentId) {
        return true
      }
    }
    return false
  }

  completedCount(): number {
    return this.completed.size
  }

  clear(): void {
    this.inflight.clear()
    this.completed.clear()
    this.operationIdToKey.clear()
  }
}
