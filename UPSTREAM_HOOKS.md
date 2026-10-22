# Upstream hooks

Every upstream file this fork touches, with a one-line reason. New host-owned files (for example
`packages/extension-sdk/**`, `apps/web/src/extensions/**`, `apps/server/src/extensions/**`) are not
hooks and are not listed. Keep each hook small: call into a host-owned module.

| File                                                     | Reason                                                                                        |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| .gitignore                                               | Ignore host-local `t4.extensions.json` and `t4.branding.json`.                                |
| pnpm-lock.yaml                                           | Workspace link for `@t3tools/extension-sdk` (generated).                                      |
| apps/web/package.json                                    | Depend on `@t3tools/extension-sdk`.                                                           |
| apps/server/package.json                                 | Depend on `@t3tools/extension-sdk`.                                                           |
| apps/desktop/package.json                                | Depend on `@t3tools/extension-sdk`.                                                           |
| apps/server/src/server.ts                                | Register the scoped extension host and its authenticated HTTP routes.                         |
| packages/shared/src/devProxy.ts                          | Proxy extension requests through Vite, preserving cookie mutation origins.                    |
| apps/web/vite.config.ts                                  | Register the extension list and optional host branding plugins.                               |
| apps/web/src/components/sidebar/SidebarChrome.tsx        | Add the workspace menu and optional host-owned sidebar brand.                                 |
| apps/web/src/components/AppSidebarLayout.tsx             | Mount extension navigation and workspace outlet.                                              |
| apps/web/src/rightPanelStore.ts                          | Persist namespaced extension surfaces and discard removed slots on rehydrate.                 |
| apps/web/src/components/RightPanelTabs.tsx               | Add extension launcher entries, labels and retained panel views.                              |
| apps/web/src/reopenClosedView.ts                         | Reopen a closed extension panel through the same store action.                                |
| apps/web/src/components/settings/SettingsSidebarNav.tsx  | List extension settings slots.                                                                |
| apps/web/src/routes/settings.tsx                         | Render extension settings in the scoped settings outlet.                                      |
| packages/client-runtime/package.json                     | Export the authenticated extension HTTP request module.                                       |
| packages/client-runtime/src/state/environmentHttpAuth.ts | Support authenticated extension URLs alongside typed API groups.                              |
| packages/contracts/src/desktopBootstrap.ts               | Carry the optional private extension list, backend descriptors and launch failures.           |
| apps/server/src/config.ts                                | Retain the private extension handoff in server-only configuration.                            |
| apps/server/src/cli/config.ts                            | Read the extension handoff from the existing desktop bootstrap envelope.                      |
| apps/desktop/src/backend/DesktopBackendConfiguration.ts  | Resolve app-owned extension descriptors for every local backend start; disable WSL ownership. |
| apps/desktop/src/app/DesktopShutdown.ts                  | Stop registered extension owners before acknowledging app shutdown.                           |
| apps/desktop/vite.config.ts                              | Embed optional host identity at bundle time.                                                  |
| apps/desktop/src/app/DesktopAssets.ts                    | Prefer configured native icons without changing upstream fallback.                            |
| apps/desktop/src/app/DesktopEarlyElectronStartup.ts      | Separate early Linux WM class and desktop entry identity.                                     |
| apps/desktop/src/app/DesktopEnvironment.ts               | Apply the configured display name and native app identity.                                    |
| apps/desktop/src/app/DesktopStatePaths.ts                | Use the host home name only when no explicit home exists.                                     |
| apps/desktop/src/app/DesktopUserData.ts                  | Isolate branded Electron profiles without migrating upstream credentials.                     |
| apps/desktop/src/electron/ElectronProtocol.ts            | Register and serve the configured desktop protocol schemes.                                   |
| apps/web/src/branding.ts                                 | Resolve optional host identity through the existing branding seam.                            |
| packages/contracts/src/ipc.ts                            | Allow host stage labels in the existing desktop branding payload.                             |
| scripts/build-desktop-artifact.ts                        | Apply host product name, bundle id, protocols and staged icons.                               |

| apps/server/vite.config.ts | Embed the same host identity in packaged server URL helpers. |
| apps/server/src/httpCors.ts | Trust the configured desktop renderer origins. |
| packages/shared/src/providerAuthReturnUrl.ts | Validate branded desktop sign-in return URLs. |
| packages/shared/src/codexAuthHandoff.ts | Generate and validate the configured Codex sign-in handoff scheme. |

## General fixes

| File                                                                         | Reason                                                                              |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| apps/server/src/provider/Drivers/CodexExecutable.ts                          | Discover the current Windows desktop CLI while preserving custom binaries.          |
| apps/server/src/provider/CodexProvider.ts                                    | Resolve the executable at the shared probe/session spawn boundary.                  |
| apps/server/src/provider/CodexProvider.test.ts                               | Reproduce missing Windows discovery and cover newest executable selection.          |
| apps/server/src/project/RepositoryIdentityResolver.test.ts                   | Prove upstream already caches negative Git roots, expiry and explicit refresh.      |
| packages/effect-codex-app-server/src/_internal/stdio.ts                      | Attach an allowlisted startup diagnostic to process exit errors.                    |
| packages/effect-codex-app-server/src/client.ts                               | Classify bounded stderr and stop waiting for inherited pipes after parent exit.     |
| packages/effect-codex-app-server/src/errors.ts                               | Render safe memory/thread failure guidance without publishing stderr.               |
| packages/effect-codex-app-server/src/client.test.ts                          | Reproduce missing diagnostics and verify inherited stderr cannot stall termination. |
| packages/effect-codex-app-server/test/fixtures/codex-app-server-mock-peer.ts | Exercise a real startup failure containing private diagnostic text.                 |
