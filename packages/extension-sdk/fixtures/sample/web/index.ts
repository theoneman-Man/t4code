import { lazy } from "react";
import type { ExtensionModule } from "@t3tools/extension-sdk";

const View = lazy(() => import("./SampleView"));
const Icon = () => null;

export default {
  id: "sample",
  sdk: 1,
  slots: [
    {
      kind: "workspace",
      id: "workspace",
      title: "Sample workspace",
      icon: Icon,
      component: View,
      keepAlive: true,
    },
    { kind: "rightPanel", id: "panel", title: "Sample panel", icon: Icon, component: View },
  ],
} satisfies ExtensionModule;
