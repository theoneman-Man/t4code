import { beforeEach, expect, it, vi } from "vite-plus/test";
import { useHostExtContext } from "./hostContext";

const mocks = vi.hoisted(() => ({
  target: vi.fn(),
  draft: vi.fn(),
  thread: vi.fn(),
  primary: vi.fn(),
  settings: vi.fn(),
}));
vi.mock("../hooks/useThreadRouteTarget", () => ({ useThreadRouteTarget: mocks.target }));
vi.mock("../composerDraftStore", () => ({
  useComposerDraftStore: (select: (store: { getDraftSession: typeof mocks.draft }) => unknown) =>
    select({ getDraftSession: mocks.draft }),
}));
vi.mock("../state/entities", () => ({ useThreadShell: mocks.thread }));
vi.mock("../state/environments", () => ({ usePrimaryEnvironmentId: mocks.primary }));
vi.mock("../components/settings/SettingsScopeContext", () => ({
  useOptionalSettingsScope: mocks.settings,
}));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.primary.mockReturnValue("primary");
});

it("passes a draft's selected project and environment without inventing a server thread", () => {
  mocks.target.mockReturnValue({ kind: "draft", draftId: "draft" });
  mocks.draft.mockReturnValue({ environmentId: "remote", projectId: "selected-project" });
  expect(useHostExtContext()).toEqual({ environmentId: "remote", projectId: "selected-project" });
  expect(mocks.draft).toHaveBeenCalledWith("draft");
});

it("follows project changes within the same draft", () => {
  mocks.target.mockReturnValue({ kind: "draft", draftId: "draft" });
  mocks.draft.mockReturnValueOnce({ environmentId: "remote", projectId: "first" });
  mocks.draft.mockReturnValueOnce({ environmentId: "remote", projectId: "second" });
  expect(useHostExtContext()?.projectId).toBe("first");
  expect(useHostExtContext()?.projectId).toBe("second");
});

it("retains the server thread context", () => {
  mocks.target.mockReturnValue({
    kind: "server",
    threadRef: { environmentId: "remote", threadId: "thread" },
  });
  mocks.thread.mockReturnValue({ projectId: "project" });
  expect(useHostExtContext()).toEqual({
    environmentId: "remote",
    threadId: "thread",
    projectId: "project",
  });
  expect(mocks.draft).not.toHaveBeenCalled();
});

it("falls back to the primary environment before a draft exists", () => {
  mocks.target.mockReturnValue({ kind: "draft", draftId: "missing" });
  expect(useHostExtContext()).toEqual({ environmentId: "primary" });
});
