import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as DesktopObservability from "../app/DesktopObservability.ts";

const PackagedPolicy = Schema.fromJsonString(
  Schema.Struct({ version: Schema.Literal(1), autoUpdate: Schema.Boolean }),
);
const decodePolicy = Schema.decodeUnknownEffect(PackagedPolicy);
const { logWarning } = DesktopObservability.makeComponentLogger("desktop-packaged-policy");
const disabledReason = "Automatic updates are disabled by the packaged policy.";
const invalidReason =
  "Automatic updates are disabled because the packaged policy could not be read or is invalid.";

export const readPackagedUpdateDisabledReason = Effect.fn("desktop.packagedPolicy.read")(function* (
  resourcesPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const policyPath = path.join(resourcesPath, "t4-packaged-policy.json");
  return yield* fs.readFileString(policyPath).pipe(
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeed(null),
    ),
    Effect.flatMap((raw) =>
      raw === null
        ? Effect.succeed(Option.none<string>())
        : decodePolicy(raw).pipe(
            Effect.map((policy) =>
              policy.autoUpdate ? Option.none<string>() : Option.some(disabledReason),
            ),
          ),
    ),
    // Only a missing file preserves upstream behavior. Invalid or unreadable policy fails safe.
    Effect.catch(() =>
      logWarning("Packaged policy is unreadable or invalid; updates are disabled.").pipe(
        Effect.as(Option.some(invalidReason)),
      ),
    ),
  );
});
