import type { NetSocketConnectionHandle } from './workspace-port-tunnel-session-sockets'
import type { InstalledStreamSocket } from './workspace-port-tunnel-session-stream-socket'
import type { QueuedOutboundFrame } from './workspace-port-tunnel-session-outbound'

export type ActiveStream = {
  streamId: number
  endpointId: number
  installed: InstalledStreamSocket | null
  connectHandle: NetSocketConnectionHandle | null
  halfClosedRemote: boolean
  halfClosedLocal: boolean
  cleanedUp: boolean
  finEmitted: boolean
}

export type StreamLifecycleEmit = (frame: QueuedOutboundFrame) => void

export type StreamLifecycleCallbacks = {
  onStreamRemoved: (streamId: number) => void
  onStreamCapExceeded: (streamId: number, endpointId: number) => void
  onEgressOverflow: (
    streamId: number,
    overflow:
      | { kind: 'stream-overflow'; limit: number }
      | { kind: 'channel-overflow'; limit: number }
  ) => void
}
