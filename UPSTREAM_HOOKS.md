# Upstream hooks

Every upstream file this fork touches, with a one-line reason. New host-owned files (for example
`packages/extension-sdk/**`, `apps/web/src/extensions/**`, `apps/server/src/extensions/**`) are not
hooks and are not listed. Keep each hook small: call into a host-owned module.

| File                                                     | Reason                                                                        |
| -------------------------------------------------------- | ----------------------------------------------------------------------------- |
| .gitignore                                               | Ignore host-local `t4.extensions.json` and `t4.branding.json`.                |
| pnpm-lock.yaml                                           | Workspace link for `@t3tools/extension-sdk` (generated).                      |
| apps/web/package.json                                    | Depend on `@t3tools/extension-sdk`.                                           |
| apps/server/package.json                                 | Depend on `@t3tools/extension-sdk`.                                           |
| apps/desktop/package.json                                | Depend on `@t3tools/extension-sdk`.                                           |
| apps/server/src/server.ts                                | Register the scoped extension host and its authenticated HTTP routes.         |
| packages/shared/src/devProxy.ts                          | Proxy extension requests through Vite, preserving cookie mutation origins.    |
| apps/web/vite.config.ts                                  | Register the generic extension list plugin.                                   |
| apps/web/src/components/sidebar/SidebarChrome.tsx        | Add the workspace menu when extension workspace slots exist.                  |
| apps/web/src/components/AppSidebarLayout.tsx             | Mount extension navigation and workspace outlet.                              |
| apps/web/src/rightPanelStore.ts                          | Persist namespaced extension surfaces and discard removed slots on rehydrate. |
| apps/web/src/components/RightPanelTabs.tsx               | Add extension launcher entries, labels and retained panel views.              |
| apps/web/src/reopenClosedView.ts                         | Reopen a closed extension panel through the same store action.                |
| apps/web/src/components/settings/SettingsSidebarNav.tsx  | List extension settings slots.                                                |
| apps/web/src/routes/settings.tsx                         | Render extension settings in the scoped settings outlet.                      |
| packages/client-runtime/package.json                     | Export the authenticated extension HTTP request module.                       |
| packages/client-runtime/src/state/environmentHttpAuth.ts | Support authenticated extension URLs alongside typed API groups.              |
