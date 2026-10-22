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
the host adapter. `useExtMediaUrl(path)` fetches media through that adapter and returns a blob
URL, which is revoked when the path changes or the view unmounts.

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
