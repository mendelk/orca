# Paired-runtime direct browser implementation handoff

Status: foundations implemented; production integration remains.

Last updated: 2026-08-19.

## Read this first

This document is the context-free continuation point for paired-runtime direct browser rendering.

The complete approved design is in [2026-08-15-paired-runtime-direct-browser-design.md](./2026-08-15-paired-runtime-direct-browser-design.md). That document defines the target architecture and acceptance criteria. This handoff records what the feature branch actually contains, what is not wired, and the safest next implementation order.

Do not infer feature completeness from the number of transport modules or tests. The branch contains substantial, tested foundations, but the desktop manager and browser controller are not instantiated by production code. No user can open a paired-runtime development server in a client-owned webview through this work yet.

## Repository state

- Upstream repository: `stablyai/orca`
- Fork: `mendelk/orca`
- Local fork checkout: `/Users/mendel/orca/projects/orca-fork`
- Feature branch: `feature/paired-runtime-direct-browser`
- Last integrated commit at handoff: `c8a05e7719`
- Push remote in the fork checkout: `origin`
- Upstream remote in the fork checkout: `upstream`
- Working tree was clean and synchronized with `origin/feature/paired-runtime-direct-browser` before this document was added.
- All temporary worker worktrees and model terminals were removed.

The original `/Users/mendel/orca/projects/orca` checkout is registered in Orca as a folder workspace. The fork checkout above is the Git repo registration used for this feature. Create future Orca worktrees from repo ID `5956c259-38de-4e08-a19f-b83c92c2bbac`, not from the original folder workspace.

## Problem

Browser pages associated with a paired remote runtime are currently owned by the runtime. The runtime launches Chromium, captures a screencast, and forwards synthetic input to it. That makes runtime-local development URLs reachable, but it produces lower-quality rendering and prevents the desktop from using Orca's normal local Electron webview and CDP feature path.

The chosen solution is:

1. Forward a small, runtime-verified set of workspace TCP listeners to exact loopback ports on the desktop.
2. Open eligible paired-runtime development URLs as client-owned browser pages with `browserRuntimeEnvironmentId: null` while retaining their remote workspace association.
3. Reuse the existing local Electron webview/CDP browser implementation.
4. Fall back to the existing host-owned screencast path when direct rendering cannot be established or drops.

Raw TCP is intentional. It preserves HTTP, HTTPS, SSE, WebSocket upgrades, and HMR bytes without rewriting application content, CSP, cookies, service workers, or JavaScript.

## Architectural boundaries

```text
Renderer browser controller
        |
        | opaque acquire/release/status API (not wired yet)
        v
Desktop main RuntimePortTunnelManager
        |
        | dedicated paired-runtime E2EE binary channel
        v
Runtime WorkspacePortTunnelSession
        |
        | authorized loopback TCP socket
        v
Remote development server
```

The control plane is ordinary runtime RPC. The data plane is a dedicated E2EE channel negotiated as `workspace-port-tunnel.v1`. Browser bytes never use JSON RPC or terminal stream opcodes.

The trust boundary is important:

- The renderer may identify a workspace and requested ports.
- The renderer must never receive or supply a grant ID, device token, connect host, PID, or runtime endpoint ID.
- The runtime performs a fresh metadata-required scan and derives exact authorized endpoints.
- The desktop main process owns grants, E2EE channels, local listeners, and opaque lease IDs.
- Local listeners bind only to `127.0.0.1`.

## Implemented foundations

### Design and wire contract

Commits:

- `2bab99d257` `docs: specify paired runtime direct browser`
- `7d5d476d38` `feat(runtime): define port tunnel wire protocol`

Implemented:

- Runtime capability `workspace-port-tunnel.v1` in `src/shared/protocol-version.ts`.
- Versioned binary frame codec in `src/shared/workspace-port-tunnel-protocol.ts`.
- Payload codecs and permanent opcodes for authorization, stream open, data, FIN, RESET, receive-window updates, and liveness.
- Per-stream state and credit primitives.
- Strict framing, stream ID, payload size, and memory bounds.
- No terminal opcode or existing RPC meaning was changed.

### Endpoint policy and authorization

Commits:

- `f565ac4878` `feat(runtime): add port tunnel endpoint policy`
- `6478a6b403` `feat(runtime): add port tunnel grant store`
- `93168b5168` `feat(runtime): authorize workspace port tunnels`

Implemented under `src/main/runtime-port-tunnel/`:

- Workspace-owned listener eligibility.
- Loopback/wildcard and custom-loopback DNS policy.
- Exact-port URL rewriting while preserving path, query, fragment, Host, cookies, and TLS SNI where possible.
- Selected versus companion endpoint ordering and limits.
- Exact-port binding policy.
- Cryptographically strong, one-use, expiring, device/runtime/workspace-bound grants.
- Globally unique endpoint IDs across grants on one runtime.
- Grant replay, expiry, capacity, device revocation, runtime revocation, and channel release handling.
- `workspacePortTunnels.authorize` runtime RPC.
- Runtime-side workspace resolution and metadata-required port scan.
- Runtime kill switch through `ORCA_RUNTIME_PORT_TUNNEL=0`.
- Mobile-scoped and unauthenticated callers are rejected.

Folder workspaces use runtime workspace resolution and do not require Git metadata.

### E2EE channel negotiation

Commit:

- `33b86ab1ef` `feat(runtime): negotiate port tunnel channels`

Implemented:

- Optional E2EE auth fields for `workspace-port-tunnel.v1` and one-use grant attachment.
- Legacy omitted-channel RPC/terminal behavior remains unchanged.
- Selected channel is echoed in the authenticated response.
- Direct and relay-v2 negotiation tests.
- Runtime-scoped device enforcement.
- Binary route isolation: tunnel bytes do not enter terminal multiplex handlers.
- Writable signaling and bounded retry support.

### Runtime host tunnel session

Commits:

- `4bbfda29fd` `feat(runtime): serve workspace port tunnels`
- `ca3fcacb0b` `refactor(runtime): split tunnel flow bookkeeping`
- `59dc62bf76` `refactor(runtime): isolate E2EE writable signal`

Implemented in `workspace-port-tunnel-session*.ts` and runtime RPC wiring:

- Session creation from authenticated initial grant descriptors.
- Grant extension authorization.
- Exact grant-derived TCP connect targets.
- Asynchronous connect success, refusal, timeout, cancel, and late-event suppression.
- `OPEN`, `OPENED`, `OPEN_ERROR`, `DATA`, `FIN`, `RESET`, `WINDOW_UPDATE`, `PING`, and `PONG` handling.
- Maximum 64 authorized endpoints and 64 active streams.
- 64 KiB DATA chunking.
- Per-stream and aggregate memory bounds.
- Bidirectional credit accounting and socket pause/resume.
- `socket.write(false)` drain accounting.
- Fair egress scheduling.
- Transport retry bounds and writable notification.
- FIN only after queued DATA is transport-accepted.
- Content-free protocol errors.
- Session-scoped grant release and teardown.
- Runtime RPC socket lifecycle integration.

### Desktop tunnel manager

Commit:

- `c8a05e7719` `feat(runtime): manage desktop port tunnels`

Implemented under `runtime-port-tunnel-*.ts`:

- Reference-counted exact-port listeners on `127.0.0.1`.
- Process-global local port reservations.
- Selected conflicts versus companion partial conflicts.
- One multiplexed channel per runtime environment.
- Opaque renderer-owner-scoped operation and lease bookkeeping.
- Concurrent acquisition deduplication and collision detection.
- Environment generation invalidation.
- Listener close-before-rebind behavior.
- Listener/channel/lease/stream bounds.
- DATA and reliable control-frame queues with transport retry.
- Credit-controlled chunking, inbound drain accounting, FIN ordering, RESET ordering, and fair scheduling.
- Atomic selected-plus-companion plan acquisition helper.
- Channel-drop, environment removal, renderer-owner, and shutdown cleanup foundations.

Important: `RuntimePortTunnelManager` currently appears only in its own modules and tests. Production main-process code does not instantiate it.

### Browser state and controller

Commits:

- `0b4e6f70e7` `feat(browser): persist remote port tunnel intent`
- `b5be4d128b` `feat(browser): orchestrate remote port tunnels`

Implemented:

- Strict persisted `BrowserPortTunnelDescriptor` with environment, worktree, remote origin, and remote port.
- Invalid optional descriptor data is stripped without dropping the browser tab.
- Lease IDs, grants, sockets, and local addresses are never persisted.
- `browserRuntimeEnvironmentId: null` remains explicit client ownership, including remote workspaces.
- URL translation preserves paths, queries, fragments, custom loopback hostnames, and external navigation.
- Pure actions for client-owned creation and host-owned fallback transition.
- Renderer controller interfaces for opaque acquire/release/status, browser store mutations, and remote fallback.
- Acquire-before-page-create and reacquire-before-restore-navigation behavior.
- Complete selected and companion lease tracking.
- Concurrent operation deduplication and collision-safe fingerprints.
- Stale async completion suppression.
- One-shot dropped-tunnel fallback without automatic promotion.
- Exactly-once lease release and best-effort orphan remote-handle cleanup.
- Bounded release-failure reporting and companion warnings.

Important: `BrowserPortTunnelController` currently appears only in its own modules and tests. Production renderer code does not instantiate it.

## Verified behavior

The latest combined desktop/host verification at `c8a05e7719` passed:

```text
25 test files
321 tests
pnpm typecheck:node
oxlint on tunnel and affected runtime files
pnpm check:max-lines-ratchet
git diff --check
```

The browser controller separately passed:

```text
119 focused renderer controller tests
pnpm typecheck
oxlint on browser-port-tunnel modules
pnpm check:max-lines-ratchet
git diff --check
```

Coverage includes:

- HTTP/TLS/WebSocket-shaped byte transport.
- Direct and relay-v2 E2EE negotiation.
- Connect refusal, timeout, late events, and post-connect failures.
- More-than-64-KiB chunking and exact byte order.
- Credit exhaustion, refill, `write(false)`, drain, and peer-window violations.
- Stream and channel overflow policy.
- Fair scheduling and bounded retry.
- FIN/RESET ordering under blocked transport.
- Grant replay, endpoint denial, extension, and teardown.
- Exact-port conflicts, concurrent acquisition, close-before-rebind, environment drop, and shutdown.
- Browser schema salvage, custom origins, folder workspaces, restore gating, stale async operations, companion warnings, and fallback races.

Not verified:

- A real paired-runtime desktop flow.
- Electron webview rendering through an actual local listener.
- Vite or Next.js HMR end to end.
- Real HTTPS certificates through the local listener.
- Real relay throughput/backpressure over a deployed relay.
- macOS, Windows, and Linux packaging/runtime matrices.
- Orca UI behavior or accessibility.

## What is not implemented

### Desktop main integration

There is no production owner that:

- Instantiates `RuntimePortTunnelManager`.
- Calls `workspacePortTunnels.authorize` for selected and companion ports.
- Opens the dedicated paired-runtime E2EE tunnel WebSocket.
- Converts grant endpoint descriptors into manager endpoint IDs without exposing them to the renderer.
- Adapts E2EE send/receive/writable events to `RuntimePortTunnelChannel`.
- Scopes `rendererOwnerId` from the invoking `webContents`, rather than trusting renderer input.
- Revokes all leases when that renderer is destroyed or reloaded.
- Maps environment pairing revisions and removal into manager cleanup.
- Owns startup and application-shutdown teardown.

### Preload IPC

There is no `RuntimePortTunnelApi` in `src/preload/`.

Still required:

- Narrow `acquire`, `release`, `status`, and `onStatusChanged` IPC.
- Opaque request/result types that contain workspace, ports, protocols, operation ID, lease IDs, local URL, and bounded warnings/errors.
- No grant IDs, endpoint IDs, pairing tokens, PIDs, paths, or connect hosts across the preload boundary.
- Sender ownership and idempotency enforced in main.

### Renderer production integration

Still required:

- Instantiate `BrowserPortTunnelController` with production adapters.
- Adapt the real browser Zustand store to `BrowserPageStorePort`.
- Adapt existing remote `browser.tabCreate` and close behavior to `RemoteBrowserFallbackPort`.
- Refactor `openWorkspacePortInBrowser` to choose direct versus screencast behavior.
- Run eligible paired-runtime opens through fresh scan, endpoint planning, acquire, then local page creation.
- Gate restored descriptor pages before the webview receives a source URL.
- Release leases on page close, ownership transition, renderer disposal, environment revision, and environment removal.
- Translate the last committed URL during fallback.

The existing `openWorkspacePortInBrowser` behavior remains the production path and still creates a host-owned remote browser page for paired runtimes.

### Browser rendering and UX

Still required:

- Connect client-owned tunnel pages to the existing `BrowserPagePane` webview path.
- Ensure no host remote handle is created on a healthy direct path.
- Add `Direct`, `Partial`, `Unavailable`, and `Dropped` states using the existing design system.
- Surface selected exact-port conflicts as direct-render blockers.
- Surface companion conflicts as partial warnings.
- Add explicit retry without automatic promotion.
- Preserve the tab with a bounded load error if remote fallback also fails.
- Add no new colors, font sizes, spacing, or shadows outside `docs/STYLEGUIDE.md` and `src/renderer/src/assets/main.css` tokens.

### System browser behavior

The existing system-browser setting has not been integrated with tunnel lease ownership. If implemented, a system-browser open may reuse an already active lease but must not create an unowned persistent tunnel.

### Observability and rollout

Still required:

- Content-free metrics from the design spec.
- Direct-versus-relay tunnel timing and byte counters.
- Listener/lease/stream/queue gauges.
- Partial and fallback reason telemetry.
- Desktop-side `ORCA_RUNTIME_PORT_TUNNEL=0` behavior that prevents acquisition, not only runtime capability publication.
- Stable-release kill-switch validation.

## Recommended continuation order

### 1. Define the production main adapter

Create a focused main-process owner around `RuntimePortTunnelManager`.

Responsibilities:

1. Receive workspace/port plans from IPC.
2. Resolve the runtime environment and check `workspace-port-tunnel.v1`.
3. Call `workspacePortTunnels.authorize` with the worktree selector and requested ports.
4. Open or reuse one E2EE tunnel data channel for that environment.
5. Attach the initial grant during E2EE auth and extension grants through `AUTHORIZE`.
6. Feed encrypted binary frames to/from `RuntimePortTunnelChannel`.
7. Acquire the selected listener first, then companions.
8. Return only opaque leases and the actual local origin/URL.
9. Own renderer/environment/application cleanup.

Keep the new owner under `src/main/runtime-port-tunnel/`; do not put tunnel behavior into generic runtime helpers.

### 2. Add preload IPC

Add a concrete runtime-port-tunnel preload API and declarations following existing narrow preload module conventions.

Security review points:

- Derive renderer ownership from IPC sender identity.
- Validate every input with strict schemas.
- Never accept connect host, grant ID, endpoint ID, device token, PID, or filesystem path from renderer.
- Bound endpoints, operations, listeners, and status subscriptions.
- Remove subscriptions and leases when the sender is destroyed.

### 3. Add production renderer adapters

Wire `BrowserPortTunnelController` without changing `BrowserPane` selection logic:

- A tunneled direct page has `browserRuntimeEnvironmentId: null` and follows local rendering.
- A fallback page has the remote environment ID and existing remote handle mapping.
- `portTunnelDescriptor` remains on fallback for explicit retry.

Do not persist live lease state.

### 4. Integrate port-open and restore flows

- Update the Ports panel action path first.
- Preserve system-browser behavior.
- Then add session restore gating before webview materialization.
- Finally connect page-close and environment lifecycle release.

This order gives a manually testable new-open path before changing restore behavior.

### 5. Add UX and Electron validation

Before UI edits, read `docs/STYLEGUIDE.md` and use existing shadcn primitives and canonical tokens.

Use the `electron` skill and Playwright CDP, as required by `AGENTS.md`.

Validate:

- Eligible open renders through a real local Electron webview.
- Existing grab, click, type, screenshot, annotation, find, viewport, download, and CDP paths work without tunnel branches.
- Selected conflicts use screencast fallback.
- Companion conflicts show partial state.
- Tunnel drop creates exactly one remote page and releases every local lease.
- Fallback failure retains the tab and descriptor.
- Restore never navigates before reacquire resolves.

### 6. Run end-to-end fixtures

Required fixtures:

- Plain HTTP.
- HTTPS with a local development certificate.
- Chunked response.
- SSE.
- WebSocket echo.
- Vite HMR.
- Next.js HMR.
- Split frontend/API companion ports.
- Large download concurrent with HMR.
- Folder workspace without Git.
- Direct paired transport.
- Cloud relay v2.
- New client/old runtime and old client/new runtime.
- SSH workspace regression, which must continue using `SshPortForwardManager`.

Run relevant platform coverage on macOS, Windows, and Ubuntu 20.04-compatible Linux.

## Constraints future work must preserve

- Mixed client/runtime versions are normal.
- Do not bump `RUNTIME_PROTOCOL_VERSION` for this capability-gated channel.
- Do not add or reuse terminal stream opcodes.
- Do not expose tunnel grants or endpoint IDs to renderer.
- Bind desktop listeners only to `127.0.0.1`.
- Do not silently remap the selected port.
- A companion conflict is partial; a selected conflict blocks direct mode.
- Keep all memory, stream, endpoint, listener, lease, and operation bounds.
- Preserve TCP half-close semantics.
- Preserve folder workspaces, SSH workspaces, relay transport, and cross-platform behavior.
- Do not assume Git is present for workspace resolution.
- Do not add max-lines disables or baseline exceptions.
- Do not add generic `helpers`, `utils`, `common`, or similarly vague modules.
- Do not add backward-compatibility branches without a concrete persisted or wire compatibility need.

## Known design decisions that should not be reopened casually

- Use client-owned Electron webviews for eligible desktop development URLs.
- Use byte-preserving raw TCP rather than an HTTP rewriting proxy.
- Keep the web client on screencast in Stages 1 and 2.
- Prefer exact same-port binding for selected and companion endpoints.
- Keep runtime endpoint authorization based on fresh workspace attribution.
- Keep browser profile/cookies local for direct pages; do not migrate host browser storage.
- Do not create a host-owned mirror during healthy direct rendering.
- Do not automatically promote a fallback screencast back to direct mode.

## Deferred Stage 3 scope

The following remains intentionally deferred:

- Plain cross-origin iframe preview in the web client.
- Same-origin rewriting proxy for web-client automation.
- Continuous publication of newly detected companion ports.
- SOCKS/private-DNS routing for runtime-internal services.
- Host-to-client browser cookie/session migration.

## Useful verification commands

Run from `/Users/mendel/orca/projects/orca-fork` or a future Orca worktree:

```bash
pnpm exec vitest run --config config/vitest.config.ts src/main/runtime-port-tunnel/*.test.ts src/main/runtime/rpc/mobile-socket-wiring.test.ts src/main/runtime/rpc/e2ee-channel*.test.ts src/main/runtime/remote-runtime-request-connection.integration.test.ts src/main/runtime/runtime-rpc-mobile-terminal-streaming.test.ts
pnpm typecheck:node
pnpm exec oxlint src/main/runtime-port-tunnel src/main/runtime/remote-runtime-request-connection.integration.test.ts src/main/runtime/runtime-rpc-mobile-terminal-streaming.test.ts
pnpm check:max-lines-ratchet
pnpm exec vitest run --config config/vitest.config.ts src/renderer/src/browser-port-tunnel
pnpm typecheck
pnpm exec oxlint src/renderer/src/browser-port-tunnel
git diff --check
```

The repository declares Node 24. Some work during this branch used a newer local Node and produced an engine warning; final CI must run on the repository-supported toolchain.

## Commit map

```text
2bab99d257 docs: specify paired runtime direct browser
f565ac4878 feat(runtime): add port tunnel endpoint policy
7d5d476d38 feat(runtime): define port tunnel wire protocol
6478a6b403 feat(runtime): add port tunnel grant store
93168b5168 feat(runtime): authorize workspace port tunnels
33b86ab1ef feat(runtime): negotiate port tunnel channels
0b4e6f70e7 feat(browser): persist remote port tunnel intent
b5be4d128b feat(browser): orchestrate remote port tunnels
4bbfda29fd feat(runtime): serve workspace port tunnels
ca3fcacb0b refactor(runtime): split tunnel flow bookkeeping
59dc62bf76 refactor(runtime): isolate E2EE writable signal
c8a05e7719 feat(runtime): manage desktop port tunnels
```

## Definition of done for the next milestone

The next milestone is complete only when a real paired runtime can serve a development page that:

1. Is opened from the Ports panel.
2. Acquires runtime-authorized exact-port reachability through main/preload IPC.
3. Renders in the desktop's existing local Electron webview path.
4. Maintains Vite and Next.js HMR WebSockets.
5. Uses existing local browser/CDP features without special cases.
6. Falls back exactly once to the existing remote screencast path on tunnel loss.
7. Releases all listeners, streams, channels, leases, subscriptions, and remote handles on every success, failure, close, revision, and shutdown path.
8. Passes mixed-version, folder-workspace, SSH-regression, relay, Electron, and platform validation.
