# Paired-runtime direct browser rendering

Status: proposed design for implementation.

Last updated: 2026-08-15.

Implementation handoff: [2026-08-19 paired-runtime direct browser handoff](./2026-08-19-paired-runtime-direct-browser-handoff.md).

## Decision summary

Orca will render eligible development servers from a paired remote runtime in a client-owned Electron `<webview>` instead of a host-owned screencast.

The work has two stages:

1. Add an authenticated raw-TCP tunnel from loopback listeners on the desktop client to workspace-attributed listeners on a paired runtime.
2. Open tunneled development URLs as client-owned browser pages while retaining their remote workspace association and falling back to the existing host-owned screencast path when direct rendering is unavailable.

This is approach A from the design discussion: relocate browser-page ownership to the client. It is preferred over a same-origin rewriting proxy because the target corpus is trusted development servers on a small number of known ports. A byte-preserving TCP tunnel supports HTTP, HTTPS, Server-Sent Events, and HMR WebSockets without rewriting HTML, JavaScript, CSP, cookies, or service-worker traffic.

The web client remains on screencast in this design. A cross-origin iframe and any same-origin rewriting proxy are separate Stage 3 decisions.

## Context

Today a browser page associated with a paired runtime is host-owned:

- `workspacePorts.scan` already discovers listeners on the runtime and attributes them to workspaces through `src/main/ports/local-workspace-port-scanner.ts` and `advertised-url-watcher.ts`.
- `openWorkspacePortInBrowser` creates the page through `browser.tabCreate` on the runtime and records a remote handle.
- `BrowserPane` sees a non-null `browserRuntimeEnvironmentId` and renders `RemoteBrowserPagePane`, which displays a host-side screencast and forwards synthetic input.
- The target URL can remain on the runtime's loopback interface because Chromium runs there.

The existing browser model also contains the seam needed for direct rendering:

- Browser ownership is per page, not per workspace.
- `browserRuntimeEnvironmentId: null` explicitly means client-owned even when the containing worktree belongs to a paired runtime.
- A client-owned page follows the normal `BrowserPagePane` and Electron `<webview>` path, including the local CDP bridge, grab, annotations, screenshots, find, downloads, viewport emulation, and browser-level input.

The missing substrate is reachability. A local Electron `<webview>` cannot connect to `localhost:5173` on the remote runtime without a tunnel.

## Goals

- Render a workspace-attributed development server from a paired runtime as a sharp, interactive local Electron `<webview>`.
- Preserve the existing local browser feature set by reusing the local page path instead of reimplementing browser automation.
- Carry ordinary HTTP, HTTPS, streaming responses, Server-Sent Events, and WebSocket upgrades without application-layer rewriting.
- Preserve the remote workspace association for tab placement, persistence, navigation, and agent context.
- Prefer the same local port number as the runtime port so Vite, Next.js, and similar HMR clients continue to work without configuration.
- Automatically include a bounded set of companion ports attributed to the same workspace.
- Keep tunnel access scoped to the authenticated runtime connection and to runtime-verified workspace listeners.
- Fail safely to the existing host-owned screencast path.
- Work for git worktrees and folder workspaces without assuming Git metadata.
- Preserve mixed-version behavior in both directions.

## Non-goals

- Rendering remote pages in an iframe in the Orca web client.
- A same-origin rewriting proxy or injected browser automation agent.
- General VPN, SOCKS, arbitrary destination, or arbitrary internet proxying.
- Migrating cookies, local storage, service workers, or login state from a host-owned browser profile to the desktop.
- Making client-side services such as databases directly reachable. Server-to-database traffic remains on the runtime host and is unaffected.
- Replacing SSH port forwarding. SSH workspaces continue to use `SshPortForwardManager` and the current local browser path.
- Guaranteeing direct rendering for pages that require runtime-private DNS names, runtime-private IP addresses, or browser-visible services Orca has not forwarded.
- Seamlessly preserving in-page state when ownership falls back from local rendering to a remote screencast.

## Product behavior

### Opening a detected port

For a workspace port owned by a paired runtime, the Ports panel's in-Orca open action behaves as follows:

1. Check that the runtime advertises `workspace-port-tunnel.v1`.
2. Ask the runtime for a fresh workspace port scan.
3. Verify that the selected row is still attributed to the same workspace and is eligible for tunneling.
4. Select eligible companion listeners from the same workspace, subject to the limits below.
5. Acquire local tunnel listeners, requiring the selected origin to bind its original port.
6. Create a browser page in the remote workspace with `browserRuntimeEnvironmentId: null` and persisted tunnel metadata.
7. Load the local tunnel URL in the normal Electron browser path.

The existing setting that chooses Orca's browser versus the system browser remains authoritative. Stage 2 changes only the in-Orca path. Opening in the system browser may reuse an already active tunnel, but it must not create an unowned persistent tunnel.

### Eligibility

A selected listener is eligible only when all of these are true:

- The runtime returned it from a fresh `workspacePorts.scan` call.
- Its `kind` is `workspace` and its owner is the selected workspace.
- Its port is in the valid TCP range.
- Its bind/connect address is loopback or wildcard, or its advertised custom hostname resolves to loopback on the client.
- Its protocol is `http` or `https`, or the user explicitly opened an `unknown` listener from the Ports panel.

Private and public IP literals are not rewritten into local addresses. They remain on the screencast path unless the same application also exposes a verified loopback listener.

Container and external listeners are excluded in Stages 1 and 2 because they lack a workspace ownership proof.

### Companion ports

When the selected port is opened, Orca also requests tunnels for up to 15 additional listeners that:

- have the same exact workspace owner;
- are loopback or wildcard listeners;
- were present in the same fresh scan; and
- use HTTP, HTTPS, or an advertised URL.

The selected origin has priority, followed by advertised URLs, then ascending port number. The total is capped at 16 endpoints per browser workspace.

Companions cover common split frontend/API/admin-UI setups. A companion that cannot bind its original local port is omitted and shown as a non-blocking warning. A conflict on the selected origin blocks direct rendering because silently choosing another port commonly produces a page that loads while HMR fails.

Stages 1 and 2 do not continuously rescan for newly started companion services. The browser's retry action performs a fresh scan and reacquires the set. Continuous runtime port publication can be considered separately if usage shows it is needed.

### User-visible states

- **Direct**: the page is client-owned and the tunnel is healthy. Browser chrome shows a small `Direct` indicator with the runtime name.
- **Partial**: the selected origin is direct, but one or more companion ports could not bind. The page remains usable and the indicator exposes the conflicting ports.
- **Unavailable**: capability missing, selected port stale, destination ineligible, authorization rejected, or selected local port occupied. Orca keeps or creates the current remote screencast page and explains why direct rendering was skipped.
- **Dropped**: an active tunnel transport disconnects. Existing tunneled sockets reset, then the page falls back to a host-owned screencast at its last committed URL.

Orca does not automatically promote a fallback screencast back to direct mode. The user retries explicitly, avoiding repeated ownership flips and loss of page state during an unstable connection.

## Architecture

```text
Desktop renderer
  Ports panel / browser restore
          |
          | acquire/release IPC
          v
Desktop main: RuntimePortTunnelManager
  127.0.0.1:<remote-port> listener(s)
          |
          | multiplexed encrypted binary channel
          | over the paired runtime endpoint
          v
Runtime: WorkspacePortTunnelSession
          |
          | bounded TCP sockets to authorized listeners
          v
  remote 127.0.0.1:<remote-port>

Desktop renderer
  remote workspace
    client-owned BrowserPage (`browserRuntimeEnvironmentId: null`)
          |
          v
  existing BrowserPagePane -> Electron <webview> -> local tunnel listener
```

The control plane uses ordinary runtime RPC. The data plane uses one dedicated E2EE WebSocket per runtime environment and multiplexes all tunnel sockets for that environment. It does not put browser bytes into JSON RPC or terminal stream opcodes.

## Stage 1: reachability substrate

### Runtime capability

Add `WORKSPACE_PORT_TUNNEL_RUNTIME_CAPABILITY = 'workspace-port-tunnel.v1'` to `src/shared/protocol-version.ts` and the runtime's status capabilities.

Clients must not attempt tunnel authorization or open a tunnel data channel unless the capability is present. An old client ignores the capability. A new client paired with an old runtime retains the current screencast behavior.

This does not bump `RUNTIME_PROTOCOL_VERSION`: it adds a method, an optional authentication field used only after capability detection, and a separate negotiated channel. It does not add an unnegotiated terminal stream opcode.

### Authorization RPC

Add `workspacePortTunnels.authorize` with this logical request:

```ts
type WorkspacePortTunnelAuthorizeRequest = {
  worktree: string
  endpoints: Array<{
    port: number
    expectedProtocol: 'http' | 'https' | 'unknown'
  }>
}
```

The runtime resolves `worktree` through its own selector logic, runs a metadata-required port scan, and intersects the request with listeners attributed to that resolved workspace. It never accepts a renderer-provided path, PID, bind host, or arbitrary destination.

The result contains:

```ts
type WorkspacePortTunnelGrant = {
  grantId: string
  expiresAt: number
  endpoints: Array<{
    endpointId: number
    port: number
    connectHost: string
    protocol: 'http' | 'https' | 'unknown'
  }>
}
```

Grant rules:

- Bind the grant to the authenticated device token, runtime instance, and resolved workspace.
- Allow at most 16 endpoints.
- Expire an unattached grant after 30 seconds.
- Consume the grant when one data channel attaches or extends its authorized endpoint set; it cannot be replayed on another channel.
- Keep authorization in memory only.
- Revoke it when the device is unpaired or the runtime stops.
- Permit only the exact endpoint IDs returned by the runtime.

The attached channel may remain alive after `expiresAt`; expiration limits replay, not a healthy session. Reauthorization is required after reconnect. A later browser lease creates a new grant and adds it to the existing environment channel through the protocol handshake below.

### Dedicated E2EE channel

Extend the existing E2EE authentication request with optional channel negotiation:

```ts
type RuntimeChannelOffer = {
  channel?: 'rpc' | 'workspace-port-tunnel.v1'
  tunnelGrantId?: string
}
```

Omitted `channel` means the existing RPC/terminal behavior. A tunnel client offers `workspace-port-tunnel.v1` and its grant ID. The runtime validates the capability, authenticated device, and grant before installing the tunnel binary handler. The encrypted `e2ee_authenticated` response must echo the selected channel. A mismatch closes the socket before any local connection is accepted.

Direct and cloud-relay transports use the same E2EE channel. Relay E2EE v2 remains mandatory where it is mandatory today. Browser bytes are encrypted end to end between desktop and runtime; the relay cannot inspect them.

### Binary protocol

Add `src/shared/workspace-port-tunnel-protocol.ts` with a versioned binary envelope:

```text
byte 0      protocol version (1)
byte 1      opcode
bytes 2-5   unsigned stream id, big endian
bytes 6-9   payload length, big endian
bytes 10..  payload
```

Version 1 opcodes are permanent:

| Opcode | Direction | Purpose |
| --- | --- | --- |
| `AUTHORIZE` | client -> runtime | Consume an additional grant on an existing channel |
| `AUTHORIZED` | runtime -> client | Confirm the grant's endpoint IDs are usable |
| `AUTHORIZE_ERROR` | runtime -> client | Reject an expired, replayed, or mismatched grant |
| `OPEN` | client -> runtime | Open one authorized endpoint ID |
| `OPENED` | runtime -> client | Remote TCP connection established |
| `OPEN_ERROR` | runtime -> client | Bounded error code; no host details |
| `DATA` | both | Raw TCP bytes |
| `FIN` | both | Half-close the sending side |
| `RESET` | both | Abort one stream |
| `WINDOW_UPDATE` | both | Return per-stream receive credit |
| `PING` / `PONG` | both | Application liveness when transport traffic is idle |

Protocol bounds:

- Maximum 64 active TCP streams per environment channel.
- Maximum 64 authorized endpoints and 32 active browser leases per environment channel.
- Maximum `DATA` payload of 64 KiB.
- Initial per-stream receive window of 256 KiB.
- Maximum 16 MiB queued across the channel and 1 MiB per stream.
- Round-robin writable-stream scheduling so one download cannot starve HMR or API traffic.
- Pause the source TCP socket when stream credit or the encrypted WebSocket outbound budget is exhausted; resume only after `WINDOW_UPDATE` and transport drain.
- Reset only the offending stream for an unknown endpoint, duplicate stream ID, invalid state transition, or per-stream overflow.
- Close the whole channel for invalid framing, unsupported version, aggregate overflow, repeated decrypt failure, or authorization mismatch.

TCP half-close semantics matter for streaming responses and WebSocket shutdown and must be preserved instead of mapping every close to `RESET`.

### Desktop tunnel manager

Add a focused `src/main/runtime-port-tunnel/` module set:

- `runtime-port-tunnel-manager.ts`: environment-scoped channels, listener reference counts, reconnect, and shutdown.
- `runtime-port-tunnel-listener.ts`: loopback TCP listener and local socket lifecycle.
- `runtime-port-tunnel-channel.ts`: E2EE negotiation, multiplexing, flow control, and grant attachment.
- `runtime-port-tunnel-protocol.ts`: main-side protocol state machine using the shared codec.
- `runtime-port-tunnel-url.ts`: safe host and port rewriting.

Expose narrow preload methods through a new runtime port-tunnel API:

```ts
type RuntimePortTunnelApi = {
  acquire(args: RuntimePortTunnelAcquireRequest): Promise<RuntimePortTunnelLease>
  release(args: { leaseId: string }): Promise<void>
  status(args: { leaseId: string }): Promise<RuntimePortTunnelStatus>
  onStatusChanged(callback: (event: RuntimePortTunnelStatusEvent) => void): () => void
}
```

An acquire call is idempotent for one renderer operation ID and returns only after the selected listener is bound and the runtime channel accepted its grant through initial authentication or `AUTHORIZE` / `AUTHORIZED`. The renderer receives opaque lease IDs, never pairing tokens or grant IDs.

### Local binding and URL policy

- Bind only to `127.0.0.1`; never bind `0.0.0.0`, `::`, a LAN interface, or a user-configurable external interface.
- Prefer and require `localPort === remotePort` for the selected endpoint.
- Rewrite loopback and wildcard origins to `127.0.0.1:<same-port>`.
- Preserve an advertised custom hostname only if local DNS resolves every address to `127.0.0.1`. Bind the same port there and use the custom hostname in the URL so Host headers, cookies, and TLS SNI remain correct.
- Reject custom names that resolve to non-loopback addresses; do not modify hosts files or DNS.
- Preserve path, query, and fragment from the URL being opened. The port scan's advertised URL remains an origin hint, not a replacement for later browser navigation.
- For companions, require the same port and skip conflicts. Never silently remap a companion and claim full compatibility.

Exact-port binding is a correctness requirement, not an optimization. Vite and similar clients frequently bake the served port into their HMR WebSocket URL. A random local port can make the document load while live reload silently fails.

### Lifecycle

- One multiplexed data channel per runtime environment, shared by all active leases.
- One local listener per unique environment/remote endpoint/local bind tuple, reference-counted across browser pages.
- Closing the last browser page lease closes its unreferenced listeners.
- Removing or re-pairing an environment immediately closes its channel, listeners, grants, and sockets.
- Renderer crash or reload releases renderer-owned leases. Main-process shutdown closes listeners before runtime transport teardown.
- A channel drop resets active TCP sockets. The manager may reconnect only for a new acquire/retry; it does not silently replay live TCP streams.
- Listener and channel maps have fixed bounds and LRU cleanup for completed operation IDs.

## Stage 2: client-owned desktop browser pages

### Persisted page intent

Add an optional descriptor to `BrowserPage` and `browserPageSchema`:

```ts
type BrowserPortTunnelDescriptor = {
  environmentId: string
  worktreeId: string
  remoteOrigin: string
  remotePort: number
}
```

The descriptor records intent, not a live resource. Lease IDs, grant IDs, local socket addresses, and connection state are never persisted.

An explicit `browserRuntimeEnvironmentId: null` remains the source of truth for page ownership. The tunnel descriptor explains how a client-owned page in a remote workspace regains reachability after restore.

Older builds strip the optional descriptor when loading session state. Because the same page is explicitly client-owned, an older build may show a normal load failure for its loopback URL; it must not attempt a new wire feature. New builds restore the tunnel before allowing the webview to navigate.

### Creation flow

Refactor `openWorkspacePortInBrowser` into an ownership decision followed by page creation:

- Local runtime target: unchanged local page behavior.
- Paired runtime with tunnel capability and eligible selected port: acquire tunnel, then create a client-owned page with the descriptor.
- Paired runtime without capability or failed acquire: use the existing `browser.tabCreate` plus remote handle path.

Do not create a host-owned mirror during the healthy direct path. That would double browser resource use and create two independent sessions that appear to be one page.

The client-owned page uses the local browser session-profile host ID. Cookies and storage therefore belong to the desktop profile by design. Runtime browser profiles and imported runtime cookies are not copied.

### Rendering and restore

`BrowserPane` continues to select rendering from `browserRuntimeEnvironmentId`:

- `null`: existing local `BrowserPagePane` and persistent Electron webview.
- runtime ID: existing `RemoteBrowserPagePane` and screencast.

Add a small tunnel lease controller around local-page materialization:

1. For a page with a tunnel descriptor, acquire or attach to its lease before setting the webview source.
2. Keep the ordinary browser loading state visible while authorization and binding complete.
3. On success, navigate to the resolved local URL.
4. Release the lease when the page closes, ownership changes, or its environment revision changes.
5. On session restore, run the same acquisition flow; never persist or assume a previous listener.

Inactive local webviews remain mounted under the existing retention rules. Hiding a page does not release its tunnel because doing so would terminate live HMR, SSE, and form state.

### Navigation and automation

Once direct rendering is active, all browser operations use the existing local APIs. No tunnel-specific branches are added to grab, click, type, screenshot, annotation, find, viewport, download, certificate, or CDP code.

Top-level navigation away from the tunneled origin is allowed and uses the desktop's normal network. The tunnel lease remains attached to the page until close so Back navigation and application subresources continue to work.

The address bar shows the browser's actual URL. For the normal same-port loopback case this matches the runtime URL except for wildcard normalization. The Direct indicator preserves provenance rather than teaching browser controls a second display URL.

### Fallback to screencast

Fallback is an ownership transition on the existing page:

1. Capture the page's last committed source URL, translating the local tunnel origin back to the descriptor's runtime origin.
2. Call `browser.tabCreate` on the owning runtime with that URL and the same workspace selector.
3. Store the returned remote handle for the existing page ID.
4. Set `browserRuntimeEnvironmentId` to the environment ID and clear the active tunnel lease.
5. Let `BrowserPane` destroy the persistent local webview and mount `RemoteBrowserPagePane` through its current branch.

If remote browser creation also fails, retain the page and show the existing load-error surface with both failure causes. Never close the user's tab because reachability failed.

Fallback triggers:

- selected listener cannot be rebound during restore;
- runtime rejects a renewed grant;
- environment pairing revision changes;
- the tunnel channel closes unexpectedly while the page is active; or
- local listener reports an unrecoverable error.

An individual upstream HTTP error does not trigger fallback. It is application behavior and should remain visible in the webview.

## Security model

The feature is a narrow port forward, not a general network proxy.

- Every data channel uses the existing paired-device E2EE identity.
- The runtime derives allowed workspaces and listeners from its own store and fresh process scan.
- Grants are short-lived, one-use, device-bound, runtime-bound, and memory-only.
- Data frames address numeric endpoint IDs, not hostnames or ports supplied after authorization.
- Local listeners bind only to loopback.
- Runtime sockets connect only to endpoints in the consumed grant.
- Mobile-scoped devices are denied `workspacePortTunnels.authorize`; the capability is desktop runtime scope only in Stages 1 and 2.
- Logs and telemetry contain runtime ID, counts, ports, byte totals, timings, and bounded error codes. They do not contain URLs with paths/query strings, headers, cookies, request bodies, response bodies, grant IDs, or device tokens.
- Tunnel traffic is trusted application traffic but remains subject to strict memory, stream, and connection bounds.

The local webview has the same security posture as an ordinary local Orca browser page. Direct rendering does not make a remote page same-origin with the Orca renderer.

## Remote wire compatibility

Mixed client/runtime versions are expected:

| Client | Runtime | Behavior |
| --- | --- | --- |
| Old | New | Ignores `workspace-port-tunnel.v1`; existing remote screencast behavior |
| New | Old | Capability absent; existing remote screencast behavior |
| New | New | Tunnel eligible ports; fallback to screencast on any negotiation failure |
| Web client | Any | Existing screencast behavior; never offers the tunnel channel |

Compatibility requirements:

- Do not change existing `workspacePorts.scan`, browser RPC, screencast, or terminal stream meanings.
- Do not reuse a terminal stream opcode.
- The new E2EE authentication fields are optional and are sent only on a fresh, capability-gated tunnel socket.
- Require the runtime to echo the selected tunnel channel before sending binary data.
- Add a current/newest-release cross-version test for status capability detection and both skew directions. The existing terminal wire test remains unchanged because this is a separate protocol.
- Relay routing must preserve encrypted binary frames without understanding tunnel opcodes.

## Cross-platform, SSH, and folder workspaces

- macOS, Linux, and Windows use Node `net.Server`/`net.Socket`; no shell command or platform-specific forwarding binary is introduced.
- Binding, DNS checks, and socket errors use Node APIs. Paths use existing worktree selectors and `path` utilities; no path is sent in tunnel authorization.
- Windows firewalls must not receive a public-listener prompt because listeners bind only to `127.0.0.1`.
- Runtime listener discovery retains the existing Linux, macOS, and Windows scanner implementations and their timeout/backoff behavior.
- Folder workspaces are eligible when `workspacePorts.scan` attributes the listener to their resolved workspace ID. Authorization must use runtime workspace resolution and must not require a Git repository or branch.
- SSH workspaces remain unchanged. Their established `SshPortForwardManager` path already provides a local TCP listener and local webview. Shared URL-policy tests should cover both managers, but the runtime tunnel must not route through SSH shell preferences or relay commands.
- WSL behavior remains whatever execution host owns `workspacePorts.scan`; native Windows and each remote runtime keep separate tunnel managers and capability state.

## Failure behavior

| Failure | Required result |
| --- | --- |
| Capability absent | Open the existing remote screencast page |
| Fresh scan unavailable | Keep screencast; surface the scanner's bounded reason |
| Selected port no longer owned by workspace | Reject authorization and keep screencast |
| Selected local port occupied | Keep screencast and identify the local conflict |
| Companion local port occupied | Continue direct mode with a partial warning |
| Grant expires before attach | Reauthorize once; then keep screencast |
| E2EE channel mismatch | Close channel before accepting local sockets; keep screencast |
| One remote TCP connect fails | Reset that stream; preserve other streams and listener |
| One stream exceeds bounds | Reset that stream; preserve channel |
| Channel exceeds aggregate bounds or framing is invalid | Close channel and fall back affected pages |
| Runtime or relay disconnects | Reset sockets, close listeners, and fall back when control RPC is available |
| Fallback browser creation fails | Keep tab with a load error; do not discard page metadata |
| Renderer reloads | Main releases orphaned leases; restored pages reacquire from descriptors |

## Observability

Add content-free metrics for:

- authorization attempts, eligible endpoint count, rejection code, and scan latency;
- selected and companion exact-port bind success/conflict;
- channel authentication and ready latency by direct versus relay transport;
- active listeners, leases, streams, queued bytes, flow-control pauses, and resets;
- bytes in/out and stream duration aggregated per tunnel session;
- direct-render creation, restore, partial mode, fallback reason, and fallback success;
- HMR-shaped WebSocket upgrade survival in E2E tests, not production payload inspection.

No metric or log may capture tunneled content or full URLs.

## Verification matrix

### Protocol and security

- Codec round trips and rejects truncated, oversized, unknown-version, and invalid-state frames.
- Grant is exact-workspace, exact-device, exact-runtime, one-use, expiring, and bounded to 16 endpoints.
- A forged endpoint ID, replayed grant, wrong device, mobile-scoped token, and stale runtime revision are rejected.
- Unknown tunnel auth fields remain harmless to old peers because new clients never send them without the runtime capability.
- Direct and relay E2EE channels carry binary data without exposing plaintext to relay routing.

### Flow control and lifecycle

- HTTP request/response, chunked response, SSE, WebSocket echo, TLS passthrough, and TCP half-close work through one listener.
- A large download cannot starve a concurrent HMR stream or small API request.
- Per-stream and aggregate bounds pause sockets and recover after drain without unbounded buffering.
- Channel loss resets all streams and releases memory.
- Acquire is idempotent, listeners are reference-counted, renderer teardown releases leases, and environment removal leaves no listener.
- Reconnect requires a new grant and never replays an existing TCP stream.

### Browser behavior

- Opening an eligible paired-runtime port creates a page with `browserRuntimeEnvironmentId: null`, no remote handle, and a tunnel descriptor.
- The page renders through an Electron webview and existing CDP automation can snapshot, click, type, grab, annotate, find, emulate a viewport, and take screenshots.
- Vite and Next.js fixtures retain HMR WebSocket connectivity on the same port.
- A selected-port conflict uses screencast rather than an alternate port.
- Companion conflict shows partial mode while the selected page remains direct.
- Restore reacquires before navigation; close and ownership transition release the lease.
- Tunnel drop creates one remote page, updates ownership once, and renders through the existing screencast path.
- Fallback failure retains the browser tab and persisted descriptor.

### Compatibility and platforms

- New client/old runtime and old client/new runtime both retain screencast behavior.
- Web client behavior is unchanged.
- macOS, Windows, and Ubuntu 20.04-compatible builds pass loopback bind, exact-port conflict, DNS-loopback, HTTP, TLS, and WebSocket tests.
- Folder workspace attribution and authorization pass without Git metadata.
- SSH port forwarding tests remain unchanged and local SSH browser opens do not use the runtime tunnel.
- Relay tests cover disconnect, backpressure, binary-frame bounds, and billed connection cleanup.

## Acceptance criteria

Correctness:

- An eligible paired-runtime dev server opens in a client-owned Electron webview and passes the existing local browser parity suite.
- Vite and Next.js fixture HMR remains connected for at least five minutes and across ten source updates.
- HTTP, HTTPS, WebSocket, SSE, and half-close fixtures preserve bytes end to end.
- No selected origin is silently remapped to a different local port.
- Every failed direct-render attempt has a working screencast fallback or a retained tab with an actionable error.

Isolation and security:

- No local listener binds beyond loopback.
- The runtime cannot be used to reach an endpoint absent from the consumed workspace grant.
- Tunnel memory and stream counts remain within the stated bounds under a stalled receiver and a 1 GiB transfer.
- Revoking a device or replacing an environment closes its tunnel channel and listeners immediately.

Compatibility:

- Both mixed-version directions pass.
- Existing terminal, browser screencast, workspace port scan, SSH forward, folder workspace, and web-client tests remain green.
- No `RUNTIME_PROTOCOL_VERSION` bump and no terminal stream opcode change are required.

Performance:

- Median tunnel overhead for a 1 KiB local HTTP response is below 15 ms beyond the paired transport's baseline round-trip time on a direct connection.
- Sustained transfer reaches at least 80% of the underlying paired transport throughput without renderer long tasks attributable to tunneling.
- HMR messages are not delayed more than 100 ms by a concurrent bulk transfer after the transport itself is writable.

## Rollout

### Stage 1 exit

- Capability, authorization RPC, grant store, dedicated data channel, codec, flow control, desktop manager, preload API, and lifecycle tests are complete.
- A test client can tunnel HTTP, HTTPS, WebSocket, and SSE fixtures by acquiring a lease directly.
- Direct, relay, mixed-version, memory-bound, and teardown gates pass.
- No browser ownership behavior changes yet.

### Stage 2 exit

- Eligible Ports panel opens use client-owned pages by default on desktop.
- Browser persistence, restore, local profile ownership, indicators, partial companion state, and fallback are complete.
- Local browser parity and HMR acceptance gates pass on macOS, Windows, and Linux.
- Web client and SSH behavior remain unchanged.

Ship behind `ORCA_RUNTIME_PORT_TUNNEL=0` as a desktop/runtime kill switch for one stable release. The switch disables capability publication on the runtime and direct-render acquisition on the desktop, forcing existing screencast behavior without changing stored browser sessions. A page restored while the switch is off follows the normal fallback transition.

## Deferred Stage 3 decisions

The following are deliberately excluded rather than unresolved:

- A plain cross-origin iframe for human-only web-client preview.
- A same-origin rewriting proxy for capable web-client automation.
- Continuous publication of newly detected companion ports.
- SOCKS or private-DNS routing for browser-visible runtime-internal services.
- Cross-host browser cookie/session migration.

Each changes the security or correctness envelope and should be designed from usage evidence after Stages 1 and 2 are stable.
