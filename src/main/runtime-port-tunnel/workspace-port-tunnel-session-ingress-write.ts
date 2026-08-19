import type {
  ActiveStream,
  StreamLifecycleEmit
} from './workspace-port-tunnel-session-active-stream'
import type { WorkspacePortTunnelEgressFlow } from './workspace-port-tunnel-session-egress-flow'
import type { WorkspacePortTunnelIngressCredit } from './workspace-port-tunnel-session-ingress-credit'
import { encodeWindowUpdateFrame } from './workspace-port-tunnel-session-outbound'
import type { InstalledStreamSocket } from './workspace-port-tunnel-session-stream-socket'

export function writeClientData(args: {
  installed: InstalledStreamSocket | null
  ingress: WorkspacePortTunnelIngressCredit
  emit: StreamLifecycleEmit
  resetStream: () => void
  emitUnknownReset: () => void
  streamId: number
  payload: Uint8Array
}): void {
  if (!args.installed?.controller.isWritable()) {
    args.emitUnknownReset()
    return
  }
  if (args.ingress.remainingWindow(args.streamId) < args.payload.byteLength) {
    args.resetStream()
    return
  }
  const accepted = args.installed.controller.write(args.payload)
  if (args.payload.byteLength > 0) {
    returnIngressCredit({ ...args, bytes: args.payload.byteLength, accepted })
  }
}

export function returnIngressCredit(args: {
  ingress: WorkspacePortTunnelIngressCredit
  emit: StreamLifecycleEmit
  resetStream: (streamId: number) => void
  streamId: number
  bytes: number
  accepted: boolean
}): void {
  const result = args.accepted
    ? args.ingress.recordAccepted(args.streamId, args.bytes)
    : args.ingress.recordPending(args.streamId, args.bytes)
  if (!result.ok && result.reason === 'window-exceeded') {
    args.resetStream(args.streamId)
    return
  }
  if (result.ok && result.creditToReturn > 0) {
    args.emit(encodeWindowUpdateFrame(args.streamId, result.creditToReturn))
  }
}

export function syncSourcePauseResume(
  streams: ReadonlyMap<number, ActiveStream>,
  egress: WorkspacePortTunnelEgressFlow
): void {
  for (const [streamId, stream] of streams) {
    if (!stream.installed) {
      continue
    }
    if (egress.isSourcePaused(streamId)) {
      stream.installed.controller.pauseSource()
    } else {
      stream.installed.controller.resumeSource()
    }
  }
}
