// @effect-diagnostics nodeBuiltinImport:off -- Build tooling and process hosts read extension manifests synchronously at startup, outside Effect.
// Node-only helpers for build tooling, the server and the desktop app.
import * as FS from "node:fs";
import * as Path from "node:path";
export { createBackendThreadClient } from "./threads.ts";

import {
  EXTENSION_LIST_FILE,
  EXTENSION_MANIFEST_FILE,
  ExtensionManifestError,
  parseExtensionList,
  parseExtensionManifest,
  type ExtensionManifest,
} from "./manifest.ts";

export interface ResolvedExtension {
  readonly manifest: ExtensionManifest;
  /** Absolute extension folder. */
  readonly root: string;
  /** Absolute web entry, when the manifest declares one. */
  readonly webEntry?: string;
  /** Absolute backend working directory, when the manifest declares a backend. */
  readonly backendCwd?: string;
  /** Absolute data directory: list override, else manifest default, else undefined (host decides). */
  readonly dataDir?: string;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(FS.readFileSync(file, "utf8"));
  } catch (cause) {
    throw new ExtensionManifestError(`${file}: ${(cause as Error).message}`);
  }
}

/**
 * Reads `<hostRoot>/t4.extensions.json`. A missing file means no extensions, which must leave the
 * host behaving exactly like upstream. Rejects duplicate ids and SDK mismatches.
 */
export function loadExtensions(
  hostRoot: string,
  listFile = Path.join(hostRoot, EXTENSION_LIST_FILE),
): ResolvedExtension[] {
  if (!FS.existsSync(listFile)) return [];
  const entries = parseExtensionList(readJson(listFile), listFile);
  const listDir = Path.dirname(listFile);
  const seen = new Map<string, string>();
  return entries.map((entry) => {
    const root = Path.resolve(listDir, entry.path);
    const manifestFile = Path.join(root, EXTENSION_MANIFEST_FILE);
    if (!FS.existsSync(manifestFile)) {
      throw new ExtensionManifestError(`${listFile}: ${manifestFile} does not exist`);
    }
    const manifest = parseExtensionManifest(readJson(manifestFile), manifestFile);
    const previous = seen.get(manifest.id);
    if (previous !== undefined) {
      throw new ExtensionManifestError(
        `${listFile}: duplicate extension id "${manifest.id}" in ${previous} and ${root}`,
      );
    }
    seen.set(manifest.id, root);
    const dataDir =
      entry.dataDir !== undefined
        ? Path.resolve(listDir, entry.dataDir)
        : manifest.backend?.dataDir !== undefined
          ? Path.resolve(root, manifest.backend.dataDir)
          : undefined;
    return {
      manifest,
      root,
      ...(manifest.web === undefined ? {} : { webEntry: Path.resolve(root, manifest.web) }),
      ...(manifest.backend === undefined
        ? {}
        : { backendCwd: Path.resolve(root, manifest.backend.cwd) }),
      ...(dataDir === undefined ? {} : { dataDir }),
    };
  });
}
