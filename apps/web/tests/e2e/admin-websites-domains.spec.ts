import { createDomain } from "@launchos/core";
import { createDb, schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { expect, test } from "@playwright/test";
import { signIn } from "./sign-in";
import { DATABASE_URL } from "./seed-credentials";

const SEEDED_SITE_NAME = "Grays CabLine";

// First visit to a route compiles it in `next dev`; give it the same budget as the other specs.
const COLD_COMPILE = 90_000;

test("websites and domains screens: navigate to a domain and manage its DNS records", async ({ page }) => {
  // Domain creation lives on the client page (Task 10); this spec seeds one
  // directly against the local dev database, attached to a seeded site, so
  // this screen's own DNS-record flow can be exercised independently.
  const db = createDb(DATABASE_URL);
  const [organisation] = await db.select().from(schema.organisations).where(eq(schema.organisations.slug, "launchflow"));
  if (!organisation) throw new Error("seed organisation not found — run `pnpm db:seed` first");

  const [site] = await db
    .select()
    .from(schema.sites)
    .where(and(eq(schema.sites.organisationId, organisation.id), eq(schema.sites.name, SEEDED_SITE_NAME)));
  if (!site) throw new Error(`seeded site "${SEEDED_SITE_NAME}" not found — run \`pnpm db:seed\` first`);

  const stamp = Date.now();
  const domainName = `e2e-dns-${stamp}.example.test`;
  await createDomain(db, organisation.id, {
    clientId: site.clientId,
    siteId: site.id,
    name: domainName,
    actorKind: "system",
  });

  try {
    await signIn(page);

    await page.getByRole("navigation").getByRole("link", { name: "Websites" }).click();
    await expect(page.getByRole("heading", { name: "Websites" })).toBeVisible();
    // The client's own name link appears further down the same row, so scope
    // to the row and take the first (website name) link.
    await page.getByRole("row", { name: SEEDED_SITE_NAME }).getByRole("link").first().click();

    await expect(page.getByRole("heading", { name: SEEDED_SITE_NAME })).toBeVisible();
    await page.getByRole("link", { name: domainName }).click();

    await expect(page.getByRole("heading", { name: domainName })).toBeVisible({ timeout: COLD_COMPILE });

    await page.getByLabel("Value").fill("203.0.113.10");
    await page.getByRole("button", { name: "Add record" }).click();
    await expect(page.getByRole("cell", { name: "203.0.113.10" })).toBeVisible();

    await page.getByLabel("Value").fill("not-an-ip");
    await page.getByRole("button", { name: "Add record" }).click();
    await expect(page.getByText(/is not a valid IPv4 address/i)).toBeVisible();
  } finally {
    await db.$client.end();
  }
});
