import {
  WorkspacePortTunnelOpcode,
  decodeWorkspacePortTunnelFrameDetailed
} from '../../shared/workspace-port-tunnel-protocol'
import { WorkspacePortTunnelErrorCode } from '../../shared/workspace-port-tunnel-payloads'
import type { WorkspacePortTunnelGrantStore } from './workspace-port-tunnel-grant-store'
import {
  installGrantedEndpoints,
  createAuthorizedEndpointTable,
  lookupGrantedEndpoint,
  preflightAuthorize
} from './workspace-port-tunnel-session-authorization'
import type { NetSocketFactory } from './workspace-port-tunnel-session-sockets'
import { WorkspacePortTunnelEgressFlow } from './workspace-port-tunnel-session-egress-flow'
import { WorkspacePortTunnelIngressCredit } from './workspace-port-tunnel-session-ingress-credit'
import {
  OutboundRetryQueue,
  type OutboundOverflow,
  type QueuedOutboundFrame,
  encodeOpenErrorFrame
} from './workspace-port-tunnel-session-outbound'
import {
  buildAuthorizeErrorFrame,
  buildAuthorizedFrame,
  buildPongFrame,
  buildResetFrame,
  decodeClientFrame,
  mapGrantErrorToAuthorizeErrorCode
} from './workspace-port-tunnel-session-frame-decoder'
import { StreamLifecycle } from './workspace-port-tunnel-session-stream-lifecycle'

export type WorkspacePortTunnelSessionOptions = {
  grantStore: WorkspacePortTunnelGrantStore
  deviceToken: string
  runtimeInstanceId: string
  socketFactory: NetSocketFactory
  sendFrame: (plaintext: Uint8Array<ArrayBufferLike>) => boolean
  closeChannel: (code: number, reason: string) => void
  initialGrantId?: string
  initialEndpoints?: readonly {
    endpointId: number
    port: number
    connectHost: string
    protocol: 'http' | 'https' | 'unknown'
  }[]
  connectTimeoutMs?: number
}

const CHANNEL_CLOSE_FRAMING = 4002
const CHANNEL_CLOSE_OVERFLOW = 4003

export class WorkspacePortTunnelSession {
  private readonly grantStore: WorkspacePortTunnelGrantStore
  private readonly deviceToken: string
  private readonly runtimeInstanceId: string
  private readonly closeChannelCb: (code: number, reason: string) => void
  private readonly authorized = createAuthorizedEndpointTable()
  private readonly consumedGrantIds = new Set<string>()
  private readonly egress = new WorkspacePortTunnelEgressFlow()
  private readonly ingress = new WorkspacePortTunnelIngressCredit()
  private readonly outbound: OutboundRetryQueue
  private readonly streams: StreamLifecycle
  private closed = false

  constructor(options: WorkspacePortTunnelSessionOptions) {
    this.grantStore = options.grantStore
    this.deviceToken = options.deviceToken
    this.runtimeInstanceId = options.runtimeInstanceId
    this.closeChannelCb = options.closeChannel
    this.outbound = new OutboundRetryQueue(
      options.sendFrame,
      (overflow) => this.onOutboundOverflow(overflow),
      {
        currentEgressBytes: () => this.egress.channelQueuedBytesTotal(),
        onSent: (frame) => {
          if (frame.opcode === WorkspacePortTunnelOpcode.Fin) {
            this.streams.handleOutboundFinSent(frame.streamId)
          }
        }
      }
    )
    this.streams = new StreamLifecycle({
      socketFactory: options.socketFactory,
      connectTimeoutMs: options.connectTimeoutMs ?? 10_000,
      egress: this.egress,
      ingress: this.ingress,
      emit: (frame) => this.enqueueOutbound(frame),
      isTransportBlocked: () => this.outbound.isBlocked(),
      callbacks: {
        onEgressOverflow: (streamId, overflow) => {
          if (overflow.kind === 'stream-overflow') {
            this.streams.handleReset(streamId)
            this.outbound.dropStream(streamId)
            this.enqueueOutbound(buildResetFrame(streamId))
          } else {
            this.closeChannel(CHANNEL_CLOSE_OVERFLOW, 'Channel queue overflow.')
          }
        },
        // Why: drop any remaining retry-queued frames for a removed/reset
        // stream so DATA/FIN never transmit after RESET or after the stream
        // is gone. Normal removal only fires after FIN drained, so this is a
        // no-op there.
        onStreamRemoved: (streamId) => {
          this.outbound.dropStream(streamId)
        },
        onStreamCapExceeded: (streamId, endpointId) => {
          this.enqueueOutbound(
            encodeOpenErrorFrame(streamId, endpointId, WorkspacePortTunnelErrorCode.InternalError)
          )
        }
      }
    })
    if (options.initialGrantId && options.initialEndpoints && options.initialEndpoints.length > 0) {
      this.installInitialGrant(options.initialGrantId, options.initialEndpoints)
    }
  }

  private installInitialGrant(
    grantId: string,
    endpoints: readonly {
      endpointId: number
      port: number
      connectHost: string
      protocol: 'http' | 'https' | 'unknown'
    }[]
  ): void {
    this.consumedGrantIds.add(grantId)
    const endpointIds = endpoints.map((e) => e.endpointId)
    const preflight = preflightAuthorize({
      currentEndpointIds: new Set(this.authorized.byId.keys()),
      grantEndpointIds: endpointIds
    })
    if (!preflight.ok) {
      this.closeChannel(CHANNEL_CLOSE_FRAMING, 'Initial grant endpoint overflow.')
      return
    }
    for (const ep of endpoints) {
      this.authorized.byId.set(ep.endpointId, ep)
    }
  }

  handleBinaryFrame(bytes: Uint8Array<ArrayBufferLike>): void {
    if (this.closed) {
      return
    }
    const result = decodeWorkspacePortTunnelFrameDetailed(bytes)
    if (!result.ok) {
      this.closeChannel(CHANNEL_CLOSE_FRAMING, 'Invalid tunnel frame.')
      return
    }
    const decoded = decodeClientFrame(result.frame)
    switch (decoded.kind) {
      case 'authorize':
        this.handleAuthorize(decoded.grantId)
        break
      case 'open':
        this.handleOpen(decoded.streamId, decoded.endpointId)
        break
      case 'data':
        this.streams.handleClientData(decoded.streamId, decoded.payload)
        break
      case 'fin':
        this.streams.handleFin(decoded.streamId)
        break
      case 'reset':
        this.streams.handleReset(decoded.streamId)
        break
      case 'window-update':
        this.streams.handleWindowUpdate(decoded.streamId, decoded.credit)
        break
      case 'ping':
        this.enqueueOutbound(buildPongFrame())
        break
      case 'pong':
        break
      case 'runtime-to-client-only':
      case 'invalid-payload':
        this.closeChannel(CHANNEL_CLOSE_FRAMING, 'Invalid tunnel opcode.')
        break
    }
  }

  // Why: the E2EE transport reports writable — drain queued outbound frames
  // THEN pump remaining egress so source sockets resume after backpressure.
  // Prior code only drained the retry queue without pumping egress, leaving
  // queued DATA stuck until the next WINDOW_UPDATE.
  notifyTransportWritable(): void {
    if (this.closed) {
      return
    }
    this.outbound.drain()
    this.streams.notifyWritable()
  }

  // Why: idempotent close — safe to call multiple times. Releases grants,
  // destroys sockets, clears queues exactly once.
  handleClose(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    this.streams.markClosed()
    this.streams.teardownAll()
    this.egress.clear()
    this.ingress.clear()
    this.outbound.dropAll()
    this.grantStore.releaseGrantsForChannel({ grantIds: [...this.consumedGrantIds] })
    this.consumedGrantIds.clear()
    this.authorized.byId.clear()
  }

  private handleAuthorize(grantId: string): void {
    const consume = this.grantStore.consume({
      grantId,
      deviceToken: this.deviceToken,
      runtimeInstanceId: this.runtimeInstanceId
    })
    if (!consume.ok) {
      this.enqueueOutbound(
        buildAuthorizeErrorFrame(mapGrantErrorToAuthorizeErrorCode(consume.error))
      )
      return
    }
    const grantEndpointIds = consume.grant.endpoints.map((e) => e.endpointId)
    const preflight = preflightAuthorize({
      currentEndpointIds: new Set(this.authorized.byId.keys()),
      grantEndpointIds
    })
    if (!preflight.ok) {
      this.grantStore.releaseGrantsForChannel({ grantIds: [grantId] })
      this.enqueueOutbound(buildAuthorizeErrorFrame(preflight.errorCode))
      return
    }
    const install = installGrantedEndpoints({
      table: this.authorized,
      endpoints: consume.grant.endpoints
    })
    if (!install.ok) {
      this.grantStore.releaseGrantsForChannel({ grantIds: [grantId] })
      this.enqueueOutbound(buildAuthorizeErrorFrame(install.errorCode))
      return
    }
    this.consumedGrantIds.add(grantId)
    // Why: AUTHORIZED identifies the newly accepted grant endpoints per the
    // protocol contract, not ambiguously all prior endpoints. The client
    // knows which endpoints this specific grant authorized.
    this.enqueueOutbound(buildAuthorizedFrame(grantEndpointIds))
  }

  private handleOpen(streamId: number, endpointId: number): void {
    if (streamId === 0 || this.streams.has(streamId)) {
      this.closeChannel(CHANNEL_CLOSE_FRAMING, 'Invalid tunnel stream id.')
      return
    }
    const endpoint = lookupGrantedEndpoint(this.authorized, endpointId)
    if (!endpoint || endpoint.connectHost.length === 0 || endpoint.port === 0) {
      this.enqueueOutbound(
        encodeOpenErrorFrame(
          streamId,
          endpointId,
          WorkspacePortTunnelErrorCode.EndpointNotAuthorized
        )
      )
      return
    }
    this.streams.open(streamId, endpoint.connectHost, endpoint.port, endpointId)
  }

  private enqueueOutbound(frame: QueuedOutboundFrame): void {
    if (this.closed) {
      return
    }
    this.outbound.enqueueOrSend(frame)
  }

  // Why: DATA/FIN overflow for a stream resets that stream AND drops its
  // queued retry frames so nothing transmits after RESET. Control-frame or
  // aggregate overflow closes the whole channel. Never transmit DATA/FIN
  // after RESET — dropStream removes them from the retry queue.
  private onOutboundOverflow(overflow: OutboundOverflow): void {
    if (overflow.kind === 'stream-overflow') {
      this.streams.handleReset(overflow.streamId)
      this.outbound.dropStream(overflow.streamId)
      this.enqueueOutbound(buildResetFrame(overflow.streamId))
    } else {
      this.closeChannel(CHANNEL_CLOSE_OVERFLOW, 'Channel queue overflow.')
    }
  }

  private closeChannel(code: number, reason: string): void {
    if (this.closed) {
      return
    }
    this.closed = true
    this.streams.markClosed()
    this.streams.teardownAll()
    this.egress.clear()
    this.ingress.clear()
    this.outbound.dropAll()
    this.grantStore.releaseGrantsForChannel({ grantIds: [...this.consumedGrantIds] })
    this.consumedGrantIds.clear()
    this.authorized.byId.clear()
    try {
      this.closeChannelCb(code, reason)
    } catch {
      // best-effort
    }
  }

  get activeStreamCount(): number {
    return this.streams.size()
  }
  get authorizedEndpointCount(): number {
    return this.authorized.byId.size
  }
  get consumedGrantCount(): number {
    return this.consumedGrantIds.size
  }
  get isClosed(): boolean {
    return this.closed
  }
  get pendingOutboundFrames(): number {
    return this.outbound.pending()
  }
  get channelQueuedBytes(): number {
    // Why: aggregate channel budget = egress queued + retry queued, so the
    // session reports a single 16 MiB cap across both pools.
    return this.egress.channelQueuedBytesTotal() + this.outbound.queuedBytesTotal()
  }
  get retryQueuedBytes(): number {
    return this.outbound.queuedBytesTotal()
  }
}
