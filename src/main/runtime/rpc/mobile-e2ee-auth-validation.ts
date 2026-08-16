import type { DesktopMobileE2EEV2Session } from './mobile-e2ee-v2-desktop-session'
import { publicKeyFromBase64 } from './e2ee-crypto'
import { parseRemoteRuntimeJsonText } from '../../../shared/remote-runtime-request-frames'

export type MobileE2EEAuth = {
  type: 'e2ee_auth'
  deviceToken: string
  clientCapabilities?: unknown
  v?: 2
  transcriptHashB64?: string
  channel?: 'rpc' | 'workspace-port-tunnel.v1'
  tunnelGrantId?: string
}

export function isValidMobileE2EEAuthVersion(
  auth: MobileE2EEAuth,
  v2Session: DesktopMobileE2EEV2Session | null
): boolean {
  if (!v2Session) {
    return auth.v === undefined && auth.transcriptHashB64 === undefined
  }
  // Why: mobile v2 keeps an exact transcript-bound shape; runtime capabilities use legacy paired-runtime auth.
  const keys = Object.keys(auth)
    .filter((k) => k !== 'channel' && k !== 'tunnelGrantId')
    .sort()
    .join(',')
  return (
    keys === 'deviceToken,transcriptHashB64,type,v' &&
    auth.v === 2 &&
    auth.transcriptHashB64 === v2Session.transcriptHashB64
  )
}

export function authenticateMobileE2EE<TDevice extends { deviceToken: string }>(args: {
  plaintext: string
  v2Session: DesktopMobileE2EEV2Session | null
  resolveDevice: (token: string) => TDevice | null
}):
  | { ok: true; device: TDevice; auth: MobileE2EEAuth }
  | { ok: false; code: 'bad_auth' | 'unauthorized' } {
  let auth: MobileE2EEAuth
  try {
    auth = parseRemoteRuntimeJsonText(args.plaintext) as MobileE2EEAuth
  } catch {
    return { ok: false, code: 'bad_auth' }
  }
  if (
    auth.type !== 'e2ee_auth' ||
    !auth.deviceToken ||
    !isValidMobileE2EEAuthVersion(auth, args.v2Session) ||
    !isValidRequestedChannel(auth)
  ) {
    return { ok: false, code: 'bad_auth' }
  }
  const device = args.resolveDevice(auth.deviceToken)
  return device?.deviceToken === auth.deviceToken
    ? { ok: true, device, auth }
    : { ok: false, code: 'unauthorized' }
}

function isValidRequestedChannel(auth: MobileE2EEAuth): boolean {
  if (auth.channel === undefined || auth.channel === 'rpc') {
    return auth.tunnelGrantId === undefined
  }
  return (
    auth.channel === 'workspace-port-tunnel.v1' &&
    typeof auth.tunnelGrantId === 'string' &&
    auth.tunnelGrantId.length > 0 &&
    auth.tunnelGrantId.length <= 256
  )
}

export function decodeMobileE2EEPublicKey(value: string): Uint8Array | null {
  try {
    return publicKeyFromBase64(value)
  } catch {
    return null
  }
}
