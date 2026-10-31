import { hostScheme } from "@t3tools/extension-sdk/branding";
import { ORCHESTRATION_PROTOCOL_HEADER } from "@t3tools/contracts";

// Extension views proxy through /ext/*, so their write methods and receipt headers must pass preflight.
export const browserApiCorsAllowedMethods = ["GET", "POST", "PUT", "OPTIONS"] as const;
export const browserApiCorsAllowedHeaders = [
  "authorization",
  "b3",
  "traceparent",
  "content-type",
  "dpop",
  "idempotency-key",
  "x-request-id",
  ORCHESTRATION_PROTOCOL_HEADER,
] as const;

export const DESKTOP_RENDERER_ORIGINS = [
  `${hostScheme("t3code", false)}://app`,
  `${hostScheme("t3code-dev", true)}://app`,
] as const;
