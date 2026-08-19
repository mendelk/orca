import type { RuntimePortTunnelStreamRecord } from './runtime-port-tunnel-channel-socket'
import type { RuntimePortTunnelOutboundQueue } from './runtime-port-tunnel-outbound-queue'
import type { RuntimePortTunnelProtocol } from './runtime-port-tunnel-protocol'
import type { RuntimePortTunnelSchedulerStream } from './runtime-port-tunnel-scheduler'

export function sendRuntimePortTunnelQueueItem(args: {
  streamId: number
  streamInfo: RuntimePortTunnelSchedulerStream
  protocol: RuntimePortTunnelProtocol
  queue: RuntimePortTunnelOutboundQueue
  sendToRemote: (frame: Uint8Array) => boolean
  getRecord: (streamId: number) => RuntimePortTunnelStreamRecord | undefined
  pause: (record: RuntimePortTunnelStreamRecord) => void
  maybeSendFin: (record: RuntimePortTunnelStreamRecord) => void
}): boolean {
  const state = args.streamId === 0 ? null : args.protocol.registry.get(args.streamId)
  const credit = args.streamId === 0 ? Number.POSITIVE_INFINITY : (state?.sendCredit ?? 0)
  const nextType = args.queue.peekNextType(args.streamId)
  if (!nextType) {
    args.streamInfo.queuedBytes = 0
    return true
  }
  if (nextType === 'data' && credit <= 0) {
    const record = args.getRecord(args.streamId)
    if (record) {
      args.pause(record)
    }
    args.streamInfo.queuedBytes = 0
    return true
  }
  let bytesSent = 0
  const result = args.queue.sendOne(
    args.streamId,
    Math.min(Math.max(0, credit), 65536),
    (data) => {
      const accepted = args.sendToRemote(args.protocol.encodeData(args.streamId, data))
      bytesSent = accepted ? data.byteLength : 0
      return accepted
    },
    args.sendToRemote
  )
  if (!result.ok) {
    return result.reason !== 'transport-rejected'
  }
  if (bytesSent > 0) {
    args.protocol.registry.consumeSendCredit(args.streamId, bytesSent)
    const record = args.getRecord(args.streamId)
    if (record) {
      args.pause(record)
      args.maybeSendFin(record)
    }
  }
  args.streamInfo.queuedBytes = args.queue.queuedBytesFor(args.streamId)
  return true
}
