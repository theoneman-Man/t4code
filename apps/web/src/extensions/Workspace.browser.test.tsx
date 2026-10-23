import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "../../test/render";
import { WorkspaceSwitcher, withWorkspaceSwitcher } from "./Workspace";
import { ExtensionNavigationBridge } from "./navigation";
import "../index.css";

vi.mock("virtual:t4-extensions", () => ({
  default: [
    {
      id: "sample",
      sdk: 1,
      slots: [
        {
          kind: "workspace",
          id: "workspace",
          title: "Sample workspace",
          icon: () => <svg aria-hidden="true" />,
          component: () => <p>Sample content</p>,
        },
      ],
    },
  ],
}));
vi.mock("./SlotHost", () => ({ SlotHost: () => null }));
vi.mock("./hostContext", () => ({ useHostExtContext: () => null }));
vi.mock("../hooks/useThreadRouteTarget", () => ({ useThreadRouteRef: () => null }));
vi.mock("@t3tools/extension-sdk/branding", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/extension-sdk/branding")>()),
  hostBranding: { appName: "Example Host", logo: "/example.svg" },
}));

it("preserves the upstream header and renders no switcher without workspaces", async () => {
  const header = <a href="/">Original brand</a>;
  expect(withWorkspaceSwitcher(header, true, [])).toBe(header);
  await using screen = await render(
    <>
      {withWorkspaceSwitcher(header, true, [])}
      <WorkspaceSwitcher entries={[]} />
    </>,
  );
  await expect.element(screen.getByRole("link", { name: "Original brand" })).toBeVisible();
  await expect.element(screen.getByRole("button")).not.toBeInTheDocument();
});

it("overlays the branded header, selects a workspace and closes", async () => {
  await using screen = await render(
    <>
      <ExtensionNavigationBridge />
      <WorkspaceSwitcher />
    </>,
  );
  const trigger = screen.getByRole("button", { name: "Switch workspace" });
  await expect.element(trigger).toHaveTextContent("Example HostChat");
  await trigger.click();
  await expect.element(trigger).toHaveAttribute("aria-expanded", "true");
  await expect
    .element(page.getByRole("menuitemradio", { name: "Chat", exact: true }))
    .toHaveAttribute("aria-checked", "true");
  await page.getByRole("menuitemradio", { name: "Sample workspace", exact: true }).click();
  await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
  await expect.element(trigger).toHaveTextContent("Example HostSample workspace");
  await trigger.click();
  await expect
    .element(page.getByRole("menuitemradio", { name: "Sample workspace", exact: true }))
    .toHaveAttribute("aria-checked", "true");
  await page.getByRole("menuitem", { name: "Close workspace switcher" }).click();
  await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
  await expect.element(trigger).toHaveFocus();
});

it("supports keyboard selection and Escape without changing the workspace", async () => {
  await using screen = await render(
    <>
      <ExtensionNavigationBridge />
      <WorkspaceSwitcher />
    </>,
  );
  const trigger = screen.getByRole("button", { name: "Switch workspace" });
  await trigger.click();
  await userEvent.keyboard("{End}{Enter}");
  await expect.element(trigger).toHaveTextContent("Example HostSample workspace");
  await expect.element(trigger).toHaveFocus();
  await userEvent.keyboard("{ArrowDown}");
  await expect.element(page.getByRole("menu")).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
  await expect.element(trigger).toHaveFocus();
  await expect.element(trigger).toHaveTextContent("Example HostSample workspace");
  await userEvent.keyboard("{ArrowDown}{Home}{Enter}");
  await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
  await expect.element(trigger).toHaveFocus();
});

it("keeps the header overlay aligned and legible in light and dark themes", async () => {
  const root = document.documentElement;
  const originalClass = root.className;
  using _theme = {
    [Symbol.dispose]: () => {
      root.className = originalClass;
    },
  };
  await using screen = await render(<WorkspaceSwitcher />);
  const trigger = screen.getByRole("button", { name: "Switch workspace" });
  const backgrounds: string[] = [];
  for (const dark of [false, true]) {
    root.classList.toggle("dark", dark);
    await trigger.click();
    await expect.element(page.getByRole("menu")).toBeVisible();
    const popup = document.querySelector('[data-host-workspace="popup"]');
    const button = screen.container.querySelector('[data-host-workspace="trigger"]');
    expect(popup).toBeInstanceOf(HTMLElement);
    expect(button).toBeInstanceOf(HTMLElement);
    if (!(popup instanceof HTMLElement) || !(button instanceof HTMLElement))
      throw new Error("Missing switcher");
    expect(getComputedStyle(button).opacity).toBe("0");
    expect(button.getBoundingClientRect().width).toBe(160);
    expect(
      Math.abs(popup.getBoundingClientRect().top - button.getBoundingClientRect().top),
    ).toBeLessThan(3);
    backgrounds.push(getComputedStyle(popup).backgroundColor);
    expect(getComputedStyle(popup).backdropFilter).toContain("blur(24px)");
    await page.getByRole("menuitem", { name: "Close workspace switcher" }).click();
    await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
  }
  expect(backgrounds[0]).not.toBe(backgrounds[1]);
});
