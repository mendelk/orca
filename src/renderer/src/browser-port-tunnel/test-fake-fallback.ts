/* Why: the fake remote browser fallback port, split out of test-harness.ts
 *  to keep that file under the max-lines budget. */
import type { RemoteBrowserPageHandle } from '../store/slices/browser-port-tunnel-actions'
import type { BrowserPortTunnelDescriptor } from '../../../shared/browser-workspace-types'
import type {
  CreateRemoteBrowserPageOutcome,
  CreateRemoteBrowserPageRequest,
  RemoteBrowserFallbackPort
} from './remote-browser-fallback-port'

export type FakeFallbackOptions = {
  createFailure?: string
  handle?: RemoteBrowserPageHandle
}

export type FakeFallbackCall = {
  kind: 'existing-page' | 'new-open'
  pageId: string | null
  workspaceId: string | null
  worktreeId: string | null
  descriptor: BrowserPortTunnelDescriptor
  remoteUrl: string
}

export class FakeRemoteBrowserFallbackPort implements RemoteBrowserFallbackPort {
  readonly calls: FakeFallbackCall[] = []
  readonly closedHandles: RemoteBrowserPageHandle[] = []
  private readonly options: FakeFallbackOptions
  private remoteCounter = 0

  constructor(options: FakeFallbackOptions = {}) {
    this.options = options
  }

  async createRemoteBrowserPage(
    request: CreateRemoteBrowserPageRequest
  ): Promise<CreateRemoteBrowserPageOutcome> {
    this.calls.push({
      kind: request.kind,
      pageId: request.kind === 'existing-page' ? request.pageId : null,
      workspaceId: request.kind === 'new-open' ? request.workspaceId : null,
      worktreeId: request.kind === 'new-open' ? request.worktreeId : null,
      descriptor: request.descriptor,
      remoteUrl: request.remoteUrl
    })
    if (this.options.createFailure) {
      return { ok: false, reason: this.options.createFailure }
    }
    return {
      ok: true,
      handle: this.options.handle ?? {
        environmentId: request.descriptor.environmentId,
        remotePageId: `remote-${this.remoteCounter++}`
      }
    }
  }

  async closeRemoteBrowserPage(request: { handle: RemoteBrowserPageHandle }): Promise<void> {
    this.closedHandles.push(request.handle)
  }
}
