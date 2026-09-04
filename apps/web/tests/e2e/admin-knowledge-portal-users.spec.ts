import { expect, test, type Locator, type Page } from "@playwright/test";
import { signIn } from "./sign-in";

// The dev server compiles a route the first time it is requested, which can
// take longer than the 5s default expect timeout on a cold start. The first
// assertion after each new route gets a budget that covers that compile. 30s is
// not enough on a busy dev server: a first navigation to `/clients/[id]/support`
// was measured past it while other work was compiling.
const COLD_COMPILE = 60_000;

/**
 * Follows a link and waits for the destination to render.
 *
 * A plain `click()` is not enough against `next dev`: a Fast Refresh full
 * reload — which fires whenever anything in the tree is saved while the suite
 * runs — cancels the in-flight client navigation, and the run then sits on the
 * old screen until the assertion times out. Retrying the click is the only
 * reliable answer; the assertion it waits on is the real one.
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
 * client bundle `next dev` has not finished serving does nothing at all, so the
 * click is retried until the dialog is actually there.
 */
async function openDialog(page: Page, trigger: Locator): Promise<Locator> {
  const dialog = page.getByRole("dialog");
  await expect(async () => {
    await trigger.click();
    await expect(dialog).toBeVisible({ timeout: 10_000 });
  }).toPass({ timeout: COLD_COMPILE, intervals: [1_000] });
  return dialog;
}

/** A word Postgres tokenises as one lexeme, so `plainto_tsquery` matches it exactly. */
function uniqueWord(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}`;
}

test("write a knowledge article, preview it, publish it and find it with search", async ({ page }) => {
  // Four routes and two server actions, each compiled on first use, which does
  // not fit Playwright's 30s per-test default on a cold dev server.
  test.setTimeout(300_000);

  const token = uniqueWord("zephyrine");
  const title = `E2E Article ${token}`;

  await signIn(page);
  await follow(page, page.getByRole("navigation").getByRole("link", { name: "Knowledge Base" }), "Knowledge Base");
  await follow(page, page.getByRole("link", { name: "New article" }), "New article");

  await page.getByLabel("Title").fill(title);
  await page.getByLabel("Tags").fill(`e2e, ${token}`);
  await page.getByLabel("Article body").fill(`# Heading ${token}\n\nHow to fix ${token} on a client site.`);

  // Preview renders the Markdown rather than the source, and switching back
  // keeps what was typed.
  await page.getByRole("button", { name: "Preview" }).click();
  await expect(page.getByRole("heading", { name: `Heading ${token}` })).toBeVisible();
  await page.getByRole("button", { name: "Write" }).click();
  await expect(page.getByLabel("Article body")).toHaveValue(new RegExp(token));

  await page.getByLabel("Published").check();
  await page.getByRole("button", { name: "Create article" }).click();

  // Redirected to the article's own page, pre-filled and ready to edit.
  await expect(page.getByRole("heading", { name: title })).toBeVisible({ timeout: COLD_COMPILE });
  await expect(page.getByLabel("Title")).toHaveValue(title);
  await expect(page.getByLabel("Published")).toBeChecked();

  await follow(page, page.getByRole("navigation").getByRole("link", { name: "Knowledge Base" }), "Knowledge Base");
  await expect(page.getByRole("link", { name: title })).toBeVisible({ timeout: COLD_COMPILE });

  // Full-text search finds it by a word that appears only in this article.
  await page.getByLabel("Search articles").fill(token);
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByRole("link", { name: title })).toBeVisible({ timeout: COLD_COMPILE });
  await expect(page.getByRole("link", { name: title })).toHaveCount(1);
});

test("invite a portal user from a client and see the one-time password exactly once", async ({ page }) => {
  test.setTimeout(300_000);

  const email = `e2e-portal-${Date.now()}@example.test`;

  await signIn(page);
  await follow(page, page.getByRole("navigation").getByRole("link", { name: "Clients" }), "Clients");
  await follow(page, page.getByRole("link", { name: "Grays CabLine" }), "Grays CabLine");

  // The Support tab is enabled by this plan, so the client's own support
  // address is reachable without leaving the client.
  await follow(page, page.getByRole("link", { name: "Support", exact: true }), "Support address");
  await follow(page, page.getByRole("link", { name: "Portal users" }), "Portal users");

  const dialog = await openDialog(page, page.getByRole("button", { name: "Invite user" }));
  await dialog.getByLabel("Full name").fill("E2E Portal User");
  await dialog.getByLabel("Email address").fill(email);
  await dialog.getByRole("button", { name: "Create portal user" }).click();

  const password = page.getByTestId("one-time-password");
  await expect(password).toBeVisible({ timeout: COLD_COMPILE });
  await expect(password).not.toHaveText("");

  // `exact` because the row's action cell also carries the address in its
  // button label (Suspend/Reactivate).
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("cell", { name: email, exact: true })).toBeVisible();

  // Reopening starts a fresh invite: the form is back and the previous user's
  // password is gone. The dialog body is remounted on close for exactly this —
  // `router.refresh()` alone would leave the old action state in place and make
  // a second invite impossible without a full page reload.
  const reopened = await openDialog(page, page.getByRole("button", { name: "Invite user" }));
  await expect(reopened.getByLabel("Full name")).toBeVisible();
  await expect(reopened.getByLabel("Full name")).toHaveValue("");
  await expect(page.getByTestId("one-time-password")).toHaveCount(0);
  await reopened.getByRole("button", { name: "Cancel" }).click();

  // Shown once only: reloading the page must not reveal it again.
  await page.reload();
  await expect(page.getByTestId("one-time-password")).toHaveCount(0);
  await expect(page.getByRole("cell", { name: email, exact: true })).toBeVisible();
});
