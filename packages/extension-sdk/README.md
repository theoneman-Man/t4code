# Extension SDK

An extension imports host APIs only from `@t3tools/extension-sdk`. The host Vite plugin replaces
that entry with its web runtime and deduplicates the SDK, React and React DOM. Node tooling uses
the pure `manifest`, `node` and `protocol` subpaths.

The web entry default-exports an `ExtensionModule` with `id` matching the manifest and `sdk: 1`.
It may re-export that object from another file. The generated registry statically imports each
entry, so keep entries small. Wrap views in `React.lazy(() => import("./View"))`, as the fixture
does, and import CSS from the lazily loaded view module. The host renders every slot inside
`Suspense`. Slots may be imported or computed arrays. Slot IDs are
unique within an extension. Addresses passed to `openWorkspace` and `openPanel` are
`<extension id>:<slot id>`; `openWorkspace("chat")` restores chat.

Workspace URLs retain the chat pathname and search, with `#ext-workspace=<encoded address>`.
Settings slots use `/settings/general#ext-settings=<encoded address>`, sharing the settings
scope and authenticated outlet. The router manages reload and back/forward history. Removing
a workspace or settings slot restores the underlying host view. Removed panel slots are
discarded when persisted tabs rehydrate.

`useExtFetch()` accepts a backend path starting with `/`. The host adds `/ext/<extension id>`
and sends the request through the selected environment's authenticated HTTP machinery, including
cookie credentials, bearer credentials, relay renewal and DPoP proofs. Credentials stay inside
the host adapter. `useExtMediaUrl(path)` returns a shared signed media URL, refreshed before expiry. Use it with
`<img loading="lazy">` so the browser can cache and defer the download. If URL issuance fails,
the hook falls back to an authenticated blob download. Signed URLs serve images only; SVG and non-image responses are refused.

`useExtEvents(topic, callback)` shares one authenticated streaming-fetch connection per extension
and environment. Events have `{ topic, cursor, data }`. Every subscriber receives `reset`, even
when subscribed to another topic; reload that view's state on reset. Reconnects use bounded
backoff and the last SSE cursor. The last unsubscribe stops the connection. A hidden keepAlive
view remains subscribed, and receives `active={false}` so expensive visual work can pause.

Scope CSS under `.t4-ext-<extension id>` and use a named `@layer ext-<extension id>`. SDK popup
wrappers carry that class as well. Do not write global selectors. Backend starting, restarting,
failed and stopped states display a status message with a refresh action. Render errors are
contained at each slot boundary. The host also refreshes backend status when an event stream
reconnects or a proxied request returns 503.

## Backend launch protocol v1

The host launches `backend.command` with `T4_EXT_ID`, `T4_EXT_PORT`, `T4_EXT_TOKEN`,
`T4_EXT_DATA_DIR` and `T4_EXT_INSTANCE`. The backend binds to loopback and answers
`GET /.t4/ready` with `{ protocol: 1, extensionId, instanceId, dataDir }` within 60 seconds.
Every request requires the private per-launch bearer.

On stop, including update suspension and host quit, the host first sends `POST /.t4/shutdown`
with that bearer. This optional step does not change protocol v1. A backend can acknowledge
with a successful status such as `202`, stop workers, flush state, release ownership and exit.
The host allows up to 5 seconds total for the request and process exit, then uses its existing
process-tree termination. Unsupported routes, unsuccessful statuses and connection errors fall
back immediately. Redirects are rejected so the bearer stays at the launched endpoint.
Backends without this route continue to work. Windows process-tree termination cannot deliver
SIGTERM, so backends that need clean finalization should implement the HTTP step.

Development source hosts watch each owned backend's extension folder and debounce changes for
750 ms. Packaged hosts never subscribe. Set optional SDK 1 field `backend.watch` to a non-empty
array of relative directories or globs to select backend sources (for example
`["runtime", "shared/**/*.ts"]`); web sources served by Vite can be left out. Dependencies,
build output, data directories, logs and the resolved backend data directory are ignored.
A planned reload uses the same graceful shutdown, waits for exit and repeats readiness without
spending the crash retry budget. Desktop owns this watcher when it owns the child; borrowed
servers do not watch or restart it.

Backends may implement authenticated `GET /.t4/busy` returning `{ busy: boolean, reason?: string }`.
Report active work that a restart would interrupt, with a short reason; human gates can be idle.
A busy reply keeps one pending reload, rechecks every 3 seconds and logs the reason once.
Additional edits join that pending reload. HTTP 404/405 means unsupported and reloads immediately
after the debounce. Other probe failures defer until the endpoint responds again. Reload logs
include the number of distinct changed files. This endpoint is optional in protocol 1.

## Typechecking an external folder

Given a host checkout at `C:/dev/host` and an extension at any other location, use this exact
`tsconfig.json`, replacing `C:/dev/host` with the host checkout's absolute path:

```json
{
  "extends": "C:/dev/host/packages/extension-sdk/tsconfig.json",
  "include": ["web"]
}
```

Run `C:/dev/host/node_modules/.bin/tsc-rs --noEmit -p tsconfig.json` from the extension folder.
The SDK tsconfig supplies paths for `@t3tools/extension-sdk`, `react` and `react/jsx-runtime`,
and resolves Node types from the host. Inherited paths resolve relative to that SDK config,
so they work regardless of the extension folder's location.
On PowerShell use `tsc-rs.cmd`. This uses the SDK's UI prop contract and the host's React types;
it resolves React types from the SDK's own dependencies and does not require installing host
packages into the extension. Extension-specific dependencies
resolve from the extension's own `node_modules`. The sample's own tsconfig uses the same mappings
with relative paths and is checked with
`tsc-rs --noEmit -p packages/extension-sdk/fixtures/sample/tsconfig.json` from the host checkout.

## Extension threads

Add `"permissions": ["threads"]` to the manifest to enable the reserved host routes under
`/ext/<id>/.t4/threads`. Browser requests require the environment's read or operate scope.
Backends use their current `T4_EXT_TOKEN` bearer, which grants access only to their extension's
owned threads. This bearer does not grant arbitrary RPC or access to other threads.

`useExtThreads()` returns `launchThread({ projectId?, title, prompt, instructions?, idempotencyKey, media? })`,
`sendToThread(threadId, text, media?)`, `readThread(threadId, { after? })`,
`subscribeThread(threadId, onEvent)` and `openThread(threadId)`.
Launch returns a thread ID. Reusing a key with the same input returns the same thread;
changing its input returns 409. Receipts survive host restarts. Omitting `projectId` uses the
host's scratch project. The project's effective default model must be configured. Launches
require approvals. Optional instructions precede the prompt in the initial message.
`media` accepts up to 24 `{ path, name?, mimeType? }` references to absolute extension backend
GET paths, including version queries. The timeline loads thumbnails and opens the original on
click. Media stays on the backend; the host stores references and returns them in `messages[].media` with their owning `messages[].extensionId`.

Read returns at most 100 conversation items, the orchestration status or `archived`,
and an opaque `after` cursor for the next page. A subscription uses the existing SDK event
stream machinery with reconnect and cursor replay. It returns an unsubscribe function.
Events have topic `thread:<threadId>` and data `{ threadId, type }`; they invalidate the read
result. Reread without `after` to refresh streaming messages. Provider/tool payloads stay in
orchestration. `openThread` verifies ownership and navigates within the bound environment.

Backends import `createBackendThreadClient` from `@t3tools/extension-sdk/node` or
`@t3tools/extension-sdk/threads`. Create it with `{ hostUrl, extensionId, token }`, taking
`hostUrl` from the host-supplied `x-t4-thread-host` proxy request header and `token` from
`T4_EXT_TOKEN`. It exposes launch, send and read. Persist the thread ID in your own state;
when an event needs attention, call `sendToThread(threadId, text)`. Refresh the host URL on
subsequent proxied requests because the host may restart on a different port.

## Host branding

Copy `t4.branding.example.json` to the gitignored root `t4.branding.json` and supply your own assets.
Restart the build or dev process after changing it. Missing config preserves upstream identity and appearance.
`appName` and `stageLabel` form the display name; `appId`, `scheme`, and `homeDirName` separate native identity,
Electron profiles and default data. Explicit `T3CODE_HOME`, `--home-dir` and
`T3CODE_DESKTOP_APP_USER_MODEL_ID` overrides keep precedence. Development uses `.dev` on the app id and
`-dev` on the protocol. Assets and optional CSS resolve relative to the config; tokens and extra CSS run in
`@layer host-branding`. Tokens take precedence over upstream theme defaults. Use a PNG favicon for native window/tray icons
and macOS/Linux artifact icons; an ICO logo or favicon can supply the Windows artifact icon. Packaged apps
carry the resolved identity and assets and do not need the local config file.
