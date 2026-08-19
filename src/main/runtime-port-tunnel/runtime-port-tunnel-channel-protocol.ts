import type { RuntimePortTunnelStreamRecord } from './runtime-port-tunnel-channel-socket'
import type { RuntimePortTunnelProtocol } from './runtime-port-tunnel-protocol'

export function installRuntimePortTunnelProtocolHandlers(args: {
  protocol: RuntimePortTunnelProtocol
  getRecord: (streamId: number) => RuntimePortTunnelStreamRecord | undefined
  resume: (record: RuntimePortTunnelStreamRecord) => void
  drain: () => void
  closeStream: (streamId: number) => void
  enqueueReset: (record: RuntimePortTunnelStreamRecord, raw?: boolean) => void
  closeLocalResources: (record: RuntimePortTunnelStreamRecord) => void
  cleanup: (record: RuntimePortTunnelStreamRecord) => void
  enqueueControl: (streamId: number, frame: Uint8Array) => void
  closeChannel: () => void
}): void {
  args.protocol.on('opened', ({ streamId }) => {
    const record = args.getRecord(streamId)
    if (record) {
      args.resume(record)
      args.drain()
    }
  })
  args.protocol.on('openError', ({ streamId }) => args.closeStream(streamId))
  args.protocol.on('data', ({ streamId, data }) => {
    const record = args.getRecord(streamId)
    if (!record) {
      return
    }
    const result = record.inbound.writeData(data)
    if (!result.ok && result.reason === 'credit-violation') {
      args.enqueueReset(record, true)
      args.closeLocalResources(record)
    }
  })
  args.protocol.on('fin', ({ streamId }) => {
    const record = args.getRecord(streamId)
    if (record) {
      record.remoteClosed = true
      record.socket.end()
      args.cleanup(record)
    }
  })
  args.protocol.on('reset', ({ streamId }) => {
    const record = args.getRecord(streamId)
    if (record) {
      record.remoteClosed = true
      args.closeLocalResources(record)
      args.cleanup(record)
    }
  })
  args.protocol.on('windowUpdate', ({ streamId }) => {
    const record = args.getRecord(streamId)
    if (record) {
      args.resume(record)
      args.drain()
    }
  })
  args.protocol.on('ping', () => args.enqueueControl(0, args.protocol.encodePong()))
  args.protocol.on('resetStream', ({ streamId }) => {
    const record = args.getRecord(streamId)
    if (record) {
      args.enqueueReset(record, true)
    } else {
      args.enqueueControl(streamId, args.protocol.encodeRawReset(streamId))
    }
  })
  args.protocol.on('protocolError', args.closeChannel)
}
