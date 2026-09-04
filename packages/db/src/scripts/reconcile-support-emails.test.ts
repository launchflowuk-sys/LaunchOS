import { describe, expect, it } from "vitest";
import { planReconciliation } from "./reconcile-support-emails.js";

const client = (orgSlug: string, slug: string, supportEmail: string | null) => ({
  id: `${orgSlug}-${slug}`,
  organisationId: orgSlug,
  orgSlug,
  slug,
  supportEmail,
});

describe("planReconciliation", () => {
  it("re-points addresses left on the migration's literal domain", () => {
    const changes = planReconciliation(
      [client("launchflow", "acme", "acme@support.launchflow.co.uk")],
      "support.launchflow.io",
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]!.to).toBe("acme@support.launchflow.io");
  });

  it("leaves rows that already match alone", () => {
    expect(planReconciliation([client("launchflow", "acme", "acme@support.example")], "support.example")).toEqual([]);
  });

  it("fills in a NULL address", () => {
    const changes = planReconciliation([client("launchflow", "acme", null)], "support.example");
    expect(changes).toEqual([{ client: expect.anything(), from: null, to: "acme@support.example" }]);
  });

  it("suffixes the later organisation when two orgs share a client slug", () => {
    // `slug` is unique per organisation but `support_email` is unique globally,
    // so the same slug in two orgs is the collision migration 0007 could not see.
    const changes = planReconciliation(
      [client("launchflow", "acme", null), client("other-agency", "acme", null)],
      "support.example",
    );
    expect(changes.map((c) => c.to)).toEqual(["acme@support.example", "acme-other-agency@support.example"]);
  });

  it("keeps the first organisation's existing address untouched on a collision", () => {
    const changes = planReconciliation(
      [client("launchflow", "acme", "acme@support.example"), client("other-agency", "acme", null)],
      "support.example",
    );
    expect(changes.map((c) => c.to)).toEqual(["acme-other-agency@support.example"]);
  });

  it("never produces a duplicate address, however many organisations collide", () => {
    const changes = planReconciliation(
      [
        client("a", "acme", null),
        client("b", "acme", null),
        client("c", "acme", null),
        // An address that would collide with the suffix chosen for org b.
        client("c", "acme-b", null),
      ],
      "support.example",
    );
    const targets = changes.map((c) => c.to);
    expect(targets).toHaveLength(4);
    expect(new Set(targets).size).toBe(4);
  });
});
