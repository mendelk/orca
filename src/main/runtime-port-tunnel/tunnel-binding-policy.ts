import type { WorkspacePort } from '../../shared/workspace-ports'

export type BindProbe = {
  isLocalPortFree(port: number, bindHost?: string): Promise<boolean>
}

export type BindingPolicyEndpoint = {
  port: WorkspacePort
  requiredLocalPort: number
  bindHost: string
}

export type BindingPolicyResult = {
  selected: BindingOutcome
  companions: (BindingOutcome & { port: WorkspacePort })[]
}

export type BindingOutcome =
  | { ok: true; localPort: number; bindHost: string }
  | {
      ok: false
      reason: 'bind-failed' | 'invalid-port' | 'missing-selected' | 'port-occupied'
      detail?: string
    }

export async function applyExactPortBindingPolicy(
  selected: BindingPolicyEndpoint | null,
  companions: readonly BindingPolicyEndpoint[],
  probe: BindProbe
): Promise<BindingPolicyResult> {
  if (!selected) {
    return {
      selected: { ok: false, reason: 'missing-selected' },
      companions: []
    }
  }

  const selectedOutcome = await bindExactPort(selected, probe)
  if (!selectedOutcome.ok) {
    // Why: a selected-port conflict blocks direct rendering. Return without
    // probing companions — they are irrelevant when the origin fails.
    return { selected: selectedOutcome, companions: [] }
  }

  const companionOutcomes: (BindingOutcome & { port: WorkspacePort })[] = []
  for (const companion of companions) {
    const outcome = await bindExactPort(companion, probe)
    if (outcome.ok) {
      companionOutcomes.push({ ...outcome, port: companion.port })
    } else {
      companionOutcomes.push({ ...outcome, port: companion.port })
    }
  }

  return {
    selected: selectedOutcome,
    companions: companionOutcomes
  }
}

async function bindExactPort(
  endpoint: BindingPolicyEndpoint,
  probe: BindProbe
): Promise<BindingOutcome> {
  if (
    !Number.isSafeInteger(endpoint.requiredLocalPort) ||
    endpoint.requiredLocalPort <= 0 ||
    endpoint.requiredLocalPort > 65535
  ) {
    return { ok: false, reason: 'invalid-port', detail: `invalid port ${endpoint.requiredLocalPort}` }
  }
  let free: boolean
  try {
    free = await probe.isLocalPortFree(endpoint.requiredLocalPort, endpoint.bindHost)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { ok: false, reason: 'bind-failed', detail }
  }
  if (!free) {
    return {
      ok: false,
      reason: 'port-occupied',
      detail: `local port ${endpoint.requiredLocalPort} is already in use`
    }
  }
  return { ok: true, localPort: endpoint.requiredLocalPort, bindHost: endpoint.bindHost }
}

export function partitionBoundCompanions(
  outcomes: readonly (BindingOutcome & { port: WorkspacePort })[]
): {
  bound: { localPort: number; bindHost: string; port: WorkspacePort }[]
  conflicted: { port: WorkspacePort; detail?: string }[]
} {
  const bound: { localPort: number; bindHost: string; port: WorkspacePort }[] = []
  const conflicted: { port: WorkspacePort; detail?: string }[] = []
  for (const outcome of outcomes) {
    if (outcome.ok) {
      bound.push({
        localPort: outcome.localPort,
        bindHost: outcome.bindHost,
        port: outcome.port
      })
    } else {
      conflicted.push({ port: outcome.port, detail: outcome.detail })
    }
  }
  return { bound, conflicted }
}
