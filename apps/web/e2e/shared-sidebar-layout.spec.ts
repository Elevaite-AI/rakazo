import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("conversation-only workspace uses the native sidebar at full and icon widths", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signup(page, `shared-sidebar-${Date.now()}@rakazo.test`, "password12", "Shared Sample");
  await completeOnboarding(page);
  await page.route("**/rpc/bootstrap*", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    if (body.json?.me) body.json.me.conversationOnly = true;
    await route.fulfill({ response, json: body });
  });
  await page.reload();
  const sidebar = page.getByTestId("bots-sidebar");
  const row = sidebar.locator("[data-roster-bot-id]").first();
  await expect(row).toBeVisible();
  await expect(sidebar.getByTestId("sidebar-search-trigger")).toHaveCount(0);
  await expect(sidebar.getByTestId("create-menu-trigger")).toHaveCount(0);
  await expect(sidebar.getByTestId("sidebar-footer")).toBeVisible();
  await captureScreenshot(page, testInfo, "shared-sidebar-expanded");

  await sidebar.getByTestId("minimize-bots-sidebar").click();
  await expect(sidebar).toHaveCSS("width", "72px");
  await expect(row).toHaveAccessibleName(/Chief/);
  await expect(sidebar.getByTestId("user-menu-trigger")).toBeVisible();
  expect(await sidebar.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  await captureScreenshot(page, testInfo, "shared-sidebar-collapsed");
  await row.click();
  await expect(row).toHaveAttribute("aria-current", "page");
  await sidebar.getByTestId("restore-bots-sidebar").click();
  await expect(sidebar).toHaveCSS("width", "316px");
  await sidebar.getByTestId("user-menu-trigger").click();
  await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Settings" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(sidebar).toHaveCSS("width", "316px");
  expect(await sidebar.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  await captureScreenshot(page, testInfo, "shared-sidebar-mobile");
});
