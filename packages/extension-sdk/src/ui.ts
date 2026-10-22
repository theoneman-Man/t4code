// Public UI declarations mirror host primitives without importing the host application graph.
import type { ComponentType, ComponentProps, CSSProperties, ReactNode } from "react";
import type { useRender } from "@base-ui/react/use-render";
import type { Dialog as D } from "@base-ui/react/dialog";
import type { Menu as M } from "@base-ui/react/menu";
import type { Select as S } from "@base-ui/react/select";
import type { Tooltip as T } from "@base-ui/react/tooltip";
import type { Toggle as TogglePrimitive } from "@base-ui/react/toggle";
import type { ToggleGroup as ToggleGroupPrimitive } from "@base-ui/react/toggle-group";
import type { Input as InputPrimitive } from "@base-ui/react/input";
import type { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import type { ScrollArea as ScrollPrimitive } from "@base-ui/react/scroll-area";

type Div = ComponentProps<"div">;
export type ButtonVariant =
  | "default"
  | "destructive"
  | "destructive-outline"
  | "ghost"
  | "ghost-muted"
  | "ghost-destructive"
  | "glass"
  | "link"
  | "media-close"
  | "media-navigation"
  | "outline"
  | "overlay"
  | "secondary"
  | "warning-outline";
export type ButtonSize =
  | "compact"
  | "default"
  | "icon"
  | "icon-lg"
  | "icon-micro"
  | "icon-tiny"
  | "icon-sm"
  | "icon-xl"
  | "icon-xs"
  | "lg"
  | "micro"
  | "sm"
  | "sm-multiline"
  | "xl"
  | "xs";
export declare const Button: ComponentType<
  useRender.ComponentProps<"button"> & { variant?: ButtonVariant; size?: ButtonSize }
>;
export declare const Badge: ComponentType<
  useRender.ComponentProps<"span"> & {
    size?: "control" | "default" | "lg" | "sm";
    variant?:
      | "default"
      | "secondary"
      | "destructive"
      | "error"
      | "outline"
      | "success"
      | "warning"
      | "info"
      | "label";
  }
>;
export declare const Checkbox: ComponentType<CheckboxPrimitive.Root.Props>;
export declare const Input: ComponentType<
  Omit<InputPrimitive.Props, "size"> & {
    size?: "sm" | "compact" | "default" | "lg" | number;
    font?: "default" | "mono";
    unstyled?: boolean;
    nativeInput?: boolean;
  }
>;
export declare const Textarea: ComponentType<
  ComponentProps<"textarea"> & { size?: "sm" | "default" | "lg" | number; unstyled?: boolean }
>;
export declare const Skeleton: ComponentType<Div & { shape?: "block" | "card" | "pill" }>;
export declare const ScrollArea: ComponentType<
  ScrollPrimitive.Root.Props & {
    scrollFade?: boolean;
    scrollFadePadding?: boolean;
    scrollbarGutter?: boolean;
    hideScrollbars?: boolean;
    chainVerticalScroll?: boolean;
    radius?: "inherit" | "none";
    viewportTabIndex?: number;
  }
>;
type ToggleStyle = {
  variant?: "default" | "pill" | "ghost" | "outline" | "segmented";
  size?: "compact" | "default" | "lg" | "segmented" | "sm" | "xs";
};
export declare const Toggle: ComponentType<TogglePrimitive.Props & ToggleStyle>;
export declare const ToggleGroup: ComponentType<ToggleGroupPrimitive.Props & ToggleStyle>;
export declare const ToggleGroupItem: typeof Toggle;
export declare const Dialog: typeof D.Root;
export declare const DialogTrigger: ComponentType<D.Trigger.Props>;
export declare const DialogPortal: ComponentType<D.Portal.Props>;
export declare const DialogClose: ComponentType<D.Close.Props>;
export declare const DialogBackdrop: ComponentType<
  D.Backdrop.Props & { variant?: "default" | "media" }
>;
export declare const DialogOverlay: typeof DialogBackdrop;
export declare const DialogViewport: ComponentType<D.Viewport.Props>;
export declare const DialogPopup: ComponentType<
  D.Popup.Props & {
    showCloseButton?: boolean;
    bottomStickOnMobile?: boolean;
    variant?: "default" | "media";
  }
>;
export declare const DialogContent: typeof DialogPopup;
export declare const DialogHeader: ComponentType<Div>;
export declare const DialogFooter: ComponentType<Div & { variant?: "default" | "bare" }>;
export declare const DialogTitle: ComponentType<D.Title.Props>;
export declare const DialogDescription: ComponentType<D.Description.Props>;
export declare const DialogPanel: ComponentType<Div & { scrollFade?: boolean }>;
export declare const Sheet: typeof D.Root;
export declare const SheetPortal: ComponentType<D.Portal.Props>;
export declare const SheetBackdrop: ComponentType<D.Backdrop.Props>;
export declare const SheetOverlay: typeof SheetBackdrop;
export declare const SheetPopup: ComponentType<
  D.Popup.Props & {
    showCloseButton?: boolean;
    keepMounted?: boolean;
    transitionDurationMs?: number;
    side?: "right" | "left" | "top" | "bottom";
    variant?: "default" | "inset";
    style?: CSSProperties;
  }
>;
export declare const SheetContent: typeof SheetPopup;
export declare const SheetHeader: ComponentType<Div>;
export declare const SheetTitle: ComponentType<D.Title.Props>;
export declare const SheetDescription: ComponentType<D.Description.Props>;
export declare const Menu: typeof M.Root;
export declare const MenuTrigger: ComponentType<M.Trigger.Props>;
type MenuPosition = Pick<
  M.Positioner.Props,
  "align" | "sideOffset" | "alignOffset" | "side" | "anchor"
>;
export declare const MenuPopup: ComponentType<
  M.Popup.Props & MenuPosition & { keepMounted?: boolean; width?: "default" | "content" }
>;
export declare const MenuGroup: ComponentType<M.Group.Props>;
export declare const MenuItem: ComponentType<
  M.Item.Props & {
    inset?: boolean;
    density?: "default" | "touch";
    variant?: "default" | "destructive" | "ghost";
  }
>;
export declare const MenuItemLabel: ComponentType<ComponentProps<"span">>;
export declare const MenuCheckboxItem: ComponentType<
  M.CheckboxItem.Props & { variant?: "default" | "switch" }
>;
export declare const MenuRadioGroup: ComponentType<M.RadioGroup.Props>;
export declare const MenuRadioItem: ComponentType<M.RadioItem.Props & { hideIndicator?: boolean }>;
export declare const MenuRadioItemIndicator: ComponentType<M.RadioItemIndicator.Props>;
export declare const MenuGroupLabel: ComponentType<M.GroupLabel.Props & { inset?: boolean }>;
export declare const MenuSeparator: ComponentType<M.Separator.Props>;
export declare const MenuShortcut: ComponentType<ComponentProps<"kbd">>;
export declare const MenuSub: typeof M.SubmenuRoot;
export declare const MenuSubTrigger: ComponentType<M.SubmenuTrigger.Props>;
export declare const MenuSubPopup: typeof MenuPopup;
export declare const TooltipProvider: typeof T.Provider;
export declare const Tooltip: typeof T.Root;
export declare const TooltipTrigger: ComponentType<T.Trigger.Props>;
export declare const TooltipPopup: ComponentType<
  T.Popup.Props &
    Pick<T.Positioner.Props, "side" | "sideOffset" | "align" | "alignOffset"> & {
      variant?: "default" | "glass" | "code";
      anchor?: T.Positioner.Props["anchor"];
      children?: ReactNode;
    }
>;
export declare const TooltipScrollDismissArea: ComponentType<Div>;
export declare const Select: typeof S.Root;
type SelectStyle = {
  size?: "compact" | "default" | "lg" | "sm" | "xs";
  variant?: "default" | "ghost";
};
export declare const SelectTrigger: ComponentType<
  S.Trigger.Props & SelectStyle & { icon?: ReactNode }
>;
export declare const SelectButton: ComponentType<
  useRender.ComponentProps<"button"> & Pick<SelectStyle, "size">
>;
export declare const SelectValue: ComponentType<S.Value.Props>;
export declare const SelectPopup: ComponentType<
  S.Popup.Props &
    Pick<
      S.Positioner.Props,
      "side" | "sideOffset" | "align" | "alignOffset" | "alignItemWithTrigger" | "anchor"
    > & { matchTriggerWidth?: boolean }
>;
export declare const SelectContent: typeof SelectPopup;
export declare const SelectItem: ComponentType<S.Item.Props & { hideIndicator?: boolean }>;
export declare const SelectGroup: ComponentType<S.Group.Props>;
export declare const SelectGroupLabel: ComponentType<S.GroupLabel.Props>;
export declare const toastManager: ReturnType<
  typeof import("@base-ui/react/toast").Toast.createToastManager
>;
type ClassValue =
  | string
  | number
  | bigint
  | boolean
  | null
  | undefined
  | ClassValue[]
  | Record<string, unknown>;
export declare function cn(...inputs: ClassValue[]): string;
