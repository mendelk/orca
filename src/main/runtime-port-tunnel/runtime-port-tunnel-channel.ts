import { EventEmitter } from 'node:events'
import { RuntimePortTunnelProtocol } from './runtime-port-tunnel-protocol'
import {
  RuntimePortTunnelScheduler,
  type RuntimePortTunnelSchedulerStream
} from './runtime-port-tunnel-scheduler'
import { RuntimePortTunnelOutboundQueue } from './runtime-port-tunnel-outbound-queue'
import { installRuntimePortTunnelProtocolHandlers } from './runtime-port-tunnel-channel-protocol'
import {
  attachRuntimePortTunnelSocket,
  type RuntimePortTunnelStreamRecord
} from './runtime-port-tunnel-channel-socket'
import { sendRuntimePortTunnelQueueItem } from './runtime-port-tunnel-channel-outbound'
import type * as net from 'node:net'
export type RuntimePortTunnelChannelOptions = {
  sendToRemote: (data: Uint8Array) => boolean
  canSendToRemote: () => boolean
  onTransportDrain: (callback: () => void) => () => void
  onDisconnect: () => void
}
export class RuntimePortTunnelChannel extends EventEmitter {
  private protocol = new RuntimePortTunnelProtocol()
  private streams = new Map<number, RuntimePortTunnelStreamRecord>()
  private nextStreamId = 1
  private isClosed = false
  private readonly scheduler: RuntimePortTunnelScheduler
  private readonly queue: RuntimePortTunnelOutboundQueue
  private readonly sendToRemote: (data: Uint8Array) => boolean
  private readonly canSendToRemote: () => boolean
  private readonly onDisconnect: () => void
  private unsubscribeTransportDrain: (() => void) | null = null
  constructor(options: RuntimePortTunnelChannelOptions) {
    super()
    this.on('error', () => {})
    this.sendToRemote = options.sendToRemote
    this.canSendToRemote = options.canSendToRemote
    this.onDisconnect = options.onDisconnect
    this.queue = new RuntimePortTunnelOutboundQueue()
    this.scheduler = new RuntimePortTunnelScheduler({
      transport: {
        canSend: () => this.canSendToRemote(),
        send: (stream) => this.sendOne(stream.streamId, stream)
      },
      onTransportSaturated: () => {
        for (const record of this.streams.values()) {
          this.maybePauseUpstream(record)
        }
      }
    })
    this.unsubscribeTransportDrain = options.onTransportDrain(() => {
      this.scheduler.notifyTransportDrained()
      for (const record of this.streams.values()) {
        this.maybeResumeUpstream(record)
      }
      this.drainOutbound()
    })
    installRuntimePortTunnelProtocolHandlers({
      protocol: this.protocol,
      getRecord: (streamId) => this.streams.get(streamId),
      resume: (record) => this.maybeResumeUpstream(record),
      drain: () => this.drainOutbound(),
      closeStream: (streamId) => this.closeStreamLocal(streamId),
      enqueueReset: (record, raw) => this.enqueueReset(record, raw),
      closeLocalResources: (record) => this.closeLocalResources(record),
      cleanup: (record) => this.maybeCleanupOutbound(record),
      enqueueControl: (streamId, frame) => this.enqueueControl(streamId, frame),
      closeChannel: () => this.close()
    })
  }
  handleIncomingData(data: Uint8Array): void {
    if (this.isClosed) {
      return
    }
    this.protocol.handleIncomingData(data)
  }
  attachSocket(endpointId: number, socket: net.Socket): number {
    if (this.streams.size >= 64) {
      socket.destroy()
      return -1
    }
    let streamId = this.nextStreamId,
      iterations = 0
    while (this.streams.has(streamId) || streamId === 0) {
      streamId++
      if (streamId > 0x7fffffff) {
        streamId = 1
      }
      iterations++
      if (iterations > 64) {
        socket.destroy()
        return -1
      }
    }
    this.nextStreamId = streamId + 1
    if (this.nextStreamId > 0x7fffffff) {
      this.nextStreamId = 1
    }

    attachRuntimePortTunnelSocket({
      streamId,
      endpointId,
      socket,
      protocol: this.protocol,
      queue: this.queue,
      isClosed: () => this.isClosed,
      register: (record) => this.streams.set(streamId, record),
      enqueueControl: (id, frame) => this.enqueueControl(id, frame),
      enqueueReset: (record) => this.enqueueReset(record),
      closeLocalResources: (record) => this.closeLocalResources(record),
      maybeCleanupOutbound: (record) => this.maybeCleanupOutbound(record),
      maybePauseUpstream: (record) => this.maybePauseUpstream(record),
      maybeSendFin: (record) => this.maybeSendFin(record),
      drainOutbound: () => this.drainOutbound(),
      closeChannel: () => this.close()
    })
    return streamId
  }
  authorize(grantId: Uint8Array): void {
    this.enqueueControl(0, this.protocol.encodeAuthorize(grantId))
  }
  private enqueueControl(streamId: number, frame: Uint8Array, onSent?: () => void): void {
    if (this.isClosed) {
      return
    }
    const result = this.queue.enqueueControl(streamId, frame, onSent)
    if (!result.ok) {
      if (result.reason === 'stream-overflow') {
        const record = this.streams.get(streamId)
        if (record) {
          this.closeLocalResources(record)
          this.maybeCleanupOutbound(record)
        }
      } else if (result.reason === 'channel-overflow') {
        this.close()
      }
    } else {
      if (streamId !== 0) {
        const record = this.streams.get(streamId)
        if (record) {
          this.maybePauseUpstream(record)
        }
      }
      this.drainOutbound()
    }
  }
  private sendOne(streamId: number, streamInfo: RuntimePortTunnelSchedulerStream): boolean {
    return sendRuntimePortTunnelQueueItem({
      streamId,
      streamInfo,
      protocol: this.protocol,
      queue: this.queue,
      sendToRemote: this.sendToRemote,
      getRecord: (id) => this.streams.get(id),
      pause: (record) => this.maybePauseUpstream(record),
      maybeSendFin: (record) => this.maybeSendFin(record)
    })
  }
  private maybeSendFin(record: RuntimePortTunnelStreamRecord): void {
    if (
      record.localHalfClosed &&
      !record.finQueued &&
      !record.resetQueued &&
      this.queue.queuedBytesFor(record.streamId) === 0
    ) {
      record.finQueued = true
      this.enqueueControl(record.streamId, this.protocol.encodeFin(record.streamId), () => {
        record.finAccepted = true
        this.maybeCleanupOutbound(record)
      })
    }
  }
  drainOutbound(): void {
    if (this.isClosed) {
      return
    }
    this.scheduler.drain(this.queue.schedulerStreams())
  }
  maybePauseUpstream(record: RuntimePortTunnelStreamRecord): void {
    if (record.paused) {
      return
    }
    const state = this.protocol.registry.get(record.streamId)
    const phase = state?.phase ?? 'idle'
    const cannotDrain =
      phase !== 'open' && phase !== 'half-closed-local' && phase !== 'half-closed-remote'
    if (
      cannotDrain ||
      (state?.sendCredit ?? 0) <= 0 ||
      this.scheduler.isSaturated() ||
      this.queue.queuedBytesFor(record.streamId) >= this.queue.maxStreamBytes()
    ) {
      record.socket.pause()
      record.paused = true
    }
  }
  maybeResumeUpstream(record: RuntimePortTunnelStreamRecord): void {
    if (!record.paused) {
      return
    }
    const state = this.protocol.registry.get(record.streamId)
    const phase = state?.phase ?? 'idle'
    const canDrain =
      (phase === 'open' || phase === 'half-closed-local' || phase === 'half-closed-remote') &&
      (state?.sendCredit ?? 0) > 0 &&
      !this.scheduler.isSaturated() &&
      this.queue.queuedBytesFor(record.streamId) < this.queue.maxStreamBytes()
    if (canDrain) {
      record.socket.resume()
      record.paused = false
    }
  }

  private closeLocalResources(record: RuntimePortTunnelStreamRecord): void {
    record.localClosed = true
    record.socket.destroy()
    record.inbound.unbindStream()
  }

  private maybeCleanupOutbound(record: RuntimePortTunnelStreamRecord): void {
    if (this.isClosed) {
      return
    }
    if (record.resetQueued) {
      return
    }
    if (!record.localClosed) {
      return
    }
    if (record.finQueued && !record.finAccepted) {
      return
    }
    if (!record.remoteClosed && !record.resetQueued && !(record.finQueued && record.finAccepted)) {
      return
    } // Wait until remote closed or we sent fin/reset
    this.queue.dropStream(record.streamId)
    this.streams.delete(record.streamId)
  }

  private enqueueReset(record: RuntimePortTunnelStreamRecord, isRaw = false): void {
    if (record.resetQueued) {
      return
    }
    record.resetQueued = true
    this.queue.dropStream(record.streamId)
    const frame = isRaw
      ? this.protocol.encodeRawReset(record.streamId)
      : this.protocol.encodeReset(record.streamId)
    this.enqueueControl(record.streamId, frame, () => {
      record.resetQueued = false
      this.finalizeStream(record)
    })
  }

  private finalizeStream(record: RuntimePortTunnelStreamRecord): void {
    this.closeLocalResources(record)
    this.queue.dropStream(record.streamId)
    this.streams.delete(record.streamId)
  }

  closeStreamLocal(streamId: number): void {
    const record = this.streams.get(streamId)
    if (!record) {
      return
    }
    this.finalizeStream(record)
  }
  close(): void {
    if (this.isClosed) {
      return
    }
    this.isClosed = true
    if (this.unsubscribeTransportDrain) {
      this.unsubscribeTransportDrain()
      this.unsubscribeTransportDrain = null
    }
    for (const record of this.streams.values()) {
      record.socket.destroy()
      record.inbound.unbindStream()
    }
    this.streams.clear()
    this.queue.clear()
    this.scheduler.resetCursor()
    this.emit('close')
    this.onDisconnect()
  }
  activeStreamCount(): number {
    return this.streams.size
  }
  isChannelClosed(): boolean {
    return this.isClosed
  }
  simulateChannelDrop(): void {
    this.emit('channelDrop')
    this.close()
  }
}
