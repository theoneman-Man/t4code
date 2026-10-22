import { createContext, use, useState, useImperativeHandle, type Ref } from "react";
import type { ExtContext } from "@t3tools/extension-sdk";
import type { ExtFetch } from "./events";

export const ExtensionRuntimeContext = createContext<{
  extensionId: string;
  context: ExtContext;
  fetch: ExtFetch;
} | null>(null);

export function useExtensionRuntime() {
  const runtime = use(ExtensionRuntimeContext);
  if (!runtime) throw new Error("Extension hooks must run inside an extension slot.");
  return runtime;
}

export function useExtensionClass() {
  return `t4-ext t4-ext-${useExtensionRuntime().extensionId}`;
}

export function extensionRootClass(id: string) {
  return ["t4-ext", `t4-ext-${id}`].join(" ");
}

export function useExtensionPortalProps<Props extends { ref?: Ref<HTMLDivElement> | undefined }>(
  props: Props,
) {
  const { extensionId } = useExtensionRuntime();
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  useImperativeHandle(props.ref, () => node!, [node]);
  const attach = (element: HTMLDivElement | null) => {
    setNode(element);
    if (element) {
      // Host primitives own their internal portals. Tag the body child containing the popup
      // through its public ref, including portals nested beneath another extension popup.
      let root: HTMLElement = element;
      while (root.parentElement && root.parentElement !== element.ownerDocument.body)
        root = root.parentElement;
      root.classList.add("t4-ext", `t4-ext-${extensionId}`);
      root.dataset.extensionId = extensionId;
    }
  };
  return { ...props, ref: attach };
}
