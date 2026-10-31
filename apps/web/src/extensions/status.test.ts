import { expect, it, vi } from "vite-plus/test";
import { createBackendNotifications } from "./status";

it("notifies once per outage across retries and clears the notice on recovery", () => {
  const down = vi.fn(() => "notice");
  const recovered = vi.fn();
  const update = createBackendNotifications({ down, recovered });
  for (const state of ["down", "down", "restarting", "down", "ready"] as const)
    update("env:sample", "sample", { state, since: 0 });
  expect(down).toHaveBeenCalledOnce();
  expect(recovered).toHaveBeenCalledExactlyOnceWith("notice");
  update("env:sample", "sample", { state: "down", since: 1 });
  expect(down).toHaveBeenCalledTimes(2);
});
