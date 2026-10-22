import { expectTypeOf, it } from "vite-plus/test";
import type * as PublicSdk from "@t3tools/extension-sdk";
import type * as RuntimeSdk from "./sdk";

it("implements the SDK declarations used by external extension typechecks", () => {
  const contract = (runtime: typeof RuntimeSdk): typeof PublicSdk => runtime;
  expectTypeOf(contract).returns.toEqualTypeOf<typeof PublicSdk>();
});
