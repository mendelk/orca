/* Why: Stage 2 persisted intent for a client-owned browser page that reaches
 * a paired runtime listener through a workspace port tunnel. The descriptor
 * records only what is required to reacquire reachability after restore —
 * never lease IDs, grant IDs, local socket addresses, or live socket state.
 *
 * Validation is strict on origin/port because the descriptor drives URL
 * translation for fallback and the "must reacquire before navigation" gate
 * on restore. A malformed descriptor would otherwise let a restored page
 * navigate to a wrong local port or mis-translate back to the remote origin.
 */
import { z } from 'zod'
import type { BrowserPortTunnelDescriptor } from './browser-workspace-types'

const URL_ORIGIN_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s/?#]+$/i
const TCP_PORT_MAX = 65_535
const DEFAULT_PORTS: Record<string, number> = { 'http:': 80, 'https:': 443 }

function effectivePort(url: URL): number {
  if (url.port !== '') {
    return Number(url.port)
  }
  return DEFAULT_PORTS[url.protocol] ?? 0
}

export const browserPortTunnelDescriptorSchema: z.ZodType<BrowserPortTunnelDescriptor> = z
  .object({
    environmentId: z.string().min(1),
    worktreeId: z.string().min(1),
    remoteOrigin: z
      .string()
      .trim()
      .min(1)
      .max(512)
      .refine((value) => {
        if (!URL_ORIGIN_RE.test(value)) {
          return false
        }
        try {
          const url = new URL(value)
          if (url.protocol !== 'http:' && url.protocol !== 'https:') {
            return false
          }
          // Why: credentials in the descriptor origin would leak through URL
          // translation and could be replayed; reject userinfo outright.
          if (url.username !== '' || url.password !== '') {
            return false
          }
          return true
        } catch {
          return false
        }
      }, 'remoteOrigin must be an http(s):// origin with no path/query/fragment/userinfo'),
    remotePort: z.number().int().min(1).max(TCP_PORT_MAX)
  })
  .strict()
  .superRefine((value, ctx) => {
    // Why: the descriptor drives URL translation; a remoteOrigin whose
    // effective port differs from remotePort would let remoteOriginForDescriptor
    // return contradictory port/origin values. Require them to agree so the
    // descriptor is self-consistent.
    try {
      const url = new URL(value.remoteOrigin)
      if (effectivePort(url) !== value.remotePort) {
        ctx.addIssue({
          code: 'custom',
          message: 'remoteOrigin effective port must equal remotePort',
          path: ['remotePort']
        })
      }
    } catch {
      // origin refinement already rejects this; no duplicate issue
    }
  })

/** Result of validating a persisted tunnel descriptor. */
export type BrowserPortTunnelDescriptorValidation =
  | { ok: true; descriptor: BrowserPortTunnelDescriptor }
  | { ok: false; reason: string }

/** Parse an unknown persisted descriptor into a strict, normalized shape or
 *  reject it with a bounded reason. Used at the session-load boundary so a
 *  corrupt or hostile descriptor never reaches the renderer store or the
 *  URL-translation path. */
export function validateBrowserPortTunnelDescriptor(
  raw: unknown
): BrowserPortTunnelDescriptorValidation {
  const result = browserPortTunnelDescriptorSchema.safeParse(raw)
  if (!result.success) {
    return { ok: false, reason: result.error.issues[0]?.message ?? 'invalid tunnel descriptor' }
  }
  return { ok: true, descriptor: result.data }
}

/** True when the page is client-owned (browserRuntimeEnvironmentId is null)
 *  AND carries a tunnel descriptor. Such pages must reacquire a tunnel before
 *  the webview navigates on restore. A page with a descriptor but a non-null
 *  environment id is treated as host-owned: the descriptor is retained for an
 *  explicit retry but the page does not need tunnel reacquisition. */
export function isClientOwnedTunneledPage(
  browserRuntimeEnvironmentId: string | null | undefined,
  portTunnelDescriptor: BrowserPortTunnelDescriptor | undefined
): boolean {
  return browserRuntimeEnvironmentId === null && Boolean(portTunnelDescriptor)
}

/** True when the page must reacquire a tunnel before its webview navigates
 *  on restore — client-owned AND carries a descriptor. */
export function pageRequiresTunnelReacquisition(
  browserRuntimeEnvironmentId: string | null | undefined,
  portTunnelDescriptor: BrowserPortTunnelDescriptor | undefined
): boolean {
  return isClientOwnedTunneledPage(browserRuntimeEnvironmentId, portTunnelDescriptor)
}
