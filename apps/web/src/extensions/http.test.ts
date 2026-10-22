import { expect, it, vi } from "vite-plus/test";
import { extensionPath } from "./http";
vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
vi.mock("../state/session", () => ({ readPreparedConnection: () => null }));

it("keeps backend paths inside the extension proxy", () => {
  expect(extensionPath("sample", "/hello?name=a%20b")).toBe("/ext/sample/hello?name=a%20b");
  for (const path of [
    "https://other.test",
    "//other.test",
    "/../other",
    "/%2e%2e/other",
    "/hello#fragment",
    "/\\other",
  ])
    expect(() => extensionPath("sample", path)).toThrow();
});
