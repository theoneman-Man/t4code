import { expect, it, vi } from "vite-plus/test";
import type { ExtensionModule } from "@t3tools/extension-sdk";
import { extensionModuleSource, validateWebEntry } from "../../vite/extensions";
import { createExtensionRegistry, validateExtensionModule } from "./registry";

vi.mock("virtual:t4-extensions", () => ({ default: [] }));

it("generates an empty module and registry for an empty list", () => {
  expect(extensionModuleSource([])).toBe("export default [];");
  expect(createExtensionRegistry([])).toEqual([]);
});

it("accepts imported or computed slots without rewriting their components", () => {
  expect(() =>
    validateWebEntry(
      'import slots from "./slots"; export default { id: "sample", sdk: 1, slots: slots.map(slot => slot) } satisfies ExtensionModule;',
      "sample",
    ),
  ).not.toThrow();
  const component = () => null;
  const module: ExtensionModule = {
    id: "sample",
    sdk: 1,
    slots: [{ kind: "settings", id: "prefs", title: "Preferences", component }],
  };
  expect(createExtensionRegistry([module])[0]?.slot.component).toBe(component);
});

it("reads the exported module rather than unrelated ids or SDK numbers in source", () => {
  expect(() =>
    validateWebEntry(
      'const unrelated = {id: "other", sdk: 2}; export default {id: "sample", sdk: 1, slots: []}',
      "sample",
    ),
  ).not.toThrow();
  expect(() =>
    validateWebEntry(
      'const good = {id: "sample", sdk: 1}; export default {id: "other", sdk: 1, slots: []}',
      "sample",
    ),
  ).toThrow(/module id/);
});

it("rejects SDK and module id mismatches at build time", () => {
  expect(() =>
    validateWebEntry('export default { id: "sample", sdk: 2, slots: [] }', "sample"),
  ).toThrow(/sdk: 1/);
  expect(() =>
    validateWebEntry('export default { id: "other", sdk: 1, slots: [] }', "sample"),
  ).toThrow(/module id must be "sample"/);
  expect(() =>
    validateWebEntry('export default { id: "sample", sdk: 1, slots: [] }', "sample"),
  ).not.toThrow();
});

it("validates slot addresses and modules before registering", () => {
  const module: ExtensionModule = {
    id: "sample",
    sdk: 1,
    slots: [{ kind: "settings", id: "prefs", title: "Preferences", component: () => null }],
  };
  expect(createExtensionRegistry([module]).map((entry) => entry.key)).toEqual(["sample:prefs"]);
  expect(() => validateExtensionModule(module, "different")).toThrow(/module id/);
  expect(() =>
    validateExtensionModule({ ...module, slots: [...module.slots, ...module.slots] }, "sample"),
  ).toThrow(/duplicate/);
});
