import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { readPackagedUpdateDisabledReason } from "./packagedPolicy.ts";

describe("packaged policy", () => {
  it.effect.each([
    ["missing", undefined, false, false],
    ["disabled", '{"version":1,"autoUpdate":false}', true, false],
    ["allowed", '{"version":1,"autoUpdate":true}', false, false],
    ["invalid JSON", "{", true, true],
    ["empty", "", true, true],
    ["null", "null", true, true],
    ["missing field", '{"version":1}', true, true],
    ["wrong type", '{"version":1,"autoUpdate":"false"}', true, true],
    ["unknown version", '{"version":2,"autoUpdate":true}', true, true],
  ] as const)("handles %s policy", ([_name, raw, disabled, warns]) => {
    const logs: unknown[] = [];
    const logger = Logger.make(({ message }) => {
      logs.push(message);
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const resources = yield* fs.makeTempDirectoryScoped({ prefix: "packaged-policy-" });
        if (raw !== undefined) {
          yield* fs.writeFileString(path.join(resources, "t4-packaged-policy.json"), raw);
        }
        const reason = yield* readPackagedUpdateDisabledReason(resources);
        assert.equal(Option.isSome(reason), disabled);
        assert.equal(logs.length, warns ? 1 : 0);
        if (warns) assert.include(String(logs[0]), "updates are disabled");
      }),
    ).pipe(
      Effect.provide(
        Layer.merge(NodeServices.layer, Logger.layer([logger], { mergeWithExisting: false })),
      ),
    );
  });

  it.effect("fails safe when the policy cannot be read", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const resources = yield* fs.makeTempDirectoryScoped({ prefix: "packaged-policy-" });
        yield* fs.makeDirectory(path.join(resources, "t4-packaged-policy.json"));
        assert.isTrue(Option.isSome(yield* readPackagedUpdateDisabledReason(resources)));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
