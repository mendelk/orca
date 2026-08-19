import type * as net from 'node:net'
import { RuntimePortTunnelInboundWriter } from './runtime-port-tunnel-inbound-writer'
import type { RuntimePortTunnelOutboundQueue } from './runtime-port-tunnel-outbound-queue'
import type { RuntimePortTunnelProtocol } from './runtime-port-tunnel-protocol'

export type RuntimePortTunnelStreamRecord = {
  streamId: number
  socket: net.Socket
  paused: boolean
  inbound: RuntimePortTunnelInboundWriter
  localHalfClosed: boolean
  localClosed: boolean
  finQueued: boolean
  finAccepted: boolean
  resetQueued: boolean
  remoteClosed: boolean
}

export function attachRuntimePortTunnelSocket(args: {
  streamId: number
  endpointId: number
  socket: net.Socket
  protocol: RuntimePortTunnelProtocol
  queue: RuntimePortTunnelOutboundQueue
  isClosed: () => boolean
  register: (record: RuntimePortTunnelStreamRecord) => void
  enqueueControl: (streamId: number, frame: Uint8Array) => void
  enqueueReset: (record: RuntimePortTunnelStreamRecord) => void
  closeLocalResources: (record: RuntimePortTunnelStreamRecord) => void
  maybeCleanupOutbound: (record: RuntimePortTunnelStreamRecord) => void
  maybePauseUpstream: (record: RuntimePortTunnelStreamRecord) => void
  maybeSendFin: (record: RuntimePortTunnelStreamRecord) => void
  drainOutbound: () => void
  closeChannel: () => void
}): RuntimePortTunnelStreamRecord {
  const inbound = new RuntimePortTunnelInboundWriter({
    write: (data) => (args.isClosed() ? true : args.socket.write(data)),
    sendWindowUpdate: (credit) => {
      if (!args.isClosed()) {
        args.enqueueControl(args.streamId, args.protocol.encodeWindowUpdate(args.streamId, credit))
      }
    }
  })
  inbound.bindStream(args.streamId)
  const record: RuntimePortTunnelStreamRecord = {
    streamId: args.streamId,
    socket: args.socket,
    paused: true,
    inbound,
    localHalfClosed: false,
    localClosed: false,
    finQueued: false,
    finAccepted: false,
    resetQueued: false,
    remoteClosed: false
  }
  args.register(record)
  args.socket.on('drain', () => {
    if (!args.isClosed()) {
      record.inbound.notifyDrained()
    }
  })
  args.socket.on('data', (data: Buffer) => {
    if (args.isClosed() || record.resetQueued || record.finQueued) {
      return
    }
    const result = args.queue.enqueueData(args.streamId, new Uint8Array(data))
    if (!result.ok) {
      if (result.reason === 'stream-overflow') {
        args.enqueueReset(record)
        args.closeLocalResources(record)
      } else if (result.reason === 'channel-overflow') {
        args.closeChannel()
      }
      return
    }
    args.maybePauseUpstream(record)
    args.drainOutbound()
  })
  args.socket.on('end', () => {
    if (!args.isClosed()) {
      record.localHalfClosed = true
      args.maybeSendFin(record)
    }
  })
  args.socket.on('close', (hadError) => {
    if (args.isClosed()) {
      args.closeLocalResources(record)
      args.maybeCleanupOutbound(record)
      return
    }
    if (hadError) {
      args.enqueueReset(record)
      args.closeLocalResources(record)
      return
    }
    record.localClosed = true
    if (!record.finQueued && !record.localHalfClosed) {
      record.localHalfClosed = true
      args.maybeSendFin(record)
    }
    args.maybeCleanupOutbound(record)
  })
  args.socket.on('error', () => {
    if (!args.isClosed()) {
      args.enqueueReset(record)
    }
    args.closeLocalResources(record)
  })
  args.socket.pause()
  args.enqueueControl(args.streamId, args.protocol.encodeOpen(args.streamId, args.endpointId))
  return record
}
