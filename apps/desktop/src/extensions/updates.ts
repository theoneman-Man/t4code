import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as DesktopShutdown from "../app/DesktopShutdown.ts";

interface UpdateOwner {
  readonly suspend: Effect.Effect<void>;
  readonly resume: Effect.Effect<void>;
}

// Key by the app's shutdown service so separate desktop runtimes cannot share owners.
const owners = new WeakMap<DesktopShutdown.DesktopShutdown["Service"], Set<UpdateOwner>>();

export const register = Effect.fn("DesktopExtensionUpdates.register")(
  (shutdown: DesktopShutdown.DesktopShutdown["Service"], owner: UpdateOwner) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const registered = owners.get(shutdown) ?? new Set<UpdateOwner>();
        registered.add(owner);
        owners.set(shutdown, registered);
      }),
      () =>
        Effect.sync(() => {
          owners.get(shutdown)?.delete(owner);
        }),
    ),
);

export const make = Effect.gen(function* () {
  const shutdown = yield* Effect.serviceOption(DesktopShutdown.DesktopShutdown);
  const suspended = new Set<UpdateOwner>();
  return {
    stop: Effect.suspend(() =>
      Effect.forEach(
        Option.isSome(shutdown) ? [...(owners.get(shutdown.value) ?? [])] : [],
        (owner) =>
          Effect.gen(function* () {
            if (suspended.has(owner)) return;
            suspended.add(owner);
            yield* owner.suspend;
          }),
        { discard: true },
      ),
    ),
    recover: Effect.suspend(() =>
      Effect.forEach(
        [...suspended],
        (owner) =>
          owner.resume.pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                suspended.delete(owner);
              }),
            ),
            Effect.catchCause(() =>
              Effect.logError(
                "Could not restore an extension backend after update install failure.",
              ),
            ),
          ),
        { discard: true },
      ),
    ),
  };
});
