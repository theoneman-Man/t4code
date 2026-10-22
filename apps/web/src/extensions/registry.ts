import modules from "virtual:t4-extensions";
import type { ExtensionModule, ExtSlot } from "@t3tools/extension-sdk";

export function validateExtensionModule(module: ExtensionModule, id: string): ExtensionModule {
  if (module.sdk !== 1) throw new Error(`Extension ${id}: module sdk must be 1.`);
  if (module.id !== id) throw new Error(`Extension ${id}: module id is ${module.id}.`);
  const seen = new Set<string>();
  for (const slot of module.slots) {
    if (!/^[a-z][a-z0-9-]*$/.test(slot.id) || seen.has(slot.id)) {
      throw new Error(`Extension ${id}: invalid or duplicate slot id ${slot.id}.`);
    }
    seen.add(slot.id);
  }
  return module;
}

export function createExtensionRegistry(extensions: readonly ExtensionModule[]) {
  return extensions.flatMap((extension) =>
    validateExtensionModule(extension, extension.id).slots.map((slot) => ({
      extensionId: extension.id,
      key: `${extension.id}:${slot.id}`,
      slot,
    })),
  );
}

export const extensionSlots = createExtensionRegistry(modules);
export type RegisteredSlot = (typeof extensionSlots)[number];
export const findExtensionSlot = (key: string, kind?: ExtSlot["kind"]) =>
  extensionSlots.find((entry) => entry.key === key && (!kind || entry.slot.kind === kind));
