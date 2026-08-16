import type { DesktopMobileE2EEV2Context } from './mobile-e2ee-v2-desktop-session'
import type { MobileE2EEAuth } from './mobile-e2ee-auth-validation'
import type { MobileE2EEOutboundMemoryBudget } from './mobile-e2ee-outbound-memory-budget'
import type { E2EEChannel } from './e2ee-channel'

export type E2EEAuthenticatedDevice = {
  deviceId: string
  deviceToken: string
  scope: 'mobile' | 'runtime'
}

export type E2EEChannelOptions = {
  serverSecretKey: Uint8Array
  resolveAuthenticatedDevice: (token: string) => E2EEAuthenticatedDevice | null
  onReady: (
    channel: E2EEChannel,
    device: E2EEAuthenticatedDevice,
    auth: MobileE2EEAuth
  ) => void | { ok: false; code: number; reason: string }
  onError: (code: number, reason: string) => void
  transportContext?: DesktopMobileE2EEV2Context
  requireV2?: boolean
  outboundMemoryBudget?: MobileE2EEOutboundMemoryBudget
}
