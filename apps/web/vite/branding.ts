// @effect-diagnostics nodeBuiltinImport:off - Vite reads local branding assets synchronously during build hooks.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { Plugin } from "vite-plus";
import { loadHostBranding } from "@t3tools/extension-sdk/branding/node";
import { resolveHostAppBranding, type HostBranding } from "@t3tools/extension-sdk/branding";

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

export function brandingPlugin(config: HostBranding | null = loadHostBranding()): Plugin {
  const cssId = NodePath.resolve("host-branding.css");
  let building = false;
  let development = false;
  const references = new Map<string, string>();
  return {
    name: "host-branding",
    config: () => ({
      define: {
        __T4_HOST_BRANDING__: JSON.stringify(
          config
            ? {
                ...config,
                logo: config.logo ? "host-logo" : undefined,
                favicon: undefined,
                css: undefined,
              }
            : null,
        ),
      },
      server: config
        ? {
            fs: {
              allow: [
                process.cwd(),
                ...[config.logo, config.favicon, config.css].flatMap((file) =>
                  file ? [NodePath.dirname(file)] : [],
                ),
              ],
            },
          }
        : {},
    }),
    configResolved(resolved) {
      building = resolved.command === "build";
      development = !resolved.isProduction;
    },
    buildStart() {
      if (!building || !config) return;
      for (const file of [config.logo, config.favicon]) {
        if (file)
          references.set(
            file,
            this.emitFile({
              type: "asset",
              name: NodePath.basename(file),
              source: NodeFS.readFileSync(file),
            }),
          );
      }
    },
    resolveId(id) {
      if (id === "/@host-branding.css") return cssId;
    },
    load(id) {
      if (id !== cssId || !config) return;
      const imports = config.css
        ? `@import ${JSON.stringify(config.css.replaceAll("\\", "/"))} layer(host-branding);\n`
        : "";
      const tokens = Object.entries(config.tokens ?? {})
        .map(([key, value]) => `${key}:${value.replace(/\s*!important\s*$/, "")} !important;`)
        .join("");
      return `${imports}@layer host-branding { :root { ${tokens} } }`;
    },
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        if (!config) return html;
        const branding = resolveHostAppBranding(
          {
            baseName: "T3 Code",
            stageLabel: development ? "Dev" : "Beta",
            displayName: "T3 Code (Beta)",
          },
          config,
        );
        const assetUrl = (file: string) => {
          if (!building) return `/@fs/${file.replaceAll("\\", "/")}`;
          const referenceId = references.get(file);
          return `__VITE_ASSET__${referenceId}__`;
        };
        html = html
          .replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(branding.displayName)}</title>`)
          .replaceAll('alt="T3 Code"', `alt="${escapeHtml(branding.baseName)}"`)
          .replaceAll(
            'aria-label="T3 Code splash screen"',
            `aria-label="${escapeHtml(branding.baseName)} splash screen"`,
          );
        if (config.favicon) {
          const favicon = escapeHtml(assetUrl(config.favicon));
          html = html
            .replace(/<link rel="icon"[^>]*>/, `<link rel="icon" href="${favicon}" />`)
            .replace(
              /<link rel="apple-touch-icon"[^>]*>/,
              `<link rel="apple-touch-icon" href="${favicon}" />`,
            )
            .replace(/<link rel="manifest"[^>]*>/, "");
        }
        if (config.logo) {
          const logo = escapeHtml(assetUrl(config.logo));
          html = html
            .replace('src="/apple-touch-icon.png"', `src="${logo}"`)
            .replace(
              "</head>",
              `<style>@layer host-branding { :root { --host-logo: url("${logo}"); } }</style></head>`,
            );
        }
        return {
          html,
          tags: [
            {
              tag: "style",
              children: "@layer theme, base, components, utilities, host-branding;",
              injectTo: "head-prepend",
            },
            {
              tag: "link",
              attrs: { rel: "stylesheet", href: "/@host-branding.css" },
              injectTo: "head",
            },
          ],
        };
      },
    },
  };
}
