import * as Effect from "effect/Effect";

export const make = Effect.sync(() => {
  const stops = new Set<Effect.Effect<void>>();
  return {
    register: (stop: Effect.Effect<void>) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          stops.add(stop);
        }),
        () =>
          Effect.sync(() => {
            stops.delete(stop);
          }),
      ),
    stop: Effect.suspend(() => Effect.all([...stops], { concurrency: "unbounded", discard: true })),
  };
});
