import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  EXTENSION_LIST_FILE,
  EXTENSION_MANIFEST_FILE,
  parseExtensionList,
  parseExtensionManifest,
} from "@t3tools/extension-sdk/manifest";

const RESOURCE_SOURCE = "apps/desktop/prod-resources/packaged-extensions";

export interface PackagedExtensionResources {
  readonly extraResources: ReadonlyArray<{ readonly from: string; readonly to: string }>;
  readonly files: readonly string[];
}

export class PackagedExtensionError extends Schema.TaggedError<PackagedExtensionError>()(
  "PackagedExtensionError",
  { message: Schema.String, cause: Schema.optional(Schema.Unknown) },
) {}

const readJson = Effect.fn("packagedExtensions.readJson")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(file).pipe(
    Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))),
    Effect.mapError(
      (cause) => new PackagedExtensionError({ message: `Cannot read ${file}`, cause }),
    ),
  );
});

const PackageRecipe = Schema.Struct({
  command: Schema.NonEmptyArray(Schema.NonEmptyString),
  cwd: Schema.optionalKey(Schema.NonEmptyString),
  output: Schema.NonEmptyString,
});
const decodePackageRecipe = Schema.decodeUnknownEffect(PackageRecipe);

const readExtension = Effect.fn("packagedExtensions.readExtension")(function* (root: string) {
  const path = yield* Path.Path;
  const file = path.join(root, EXTENSION_MANIFEST_FILE);
  const value = yield* readJson(file);
  const manifest = yield* Effect.try({
    try: () => parseExtensionManifest(value, file),
    catch: (cause) =>
      new PackagedExtensionError({ message: `Invalid ${file}: ${String(cause)}`, cause }),
  });
  return { value, manifest };
});

export const stagePackagedExtensions = Effect.fn("packagedExtensions.stage")(function* (input: {
  readonly repoRoot: string;
  readonly stageAppDir: string;
  readonly brandingPresent: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const listFile = path.join(input.repoRoot, EXTENSION_LIST_FILE);
  const listPresent = yield* fs.exists(listFile);
  if (!listPresent && !input.brandingPresent) return undefined;

  const entries = listPresent
    ? yield* readJson(listFile).pipe(
        Effect.flatMap((value) =>
          Effect.try({
            try: () => parseExtensionList(value, listFile),
            catch: (cause) =>
              new PackagedExtensionError({
                message: `Invalid ${listFile}: ${String(cause)}`,
                cause,
              }),
          }),
        ),
      )
    : [];
  const seen = new Set<string>();
  const extensions = [];
  // Validate every source before starting commands, so duplicate ids cannot overwrite a payload.
  for (const entry of entries) {
    const root = path.resolve(input.repoRoot, entry.path);
    const { value, manifest } = yield* readExtension(root);
    if (seen.has(manifest.id)) {
      return yield* new PackagedExtensionError({
        message: `${listFile}: duplicate extension id "${manifest.id}"`,
      });
    }
    seen.add(manifest.id);
    const rawRecipe =
      typeof value === "object" && value !== null && "package" in value ? value.package : undefined;
    const recipe =
      rawRecipe === undefined
        ? undefined
        : yield* decodePackageRecipe(rawRecipe).pipe(
            Effect.mapError(
              (cause) =>
                new PackagedExtensionError({
                  message: `Extension "${manifest.id}": invalid package recipe in ${root}`,
                  cause,
                }),
            ),
          );
    if (recipe && (path.isAbsolute(recipe.cwd ?? ".") || path.isAbsolute(recipe.output))) {
      return yield* new PackagedExtensionError({
        message: `Extension "${manifest.id}": package.cwd and package.output must be relative to ${root}`,
      });
    }
    extensions.push({ root, manifest, recipe });
  }

  const sourceDir = path.join(input.stageAppDir, RESOURCE_SOURCE);
  const index: Array<{ id: string; dir: string }> = [];
  for (const { root, manifest, recipe } of extensions) {
    if (recipe) {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const [command, ...args] = recipe.command;
      const cwd = path.resolve(root, recipe.cwd ?? ".");
      yield* Effect.log(`[desktop-artifact] Packaging extension "${manifest.id}"...`);
      const spawned = yield* resolveSpawnCommand(command, args);
      const child = yield* spawner
        .spawn(
          ChildProcess.make(spawned.command, spawned.args, {
            cwd,
            shell: spawned.shell,
            stdin: "ignore",
            stdout: "inherit",
            stderr: "inherit",
          }),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new PackagedExtensionError({
                message: `Extension "${manifest.id}" package command "${command}" could not start in ${cwd}`,
                cause,
              }),
          ),
        );
      const exitCode = Number(yield* child.exitCode);
      if (exitCode !== 0) {
        return yield* new PackagedExtensionError({
          message: `Extension "${manifest.id}" package command "${command}" exited with code ${exitCode} in ${cwd}`,
        });
      }
    }
    const output = recipe ? path.resolve(root, recipe.output) : root;
    const packaged = yield* readExtension(output);
    if (packaged.manifest.id !== manifest.id) {
      return yield* new PackagedExtensionError({
        message: `${path.join(output, EXTENSION_MANIFEST_FILE)}: packaged id "${packaged.manifest.id}" does not match "${manifest.id}"`,
      });
    }
    yield* fs.makeDirectory(path.join(sourceDir, "extensions"), { recursive: true });
    yield* fs.copy(output, path.join(sourceDir, "extensions", manifest.id));
    index.push({ id: manifest.id, dir: manifest.id });
  }

  yield* fs.makeDirectory(sourceDir, { recursive: true });
  const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
  const resources: Array<{ from: string; to: string }> = [];
  if (listPresent) {
    yield* fs.makeDirectory(path.join(sourceDir, "extensions"), { recursive: true });
    yield* fs.writeFileString(
      path.join(sourceDir, "extensions/index.json"),
      `${yield* encodeJson({ version: 1, extensions: index })}\n`,
    );
    resources.push({ from: `${RESOURCE_SOURCE}/extensions`, to: "extensions" });
  }
  yield* fs.writeFileString(
    path.join(sourceDir, "t4-packaged-policy.json"),
    `${yield* encodeJson({ version: 1, autoUpdate: false })}\n`,
  );
  resources.push({
    from: `${RESOURCE_SOURCE}/t4-packaged-policy.json`,
    to: "t4-packaged-policy.json",
  });
  return {
    extraResources: resources,
    files: [`!${RESOURCE_SOURCE}`, `!${RESOURCE_SOURCE}/**/*`],
  } satisfies PackagedExtensionResources;
});

export function applyPackagedExtensionsConfig(
  upstream: Record<string, unknown>,
  resources: PackagedExtensionResources | undefined,
): Record<string, unknown> {
  if (!resources) return upstream;
  return {
    ...upstream,
    publish: null,
    files: [...(Array.isArray(upstream.files) ? upstream.files : []), ...resources.files],
    extraResources: [
      ...(Array.isArray(upstream.extraResources) ? upstream.extraResources : []),
      ...resources.extraResources,
    ],
  };
}
