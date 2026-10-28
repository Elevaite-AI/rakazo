import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

const sessions = JSON.parse(
  await readFile(new URL(".local/sessions.json", import.meta.url), "utf8"),
);
const browser = await chromium.launch({ headless: true });
const errors = [];
try {
  const pages = {};
  for (const name of ["owner", "member", "outsider"]) {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    const token = Object.entries(sessions).find(([, s]) => s.id === `pilot-${name}`)[0];
    await page.goto(`http://127.0.0.1:15440/#${token}`);
    await page.getByText(`Signed in as pilot-${name}`, { exact: true }).waitFor();
    pages[name] = page;
  }
  assert.equal(
    await pages.outsider.getByRole("button", { name: "Team workspace", exact: true }).count(),
    0,
  );
  assert.equal(
    await pages.member.getByRole("button", { name: "owner — Private", exact: true }).count(),
    0,
  );
  assert.equal(
    await pages.owner.getByRole("button", { name: "member — Private", exact: true }).count(),
    0,
  );
  for (const name of ["owner", "member"])
    await pages[name].getByRole("button", { name: "Team workspace", exact: true }).click();
  await pages.member.getByLabel("Message", { exact: true }).fill("Shared browser proof");
  await pages.member.getByRole("button", { name: "Send", exact: true }).click();
  await pages.owner.getByText("pilot-member: Shared browser proof", { exact: true }).waitFor();
  await pages.owner.screenshot({
    path: new URL(".local/shared-before.png", import.meta.url).pathname,
    fullPage: true,
  });
  const start = performance.now();
  await pages.owner.getByRole("button", { name: "Remove access", exact: true }).click();
  await pages.member.getByText("Access removed", { exact: true }).waitFor();
  assert.equal(await pages.member.locator("#workspace").isVisible(), false);
  await pages.member
    .getByRole("button", { name: "Team workspace", exact: true })
    .waitFor({ state: "detached" });
  assert.ok(
    await pages.member.getByRole("button", { name: "member — Private", exact: true }).isVisible(),
  );
  await pages.member.screenshot({
    path: new URL(".local/member-revoked.png", import.meta.url).pathname,
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        browser: "chromium",
        isolatedSessions: 3,
        sharedConversation: true,
        privateNavigationHidden: true,
        revocationUiMs: Math.round(performance.now() - start),
        revokedContentCleared: true,
        privateSpaceRetained: true,
        pageErrors: errors,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
