import { expect, test, type Locator, type Page } from "@playwright/test";
import { signIn } from "./sign-in";

// `next dev` compiles a route the first time it is requested, which can take
// longer than the 5s default expect timeout on a cold start.
const COLD_COMPILE = 60_000;

/**
 * Follows a link and waits for the destination to render.
 *
 * A plain `click()` is not enough against `next dev`: a Fast Refresh full
 * reload — which fires whenever anything in the tree is saved while the suite
 * runs — cancels the in-flight client navigation, and the run then sits on the
 * old screen until the assertion times out. Same helper as
 * `admin-knowledge-portal-users.spec.ts`.
 */
async function follow(page: Page, link: Locator, heading: string | RegExp): Promise<void> {
  const target = page.getByRole("heading", { name: heading });
  await expect(async () => {
    await link.click();
    await expect(target).toBeVisible({ timeout: 20_000 });
  }).toPass({ timeout: COLD_COMPILE, intervals: [1_000] });
}

/**
 * Opens a dialog and waits for it to be on screen. Clicking a button whose
 * client bundle `next dev` has not finished serving does nothing at all, and a
 * Fast Refresh full reload — which fires whenever anything in the tree is saved
 * while the suite runs — closes an open dialog, so the click is retried until
 * the dialog is actually there. Same helper as
 * `admin-knowledge-portal-users.spec.ts`.
 */
async function openDialog(page: Page, trigger: Locator): Promise<Locator> {
  const dialog = page.getByRole("dialog");
  await expect(async () => {
    await trigger.click();
    await expect(dialog).toBeVisible({ timeout: 10_000 });
  }).toPass({ timeout: COLD_COMPILE, intervals: [1_000] });
  return dialog;
}

test("add a team member and see the one-time password exactly once", async ({ page }) => {
  // Two routes and two server actions, each compiled on first use.
  test.setTimeout(300_000);

  const email = `e2e-staff-${Date.now()}@example.test`;

  await signIn(page);
  await follow(page, page.getByRole("navigation").getByRole("link", { name: "Team" }), "Team");

  const dialog = await openDialog(page, page.getByRole("button", { name: "Add member" }));
  await dialog.getByLabel("Full name").fill("E2E Staff");
  await dialog.getByLabel("Email address").fill(email);
  await dialog.getByRole("button", { name: "Create member" }).click();

  const password = page.getByTestId("one-time-password");
  await expect(password).toBeVisible({ timeout: COLD_COMPILE });
  await expect(password).not.toHaveText("");

  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("cell", { name: email })).toBeVisible();

  // Reopening starts a fresh add: the form is back and the previous member's
  // password is gone. The dialog body is remounted on close for exactly this —
  // `router.refresh()` alone would leave the old action state in place and make
  // a second add impossible without a full page reload.
  const reopened = await openDialog(page, page.getByRole("button", { name: "Add member" }));
  await expect(reopened.getByLabel("Full name")).toBeVisible();
  await expect(reopened.getByLabel("Full name")).toHaveValue("");
  await expect(page.getByTestId("one-time-password")).toHaveCount(0);
  await reopened.getByRole("button", { name: "Cancel" }).click();

  // Shown once only: reloading the page must not reveal it again.
  await page.reload();
  await expect(page.getByTestId("one-time-password")).toHaveCount(0);
});

test("re-issue a member's password and see it exactly once", async ({ page }) => {
  test.setTimeout(300_000);

  const email = `e2e-reissue-${Date.now()}@example.test`;

  await signIn(page);
  await follow(page, page.getByRole("navigation").getByRole("link", { name: "Team" }), "Team");

  // A member of this test's own making: "Re-issue password" is offered only for
  // an active member who is still on the password an owner issued them, which
  // is exactly what Add member leaves behind.
  const add = await openDialog(page, page.getByRole("button", { name: "Add member" }));
  await add.getByLabel("Full name").fill("E2E Reissue");
  await add.getByLabel("Email address").fill(email);
  await add.getByRole("button", { name: "Create member" }).click();
  await expect(page.getByTestId("one-time-password")).toBeVisible({ timeout: COLD_COMPILE });
  await page.getByRole("button", { name: "Done" }).click();

  const row = page.getByRole("row").filter({ hasText: email });
  await expect(row).toBeVisible();

  const dialog = await openDialog(page, row.getByRole("button", { name: "Re-issue password" }));
  await expect(dialog.getByRole("heading", { name: "Re-issue password for E2E Reissue" })).toBeVisible();
  await dialog.getByRole("button", { name: "Re-issue password" }).click();

  const password = page.getByTestId("one-time-password");
  await expect(password).toBeVisible({ timeout: COLD_COMPILE });
  await expect(password).not.toHaveText("");

  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByTestId("one-time-password")).toHaveCount(0);

  // The password just minted is live — it invalidated the old one and signed
  // that member out — so reopening must show the confirmation form again, never
  // the password. Without the remount, `useActionState` would still hold the
  // issued result and hand it to whoever reaches this tab next.
  const reopened = await openDialog(page, row.getByRole("button", { name: "Re-issue password" }));
  await expect(reopened.getByRole("heading", { name: "Re-issue password for E2E Reissue" })).toBeVisible();
  await expect(page.getByTestId("one-time-password")).toHaveCount(0);
  await reopened.getByRole("button", { name: "Cancel" }).click();

  // Shown once only: reloading the page must not reveal it again.
  await page.reload();
  await expect(page.getByTestId("one-time-password")).toHaveCount(0);
});
