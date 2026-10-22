declare module "virtual:t4-extensions" {
  const extensions: import("@t3tools/extension-sdk").ExtensionModule[];
  export default extensions;
}

declare module "*?extension-fixture" {
  const extension: import("@t3tools/extension-sdk").ExtensionModule;
  export default extension;
}
