import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { hostDesktopScheme } from "./hostScheme.ts";
import { providerAuthReturnUrl } from "./providerAuthReturnUrl.ts";
import { codexAuthHandoffUrl, readCodexAuthHandoff } from "./codexAuthHandoff.ts";

it.each([null, { scheme: "sample" }])(
  "keeps sign-in generation and validation on the host scheme %j",
  (config) => {
    vi.stubGlobal("__T4_HOST_BRANDING__", config);
    try {
      const authorizationUrl = new URL("https://auth.openai.com/api/accounts/authorize");
      authorizationUrl.search = new URLSearchParams({
        client_id: "dynamic_agent_client",
        response_type: "code",
        redirect_uri: "http://127.0.0.1:54213/auth/callback",
        state: "a".repeat(43),
        code_challenge_method: "S256",
        code_challenge: "b".repeat(43),
      }).toString();
      for (const development of [false, true]) {
        const scheme = config
          ? `sample${development ? "-dev" : ""}`
          : development
            ? "t3code-dev"
            : "t3code";
        expect(hostDesktopScheme(development)).toBe(scheme);
        const input = {
          authorizationUrl: authorizationUrl.toString(),
          returnUrl: `${scheme}://app/welcome#agents:environment`,
          environmentId: EnvironmentId.make("environment"),
          instanceId: ProviderInstanceId.make("instance"),
          flowId: "flow",
        };
        expect(providerAuthReturnUrl(input.returnUrl)).toBe(input.returnUrl);
        const link = codexAuthHandoffUrl(input, development);
        expect(new URL(link).protocol).toBe(`${scheme}:`);
        expect(readCodexAuthHandoff(link, development)).toEqual(input);
        expect(readCodexAuthHandoff(link, !development)).toBeUndefined();
        expect(providerAuthReturnUrl(`${scheme}://attacker/welcome`)).toBeUndefined();
      }
    } finally {
      vi.unstubAllGlobals();
    }
  },
);
