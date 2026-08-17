import { describe, it, expect } from 'vitest'
import { browserPageSchema, browserWorkspaceSchema } from './workspace-session-browser-schema'
import { collectSalvageDrops } from './zod-salvage'
import type { BrowserPage, BrowserPortTunnelDescriptor } from './browser-workspace-types'

const validDescriptor: BrowserPortTunnelDescriptor = {
  environmentId: 'env-1',
  worktreeId: 'repo::/srv/app',
  remoteOrigin: 'http://127.0.0.1:5173',
  remotePort: 5173
}

function validPage(): BrowserPage {
  return {
    id: 'page-1',
    workspaceId: 'ws-1',
    worktreeId: 'repo::/srv/app',
    url: 'http://127.0.0.1:5173/',
    title: 'App',
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 1,
    browserRuntimeEnvironmentId: null,
    portTunnelDescriptor: validDescriptor
  }
}

describe('browserPageSchema portTunnelDescriptor', () => {
  it('round-trips a client-owned tunneled page', () => {
    const page = validPage()
    const result = browserPageSchema.safeParse(page)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.portTunnelDescriptor).toEqual(validDescriptor)
      expect(result.data.browserRuntimeEnvironmentId).toBe(null)
    }
  })

  it('round-trips a host-owned page that retains the descriptor for retry', () => {
    const page: BrowserPage = {
      ...validPage(),
      browserRuntimeEnvironmentId: 'env-1'
    }
    const result = browserPageSchema.safeParse(page)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.portTunnelDescriptor).toEqual(validDescriptor)
      expect(result.data.browserRuntimeEnvironmentId).toBe('env-1')
    }
  })

  it('preserves a page without a descriptor (old session data unchanged)', () => {
    const page: BrowserPage = {
      id: 'page-1',
      workspaceId: 'ws-1',
      worktreeId: 'wt-1',
      url: 'http://127.0.0.1:5173/',
      title: 'App',
      loading: false,
      faviconUrl: null,
      canGoBack: false,
      canGoForward: false,
      loadError: null,
      createdAt: 1
    }
    const result = browserPageSchema.safeParse(page)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.portTunnelDescriptor).toBeUndefined()
    }
  })

  it('strips a corrupt descriptor but keeps the rest of the page', () => {
    // Why: a bad optional descriptor must not fail the whole page and drop
    // the user's tab. salvagedOptional strips the invalid descriptor and
    // returns the page with the rest of its fields intact.
    const page = {
      ...validPage(),
      portTunnelDescriptor: { ...validDescriptor, remotePort: 'nope' }
    }
    const { value: result, droppedPaths } = collectSalvageDrops(() =>
      browserPageSchema.safeParse(page)
    )
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.portTunnelDescriptor).toBeUndefined()
      expect(result.data.url).toBe('http://127.0.0.1:5173/')
      expect(result.data.title).toBe('App')
      expect(result.data.browserRuntimeEnvironmentId).toBe(null)
    }
    expect(droppedPaths.some((p) => p.includes('portTunnelDescriptor'))).toBe(true)
  })

  it('strips a descriptor carrying lease/grant/socket data (strict) but keeps the page', () => {
    const page = {
      ...validPage(),
      portTunnelDescriptor: { ...validDescriptor, leaseId: 'lease-1' }
    }
    const result = browserPageSchema.safeParse(page)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.portTunnelDescriptor).toBeUndefined()
      expect(result.data.url).toBe('http://127.0.0.1:5173/')
    }
  })

  it('strips unknown top-level keys on a page without the descriptor (old client behavior)', () => {
    const page = {
      ...validPage(),
      futureUnknownField: 'stripped'
    }
    const result = browserPageSchema.safeParse(page)
    expect(result.success).toBe(true)
    if (result.success) {
      expect((result.data as Record<string, unknown>).futureUnknownField).toBeUndefined()
    }
  })

  it('mixed-version: old client strips the descriptor when loading a newer session', () => {
    // Why: an old build does not list portTunnelDescriptor in its schema, so
    // zod strips it. Simulate by parsing with a schema that omits the field.
    const oldClientSchema = browserPageSchema.omit({ portTunnelDescriptor: true })
    const page = validPage()
    const result = oldClientSchema.safeParse(page)
    expect(result.success).toBe(true)
    if (result.success) {
      expect((result.data as BrowserPage).portTunnelDescriptor).toBeUndefined()
      // Why: the page is still client-owned; an old build may show a normal
      // load failure for its loopback URL but must not attempt a new wire
      // feature. The explicit null environment id survives.
      expect(result.data.browserRuntimeEnvironmentId).toBe(null)
    }
  })

  it('mixed-version: new client loads an old session without the descriptor unchanged', () => {
    const oldSessionPage = {
      id: 'page-1',
      workspaceId: 'ws-1',
      worktreeId: 'wt-1',
      url: 'http://127.0.0.1:5173/',
      title: 'App',
      loading: false,
      faviconUrl: null,
      canGoBack: false,
      canGoForward: false,
      loadError: null,
      createdAt: 1
    }
    const result = browserPageSchema.safeParse(oldSessionPage)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.portTunnelDescriptor).toBeUndefined()
      expect(result.data.url).toBe('http://127.0.0.1:5173/')
    }
  })

  it('folder workspace: descriptor uses worktreeId only (no Git metadata)', () => {
    // Why: folder workspaces use a folderWorkspaceKey as worktreeId; the
    // descriptor validates against the page's worktreeId, not Git metadata.
    const folderDescriptor: BrowserPortTunnelDescriptor = {
      environmentId: 'env-1',
      worktreeId: 'folder::/path/to/folder',
      remoteOrigin: 'http://127.0.0.1:5173',
      remotePort: 5173
    }
    const page: BrowserPage = {
      ...validPage(),
      worktreeId: 'folder::/path/to/folder',
      portTunnelDescriptor: folderDescriptor
    }
    const result = browserPageSchema.safeParse(page)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.portTunnelDescriptor?.worktreeId).toBe('folder::/path/to/folder')
    }
  })
})

describe('browserWorkspaceSchema (unchanged by descriptor)', () => {
  it('still round-trips a workspace without a descriptor field', () => {
    const workspace = {
      id: 'ws-1',
      worktreeId: 'wt-1',
      url: 'http://127.0.0.1:5173/',
      title: 'App',
      loading: false,
      faviconUrl: null,
      canGoBack: false,
      canGoForward: false,
      loadError: null,
      createdAt: 1
    }
    const result = browserWorkspaceSchema.safeParse(workspace)
    expect(result.success).toBe(true)
  })
})
