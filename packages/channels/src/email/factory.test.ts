import { describe, expect, it } from "vitest";
import { createEmailAdapter, smtpConfigFromEnv } from "./factory.js";

/** Enough for the factory to build a transport; the port is what each case varies. */
const smtp = { EMAIL_ADAPTER: "smtp", SMTP_HOST: "smtp.launchflow.test" } as NodeJS.ProcessEnv;

describe("createEmailAdapter", () => {
  it("is the mock unless EMAIL_ADAPTER is exactly smtp", () => {
    expect(createEmailAdapter({} as NodeJS.ProcessEnv).name).toBe("mock");
    expect(createEmailAdapter({ EMAIL_ADAPTER: "mock" } as NodeJS.ProcessEnv).name).toBe("mock");
    expect(createEmailAdapter({ EMAIL_ADAPTER: "SMTP", SMTP_HOST: "h" } as NodeJS.ProcessEnv).name).toBe("mock");
  });

  it("reads a blank EMAIL_ADAPTER as unset rather than as a fourth adapter name", () => {
    expect(createEmailAdapter({ EMAIL_ADAPTER: "" } as NodeJS.ProcessEnv).name).toBe("mock");
  });

  it("throws — never downgrades — when EMAIL_ADAPTER=smtp cannot be built", () => {
    // A downgrade here would black-hole every reply while reporting it sent;
    // `packages/integrations/src/adapter-guard.ts` mirrors this as UNBUILDABLE.
    expect(() => createEmailAdapter({ EMAIL_ADAPTER: "smtp" } as NodeJS.ProcessEnv))
      .toThrow(/SMTP_HOST is required when EMAIL_ADAPTER=smtp/);
    expect(() => createEmailAdapter({ EMAIL_ADAPTER: "smtp", SMTP_HOST: "" } as NodeJS.ProcessEnv))
      .toThrow(/SMTP_HOST is required when EMAIL_ADAPTER=smtp/);
  });

  it("builds an SMTP adapter once the host is set", () => {
    expect(createEmailAdapter(smtp).name).toBe("smtp");
  });
});

describe("smtpConfigFromEnv", () => {
  it("defaults an unset port to 587", () => {
    expect(smtpConfigFromEnv(smtp)).toMatchObject({ host: "smtp.launchflow.test", port: 587, secure: false });
  });

  it("treats `SMTP_PORT=` — a variable created and left blank — as unset", () => {
    // The bug this closes: `z.coerce.number()` turned "" into 0, `.positive()`
    // rejected it, and the worker died at boot on a bare `Invalid input` while
    // the adapter guard — which sees the same env with blanks stripped — had
    // just printed `email: "smtp"`. The same normalisation now runs in both.
    expect(smtpConfigFromEnv({ ...smtp, SMTP_PORT: "" }).port).toBe(587);
  });

  it("treats blank credentials as absent, so no auth block is built from empty strings", () => {
    expect(smtpConfigFromEnv({ ...smtp, SMTP_USER: "", SMTP_PASS: "" })).toMatchObject({ user: undefined, pass: undefined });
  });

  it("still refuses a port that is present and not a port", () => {
    expect(() => smtpConfigFromEnv({ ...smtp, SMTP_PORT: "0" })).toThrow();
    expect(() => smtpConfigFromEnv({ ...smtp, SMTP_PORT: "-25" })).toThrow();
    expect(() => smtpConfigFromEnv({ ...smtp, SMTP_PORT: "not-a-port" })).toThrow();
  });

  it("turns on TLS for 465 and leaves it off elsewhere, which is what the port means", () => {
    expect(smtpConfigFromEnv({ ...smtp, SMTP_PORT: "465" }).secure).toBe(true);
    expect(smtpConfigFromEnv({ ...smtp, SMTP_PORT: "587" }).secure).toBe(false);
  });
});
