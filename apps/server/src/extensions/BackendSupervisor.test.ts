import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import { READY_STABILITY_MS, supervise } from "./BackendSupervisor.ts";

const harness = Effect.fn("SupervisorTest.harness")(function* (ready = true) {
  const launches = yield* Queue.unbounded<Deferred.Deferred<void>>();
  const states = yield* Queue.unbounded<"restarting" | "failed">();
  let launchCount = 0;
  const fiber = yield* supervise(
    (onReady) =>
      Effect.gen(function* () {
        launchCount++;
        const exit = yield* Deferred.make<void>();
        if (ready) yield* onReady;
        yield* Queue.offer(launches, exit);
        yield* Deferred.await(exit);
        if (!ready) return yield* Effect.fail("readiness failed");
      }),
    (state) => Queue.offer(states, state).pipe(Effect.asVoid),
  ).pipe(Effect.forkScoped);
  return {
    launches,
    states,
    fiber,
    count: () => launchCount,
    crash: Effect.gen(function* () {
      const exit = yield* Queue.take(launches);
      yield* Deferred.succeed(exit, undefined);
      return yield* Queue.take(states);
    }),
  };
});

it.effect.each([true, false])("stops after five consecutive restarts, ready=%s", (ready) =>
  Effect.gen(function* () {
    const test = yield* harness(ready);
    for (const delay of [250, 500, 1000, 2000, 4000]) {
      if (!ready) {
        const exit = yield* Queue.take(test.launches);
        yield* TestClock.adjust(READY_STABILITY_MS);
        yield* Deferred.succeed(exit, undefined);
        expect(yield* Queue.take(test.states)).toBe("restarting");
      } else {
        expect(yield* test.crash).toBe("restarting");
      }
      yield* TestClock.adjust(delay);
    }
    expect(yield* test.crash).toBe("failed");
    yield* Fiber.join(test.fiber);
    expect(test.count()).toBe(6);
  }),
);

it.effect("does not recover just before the ready stability window", () =>
  Effect.gen(function* () {
    const test = yield* harness();
    for (const delay of [250, 500, 1000, 2000, 4000]) {
      expect(yield* test.crash).toBe("restarting");
      yield* TestClock.adjust(delay);
    }
    const exit = yield* Queue.take(test.launches);
    yield* TestClock.adjust(READY_STABILITY_MS - 1);
    yield* Deferred.succeed(exit, undefined);
    expect(yield* Queue.take(test.states)).toBe("failed");
    yield* Fiber.join(test.fiber);
    expect(test.count()).toBe(6);
  }),
);

it.effect("recovers the restart budget and initial backoff after a stable ready launch", () =>
  Effect.gen(function* () {
    const test = yield* harness();
    for (const delay of [250, 500, 1000, 2000, 4000]) {
      expect(yield* test.crash).toBe("restarting");
      yield* TestClock.adjust(delay);
    }
    // Take this launch before advancing time so only time spent ready can recover the budget.
    const stableExit = yield* Queue.take(test.launches);
    yield* TestClock.adjust(READY_STABILITY_MS);
    yield* Deferred.succeed(stableExit, undefined);
    expect(yield* Queue.take(test.states)).toBe("restarting");
    yield* TestClock.adjust(250);
    expect(yield* test.crash).toBe("restarting");
    yield* TestClock.adjust(500);
    for (const delay of [1000, 2000, 4000]) {
      expect(yield* test.crash).toBe("restarting");
      yield* TestClock.adjust(delay);
    }
    expect(yield* test.crash).toBe("failed");
    yield* Fiber.join(test.fiber);
    expect(test.count()).toBe(11);
  }),
);
