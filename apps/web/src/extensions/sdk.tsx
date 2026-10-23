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
  const fetch = useExtFetch();
  const [media, setMedia] = useState<{ path: string; url: string; fetch: typeof fetch } | null>(
    null,
  );
  useEffect(() => {
    const abort = new AbortController();
    let url: string | undefined;
    void fetch(path, { signal: abort.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Extension media unavailable.");
        const blob = await response.blob();
        if (abort.signal.aborted) return;
        url = URL.createObjectURL(blob);
        setMedia({ path, url, fetch });
      })
      .catch(() => {});
    return () => {
      abort.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [fetch, path]);
  return media?.path === path && media.fetch === fetch ? media.url : null;
}
