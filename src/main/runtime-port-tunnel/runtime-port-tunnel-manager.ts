import type { RuntimePortTunnelChannel } from './runtime-port-tunnel-channel'
import { RuntimePortTunnelListenerPool, makeListenerKey } from './runtime-port-tunnel-listener-pool'
import {
  RuntimePortTunnelOperationIndex,
  type RuntimePortTunnelOperationEntry
} from './runtime-port-tunnel-operation-index'
import type {
  RuntimePortTunnelManagerOptions,
  RuntimePortTunnelAcquireArgs,
  RuntimePortTunnelLease,
  RuntimePortTunnelAcquireResult
} from './runtime-port-tunnel-manager-types'

export type {
  RuntimePortTunnelManagerOptions,
  RuntimePortTunnelAcquireArgs,
  RuntimePortTunnelLease,
  RuntimePortTunnelAcquireResult
}
export class RuntimePortTunnelManager {
  private readonly channels = new Map<string, RuntimePortTunnelChannel>()
  private readonly pool: RuntimePortTunnelListenerPool
  private readonly operations = new RuntimePortTunnelOperationIndex()
  private readonly leaseToEntry = new Map<string, RuntimePortTunnelOperationEntry>()
  private readonly createChannel: (environmentId: string) => RuntimePortTunnelChannel
  private isShutdown = false
  private nextLeaseId = 1
  constructor(options: RuntimePortTunnelManagerOptions) {
    this.createChannel = options.createChannel
    this.pool = new RuntimePortTunnelListenerPool()
  }
  async acquire(args: RuntimePortTunnelAcquireArgs): Promise<RuntimePortTunnelAcquireResult> {
    if (this.isShutdown) {
      return { ok: false, reason: 'shutdown' }
    }
    const entry: RuntimePortTunnelOperationEntry = {
      rendererOwnerId: args.rendererOwnerId,
      operationId: args.operationId,
      environmentId: args.environmentId,
      remotePort: args.remotePort,
      endpointId: args.endpointId,
      role: args.role
    }
    const existing = this.operations.lookup(entry)
    if (existing.ok) {
      if (existing.kind === 'completed') {
        return { ok: true, lease: { leaseId: existing.leaseId, ...entry }, created: false }
      }
      return (await existing.inflight) as RuntimePortTunnelAcquireResult
    }
    if (!existing.ok && existing.reason === 'collision') {
      return {
        ok: false,
        reason: 'operation-collision',
        existing: existing.existing,
        attempted: existing.attempted
      }
    }
    if (this.leaseToEntry.size >= 1024) {
      return {
        ok: false,
        reason: 'listen-error',
        port: args.remotePort,
        error: new Error('Maximum leases exceeded')
      }
    }
    if (!this.channels.has(entry.environmentId) && this.channels.size >= 64) {
      return {
        ok: false,
        reason: 'listen-error',
        port: args.remotePort,
        error: new Error('Maximum channels exceeded')
      }
    }
    if (this.pool.size() >= 1024 && !this.pool.isPortReserved(entry.remotePort)) {
      return {
        ok: false,
        reason: 'listen-error',
        port: args.remotePort,
        error: new Error('Maximum listeners exceeded')
      }
    }
    let inflightResolver!: (res: RuntimePortTunnelAcquireResult) => void
    const inflightPromise = new Promise<RuntimePortTunnelAcquireResult>((resolve) => {
      inflightResolver = resolve
    })
    if (!this.operations.registerInflight(entry, inflightPromise)) {
      return this.acquire(args)
    }
    try {
      const result = await this.doAcquire(entry)
      if (!result.ok) {
        this.operations.release(entry)
      }
      inflightResolver(result)
      return result
    } catch (err) {
      this.operations.release(entry)
      inflightResolver({
        ok: false,
        reason: 'listen-error',
        port: args.remotePort,
        error: err as Error
      })
      return { ok: false, reason: 'listen-error', port: args.remotePort, error: err as Error }
    }
  }
  private readonly environmentGenerations = new Map<string, number>()
  private getEnvironmentGeneration(environmentId: string): number {
    return this.environmentGenerations.get(environmentId) || 0
  }
  private bumpEnvironmentGeneration(environmentId: string) {
    this.environmentGenerations.set(environmentId, this.getEnvironmentGeneration(environmentId) + 1)
  }
  private async doAcquire(
    entry: RuntimePortTunnelOperationEntry
  ): Promise<RuntimePortTunnelAcquireResult> {
    if (this.isShutdown) {
      return { ok: false, reason: 'shutdown' }
    }
    const generation = this.getEnvironmentGeneration(entry.environmentId)
    let createdChannel = false
    let channel = this.channels.get(entry.environmentId)
    if (!channel) {
      channel = this.createChannel(entry.environmentId)
      this.channels.set(entry.environmentId, channel)
      createdChannel = true
      channel.on('channelDrop', () => {
        void this.handleChannelDrop(entry.environmentId)
      })
      channel.on('close', () => {
        void this.handleChannelDrop(entry.environmentId)
      })
    }
    const poolResult = await this.pool.acquire({
      environmentId: entry.environmentId,
      remotePort: entry.remotePort,
      endpointId: entry.endpointId,
      role: entry.role,
      onConnection: (socket) => channel!.attachSocket(entry.endpointId, socket)
    })

    if (this.isShutdown) {
      if (poolResult.ok) {
        await this.pool.release(poolResult.listenerKey)
      }
      if (createdChannel && this.channels.get(entry.environmentId) === channel) {
        channel.close()
        this.channels.delete(entry.environmentId)
      }
      return { ok: false, reason: 'shutdown' }
    }

    if (this.getEnvironmentGeneration(entry.environmentId) !== generation) {
      if (poolResult.ok) {
        await this.pool.release(poolResult.listenerKey)
      }
      if (createdChannel && this.channels.get(entry.environmentId) === channel) {
        channel.close()
        this.channels.delete(entry.environmentId)
      }
      return { ok: false, reason: 'environment-removed' }
    }
    if (!poolResult.ok) {
      if (createdChannel) {
        channel.close()
        this.channels.delete(entry.environmentId)
      }
      if (poolResult.reason === 'port-conflict-selected') {
        return {
          ok: false,
          reason: 'port-conflict-selected',
          port: poolResult.port,
          conflictingKey: poolResult.conflictingKey
        }
      }
      if (poolResult.reason === 'port-conflict-companion') {
        return {
          ok: false,
          reason: 'port-conflict-companion',
          port: poolResult.port,
          conflictingKey: poolResult.conflictingKey
        }
      }
      return { ok: false, reason: 'listen-error', port: poolResult.port, error: poolResult.error }
    }

    const leaseId = `lease-${this.nextLeaseId++}`
    const lease: RuntimePortTunnelLease = { leaseId, ...entry }
    this.operations.completeInflight(entry, leaseId)
    this.leaseToEntry.set(leaseId, entry)
    return { ok: true, lease, created: poolResult.created }
  }
  /**
   * Release a lease. Atomically removes the operation mapping so a repeated
   * same operation replays a fresh acquire. Closes the channel when its
   * last lease goes.
   */
  async release(leaseId: string): Promise<void> {
    const entry = this.leaseToEntry.get(leaseId)
    if (!entry) {
      return
    }
    this.leaseToEntry.delete(leaseId)
    this.operations.release(entry)
    await this.pool.release(
      makeListenerKey(entry.environmentId, entry.remotePort, entry.endpointId)
    )
    let hasLease = false
    for (const e of this.leaseToEntry.values()) {
      if (e.environmentId === entry.environmentId) {
        hasLease = true
        break
      }
    }
    if (!hasLease && !this.operations.hasInflightForEnvironment(entry.environmentId)) {
      const channel = this.channels.get(entry.environmentId)
      if (channel) {
        channel.close()
        this.channels.delete(entry.environmentId)
      }
    }
  }
  private readonly channelDropInflight = new Map<string, Promise<void>>()
  private async handleChannelDrop(environmentId: string): Promise<void> {
    const existing = this.channelDropInflight.get(environmentId)
    if (existing) {
      await existing
      return
    }
    const promise = this.doHandleChannelDrop(environmentId)
    this.channelDropInflight.set(environmentId, promise)
    try {
      await promise
    } finally {
      this.channelDropInflight.delete(environmentId)
    }
  }
  private async doHandleChannelDrop(environmentId: string): Promise<void> {
    this.bumpEnvironmentGeneration(environmentId)
    const droppedEntries: RuntimePortTunnelOperationEntry[] = []
    const droppedLeaseIds: string[] = []
    for (const [leaseId, entry] of this.leaseToEntry) {
      if (entry.environmentId === environmentId) {
        droppedLeaseIds.push(leaseId)
        droppedEntries.push(entry)
        this.operations.release(entry)
      }
    }
    for (const leaseId of droppedLeaseIds) {
      this.leaseToEntry.delete(leaseId)
    }
    for (const entry of droppedEntries) {
      await this.pool.release(
        makeListenerKey(entry.environmentId, entry.remotePort, entry.endpointId)
      )
    }
    const inflightEntries = this.operations.releaseEnvironment(environmentId)
    for (const entry of inflightEntries) {
      await this.pool.release(
        makeListenerKey(entry.environmentId, entry.remotePort, entry.endpointId)
      )
    }
    this.channels.delete(environmentId)
  }
  async simulateChannelDrop(environmentId: string): Promise<void> {
    const channel = this.channels.get(environmentId)
    this.channels.delete(environmentId)
    if (channel) {
      channel.simulateChannelDrop()
      await this.handleChannelDrop(environmentId)
    } else {
      await this.handleChannelDrop(environmentId)
    }
  }
  async removeEnvironment(environmentId: string): Promise<void> {
    this.bumpEnvironmentGeneration(environmentId)
    const channel = this.channels.get(environmentId)
    if (channel) {
      channel.close()
      this.channels.delete(environmentId)
    }
    await this.handleChannelDrop(environmentId)
  }
  /**
   * Shutdown: close all channels, release all listeners, reject all
   * inflight acquires. After shutdown, acquire returns 'shutdown' so no
   * in-flight acquire can publish a lease after shutdown.
   */
  async shutdown(): Promise<void> {
    this.isShutdown = true
    for (const channel of this.channels.values()) {
      channel.close()
    }
    this.channels.clear()
    this.operations.clear()
    this.leaseToEntry.clear()
    await this.pool.closeAll()
  }
  /** True when shutdown() has been called. Exposed for tests. */
  isShutdownStarted(): boolean {
    return this.isShutdown
  }
  /** Number of active leases. Exposed for tests. */
  activeLeaseCount(): number {
    return this.leaseToEntry.size
  }
  /** True when a local port is currently reserved. Exposed for tests. */
  isPortReserved(port: number): boolean {
    return this.pool.isPortReserved(port)
  }
}
