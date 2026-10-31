import { EXTENSION_MAX_RESTARTS } from "../protocol.ts";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export const READY_STABILITY_MS = 60_000;

export function createRestartSignal() {
  let pending = false;
  let listener: (() => void) | undefined;
  return {
    request() {
      pending = true;
      listener?.();
    },
    wait: Effect.callback<void>((resume) => {
      const consume = () => {
        pending = false;
        resume(Effect.void);
      };
      listener = consume;
      if (pending) consume();
      return Effect.sync(() => {
        if (listener === consume) listener = undefined;
      });
    }),
  };
}

export const restartDelay = (attempt: number) => Math.min(250 * 2 ** Math.min(attempt, 7), 30_000);

export const supervise = Effect.fn("ExtensionHost.supervise")(function* <E, R>(
  launch: (
    ready: Effect.Effect<void, never, Scope.Scope>,
  ) => Effect.Effect<void, E, R | Scope.Scope>,
  setState: (state: "restarting" | "down", message: string) => Effect.Effect<void>,
  options: {
    readonly restart?: Effect.Effect<void>;
    readonly onAttempt?: (attempt: number) => Effect.Effect<void>;
  } = {},
) {
  let restart = 0;
  while (true) {
    let lastError = "Backend exited.";
    yield* options.onAttempt?.(restart) ?? Effect.void;
    const requested = options.restart ?? Effect.never;
    const manual = yield* Effect.raceFirst(
      Effect.scoped(
        launch(
          Effect.sleep(READY_STABILITY_MS).pipe(
            // The launch scope cancels recovery when this backend exits before becoming stable.
            Effect.andThen(
              Effect.sync(() => {
                restart = 0;
              }),
            ),
            Effect.forkScoped,
            Effect.asVoid,
          ),
        ),
      ).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            lastError =
              typeof error === "object" &&
              error !== null &&
              "_tag" in error &&
              error._tag === "TimeoutError"
                ? "Backend readiness timed out."
                : "Backend failed to start. See the extension log.";
          }),
        ),
        Effect.as(false),
      ),
      requested.pipe(Effect.as(true)),
    );
    if (manual) {
      restart = 0;
      yield* setState("restarting", "Restart requested.");
      continue;
    }
    if (restart >= EXTENSION_MAX_RESTARTS) {
      yield* setState("down", `${lastError} Retrying automatically.`);
    } else {
      yield* setState("restarting", lastError);
    }
    const wake = yield* Effect.raceFirst(
      Effect.sleep(restartDelay(restart)).pipe(Effect.as(false)),
      requested.pipe(Effect.as(true)),
    );
    if (wake) {
      restart = 0;
      yield* setState("restarting", "Restart requested.");
    } else restart++;
  }
});
