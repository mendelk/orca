import type { WorkspacePort } from '../../shared/workspace-ports'
import { evaluateTunnelEligibility, type DnsLoopbackProbe } from './tunnel-eligibility'

export const MAX_TUNNEL_ENDPOINTS = 16
export const MAX_COMPANION_ENDPOINTS = MAX_TUNNEL_ENDPOINTS - 1

export type EndpointSelectionResult = {
  selected: WorkspacePort | null
  companions: WorkspacePort[]
  unavailableReason?: string
}

export async function selectTunnelEndpoints(
  freshScanPorts: readonly WorkspacePort[],
  selectedPort: number,
  expectedWorktreeId: string,
  dns: DnsLoopbackProbe
): Promise<EndpointSelectionResult> {
  const workspaceRows = freshScanPorts.filter(
    (port): port is Extract<WorkspacePort, { kind: 'workspace' }> => port.kind === 'workspace'
  )
  const selectedRow =
    workspaceRows.find(
      (row) => row.port === selectedPort && row.owner.worktreeId === expectedWorktreeId
    ) ?? null

  if (!selectedRow) {
    const ownerMismatch = workspaceRows.some((row) => row.port === selectedPort)
    return {
      selected: null,
      companions: [],
      unavailableReason: ownerMismatch
        ? `Port ${selectedPort} is no longer owned by workspace ${expectedWorktreeId}.`
        : `Port ${selectedPort} is no longer attributed to workspace ${expectedWorktreeId}.`
    }
  }

  const selectedEligibility = await evaluateTunnelEligibility(selectedRow, expectedWorktreeId, dns)
  if (!selectedEligibility.eligible) {
    return {
      selected: null,
      companions: [],
      unavailableReason: `Port ${selectedPort} is not eligible for tunneling: ${selectedEligibility.reason}.`
    }
  }

  const candidateCompanions = workspaceRows.filter(
    (row) =>
      row.port !== selectedPort &&
      row.owner.worktreeId === expectedWorktreeId &&
      (row.protocol === 'http' || row.protocol === 'https' || Boolean(row.advertisedUrl))
  )

  const eligibleCompanions: Extract<WorkspacePort, { kind: 'workspace' }>[] = []
  for (const candidate of candidateCompanions) {
    const result = await evaluateTunnelEligibility(candidate, expectedWorktreeId, dns, {
      allowUnknownProtocol: Boolean(candidate.advertisedUrl)
    })
    if (result.eligible) {
      eligibleCompanions.push(candidate)
    }
  }

  const ranked = rankCompanions(eligibleCompanions)
  const companions = ranked.slice(0, MAX_COMPANION_ENDPOINTS)

  return {
    selected: selectedRow,
    companions
  }
}

export function rankCompanions(
  companions: readonly Extract<WorkspacePort, { kind: 'workspace' }>[]
): Extract<WorkspacePort, { kind: 'workspace' }>[] {
  return [...companions].sort((a, b) => {
    const aHasUrl = a.advertisedUrl ? 1 : 0
    const bHasUrl = b.advertisedUrl ? 1 : 0
    if (aHasUrl !== bHasUrl) {
      return bHasUrl - aHasUrl
    }
    return a.port - b.port
  })
}

export function enforceEndpointCap(
  selected: WorkspacePort | null,
  companions: readonly WorkspacePort[]
): { endpoints: WorkspacePort[]; dropped: WorkspacePort[] } {
  const endpoints: WorkspacePort[] = []
  if (selected) {
    endpoints.push(selected)
  }
  const dropped: WorkspacePort[] = []
  for (const companion of companions) {
    if (endpoints.length >= MAX_TUNNEL_ENDPOINTS) {
      dropped.push(companion)
      continue
    }
    endpoints.push(companion)
  }
  return { endpoints, dropped }
}
