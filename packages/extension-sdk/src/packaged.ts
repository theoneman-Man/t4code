// @effect-diagnostics nodeBuiltinImport:off -- Packaged desktop discovery runs synchronously at the Node startup boundary.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { EXTENSION_MANIFEST_FILE, isValidExtensionId, parseExtensionManifest } from "./manifest.ts";
import type { ResolvedExtension } from "./node.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Keep the server bootstrap format unchanged without writing into installed resources. */
export function writePackagedExtensionList(
  listFile: string,
  extensions: readonly ResolvedExtension[],
) {
  NodeFS.mkdirSync(NodePath.dirname(listFile), { recursive: true });
  NodeFS.writeFileSync(
    listFile,
    JSON.stringify(
      extensions.map((extension) => ({
        path: extension.root,
        ...(extension.dataDir === undefined ? {} : { dataDir: extension.dataDir }),
      })),
    ),
  );
}

/** A broken optional payload disables extensions without preventing desktop startup. */
export function loadPackagedExtensions(
  resourcesPath: string,
  environment: NodeJS.ProcessEnv = process.env,
): ResolvedExtension[] {
  try {
    const extensionsRoot = NodePath.resolve(resourcesPath, "extensions");
    const index: unknown = JSON.parse(
      NodeFS.readFileSync(NodePath.join(extensionsRoot, "index.json"), "utf8"),
    );
    if (!isRecord(index) || index.version !== 1 || !Array.isArray(index.extensions)) return [];
    const seen = new Set<string>();
    return index.extensions.map((entry: unknown) => {
      if (
        !isRecord(entry) ||
        typeof entry.id !== "string" ||
        !isValidExtensionId(entry.id) ||
        seen.has(entry.id) ||
        typeof entry.dir !== "string" ||
        !entry.dir.trim() ||
        NodePath.isAbsolute(entry.dir) ||
        NodePath.win32.isAbsolute(entry.dir) ||
        entry.dir.split(/[/\\]/).some((part) => part === ".." || part === "." || !part)
      ) {
        throw new Error("Invalid packaged extension entry.");
      }
      seen.add(entry.id);
      const root = NodePath.resolve(extensionsRoot, entry.dir);
      const manifestFile = NodePath.join(root, EXTENSION_MANIFEST_FILE);
      const manifest = parseExtensionManifest(
        JSON.parse(NodeFS.readFileSync(manifestFile, "utf8")),
        manifestFile,
      );
      if (manifest.id !== entry.id) throw new Error("Packaged extension id mismatch.");
      const backend = manifest.backend;
      const override =
        environment[`T4_EXT_DATA_DIR__${manifest.id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`];
      const dataDir = override ?? backend?.dataDir;
      const resolveArgument = (argument: string) =>
        argument.startsWith("./") ? NodePath.resolve(root, argument) : argument;
      return {
        manifest: {
          ...manifest,
          ...(backend
            ? {
                backend: {
                  ...backend,
                  command: [
                    resolveArgument(backend.command[0]),
                    ...backend.command.slice(1).map(resolveArgument),
                  ] as const,
                },
              }
            : {}),
        },
        root,
        ...(manifest.web === undefined ? {} : { webEntry: NodePath.resolve(root, manifest.web) }),
        ...(backend ? { backendCwd: NodePath.resolve(root, backend.cwd) } : {}),
        ...(dataDir === undefined ? {} : { dataDir: NodePath.resolve(root, dataDir) }),
      };
    });
  } catch {
    return [];
  }
}
