import type { WebSocket } from 'ws'
import type { E2EEAuthenticatedDevice } from './e2ee-channel'
import type { RuntimeCapability } from '../../../shared/protocol-version'
import type { DeviceRegistry } from '../device-registry'
import type { E2EEKeypair } from '../e2ee-keypair'
type MobileSocketPayload = string | Uint8Array<ArrayBufferLike>

export type MobileSocketTransportMetadata =
  | { transport: 'direct' }
  | {
      transport: 'relay'
      relayHostId: string
      relayDeviceId: string
      basisConnId: string
      credentialKind: 'invite' | 'resume'
    }

export type MobileSocketTransport = {
  onMessage(
    handler: (
      message: MobileSocketPayload,
      reply: (response: string) => void,
      ws: WebSocket
    ) => void
  ): void
  onConnectionClose(
    handler: (clientId: string | null, ws: WebSocket, hasOtherConnections: boolean) => void
  ): void
  setClientId(ws: WebSocket, clientId: string): void
  terminateClientConnections(clientId: string): number
}

export type AuthenticatedMobileSocket = {
  ws: WebSocket
  connectionId: string
  device: E2EEAuthenticatedDevice
  clientCapabilities: readonly RuntimeCapability[]
  transport: MobileSocketTransportMetadata
  channel: 'rpc' | 'workspace-port-tunnel.v1'
  tunnelGrantId?: string
  // Why: full server-internal endpoint descriptors from the initial consumed g...
  tunnelEndpoints?: readonly {
    endpointId: number
    port: number
    connectHost: string
    protocol: 'http' | 'https' | 'unknown'
  }[]
}

export type MobileSocketWiringOptions = {
  deviceRegistry: DeviceRegistry
  e2eeKeypair: E2EEKeypair
  onText: (
    socket: AuthenticatedMobileSocket,
    plaintext: string,
    reply: (response: string) => void,
    sendBinary: (response: Uint8Array<ArrayBufferLike>) => boolean | void
  ) => void
  onBinary: (socket: AuthenticatedMobileSocket, bytes: Uint8Array<ArrayBufferLike>) => void
  onTunnelBinary?: (socket: AuthenticatedMobileSocket, bytes: Uint8Array<ArrayBufferLike>) => void
  // Why: called when the E2EE transport reports writable for a tunnel channel....
  onTunnelWritable?: (socket: AuthenticatedMobileSocket) => void
  // Why: returns the full granted endpoint descriptors from the consumed grant...
  authorizeTunnel?: (
    grantId: string,
    deviceToken: string
  ) =>
    | readonly {
        endpointId: number
        port: number
        connectHost: string
        protocol: 'http' | 'https' | 'unknown'
      }[]
    | null
  onClose: (socket: AuthenticatedMobileSocket | null, hasOtherConnections: boolean) => void
  onReady?: (socket: AuthenticatedMobileSocket) => void
  // Why: stale keys and missing registry entries both fail before RPC can expl...
  onUnpairedDeviceAuthFailure?: (metadata: MobileSocketTransportMetadata) => void
}
