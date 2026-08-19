import type * as net from 'node:net'
import { RuntimePortTunnelListener } from './runtime-port-tunnel-listener'

export type RuntimePortTunnelListenerFactory = (options: {
  port: number
  onConnection: (socket: net.Socket) => void
}) => RuntimePortTunnelListener

export type RuntimePortTunnelPoolAcquireOptions = {
  environmentId: string
  remotePort: number
  endpointId: number
  onConnection: (socket: net.Socket) => void
  /**
   * 'selected' means the chosen origin must bind its original port or the
   * acquire fails; 'companion' means a conflict is reported as skipped instead
   * of attempted (no bind, no active lease published).
   */
  role: 'selected' | 'companion'
}

export type RuntimePortTunnelPoolAcquireResult =
  | {
      ok: true
      listener: RuntimePortTunnelListener
      listenerKey: string
      port: number
      role: 'selected' | 'companion'
      created: boolean
    }
  | {
      ok: false
      reason: 'port-conflict-selected'
      port: number
      /** The environment/operation that already holds this exact port. */
      conflictingKey: string
    }
  | {
      ok: false
      reason: 'port-conflict-companion'
      port: number
      conflictingKey: string
    }
  | { ok: false; reason: 'listen-error'; port: number; error: Error }

/**
 * Reference-counted loopback listener pool with process-global port
 * ownership.
 *
 * Why process-global: two environments/endpoints on 127.0.0.1:5173 cannot
 * each bind the same local port. The previous manager keyed listeners by
 * `environment:remotePort` and allowed two environments to attempt the same
 * local port. The reservation here is keyed by *local* port number, so a
 * selected conflict is fatal and a companion conflict is reported as
 * skipped/partial rather than attempting a bind.
 *
 * Why a pool (not the manager): the pool is the sole zero-ref close owner.
 * release() decrements; when it hits zero the pool calls closeAsync() and
 * awaits the shared close promise before deleting the entry, so a later
 * acquire for the same port cannot rebind while server.close is still
 * running.
 */
export class RuntimePortTunnelListenerPool {
  private readonly listeners = new Map<string, RuntimePortTunnelListener>()
  /**
   * Process-global reservation: local port -> the listener key that owns it.
   * Why a separate map: a listener key encodes environment+remotePort+endpointId, but
   * the *local* port is what the OS cares about. Two keys cannot reserve the
   * same local port.
   */
  private readonly portReservation = new Map<number, string>()
  private readonly inFlightReservations = new Map<
    number,
    { listenerKey: string; promise: Promise<RuntimePortTunnelPoolAcquireResult> }
  >()
  private isShutdown = false
  private readonly factory: RuntimePortTunnelListenerFactory

  constructor(factory?: RuntimePortTunnelListenerFactory) {
    this.factory = factory ?? defaultListenerFactory
  }

  /**
   * Acquire (or attach to) a listener for one environment/endpoint. The
   * selected origin must bind its exact port or the acquire fails; a
   * companion that cannot bind is reported as skipped so the caller can show
   * a partial result instead of an invented active lease.
   */
  async acquire(
    args: RuntimePortTunnelPoolAcquireOptions
  ): Promise<RuntimePortTunnelPoolAcquireResult> {
    if (this.isShutdown) {
      return {
        ok: false,
        reason: 'listen-error',
        port: args.remotePort,
        error: new Error('Listener pool is shutdown')
      }
    }
    const listenerKey = makeListenerKey(args.environmentId, args.remotePort, args.endpointId)
    let existing = this.listeners.get(listenerKey)
    if (existing && existing.isClosed()) {
      await existing.closeAsync()
      this.listeners.delete(listenerKey)
      if (this.portReservation.get(args.remotePort) === listenerKey) {
        this.portReservation.delete(args.remotePort)
      }
      existing = undefined
    }
    if (existing) {
      // Why: the same endpoint already has a listener; just bump the ref
      // count. The port reservation must already be held by this key.
      existing.retain()
      return {
        ok: true,
        listener: existing,
        listenerKey,
        port: args.remotePort,
        role: args.role,
        created: false
      }
    }
    // Why: process-global reservation. A selected conflict is fatal; a
    // companion conflict is skipped. We check before attempting bind so we
    // never publish an active lease for a port we cannot actually own.
    const conflictingKey = this.portReservation.get(args.remotePort)
    if (conflictingKey && conflictingKey !== listenerKey) {
      if (args.role === 'selected') {
        return {
          ok: false,
          reason: 'port-conflict-selected',
          port: args.remotePort,
          conflictingKey
        }
      }
      return {
        ok: false,
        reason: 'port-conflict-companion',
        port: args.remotePort,
        conflictingKey
      }
    }

    const inFlight = this.inFlightReservations.get(args.remotePort)
    if (inFlight) {
      if (inFlight.listenerKey !== listenerKey) {
        if (args.role === 'selected') {
          return {
            ok: false,
            reason: 'port-conflict-selected',
            port: args.remotePort,
            conflictingKey: inFlight.listenerKey
          }
        }
        return {
          ok: false,
          reason: 'port-conflict-companion',
          port: args.remotePort,
          conflictingKey: inFlight.listenerKey
        }
      }
      const result = await inFlight.promise
      if (result.ok) {
        result.listener.retain()
        return { ...result, created: false }
      }
      return result
    }

    const promise = this.doAcquire(args, listenerKey)
    this.inFlightReservations.set(args.remotePort, { listenerKey, promise })
    try {
      return await promise
    } finally {
      this.inFlightReservations.delete(args.remotePort)
    }
  }

  private async doAcquire(
    args: RuntimePortTunnelPoolAcquireOptions,
    listenerKey: string
  ): Promise<RuntimePortTunnelPoolAcquireResult> {
    const listener = this.factory({
      port: args.remotePort,
      onConnection: args.onConnection
    })
    try {
      await listener.listen()
    } catch (err) {
      // Why: listen failed (EADDRINUSE at the OS level, or close raced). Do
      // not reserve the port and do not publish a listener. The caller gets
      // a bounded listen-error and may surface a partial/skipped result.
      return {
        ok: false,
        reason: 'listen-error',
        port: args.remotePort,
        error: err instanceof Error ? err : new Error(String(err))
      }
    }
    if (this.isShutdown) {
      await listener.closeAsync()
      return {
        ok: false,
        reason: 'listen-error',
        port: args.remotePort,
        error: new Error('Listener pool is shutdown')
      }
    }
    this.listeners.set(listenerKey, listener)
    this.portReservation.set(args.remotePort, listenerKey)
    listener.retain()
    return {
      ok: true,
      listener,
      listenerKey,
      port: args.remotePort,
      role: args.role,
      created: true
    }
  }

  /**
   * Release one ref count on a listener. When refCount hits zero the pool
   * awaits the shared close promise before deleting the entry, so a later
   * acquire for the same port cannot rebind while server.close is still
   * running.
   */
  async release(listenerKey: string): Promise<void> {
    const listener = this.listeners.get(listenerKey)
    if (!listener) {
      return
    }
    listener.release()
    if (listener.getRefCount() <= 0) {
      // Why: pool is the sole zero-ref close owner. Awaiting closeAsync
      // here means a re-acquire for the same port cannot rebind before the
      // server.close callback has fired.
      await listener.closeAsync()
      this.listeners.delete(listenerKey)
      // Why: only clear the reservation if this key still owns it; a prior
      // failed acquire may have already cleared or never set it.
      if (this.portReservation.get(listener.getPort()) === listenerKey) {
        this.portReservation.delete(listener.getPort())
      }
    }
  }

  /**
   * Wait for any in-flight close on a listener key to finish before the
   * caller attempts a rebind. Used by the manager's getOrCreate path so a
   * rebind after a drop does not race with a pending server.close.
   */
  async awaitClose(listenerKey: string): Promise<void> {
    const listener = this.listeners.get(listenerKey)
    if (listener && listener.isClosed()) {
      await listener.closeAsync()
    }
  }

  /** True when a local port is currently reserved by any listener key. */
  isPortReserved(port: number): boolean {
    return this.portReservation.has(port) || this.inFlightReservations.has(port)
  }

  /** The listener key currently owning a local port reservation, or null. */
  portOwner(port: number): string | null {
    return (
      this.portReservation.get(port) ?? this.inFlightReservations.get(port)?.listenerKey ?? null
    )
  }

  /** Number of distinct listeners currently held. Exposed for tests. */
  size(): number {
    return this.listeners.size
  }

  /**
   * Close all listeners and clear reservations. Used on shutdown / env
   * removal so no listener outlives its environment. Awaits all close
   * promises in parallel so shutdown does not serialize.
   */
  async closeAll(): Promise<void> {
    this.isShutdown = true
    const entries = Array.from(this.listeners.entries())
    this.listeners.clear()
    this.portReservation.clear()
    const inFlights = Array.from(this.inFlightReservations.values())
    this.inFlightReservations.clear()

    await Promise.all(
      inFlights.map(async (inFlight) => {
        try {
          const result = await inFlight.promise
          if (result.ok) {
            await result.listener.closeAsync()
            this.listeners.delete(result.listenerKey)
            this.portReservation.delete(result.port)
          }
        } catch {}
      })
    )

    await Promise.all(
      entries.map(async ([_, listener]) => {
        await listener.closeAsync()
      })
    )
  }
}

export function makeListenerKey(
  environmentId: string,
  remotePort: number,
  endpointId: number
): string {
  return `${environmentId}:${remotePort}:${endpointId}`
}

const defaultListenerFactory: RuntimePortTunnelListenerFactory = (options) => {
  return new RuntimePortTunnelListener(options)
}
