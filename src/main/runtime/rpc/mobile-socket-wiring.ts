import type {
  MobileSocketTransportMetadata,
  MobileSocketTransport,
  AuthenticatedMobileSocket,
  MobileSocketWiringOptions
} from './mobile-socket-wiring-types'
export type {
  MobileSocketTransportMetadata,
  MobileSocketTransport,
  AuthenticatedMobileSocket,
  MobileSocketWiringOptions
} from './mobile-socket-wiring-types'
import { randomBytes } from 'node:crypto'
import type { WebSocket } from 'ws'
import type { DeviceEntry, DeviceRegistry } from '../device-registry'
import type { E2EEKeypair } from '../e2ee-keypair'
import { E2EEChannel, type E2EEAuthenticatedDevice } from './e2ee-channel'
import { createMobileE2EEOutboundMemoryBudget } from './mobile-e2ee-outbound-memory-budget'

function toAuthenticatedDevice(device: DeviceEntry): E2EEAuthenticatedDevice {
  return {
    deviceId: device.deviceId,
    deviceToken: device.token,
    scope: device.scope
  }
}

export class MobileSocketWiring {
  private readonly deviceRegistry: DeviceRegistry
  private readonly e2eeKeypair: E2EEKeypair
  private readonly onText: MobileSocketWiringOptions['onText']
  private readonly onBinary: MobileSocketWiringOptions['onBinary']
  private readonly onTunnelBinary: MobileSocketWiringOptions['onTunnelBinary']
  private readonly onTunnelWritable: MobileSocketWiringOptions['onTunnelWritable']
  private readonly authorizeTunnel: MobileSocketWiringOptions['authorizeTunnel']
  private readonly onClose: MobileSocketWiringOptions['onClose']
  private readonly onReady: MobileSocketWiringOptions['onReady']
  private readonly onUnpairedDeviceAuthFailure: MobileSocketWiringOptions['onUnpairedDeviceAuthFailure']
  private readonly channels = new Map<WebSocket, E2EEChannel>()
  private readonly connectionIds = new Map<WebSocket, string>()
  private readonly authenticatedSockets = new Map<WebSocket, AuthenticatedMobileSocket>()
  private readonly transports = new Set<MobileSocketTransport>()
  private readonly outboundMemoryBudget = createMobileE2EEOutboundMemoryBudget()
  // Why: bounded recheck timers for tunnel writable notification, keyed by ws.
  private readonly writableRechecks = new Map<WebSocket, ReturnType<typeof setTimeout>>()
  // Why: attempt counts per socket, persisted across recheck reschedules so a ...
  private readonly writableRecheckAttempts = new Map<WebSocket, number>()
  private static readonly WRITABLE_RECHECK_MAX_ATTEMPTS = 20

  constructor(options: MobileSocketWiringOptions) {
    this.deviceRegistry = options.deviceRegistry
    this.e2eeKeypair = options.e2eeKeypair
    this.onText = options.onText
    this.onBinary = options.onBinary
    this.onTunnelBinary = options.onTunnelBinary
    this.onTunnelWritable = options.onTunnelWritable
    this.authorizeTunnel = options.authorizeTunnel
    this.onClose = options.onClose
    this.onReady = options.onReady
    this.onUnpairedDeviceAuthFailure = options.onUnpairedDeviceAuthFailure
  }

  attachTransport(
    transport: MobileSocketTransport,
    getMetadata: (ws: WebSocket) => MobileSocketTransportMetadata = () => ({
      transport: 'direct'
    })
  ): () => void {
    this.transports.add(transport)
    transport.onMessage((message, _reply, ws) => {
      this.handleRawMessage(transport, ws, message, getMetadata(ws))
    })
    transport.onConnectionClose((_clientId, ws) => this.handleClose(ws))
    let attached = true
    return () => {
      if (!attached) {
        return
      }
      attached = false
      this.transports.delete(transport)
    }
  }

  getConnectionId(ws: WebSocket): string | undefined {
    return this.connectionIds.get(ws)
  }

  sendTunnelBinary(ws: WebSocket, plaintext: Uint8Array<ArrayBufferLike>): boolean {
    const channel = this.channels.get(ws)
    if (!channel) {
      return false
    }
    const result = channel.sendBinary(plaintext)
    if (result === false) {
      this.scheduleTunnelWritableRecheck(ws, channel)
    } else {
      const recheck = this.writableRechecks.get(ws)
      if (recheck) {
        clearTimeout(recheck)
        this.writableRechecks.delete(ws)
      }
      this.writableRecheckAttempts.delete(ws)
    }
    return result ?? false
  }

  // Why: the tunnel session closes the whole channel on invalid framing, unsup...
  private scheduleTunnelWritableRecheck(ws: WebSocket, channel: E2EEChannel): void {
    if (this.writableRechecks.has(ws)) {
      return
    }
    const attempts = this.writableRecheckAttempts.get(ws) ?? 0
    if (attempts >= MobileSocketWiring.WRITABLE_RECHECK_MAX_ATTEMPTS) {
      this.closeTunnelChannel(ws, 4003, 'Tunnel transport remained backpressured.')
      return
    }
    const nextAttempt = attempts + 1
    this.writableRecheckAttempts.set(ws, nextAttempt)
    // Why: bounded backoff: 50ms, 100ms, 200ms, 400ms, ... capped at 5s.
    const delay = Math.min(50 * 2 ** attempts, 5000)
    const poll = () => {
      this.writableRechecks.delete(ws)
      if (ws.readyState !== ws.OPEN) {
        this.writableRecheckAttempts.delete(ws)
        return
      }
      if (ws.bufferedAmount === 0) {
        // Why: ws is drained — notify. If the E2EE budget still rejects, sendTunnelB...
        channel.notifyWritable()
        return
      }
      this.scheduleTunnelWritableRecheck(ws, channel)
    }
    this.writableRechecks.set(ws, setTimeout(poll, delay))
  }

  closeTunnelChannel(ws: WebSocket, code: number, reason: string): void {
    const channel = this.channels.get(ws)
    if (channel) {
      channel.destroy()
      this.channels.delete(ws)
    }
    const recheck = this.writableRechecks.get(ws)
    if (recheck) {
      clearTimeout(recheck)
      this.writableRechecks.delete(ws)
    }
    this.writableRecheckAttempts.delete(ws)
    if (ws.readyState === ws.OPEN) {
      ws.close(code, reason)
    }
  }

  get channelCount(): number {
    return this.channels.size
  }

  get connectionCount(): number {
    return this.connectionIds.size
  }

  terminateDeviceConnections(deviceToken: string): number {
    let terminated = 0
    for (const transport of this.transports) {
      terminated += transport.terminateClientConnections(deviceToken)
    }
    return terminated
  }

  private handleRawMessage(
    transport: MobileSocketTransport,
    ws: WebSocket,
    message: string | Uint8Array<ArrayBufferLike>,
    metadata: MobileSocketTransportMetadata
  ): void {
    let channel = this.channels.get(ws)
    if (!channel) {
      const connectionId = randomBytes(8).toString('hex')
      this.connectionIds.set(ws, connectionId)
      channel = new E2EEChannel(ws, {
        serverSecretKey: this.e2eeKeypair.secretKey,
        transportContext:
          metadata.transport === 'relay'
            ? { transport: 'relay', relayHostId: metadata.relayHostId }
            : { transport: 'direct' },
        requireV2: metadata.transport === 'relay',
        outboundMemoryBudget: this.outboundMemoryBudget,
        resolveAuthenticatedDevice: (token) => {
          const device = this.deviceRegistry.validateToken(token)
          if (!device) {
            return null
          }
          // Why: outer relay authorization cannot choose the local Orca identity; E2EE...
          if (metadata.transport === 'relay' && metadata.relayDeviceId !== device.deviceId) {
            return null
          }
          return toAuthenticatedDevice(device)
        },
        onReady: (channel, device, auth) => {
          const requestedChannel = auth.channel ?? 'rpc'
          let tunnelEndpoints:
            | readonly {
                endpointId: number
                port: number
                connectHost: string
                protocol: 'http' | 'https' | 'unknown'
              }[]
            | undefined
          if (requestedChannel === 'workspace-port-tunnel.v1') {
            if (device.scope === 'mobile') {
              return {
                ok: false,
                code: 4001,
                reason: 'Mobile-scoped devices cannot authorize workspace port tunnels.'
              }
            }
            if (!auth.tunnelGrantId) {
              return { ok: false, code: 4001, reason: 'Missing tunnel grant ID.' }
            }
            const grantedEndpoints = this.authorizeTunnel?.(auth.tunnelGrantId, device.deviceToken)
            if (!grantedEndpoints) {
              return { ok: false, code: 4001, reason: 'Invalid or expired tunnel grant.' }
            }
            tunnelEndpoints = grantedEndpoints
          }

          const socket: AuthenticatedMobileSocket = {
            ws,
            connectionId,
            device,
            clientCapabilities: channel.clientCapabilities,
            transport: metadata,
            channel: requestedChannel,
            tunnelGrantId: auth.tunnelGrantId,
            ...(tunnelEndpoints ? { tunnelEndpoints } : {})
          }
          this.authenticatedSockets.set(ws, socket)
          transport.setClientId(ws, device.deviceToken)
          // Why: deferred — the client's e2ee_authenticated must not wait on a secure-...
          this.deviceRegistry.updateLastSeenDeferred(device.deviceId)
          this.onReady?.(socket)
          return undefined
        },
        onError: (code, reason) => {
          const reportUnpairedDevice = code === 4001 && reason === 'Unauthorized'
          this.channels.get(ws)?.destroy()
          this.channels.delete(ws)
          ws.close(code, reason)
          if (reportUnpairedDevice) {
            try {
              this.onUnpairedDeviceAuthFailure?.(metadata)
            } catch (error) {
              // Why: renderer teardown can make UI delivery throw; auth cleanup must remai...
              console.error('[mobile] Failed to report unpaired-device auth failure:', error)
            }
          }
        }
      })
      channel.onMessage((plaintext, reply, sendBinary) => {
        const socket = this.authenticatedSockets.get(ws)
        if (socket && socket.channel !== 'workspace-port-tunnel.v1') {
          this.onText(socket, plaintext, reply, sendBinary)
        }
      })
      channel.onBinaryMessage((bytes) => {
        const socket = this.authenticatedSockets.get(ws)
        if (socket) {
          if (socket.channel === 'workspace-port-tunnel.v1') {
            this.onTunnelBinary?.(socket, bytes)
          } else {
            this.onBinary(socket, bytes)
          }
        }
      })
      // Why: wire the E2EE channel's writable notification to the tunnel session s...
      channel.onWritable(() => {
        const socket = this.authenticatedSockets.get(ws)
        if (socket && socket.channel === 'workspace-port-tunnel.v1') {
          this.onTunnelWritable?.(socket)
        }
      })
      this.channels.set(ws, channel)
    }
    channel.handleRawMessage(message)
  }

  private handleClose(ws: WebSocket): void {
    const socket = this.authenticatedSockets.get(ws) ?? null
    this.authenticatedSockets.delete(ws)
    this.channels.get(ws)?.destroy()
    this.channels.delete(ws)
    this.connectionIds.delete(ws)
    const recheck = this.writableRechecks.get(ws)
    if (recheck) {
      clearTimeout(recheck)
      this.writableRechecks.delete(ws)
    }
    this.writableRecheckAttempts.delete(ws)
    const hasOtherConnections =
      socket !== null &&
      Array.from(this.authenticatedSockets.values()).some(
        (candidate) => candidate.device.deviceToken === socket.device.deviceToken
      )
    this.onClose(socket, hasOtherConnections)
  }
}
