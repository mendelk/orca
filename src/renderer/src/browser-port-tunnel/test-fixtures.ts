/* Why: test fixtures (plan/page builders + deterministic id generator) split
 *  out of test-harness.ts to keep that file under the max-lines budget. */
import type {
  BrowserPage,
  BrowserPortTunnelDescriptor
} from '../../../shared/browser-workspace-types'
import type { OperationIdGenerator, TunnelEndpointPlanSet } from './runtime-port-tunnel-client-port'

export function makePlan(overrides: Partial<TunnelEndpointPlanSet> = {}): TunnelEndpointPlanSet {
  const descriptor: BrowserPortTunnelDescriptor = overrides.descriptor ?? {
    environmentId: 'env-1',
    worktreeId: 'repo::/srv/app',
    remoteOrigin: 'http://127.0.0.1:5173',
    remotePort: 5173
  }
  return {
    descriptor,
    selected: overrides.selected ?? {
      port: 5173,
      protocol: 'http',
      advertisedUrl: 'http://127.0.0.1:5173/app?x=1#frag'
    },
    companions: overrides.companions ?? [
      { port: 3001, protocol: 'http', advertisedUrl: 'http://127.0.0.1:3001' }
    ]
  }
}

export function makeClientOwnedPage(overrides: Partial<BrowserPage> = {}): BrowserPage {
  const descriptor: BrowserPortTunnelDescriptor = overrides.portTunnelDescriptor ?? {
    environmentId: 'env-1',
    worktreeId: 'repo::/srv/app',
    remoteOrigin: 'http://127.0.0.1:5173',
    remotePort: 5173
  }
  return {
    id: 'page-1',
    workspaceId: 'ws-1',
    worktreeId: 'repo::/srv/app',
    url: 'http://127.0.0.1:5173/app?x=1#frag',
    title: 'App',
    loading: true,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 100,
    browserRuntimeEnvironmentId: null,
    portTunnelDescriptor: descriptor,
    ...overrides
  }
}

/** Deterministic operation id generator for tests. Produces stable, unique
 *  keys so concurrent-open dedup is predictable. */
export function deterministicIdGenerator(prefix: string): OperationIdGenerator {
  let counter = 0
  return {
    operationKey({ workspaceId, plan }) {
      return `${prefix}-open-${workspaceId}-${plan.selected.port}-${counter++}`
    },
    acquireOperationId({ pageId, generation }) {
      return `${prefix}-acquire-${pageId}-gen${generation}-${counter++}`
    }
  }
}
