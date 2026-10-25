import { EnvironmentId } from "@t3tools/contracts";
import { assetEnvironment } from "../state/assets";
import { useAtomQueryRunner } from "../state/use-atom-query-runner";
import { usePreparedConnection } from "../state/session";
import { extensionMediaUrls, mediaRefreshDelay } from "./media";
import { useEffect, useEffectEvent, useState, type ComponentProps } from "react";
import { extensionEventStreams } from "./events";
import { useExtensionRuntime, useExtensionPortalProps } from "./context";
import { useRenderedAppearance } from "../hooks/useTheme";
import { cn } from "../lib/utils";
import type { ExtensionEvent } from "@t3tools/extension-sdk";
import {
  DialogPopup as HostDialogPopup,
  DialogPortal as HostDialogPortal,
} from "../components/ui/dialog";
import {
  SheetPopup as HostSheetPopup,
  SheetPortal as HostSheetPortal,
} from "../components/ui/sheet";
import {
  MenuPopup as HostMenuPopup,
  MenuSubPopup as HostMenuSubPopup,
} from "../components/ui/menu";
import { TooltipPopup as HostTooltipPopup } from "../components/ui/tooltip";
import { SelectPopup as HostSelectPopup } from "../components/ui/select";

export type * from "@t3tools/extension-sdk";
export * from "@t3tools/extension-sdk/manifest";
export * from "@t3tools/extension-sdk/protocol";
export * from "@t3tools/extension-sdk/threads";
export { useExtThreads } from "./threads";
export type { ExtensionEvent } from "@t3tools/extension-sdk";
export { Button } from "../components/ui/button";
export { Badge } from "../components/ui/badge";
export { Checkbox } from "../components/ui/checkbox";
export { Input } from "../components/ui/input";
export { Textarea } from "../components/ui/textarea";
export { Skeleton } from "../components/ui/skeleton";
export { ScrollArea } from "../components/ui/scroll-area";
export { Toggle } from "../components/ui/toggle";
export { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group";
export { toastManager } from "../components/ui/toast";
export { cn };
export { openWorkspace, openPanel } from "./navigation";
export {
  Dialog,
  DialogTrigger,
  DialogClose,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogBackdrop,
  DialogOverlay,
  DialogViewport,
} from "../components/ui/dialog";
export {
  Sheet,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetBackdrop,
  SheetOverlay,
} from "../components/ui/sheet";
export {
  Menu,
  MenuTrigger,
  MenuGroup,
  MenuItem,
  MenuItemLabel,
  MenuCheckboxItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuGroupLabel,
  MenuSeparator,
  MenuShortcut,
  MenuSub,
  MenuSubTrigger,
} from "../components/ui/menu";
export {
  Tooltip,
  TooltipProvider,
  TooltipTrigger,
  TooltipScrollDismissArea,
} from "../components/ui/tooltip";
export {
  Select,
  SelectTrigger,
  SelectButton,
  SelectValue,
  SelectItem,
  SelectGroup,
  SelectGroupLabel,
} from "../components/ui/select";

export function DialogPortal(props: ComponentProps<typeof HostDialogPortal>) {
  const scopedProps = useExtensionPortalProps(props);
  return <HostDialogPortal {...scopedProps} />;
}
export function SheetPortal(props: ComponentProps<typeof HostSheetPortal>) {
  const scopedProps = useExtensionPortalProps(props);
  return <HostSheetPortal {...scopedProps} />;
}
export function DialogPopup(props: ComponentProps<typeof HostDialogPopup>) {
  const scopedProps = useExtensionPortalProps(props);
  return <HostDialogPopup {...scopedProps} />;
}
export function SheetPopup(props: ComponentProps<typeof HostSheetPopup>) {
  const scopedProps = useExtensionPortalProps(props);
  return <HostSheetPopup {...scopedProps} />;
}
export function MenuPopup(props: ComponentProps<typeof HostMenuPopup>) {
  const scopedProps = useExtensionPortalProps(props);
  return <HostMenuPopup {...scopedProps} />;
}
export function MenuSubPopup(props: ComponentProps<typeof HostMenuSubPopup>) {
  const scopedProps = useExtensionPortalProps(props);
  return <HostMenuSubPopup {...scopedProps} />;
}
export function TooltipPopup(props: ComponentProps<typeof HostTooltipPopup>) {
  const scopedProps = useExtensionPortalProps(props);
  return <HostTooltipPopup {...scopedProps} />;
}
export function SelectPopup(props: ComponentProps<typeof HostSelectPopup>) {
  const scopedProps = useExtensionPortalProps(props);
  return <HostSelectPopup {...scopedProps} />;
}
export { DialogPopup as DialogContent, SheetPopup as SheetContent, SelectPopup as SelectContent };

export function useExtContext() {
  return useExtensionRuntime().context;
}
export function useExtFetch() {
  return useExtensionRuntime().fetch;
}
export function useTheme(): "light" | "dark" {
  return useRenderedAppearance();
}
export function useExtEvents(topic: string, onEvent: (event: ExtensionEvent) => void) {
  const { extensionId, context, fetch } = useExtensionRuntime();
  const handleEvent = useEffectEvent(onEvent);
  useEffect(
    () =>
      extensionEventStreams.subscribe(
        `${context.environmentId}:${extensionId}`,
        fetch,
        topic,
        handleEvent,
      ),
    [context.environmentId, extensionId, fetch, topic],
  );
}
export function useExtMediaUrl(path: string): string | null {
  const { extensionId, context, fetch } = useExtensionRuntime();
  const environmentId = EnvironmentId.make(context.environmentId);
  const connection = usePreparedConnection(environmentId);
  const baseUrl = connection._tag === "Some" ? connection.value.httpBaseUrl : null;
  const issue = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });
  const issueUrl = useEffectEvent(async () => {
    const result = await issue({
      environmentId,
      input: { resource: { _tag: "extension-media", extensionId, path } },
    });
    if (result._tag !== "Success") throw new Error("Extension media URL unavailable.");
    return {
      url: result.value.relativeUrl,
      expiresAt: result.value.expiresAt,
      ttlMs: result.value.ttlMs,
    };
  });
  const key = JSON.stringify([environmentId, extensionId, path]);
  const [media, setMedia] = useState<{ key: string; url: string } | null>(null);
  useEffect(() => {
    if (!baseUrl) return;
    const abort = new AbortController();
    let blobUrl: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const value = await extensionMediaUrls(key, () => issueUrl());
        if (abort.signal.aborted) return;
        setMedia({ key, url: new URL(value.url, baseUrl).href });
        timer = setTimeout(() => void load(), mediaRefreshDelay(value.expiresAt));
      } catch {
        if (abort.signal.aborted) return;
        try {
          const response = await fetch(path, { signal: abort.signal });
          if (!response.ok) return;
          const blob = await response.blob();
          if (abort.signal.aborted) return;
          blobUrl = URL.createObjectURL(blob);
          setMedia({ key, url: blobUrl });
        } catch {}
      }
    };
    void load();
    return () => {
      abort.abort();
      clearTimeout(timer);
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [baseUrl, fetch, key, path]);
  return media?.key === key ? media.url : null;
}
