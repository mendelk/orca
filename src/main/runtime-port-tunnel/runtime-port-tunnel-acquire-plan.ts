import type { RuntimePortTunnelManager } from './runtime-port-tunnel-manager'
import type {
  RuntimePortTunnelLease,
  RuntimePortTunnelAcquireArgs
} from './runtime-port-tunnel-manager-types'

export async function acquireRuntimePortTunnelPlan(
  manager: RuntimePortTunnelManager,
  args: {
    rendererOwnerId: string
    operationId: string
    environmentId: string
    selected: { remotePort: number; endpointId: number }
    companions: { remotePort: number; endpointId: number }[]
  }
): Promise<
  | {
      ok: true
      selectedLease: RuntimePortTunnelLease
      companionLeases: RuntimePortTunnelLease[]
      companionConflicts: { port: number; conflictingKey: string }[]
    }
  | { ok: false; reason: string }
> {
  const selectedArgs: RuntimePortTunnelAcquireArgs = {
    rendererOwnerId: args.rendererOwnerId,
    operationId: JSON.stringify([args.operationId, 'selected']),
    environmentId: args.environmentId,
    remotePort: args.selected.remotePort,
    endpointId: args.selected.endpointId,
    role: 'selected'
  }
  const companionArgs: RuntimePortTunnelAcquireArgs[] = args.companions.map((c, i) => ({
    rendererOwnerId: args.rendererOwnerId,
    operationId: JSON.stringify([args.operationId, 'companion', i]),
    environmentId: args.environmentId,
    remotePort: c.remotePort,
    endpointId: c.endpointId,
    role: 'companion'
  }))
  const selectedResult = await manager.acquire(selectedArgs)
  if (!selectedResult.ok) {
    return { ok: false, reason: selectedResult.reason }
  }
  const companionLeases: RuntimePortTunnelLease[] = []
  const companionConflicts: { port: number; conflictingKey: string }[] = []

  for (const cArgs of companionArgs) {
    const result = await manager.acquire(cArgs)
    if (result.ok) {
      companionLeases.push(result.lease)
    } else if (result.reason === 'port-conflict-companion') {
      companionConflicts.push({ port: result.port, conflictingKey: result.conflictingKey })
    } else {
      await manager.release(selectedResult.lease.leaseId)
      for (const lease of companionLeases) {
        await manager.release(lease.leaseId)
      }
      return { ok: false, reason: result.reason }
    }
  }
  return { ok: true, selectedLease: selectedResult.lease, companionLeases, companionConflicts }
}
