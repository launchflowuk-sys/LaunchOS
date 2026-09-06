import { schema } from "@launchos/db";
import { hashPassword, symmetricDecrypt } from "better-auth/crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAuth } from "./auth";
import { getDb } from "./db";

/**
 * The two-factor flow end to end, against the real Better Auth instance and
 * the real database — no mock of the plugin, and a TOTP code this test
 * computes from the secret it was handed rather than one typed in by hand.
 *
 * It runs outside a rollback transaction on purpose: Better Auth writes
 * through its own connection, so a transaction here would be invisible to it.
 * Everything is created under one throwaway organisation and deleted again in
 * `afterAll`; the `user` row cascades to sessions, credentials and the
 * `two_factor` row.
 */
const PASSWORD = "a-long-enough-test-password";

let organisationId: string;
let userId: string;
let ownerId: string;
let email: string;

/** Fold a response's `set-cookie` onto the jar, dropping any it cleared. */
function jar(previous: string, response: Response): string {
  const values = new Map<string, string>();
  for (const pair of previous.split("; ").filter(Boolean)) {
    const [name, ...rest] = pair.split("=");
    values.set(name!, rest.join("="));
  }
  for (const raw of response.headers.getSetCookie()) {
    const [pair] = raw.split(";");
    const [name, ...rest] = pair!.split("=");
    const value = rest.join("=");
    if (value) values.set(name!, value);
    else values.delete(name!);
  }
  return [...values].map(([name, value]) => `${name}=${value}`).join("; ");
}

function headersFor(cookies: string): Headers {
  return new Headers({ cookie: cookies });
}

async function makeMember(role: "owner" | "staff", address: string) {
  const id = `u-${crypto.randomUUID()}`;
  await getDb().insert(schema.user).values({ id, name: "Test", email: address, emailVerified: true });
  await getDb().insert(schema.account).values({
    id: crypto.randomUUID(),
    accountId: id,
    providerId: "credential",
    issuer: "local:credential",
    userId: id,
    password: await hashPassword(PASSWORD),
  });
  await getDb().insert(schema.organisationMembers).values({ organisationId, userId: id, role });
  return id;
}

async function signIn(): Promise<{ cookies: string; twoFactorRedirect: boolean }> {
  const response = await getAuth().api.signInEmail({
    body: { email, password: PASSWORD },
    asResponse: true,
  });
  const body: unknown = await response.clone().json();
  const redirected =
    typeof body === "object" && body !== null && "twoFactorRedirect" in body && body.twoFactorRedirect === true;
  return { cookies: jar("", response), twoFactorRedirect: redirected };
}

async function auditActions() {
  const rows = await getDb()
    .select({ action: schema.auditLog.action })
    .from(schema.auditLog)
    .where(eq(schema.auditLog.organisationId, organisationId));
  return rows.map((r) => r.action);
}

beforeAll(async () => {
  const [org] = await getDb()
    .insert(schema.organisations)
    .values({ name: "Two-factor test", slug: `tf-${crypto.randomUUID()}` })
    .returning();
  organisationId = org!.id;
  email = `tf-${crypto.randomUUID()}@example.com`;
  ownerId = await makeMember("owner", `owner-${email}`);
  userId = await makeMember("staff", email);
});

afterAll(async () => {
  if (!organisationId) return;
  await getDb().delete(schema.user).where(eq(schema.user.id, userId));
  await getDb().delete(schema.user).where(eq(schema.user.id, ownerId));
  await getDb().delete(schema.organisations).where(eq(schema.organisations.id, organisationId));
});

describe("two-factor authentication", () => {
  it("enrols, challenges, spends a backup code, regenerates and turns off — auditing each one", async () => {
    const auth = getAuth();

    // ---- enrolment ----------------------------------------------------
    const first = await signIn();
    expect(first.twoFactorRedirect).toBe(false);

    const enrol = await auth.api.enableTwoFactor({
      body: { password: PASSWORD },
      headers: headersFor(first.cookies),
    });
    // `enable` is a union over the method: only the TOTP arm carries a URI and
    // codes, and this configuration has no other arm to take.
    if (!("totpURI" in enrol)) throw new Error("expected a TOTP enrolment");
    expect(enrol.totpURI).toBeTruthy();
    expect(enrol.backupCodes).toHaveLength(10);

    // The factor is not live until a code proves the app was set up. This is
    // the property that stops a half-finished enrolment locking anybody out.
    const [pending] = await getDb()
      .select({ enabled: schema.user.twoFactorEnabled })
      .from(schema.user)
      .where(eq(schema.user.id, userId));
    expect(pending!.enabled).toBe(false);

    // The `secret` in the URI is base32, which is what an authenticator app
    // reads; the raw seed is the encrypted column. Decrypting that and asking
    // Better Auth's own generator for the six digits is the closest a test can
    // get to a person reading their phone.
    expect(new URL(enrol.totpURI).searchParams.get("secret")).toBeTruthy();
    const [stored] = await getDb()
      .select({ secret: schema.twoFactor.secret, verified: schema.twoFactor.verified })
      .from(schema.twoFactor)
      .where(eq(schema.twoFactor.userId, userId));
    expect(stored!.verified).toBe(false);
    expect(stored!.secret).not.toContain(new URL(enrol.totpURI).searchParams.get("secret")!);

    const secret = await symmetricDecrypt({ key: process.env.BETTER_AUTH_SECRET!, data: stored!.secret });
    const { code } = await auth.api.generateTOTP({ body: { secret } });
    expect(code).toMatch(/^\d{6}$/);

    const confirmed = await auth.api.verifyTOTP({
      body: { code },
      headers: headersFor(first.cookies),
      asResponse: true,
    });
    expect(confirmed.status).toBe(200);

    const [live] = await getDb()
      .select({ enabled: schema.user.twoFactorEnabled })
      .from(schema.user)
      .where(eq(schema.user.id, userId));
    expect(live!.enabled).toBe(true);
    expect(await auditActions()).toEqual(["security.two_factor_enabled"]);

    // ---- the password alone stops working -----------------------------
    const challenged = await signIn();
    expect(challenged.twoFactorRedirect).toBe(true);

    // ---- a wrong code is filed, and hands out no session ---------------
    await expect(
      auth.api.verifyTOTP({ body: { code: "000000" }, headers: headersFor(challenged.cookies) }),
    ).rejects.toThrow();
    expect(await auditActions()).toContain("security.two_factor_challenge_failed");

    // ---- a backup code signs in once, and is spent --------------------
    const spent = enrol.backupCodes[0]!;
    const usedResponse = await auth.api.verifyBackupCode({
      body: { code: spent },
      headers: headersFor(challenged.cookies),
      asResponse: true,
    });
    expect(usedResponse.status).toBe(200);
    const signedIn = jar(challenged.cookies, usedResponse);
    expect(await auditActions()).toContain("security.two_factor_backup_code_used");

    const secondUse = await signIn();
    await expect(
      auth.api.verifyBackupCode({ body: { code: spent }, headers: headersFor(secondUse.cookies) }),
    ).rejects.toThrow();

    // ---- the owner hears about the two events that matter --------------
    const notifications = await getDb()
      .select({ kind: schema.notifications.kind, userId: schema.notifications.userId })
      .from(schema.notifications)
      .where(eq(schema.notifications.organisationId, organisationId));
    expect(notifications.map((n) => n.kind)).toContain("security.two_factor_backup_code_used");
    expect(notifications.every((n) => n.userId === ownerId)).toBe(true);

    // ---- replacing the codes needs the password ------------------------
    await expect(
      auth.api.generateBackupCodes({ body: { password: "not-the-password" }, headers: headersFor(signedIn) }),
    ).rejects.toThrow();

    const replaced = await auth.api.generateBackupCodes({
      body: { password: PASSWORD },
      headers: headersFor(signedIn),
    });
    expect(replaced.backupCodes).toHaveLength(10);
    expect(replaced.backupCodes).not.toContain(spent);
    expect(await auditActions()).toContain("security.two_factor_backup_codes_regenerated");

    // ---- turning it off needs the password, not just the session -------
    await expect(
      auth.api.disableTwoFactor({ body: { password: "not-the-password" }, headers: headersFor(signedIn) }),
    ).rejects.toThrow();
    const [stillOn] = await getDb()
      .select({ enabled: schema.user.twoFactorEnabled })
      .from(schema.user)
      .where(eq(schema.user.id, userId));
    expect(stillOn!.enabled).toBe(true);

    await auth.api.disableTwoFactor({
      body: { password: PASSWORD },
      headers: headersFor(signedIn),
      asResponse: true,
    });
    const [off] = await getDb()
      .select({ enabled: schema.user.twoFactorEnabled })
      .from(schema.user)
      .where(eq(schema.user.id, userId));
    expect(off!.enabled).toBe(false);
    expect(await auditActions()).toContain("security.two_factor_disabled");

    const disabledNotice = await getDb()
      .select({ kind: schema.notifications.kind })
      .from(schema.notifications)
      .where(eq(schema.notifications.organisationId, organisationId));
    expect(disabledNotice.map((n) => n.kind)).toContain("security.two_factor_disabled");

    // ---- and the password alone works again ---------------------------
    expect((await signIn()).twoFactorRedirect).toBe(false);
  });
});
