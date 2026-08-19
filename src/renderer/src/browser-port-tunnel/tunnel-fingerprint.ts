/* Why: collision-safe canonical fingerprint building, split out of the
 *  controller to keep it under the max-lines budget. Uses stable JSON
 *  stringify with sorted keys so delimiter-like values in field contents
 *  cannot cause collisions. */
import type { TunnelEndpointPlanSet } from './runtime-port-tunnel-client-port'

export function openFingerprint(args: {
  workspaceId: string
  worktreeId: string
  plan: TunnelEndpointPlanSet
}): string {
  return canonicalFingerprint('open', {
    workspaceId: args.workspaceId,
    worktreeId: args.worktreeId,
    descriptor: args.plan.descriptor,
    selected: args.plan.selected,
    companions: args.plan.companions
  })
}

export function restoreFingerprint(args: { pageId: string; plan: TunnelEndpointPlanSet }): string {
  return canonicalFingerprint('restore', {
    pageId: args.pageId,
    descriptor: args.plan.descriptor,
    selected: args.plan.selected,
    companions: args.plan.companions
  })
}

function canonicalFingerprint(prefix: string, fields: Record<string, unknown>): string {
  const sorted = Object.keys(fields)
    .sort()
    .map((k) => `${k}:${stableStringify(fields[k])}`)
    .join('|')
  return `${prefix}:${sorted}`
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`
  }
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}
