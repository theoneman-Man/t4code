import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { migratePersistedRightPanelState, useRightPanelStore } from "../rightPanelStore";

vi.mock("virtual:t4-extensions", () => ({
  default: [
    {
      id: "sample",
      sdk: 1,
      slots: [
        {
          kind: "rightPanel",
          id: "panel",
          title: "Sample",
          component: () => null,
          icon: () => null,
        },
      ],
    },
  ],
}));

it("drops removed and malformed extension surfaces, retaining installed surfaces and a valid selection", () => {
  const result = migratePersistedRightPanelState({
    byThreadKey: {
      "env:thread": {
        isOpen: true,
        activeSurfaceId: "ext:removed:panel",
        surfaces: [
          { kind: "extension", id: "ext:removed:panel", slotKey: "removed:panel" },
          { kind: "extension", id: "ext:forged:panel", slotKey: "sample:panel" },
          { kind: "extension", id: "ext:sample:panel", slotKey: "sample:panel" },
        ],
      },
    },
  });
  expect(result.byThreadKey["env:thread"]?.surfaces).toEqual([
    { kind: "extension", id: "ext:sample:panel", slotKey: "sample:panel" },
  ]);
  expect(result.byThreadKey["env:thread"]?.activeSurfaceId).toBe("ext:sample:panel");
});

it("cleans surfaces on rehydrate even when the storage version has not changed", () => {
  const merge = useRightPanelStore.persist.getOptions().merge!;
  const merged = merge(
    {
      byThreadKey: {
        "env:thread": {
          isOpen: true,
          activeSurfaceId: "ext:removed:panel",
          surfaces: [{ kind: "extension", id: "ext:removed:panel", slotKey: "removed:panel" }],
        },
      },
    },
    useRightPanelStore.getState(),
  );
  expect(merged.byThreadKey["env:thread"]?.surfaces ?? []).toEqual([]);
});

it("shallow-merges current-version state without rewriting upstream panels or visibility", () => {
  const current = useRightPanelStore.getState();
  const persisted = {
    byThreadKey: {
      "env:pull-requests-panel": {
        isOpen: true,
        activeSurfaceId: "diff",
        surfaces: [{ kind: "diff", id: "diff" }],
        maximized: true,
      },
      "env:thread": {
        isOpen: false,
        activeSurfaceId: null,
        surfaces: [],
        dismissedDeviceSurfaceIds: ["device:one"],
      },
    },
    threadPanelVisibilityByThreadKey: {
      "env:thread": { inlineOpen: true, popoverOpen: true },
    },
  };
  const merged = useRightPanelStore.persist.getOptions().merge!(persisted, current);
  expect(merged).toEqual({ ...current, ...persisted });
  expect(merged.byThreadKey).toBe(persisted.byThreadKey);
  expect(merged.threadPanelVisibilityByThreadKey).toBe(persisted.threadPanelVisibilityByThreadKey);
});

it("opens and closes extension surfaces using the ordinary panel actions", () => {
  const ref = {
    environmentId: EnvironmentId.make("extension-test"),
    threadId: ThreadId.make("thread"),
  };
  const panels = useRightPanelStore.getState();
  panels.openExtension(ref, "sample:panel");
  expect(useRightPanelStore.getState().byThreadKey[scopedThreadKey(ref)]?.activeSurfaceId).toBe(
    "ext:sample:panel",
  );
  panels.closeSurface(ref, "ext:sample:panel");
  expect(useRightPanelStore.getState().byThreadKey[scopedThreadKey(ref)]?.isOpen ?? false).toBe(
    false,
  );
  panels.removeThread(ref);
});
