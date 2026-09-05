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

/** Printed when the automatic restore below could not put the seed back. */
const RECOVERY =
  `RECOVERY: the seeded owner (${OWNER.email}) may still be on "${TEMPORARY}". ` +
  `Sign in with it at /sign-in and set the seeded password back on /account, ` +
  `or re-run the bootstrap. Until then every other e2e spec will fail at sign-in.`;

/**
 * Follows a link and waits for the destination to render. A plain `click()` is
 * not enough against `next dev`: a Fast Refresh full reload cancels the
 * in-flight client navigation. Same helper as `admin-team.spec.ts`.
 *
 * The rail's "Account" link is looked up with `exact: true` at every call site:
 * a role name is matched as a case-insensitive substring by default, and the
 * dashboard's activity feed carries links like "Google ads account connected:
 * …", which made a bare `name: "Account"` a strict-mode violation as soon as an
 * ad account existed.
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
 * Signs in from a clean cookie jar and reports whether that password works,
 * rather than failing the way `signIn` does. Used only by the restore hook,
 * which has to ask "which password is this account on?" and cannot assume.
 */
async function canSignIn(page: Page, password: string): Promise<boolean> {
  await page.context().clearCookies();
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(OWNER.email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  try {
    await page.waitForURL("/", { timeout: 30_000 });
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible({ timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * The safety net. The test below changes the credential every other spec signs
 * in with, and a failure, timeout or Ctrl-C between its two changes would leave
 * the whole suite locked out — an incident that has already happened once, and
 * whose symptom is a two-minute navigation timeout in an unrelated spec.
 *
 * So the restore does not live in the test body, where a mid-test failure skips
 * it. It runs whatever happened, asks the app which password the account is on,
 * and only acts if the seeded one has stopped working. When it cannot put the
 * seed back it says exactly how to, in the run's own output.
 */
test.afterEach(async ({ page }) => {
  // The hook gets its own budget; the test's `setTimeout` does not cover it,
  // and this may have to sign in twice and submit a form on a cold route.
  test.setTimeout(180_000);

  if (await canSignIn(page, OWNER.password)) return;

  if (!(await canSignIn(page, TEMPORARY))) {
    throw new Error(`Neither the seeded nor the temporary password signs in. ${RECOVERY}`);
  }

  try {
    await follow(page, page.getByRole("link", { name: "Account", exact: true }), "Account");
    await changePassword(page, TEMPORARY, OWNER.password);
  } catch (error) {
    throw new Error(`${RECOVERY} (restore failed: ${String(error)})`);
  }
  expect(await canSignIn(page, OWNER.password)).toBe(true);
});

/**
 * The seeded owner changes their own password and changes it straight back, so
 * the seed's credentials — which every other spec signs in with — still work
 * afterwards. What is *not* undone is the side effect being tested: stamping
 * `organisation_members.initial_password_set_at` is one-way, and it is what
 * takes "Re-issue password" off that member's row on /team for good.
 *
 * The file is named `zz-` so Playwright, which orders spec files
 * alphabetically, runs it last: if the restore above ever does fail, the specs
 * it would lock out have already run.
 */
test("an owner changes their own password, and /team stops offering a re-issue", async ({ page }) => {
  test.setTimeout(300_000);

  await signIn(page);
  await follow(page, page.getByRole("link", { name: "Account", exact: true }), "Account");
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
  // db:seed`-less run) can still sign in. The `afterEach` above is the net for
  // the case where this line is never reached.
  await follow(page, page.getByRole("link", { name: "Account", exact: true }), "Account");
  await changePassword(page, TEMPORARY, OWNER.password);

  // Proven, not assumed: sign out and back in with the seeded credentials.
  await page.context().clearCookies();
  await signIn(page);
});
