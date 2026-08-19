import type { RuntimePortTunnelChannel } from './runtime-port-tunnel-channel'
import type { RuntimePortTunnelOperationEntry } from './runtime-port-tunnel-operation-index'

export type RuntimePortTunnelManagerOptions = {
  createChannel: (environmentId: string) => RuntimePortTunnelChannel
}
export type RuntimePortTunnelAcquireArgs = {
  rendererOwnerId: string
  operationId: string
  environmentId: string
  remotePort: number
  endpointId: number
  role: 'selected' | 'companion'
}
export type RuntimePortTunnelLease = {
  leaseId: string
  rendererOwnerId: string
  environmentId: string
  remotePort: number
  endpointId: number
  role: 'selected' | 'companion'
}
export type RuntimePortTunnelAcquireResult =
  | { ok: true; lease: RuntimePortTunnelLease; created: boolean }
  | {
      ok: false
      reason: 'port-conflict-selected'
      port: number
      conflictingKey: string
    }
  | {
      ok: false
      reason: 'port-conflict-companion'
      port: number
      conflictingKey: string
    }
  | { ok: false; reason: 'listen-error'; port: number; error: Error }
  | {
      ok: false
      reason: 'operation-collision'
      existing: RuntimePortTunnelOperationEntry
      attempted: RuntimePortTunnelOperationEntry
    }
  | { ok: false; reason: 'shutdown' }
  | { ok: false; reason: 'environment-removed' }
