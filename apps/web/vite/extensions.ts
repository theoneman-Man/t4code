// @effect-diagnostics-next-line nodeBuiltinImport:off - Vite configuration runs outside the Effect runtime.
import * as NodePath from "node:path";
import { loadExtensions, type ResolvedExtension } from "@t3tools/extension-sdk/node";
import { type Plugin, searchForWorkspaceRoot, normalizePath } from "vite-plus";
import { parseAst } from "vite/rolldown/parseAst";

type Node = { type: string; [key: string]: unknown };
const node = (value: unknown): value is Node =>
  value !== null && typeof value === "object" && "type" in value;

export function validateWebEntry(code: string, id: string) {
  const body: unknown[] = parseAst(code, { lang: "tsx" }).body;
  const bindings = new Map<string, Node>();
  for (const statement of body) {
    if (!node(statement)) continue;
    const declaration = node(statement.declaration) ? statement.declaration : statement;
    if (!Array.isArray(declaration.declarations)) continue;
    for (const entry of declaration.declarations) {
      if (node(entry) && node(entry.id) && typeof entry.id.name === "string" && node(entry.init))
        bindings.set(entry.id.name, entry.init);
    }
  }
  const resolve = (value: unknown, seen = new Set<string>()): Node | undefined => {
    if (!node(value)) return;
    if (
      /^(TSAsExpression|TSSatisfiesExpression|TSNonNullExpression|ParenthesizedExpression)$/.test(
        value.type,
      )
    )
      return resolve(value.expression, seen);
    if (value.type === "Identifier" && typeof value.name === "string" && !seen.has(value.name))
      return resolve(bindings.get(value.name), new Set([...seen, value.name]));
    return value;
  };
  const exported = body.find((entry) => node(entry) && entry.type === "ExportDefaultDeclaration");
  const module = resolve(node(exported) ? exported.declaration : undefined);
  if (module?.type !== "ObjectExpression" || !Array.isArray(module.properties))
    throw new Error(
      `Extension ${id}: web entry must default-export a module object (or re-export one).`,
    );
  const properties = module.properties;
  const property = (name: string) => {
    const entry = properties.find(
      (entry: unknown) =>
        node(entry) && node(entry.key) && (entry.key.name === name || entry.key.value === name),
    );
    return node(entry) ? resolve(entry.value)?.value : undefined;
  };
  if (property("sdk") !== 1) throw new Error(`Extension ${id}: web entry must declare sdk: 1.`);
  if (property("id") !== id) throw new Error(`Extension ${id}: web module id must be "${id}".`);
}

export const EXTENSIONS_MODULE = "virtual:t4-extensions";
const resolvedModule = `\0${EXTENSIONS_MODULE}`;

export function extensionModuleSource(extensions: readonly ResolvedExtension[]): string {
  const web = extensions.filter((entry) => entry.webEntry);
  if (web.length === 0) return "export default [];";
  return [
    ...web.map(
      (entry, index) =>
        `import extension${index} from ${JSON.stringify(normalizePath(entry.webEntry!))};`,
    ),
    ...web.map(
      (entry, index) =>
        `if (extension${index}.sdk !== 1 || extension${index}.id !== ${JSON.stringify(entry.manifest.id)}) throw new Error(${JSON.stringify(`Extension ${entry.manifest.id}: web module sdk/id does not match its manifest.`)});`,
    ),
    `export default [${web.map((_, index) => `extension${index}`).join(",")}];`,
  ].join("\n");
}

export function extensionsPlugin(
  hostRoot = NodePath.resolve(import.meta.dirname, "../../.."),
): Plugin {
  const extensions = loadExtensions(hostRoot);
  const entries = new Map(
    extensions.flatMap((entry) =>
      entry.webEntry ? [[normalizePath(entry.webEntry), entry.manifest.id] as const] : [],
    ),
  );
  return {
    name: "t4:extensions",
    enforce: "pre",
    config() {
      return {
        resolve: {
          alias: [
            {
              find: /^@t3tools\/extension-sdk$/,
              replacement: NodePath.join(hostRoot, "apps/web/src/extensions/sdk.tsx"),
            },
          ],
          dedupe: ["react", "react-dom", "@t3tools/extension-sdk"],
        },
        ...(extensions.length
          ? {
              server: {
                fs: {
                  allow: [
                    searchForWorkspaceRoot(hostRoot),
                    ...extensions.map((entry) => entry.root),
                  ],
                },
              },
            }
          : {}),
      };
    },
    configResolved(config) {
      // Extension requests use the same origin and target as the existing API proxy.
      if (extensions.length && config.server.proxy?.["/api"]) {
        config.server.proxy["/ext"] = config.server.proxy["/api"];
      }
    },
    async resolveId(source, importer) {
      if (source === EXTENSIONS_MODULE) return resolvedModule;
      if (
        source.startsWith(".") ||
        source.startsWith("/") ||
        source.startsWith("\0") ||
        source.startsWith("@t3tools/extension-sdk") ||
        /^react(?:-dom)?(?:\/|$)/.test(source)
      )
        return;
      const owner =
        importer &&
        extensions.find((entry) =>
          normalizePath(importer).startsWith(`${normalizePath(entry.root)}/`),
        );
      if (owner)
        return this.resolve(source, NodePath.join(owner.root, "package.json"), { skipSelf: true });
    },
    load(id) {
      if (id === resolvedModule) return extensionModuleSource(extensions);
    },
    async transform(code, id) {
      const cleanId = normalizePath(id.split("?")[0]!);
      const owner = entries.get(cleanId);
      if (owner) {
        const reexports = [
          ...code.matchAll(/export\s*\{[^}]*\bdefault\b[^}]*\}\s*from\s*["']([^"']+)["']/g),
        ];
        if (reexports.length) {
          for (const match of reexports) {
            const target = await this.resolve(match[1]!, id);
            if (!target)
              throw new Error(
                `Extension ${owner}: cannot resolve web entry re-export ${match[1]}.`,
              );
            entries.set(normalizePath(target.id.split("?")[0]!), owner);
          }
        } else {
          validateWebEntry(code, owner);
        }
      }
      if (extensions.length && normalizePath(id).endsWith("/apps/web/src/index.css")) {
        return `${code}\n${extensions
          .filter((entry) => entry.webEntry)
          .map(
            (entry) =>
              `@source ${JSON.stringify(normalizePath(NodePath.dirname(entry.webEntry!)))};`,
          )
          .join("\n")}`;
      }
    },
  };
}
