import type { WebSocket } from 'ws'
import { encryptBytes } from './e2ee-crypto'
import { isMobileE2EEBinaryPayloadWithinLimit } from './mobile-e2ee-outbound-admission'
import type { MobileE2EEDesktopOutboundOwner } from './mobile-e2ee-desktop-outbound-owner'

export function sendLegacyE2EEBinary(args: {
  ws: WebSocket
  sharedKey: Uint8Array | null
  outbound: MobileE2EEDesktopOutboundOwner
  response: Uint8Array<ArrayBufferLike>
  closeForSize: () => void
}): boolean {
  if (!args.sharedKey || args.ws.readyState !== args.ws.OPEN) {
    return false
  }
  if (!isMobileE2EEBinaryPayloadWithinLimit(args.response)) {
    args.closeForSize()
    return false
  }
  if (!args.outbound.canSend(args.response.byteLength + 40)) {
    return false
  }
  args.ws.send(Buffer.from(encryptBytes(args.response, args.sharedKey)), { binary: true })
  return true
}
