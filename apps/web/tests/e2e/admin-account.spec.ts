import { expect, test, type Locator, type Page } from "@playwright/test";
import { OWNER } from "./seed-credentials";
import { signIn } from "./sign-in";

// `next dev` compiles a route the first time it is requested, which can take
// longer than the 5s default expect timeout on a cold start.
const COLD_COMPILE = 60_000;

/**
 * The password this spec parks the owner on for a few seconds, on the way to
 * putting the seeded one back.
 *
 * **Fixed, never generated.** This test changes the credential every other spec
 * signs in with, so if it dies between the two changes the account is left on
 * this value — and a value written down here is one anyone can sign in with and
 * put right from `/account`. A `Date.now()` in it would leave the seeded owner
 * on a password nobody knows, and the only way back would be deleting the
 * `account` row and re-running `pnpm db:bootstrap`.
 *
 * Long enough to clear `minPasswordLength` (12) and never the seeded default.
 */
const TEMPORARY = "e2e-temporary-password";

/**
 * Follows a link and waits for the destination to render. A plain `click()` is
 * not enough against `next dev`: a Fast Refresh full reload cancels the
 * in-flight client navigation. Same helper as `admin-team.spec.ts`.
 */
async function follow(page: Page, link: Locator, heading: string | RegExp): Promise<void> {
  const target = page.getByRole("heading", { name: heading });
  await expect(async () => {
    await link.click();
    await expect(target).toBeVisible({ timeout: 20_000 });
  }).toPass({ timeout: COLD_COMPILE, intervals: [1_000] });
}

/**
 * Submits the form on a freshly loaded `/account` and waits for the action to
 * land, whichever way it went.
 *
 * The reload is what makes the wait meaningful: `useActionState` starts idle on
 * a new page, so the message that appears afterwards is this submit's result
 * and not the previous submit's still sitting on screen. Without it a second
 * attempt would "pass" on the first attempt's message.
 */
async function submit(page: Page, current: string, next: string): Promise<void> {
  await page.reload();
  const form = page.getByRole("form", { name: "Change password" });
  await expect(form.getByTestId("password-changed")).toHaveCount(0);
  await expect(form.getByTestId("password-error")).toHaveCount(0);

  await form.getByLabel("Current password").fill(current);
  await form.getByLabel("New password").fill(next);
  await form.getByRole("button", { name: "Change password" }).click();
  await expect(form.getByTestId("password-changed").or(form.getByTestId("password-error"))).toBeVisible({
    timeout: COLD_COMPILE,
  });
}

async function changePassword(page: Page, current: string, next: string): Promise<void> {
  await submit(page, current, next);
  await expect(page.getByTestId("password-changed")).toBeVisible();
  await expect(page.getByTestId("password-error")).toHaveCount(0);
}

/**
 * The seeded owner changes their own password and changes it straight back, so
 * the seed's credentials — which every other spec signs in with — still work
 * afterwards. What is *not* undone is the side effect being tested: stamping
 * `organisation_members.initial_password_set_at` is one-way, and it is what
 * takes "Re-issue password" off that member's row on /team for good.
 */
test("an owner changes their own password, and /team stops offering a re-issue", async ({ page }) => {
  test.setTimeout(300_000);

  await signIn(page);
  await follow(page, page.getByRole("link", { name: "Account" }), "Account");
  // Scoped to `main`: the sidebar's identity block shows the same address.
  await expect(page.getByRole("main").getByText(OWNER.email)).toBeVisible();

  // The wrong current password is refused, and refused with a message rather
  // than Next's error page — the action never throws at the browser.
  await submit(page, `${OWNER.password}-wrong`, TEMPORARY);
  await expect(page.getByTestId("password-error")).toBeVisible();
  await expect(page.getByTestId("password-changed")).toHaveCount(0);

  await changePassword(page, OWNER.password, TEMPORARY);
  // Still signed in: the change revokes the member's *other* sessions and keeps
  // this one, so the very next request must not bounce to /sign-in.
  await page.reload();
  await expect(page.getByRole("heading", { name: "Account" })).toBeVisible();

  // /team no longer offers to re-issue a password for this member: the
  // credential is now their own, and `reissueOneTimePassword` would refuse it.
  await follow(page, page.getByRole("navigation").getByRole("link", { name: "Team" }), "Team");
  const row = page.getByRole("row").filter({ hasText: OWNER.email });
  await expect(row).toBeVisible();
  await expect(row.getByRole("button", { name: "Re-issue password" })).toHaveCount(0);

  // Back to the seeded password, so the rest of the suite (and the next `pnpm
  // db:seed`-less run) can still sign in.
  await follow(page, page.getByRole("link", { name: "Account" }), "Account");
  await changePassword(page, TEMPORARY, OWNER.password);

  // Proven, not assumed: sign out and back in with the seeded credentials.
  await page.context().clearCookies();
  await signIn(page);
});
