import { EXTENSION_MAX_RESTARTS } from "../protocol.ts";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export const READY_STABILITY_MS = 60_000;

export const supervise = Effect.fn("ExtensionHost.supervise")(function* <E, R>(
  launch: (
    ready: Effect.Effect<void, never, Scope.Scope>,
  ) => Effect.Effect<void, E, R | Scope.Scope>,
  setState: (state: "restarting" | "failed", message: string) => Effect.Effect<void>,
) {
  let restart = 0;
  while (true) {
    yield* Effect.scoped(
      launch(
        // The launch scope cancels recovery when this backend exits before becoming stable.
        Effect.sleep(READY_STABILITY_MS).pipe(
          Effect.andThen(
            Effect.sync(() => {
              restart = 0;
            }),
          ),
          Effect.forkScoped,
          Effect.asVoid,
        ),
      ),
    ).pipe(Effect.ignore);
    if (restart === EXTENSION_MAX_RESTARTS) {
      yield* setState("failed", "Backend restart limit reached.");
      return;
    }
    yield* setState("restarting", "Backend exited or failed readiness.");
    yield* Effect.sleep(Math.min(250 * 2 ** restart, 8_000));
    restart++;
  }
});
