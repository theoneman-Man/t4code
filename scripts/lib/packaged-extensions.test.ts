import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { stagePackagedExtensions } from "./packaged-extensions.ts";

const fixture = Effect.fn("test.packagedExtensionFixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "packaged-extensions-" });
  const extension = path.join(root, "fixture extension");
  const stageAppDir = path.join(root, "stage");
  yield* fs.makeDirectory(path.join(extension, "tasks"), { recursive: true });
  const manifest = {
    id: "fixture",
    sdk: 1,
    backend: { command: ["./runtime/node", "./server.cjs"], cwd: ".", protocol: 1 },
    routes: [{ method: "GET", path: "/**", scope: "read" }],
  };
  const packageRecipe = {
    command: [process.execPath, "package.cjs"],
    cwd: "tasks",
    output: "payload",
  };
  const writeManifest = (value: unknown) =>
    fs.writeFileString(path.join(extension, "t4-extension.json"), JSON.stringify(value));
  yield* writeManifest({ ...manifest, package: packageRecipe });
  yield* fs.writeFileString(
    path.join(extension, "tasks/package.cjs"),
    `const fs = require("node:fs");
     fs.mkdirSync("../payload/nested", { recursive: true });
     fs.writeFileSync("../payload/t4-extension.json", ${JSON.stringify(JSON.stringify(manifest))});
     fs.writeFileSync("../payload/nested/asset.txt", "tiny payload");
     fs.writeFileSync("../payload/env.txt", process.env.TEMP ?? "missing");`,
  );
  return { root, extension, stageAppDir, manifest, packageRecipe, writeManifest };
});

it.layer(NodeServices.layer)("packaged extensions", (it) => {
  it.effect(
    "runs the package command with relative cwd and inherited env, then stages only its output",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const f = yield* fixture();
        yield* fs.writeFileString(
          path.join(f.root, "t4.extensions.json"),
          '["./fixture extension"]',
        );
        const staged = yield* stagePackagedExtensions({
          repoRoot: f.root,
          stageAppDir: f.stageAppDir,
          brandingPresent: false,
        });
        assert.isDefined(staged);
        const resources = path.join(
          f.stageAppDir,
          "apps/desktop/prod-resources/packaged-extensions",
        );
        assert.deepEqual(
          JSON.parse(yield* fs.readFileString(path.join(resources, "extensions/index.json"))),
          {
            version: 1,
            extensions: [{ id: "fixture", dir: "fixture" }],
          },
        );
        const packaged = path.join(resources, "extensions/fixture");
        assert.deepEqual(
          JSON.parse(yield* fs.readFileString(path.join(packaged, "t4-extension.json"))),
          f.manifest,
        );
        assert.equal(
          yield* fs.readFileString(path.join(packaged, "nested/asset.txt")),
          "tiny payload",
        );
        assert.equal(
          yield* fs.readFileString(path.join(packaged, "env.txt")),
          process.env.TEMP ?? "missing",
        );
        assert.isFalse(yield* fs.exists(path.join(packaged, "tasks")));
        assert.deepEqual(
          JSON.parse(yield* fs.readFileString(path.join(resources, "t4-packaged-policy.json"))),
          { version: 1, autoUpdate: false },
        );
        assert.deepEqual(
          staged?.extraResources.map(({ to }) => to),
          ["extensions", "t4-packaged-policy.json"],
        );
      }),
  );

  it.effect("does nothing when neither list nor branding is present", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const f = yield* fixture();
      assert.isUndefined(
        yield* stagePackagedExtensions({
          repoRoot: f.root,
          stageAppDir: f.stageAppDir,
          brandingPresent: false,
        }),
      );
      assert.isFalse(yield* fs.exists(f.stageAppDir));
    }),
  );

  it.effect("writes the immutable policy for branding alone", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const f = yield* fixture();
      const staged = yield* stagePackagedExtensions({
        repoRoot: f.root,
        stageAppDir: f.stageAppDir,
        brandingPresent: true,
      });
      assert.deepEqual(
        staged?.extraResources.map(({ to }) => to),
        ["t4-packaged-policy.json"],
      );
      const policy = path.join(f.stageAppDir, staged!.extraResources[0]!.from);
      assert.deepEqual(JSON.parse(yield* fs.readFileString(policy)), {
        version: 1,
        autoUpdate: false,
      });
    }),
  );

  it.effect("preserves an explicitly empty list as an empty packaged index", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const f = yield* fixture();
      yield* fs.writeFileString(path.join(f.root, "t4.extensions.json"), '{"extensions":[]}');
      const staged = yield* stagePackagedExtensions({
        repoRoot: f.root,
        stageAppDir: f.stageAppDir,
        brandingPresent: false,
      });
      assert.isDefined(staged);
      const resources = path.join(f.stageAppDir, staged!.extraResources[0]!.from);
      assert.deepEqual(JSON.parse(yield* fs.readFileString(path.join(resources, "index.json"))), {
        version: 1,
        extensions: [],
      });
    }),
  );

  it.effect("copies an extension folder when its optional package recipe is absent", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const f = yield* fixture();
      yield* f.writeManifest(f.manifest);
      yield* fs.writeFileString(
        path.join(f.root, "t4.extensions.json"),
        JSON.stringify({ extensions: [{ path: f.extension }] }),
      );
      const staged = yield* stagePackagedExtensions({
        repoRoot: f.root,
        stageAppDir: f.stageAppDir,
        brandingPresent: false,
      });
      const resources = path.join(f.stageAppDir, staged!.extraResources[0]!.from);
      assert.deepEqual(
        JSON.parse(yield* fs.readFileString(path.join(resources, "fixture/t4-extension.json"))),
        f.manifest,
      );
    }),
  );

  it.effect("fails clearly on a nonzero package exit and never writes a success index", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const f = yield* fixture();
      yield* fs.writeFileString(path.join(f.extension, "tasks/package.cjs"), "process.exit(7);");
      yield* fs.writeFileString(path.join(f.root, "t4.extensions.json"), '["./fixture extension"]');
      const failure = yield* Effect.flip(
        stagePackagedExtensions({
          repoRoot: f.root,
          stageAppDir: f.stageAppDir,
          brandingPresent: false,
        }),
      );
      assert.match(failure.message, /fixture.*package.*exit.*7/i);
      assert.isFalse(
        yield* fs.exists(
          path.join(
            f.stageAppDir,
            "apps/desktop/prod-resources/packaged-extensions/extensions/index.json",
          ),
        ),
      );
    }),
  );

  it.effect.each([
    {
      name: "missing output manifest",
      source: 'require("node:fs").mkdirSync("../payload", {recursive:true});',
    },
    {
      name: "invalid output sdk",
      source:
        'require("node:fs").mkdirSync("../payload", {recursive:true}); require("node:fs").writeFileSync("../payload/t4-extension.json", \'{"id":"fixture","sdk":2}\');',
    },
    {
      name: "different output id",
      source:
        'require("node:fs").mkdirSync("../payload", {recursive:true}); require("node:fs").writeFileSync("../payload/t4-extension.json", \'{"id":"other","sdk":1}\');',
    },
  ])("rejects $name", ({ source }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const f = yield* fixture();
      yield* fs.writeFileString(path.join(f.extension, "tasks/package.cjs"), source);
      yield* fs.writeFileString(path.join(f.root, "t4.extensions.json"), '["./fixture extension"]');
      const failure = yield* Effect.flip(
        stagePackagedExtensions({
          repoRoot: f.root,
          stageAppDir: f.stageAppDir,
          brandingPresent: false,
        }),
      );
      assert.match(failure.message, /t4-extension.json|sdk|id/i);
    }),
  );

  it.effect("rejects invalid recipes and duplicate ids before starting package commands", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const f = yield* fixture();
      yield* fs.writeFileString(path.join(f.root, "t4.extensions.json"), '["./fixture extension"]');
      for (const recipe of [
        { command: [], output: "payload" },
        { ...f.packageRecipe, cwd: f.root },
        { ...f.packageRecipe, output: f.root },
      ]) {
        yield* f.writeManifest({ ...f.manifest, package: recipe });
        const failure = yield* Effect.flip(
          stagePackagedExtensions({
            repoRoot: f.root,
            stageAppDir: f.stageAppDir,
            brandingPresent: false,
          }),
        );
        assert.match(failure.message, /package/);
      }
      yield* f.writeManifest({ ...f.manifest, package: f.packageRecipe });
      yield* fs.writeFileString(
        path.join(f.root, "t4.extensions.json"),
        '["./fixture extension","./fixture extension"]',
      );
      const failure = yield* Effect.flip(
        stagePackagedExtensions({
          repoRoot: f.root,
          stageAppDir: f.stageAppDir,
          brandingPresent: false,
        }),
      );
      assert.match(failure.message, /duplicate.*fixture/i);
      assert.isFalse(yield* fs.exists(path.join(f.extension, "payload")));
    }),
  );
});
