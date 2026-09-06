import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { schema, type Db } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { tinyPdf } from "@launchos/channels/pdf";
import { createAccessEntry } from "../access/access-entries.js";
import { setEnqueue } from "../events/emit.js";
import { createProject } from "../projects/crud.js";
import { addMilestone, reachMilestone } from "../projects/milestones.js";
import { setPhaseStatus } from "../projects/phases.js";
import { seedOrgWithClient } from "../tasks/test-fixtures.js";
import { deliveryReportDocumentHtml, deliveryReportHtml } from "./document.js";
import { buildDeliveryReport } from "./report.js";
import { countersignDeliveryReport, renderDeliveryReport, sendDeliveryReport } from "./send.js";
import { DeliveryRefused, getDeliverySignOff } from "./shared.js";
import { getPublicDeliveryReport, signOffDelivery } from "./sign-off.js";

setEnqueue(async () => {});

const storage = await mkdtemp(join(tmpdir(), "launchos-delivery-"));
const ENV = {
  STORAGE_DIR: storage,
  SECRETS_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  APP_URL: "https://os.launchflow.test",
};
const DEPS = { render: async () => tinyPdf("Handover") };
const NOW = new Date("2026-09-07T10:00:00Z");

afterAll(async () => {
  await rm(storage, { recursive: true, force: true });
});

/** The password a client's website dashboard is behind. It must never be printed. */
const PASSWORD = "hunter2-correct-horse-battery";
/** A password somebody pasted into the notes field despite the form saying not to. */
const NOTED_PASSWORD = "the-ssh-key-passphrase-is-Tr0ub4dor";
const USERNAME = "graysadmin";

async function fixture(db: Db) {
  const seeded = await seedOrgWithClient(db);
  const [site] = await db.insert(schema.sites).values({
    organisationId: seeded.organisationId,
    clientId: seeded.clientId,
    name: "grayscabline.co.uk",
    primaryUrl: "https://grayscabline.co.uk",
  }).returning();
  await db.insert(schema.monitors).values({
    organisationId: seeded.organisationId,
    siteId: site!.id,
    target: "https://grayscabline.co.uk",
    intervalSeconds: 300,
  });
  const created = await createProject(db, seeded.organisationId, {
    clientId: seeded.clientId,
    name: "Website and booking engine",
    summary: "A new site with online booking.",
    status: "active",
    actorKind: "user",
    actorId: seeded.ownerUserId,
    now: NOW,
  });
  return { ...seeded, siteId: site!.id, project: created.project, phases: created.phases };
}

describe("buildDeliveryReport", () => {
  it("compiles the project, its sites, its monitoring and the care plan", async () => {
    await withTestDb(async (db) => {
      const { organisationId, ownerUserId, project, phases } = await fixture(db);
      const design = phases.find((phase) => phase.key === "design")!;
      await setPhaseStatus(db, organisationId, {
        projectId: project.id, phaseId: design.id, status: "done", actorKind: "user", actorId: ownerUserId, now: NOW,
      });
      const shown = await addMilestone(db, organisationId, {
        projectId: project.id, title: "Booking engine live", actorKind: "user", actorId: ownerUserId,
      });
      await addMilestone(db, organisationId, {
        projectId: project.id, title: "Stripe keys rotated", clientVisible: false, actorKind: "user", actorId: ownerUserId,
      });
      await reachMilestone(db, organisationId, {
        projectId: project.id, milestoneId: shown.id, reachedAt: NOW, actorKind: "user", actorId: ownerUserId,
      });

      const report = await buildDeliveryReport(db, organisationId, { projectId: project.id });

      expect(report.clientName).toBe("Grays CabLine");
      expect(report.phases.map((phase) => phase.name)).toContain("Design");
      // An internal milestone is dropped in the compile, not in the template:
      // this document gets emailed and forwarded.
      expect(report.milestones.map((milestone) => milestone.title)).toEqual(["Booking engine live"]);
      expect(report.sites).toEqual([{ name: "grayscabline.co.uk", url: "https://grayscabline.co.uk", live: true }]);
      expect(report.monitors).toEqual([
        { siteName: "grayscabline.co.uk", target: "https://grayscabline.co.uk", intervalSeconds: 300 },
      ]);
      expect(report.care?.packageName).toBe("Website + SEO + Social");
      expect(report.care?.covers).toContain("4 social posts a month");
      expect(report.signOff).toBeNull();
    });
  });

  it("refuses another organisation's project", async () => {
    await withTestDb(async (db) => {
      const { project } = await fixture(db);
      const [other] = await db.insert(schema.organisations)
        .values({ name: "Other", slug: `o-${randomUUID()}` }).returning();

      await expect(buildDeliveryReport(db, other!.id, { projectId: project.id }))
        .rejects.toThrow(DeliveryRefused);
      await expect(signOffDelivery(db, other!.id, {
        token: "not-this-organisations-token", signedName: "A", signedEmail: "a@b.test",
      })).rejects.toThrow(DeliveryRefused);
    });
  });
});

describe("the delivery report and secrets", () => {
  it("names where the logins live and cannot print one, not even from the notes field", async () => {
    await withTestDb(async (db) => {
      const { organisationId, clientId, siteId, project } = await fixture(db);
      await createAccessEntry(db, organisationId, {
        clientId,
        siteId,
        kind: "dashboard",
        label: "WordPress admin",
        url: "https://grayscabline.co.uk/wp-admin",
        username: USERNAME,
        secret: PASSWORD,
        notes: `Read-only MySQL user as well. ${NOTED_PASSWORD}`,
        actorKind: "user",
      }, ENV);
      await createAccessEntry(db, organisationId, {
        clientId,
        kind: "server",
        label: "Hetzner box",
        host: "88.198.146.183",
        port: 22,
        username: "root",
        actorKind: "user",
      }, ENV);

      const html = await deliveryReportHtml(db, organisationId, { projectId: project.id }, ENV);

      // What the client is told: which doors exist, and where they are.
      expect(html).toContain("Your logins");
      expect(html).toContain("WordPress admin");
      expect(html).toContain("https://grayscabline.co.uk/wp-admin");
      expect(html).toContain("88.198.146.183:22");
      expect(html).toContain("We hold the password");
      expect(html).toContain("No password held");

      // And what it can never say. The stored password, the one somebody
      // pasted into the notes, the notes themselves and the usernames are all
      // absent — because the query behind this section fetched none of them.
      expect(html).not.toContain(PASSWORD);
      expect(html).not.toContain(NOTED_PASSWORD);
      expect(html).not.toContain("Read-only MySQL user");
      expect(html).not.toContain(USERNAME);
      expect(html).not.toContain("root");

      // Belt and braces: no ciphertext envelope either, however it were
      // reached. `secret_ciphertext` starts `v1.`, so the raw column value
      // cannot be hiding in the markup.
      const [stored] = await db.select({ secret: schema.clientAccessEntries.secretCiphertext })
        .from(schema.clientAccessEntries)
        .where(and(
          eq(schema.clientAccessEntries.organisationId, organisationId),
          eq(schema.clientAccessEntries.label, "WordPress admin"),
        ));
      expect(stored!.secret).toMatch(/^v1\./);
      expect(html).not.toContain(stored!.secret!);
    });
  });

  it("escapes a client's own words rather than rendering them as markup", async () => {
    await withTestDb(async (db) => {
      const { organisationId, clientId, project } = await fixture(db);
      await createAccessEntry(db, organisationId, {
        clientId,
        kind: "other",
        label: `<script>alert("x")</script>`,
        actorKind: "user",
      }, ENV);

      const html = deliveryReportDocumentHtml(await buildDeliveryReport(db, organisationId, { projectId: project.id }), ENV);

      expect(html).not.toContain("<script>alert");
      expect(html).toContain("&lt;script&gt;");
    });
  });
});

describe("renderDeliveryReport", () => {
  it("stores the document, files it on the project and mints one sign-off token", async () => {
    await withTestDb(async (db) => {
      const { organisationId, ownerUserId, project } = await fixture(db);

      const first = await renderDeliveryReport(
        db, organisationId, { projectId: project.id, actorKind: "user", actorId: ownerUserId }, DEPS, ENV,
      );
      expect(first.document.kind).toBe("delivery_report");
      expect(first.document.subjectId).toBe(project.id);
      expect(first.documentUrl).toContain("/api/documents/");
      expect(first.signOffUrl).toContain("https://os.launchflow.test/d/");

      // A re-render replaces the document — there is only ever one current
      // handover before it is signed — but never the token, which is already
      // in the client's inbox.
      const second = await renderDeliveryReport(
        db, organisationId, { projectId: project.id, actorKind: "user", actorId: ownerUserId }, DEPS, ENV,
      );
      expect(second.document.id).not.toBe(first.document.id);
      expect(second.signOffUrl).toBe(first.signOffUrl);

      const [row] = await db.select().from(schema.projects).where(eq(schema.projects.id, project.id));
      expect(row!.deliveryReportDocumentId).toBe(second.document.id);
    });
  });

  it("queues the handover to the client and stamps when it went", async () => {
    await withTestDb(async (db) => {
      const { organisationId, clientId, ownerUserId, project } = await fixture(db);
      await db.update(schema.clients).set({ email: "office@grayscabline.test" })
        .where(eq(schema.clients.id, clientId));

      const sent = await sendDeliveryReport(
        db, organisationId, { projectId: project.id, actorKind: "user", actorId: ownerUserId }, DEPS, ENV,
      );

      expect(sent.messages).toHaveLength(1);
      expect(sent.messages[0]!.toEmail).toBe("office@grayscabline.test");
      expect(sent.messages[0]!.metadata["kind"]).toBe("delivery_notice");
      expect(sent.messages[0]!.body).toContain(sent.signOffUrl);
      const [row] = await db.select().from(schema.projects).where(eq(schema.projects.id, project.id));
      expect(row!.signOffSentAt).not.toBeNull();
    });
  });
});

describe("signOffDelivery", () => {
  it("records the signature once, closes the project and is idempotent under a double tap", async () => {
    await withTestDb(async (db) => {
      const { organisationId, ownerUserId, project } = await fixture(db);
      const rendered = await renderDeliveryReport(
        db, organisationId, { projectId: project.id, actorKind: "user", actorId: ownerUserId }, DEPS, ENV,
      );
      const token = rendered.report.project.signOffToken!;

      const first = await signOffDelivery(db, organisationId, {
        token,
        signedName: "Shumaila Khan",
        signedEmail: "Office@GraysCabLine.test",
        signatureSvg: "M10 10 C 20 20, 40 20, 50 10",
        ip: "203.0.113.9",
        userAgent: "Mozilla/5.0",
        now: NOW,
      });

      expect(first.alreadySignedOff).toBe(false);
      expect(first.delivered).toBe(true);
      expect(first.signOff.signedEmail).toBe("office@grayscabline.test");
      expect(first.signOff.ip).toBe("203.0.113.9");
      expect(first.project.deliveredAt).not.toBeNull();
      expect(first.project.status).toBe("delivered");

      // A second tap, with a different name: the first record stands.
      const second = await signOffDelivery(db, organisationId, {
        token, signedName: "Somebody Else", signedEmail: "else@grayscabline.test", now: NOW,
      });
      expect(second.alreadySignedOff).toBe(true);
      expect(second.signOff.signedName).toBe("Shumaila Khan");

      const rows = await db.select().from(schema.deliverySignOffs)
        .where(and(
          eq(schema.deliverySignOffs.organisationId, organisationId),
          eq(schema.deliverySignOffs.projectId, project.id),
        ));
      expect(rows).toHaveLength(1);

      const audits = await db.select().from(schema.auditLog).where(and(
        eq(schema.auditLog.organisationId, organisationId),
        eq(schema.auditLog.action, "delivery_report.signed_off"),
      ));
      expect(audits).toHaveLength(1);
    });
  });

  it("reads the report by token alone, then countersigns it once", async () => {
    await withTestDb(async (db) => {
      const { organisationId, ownerUserId, project } = await fixture(db);
      const rendered = await renderDeliveryReport(
        db, organisationId, { projectId: project.id, actorKind: "user", actorId: ownerUserId }, DEPS, ENV,
      );
      const token = rendered.report.project.signOffToken!;

      // The public page finds it with no organisation of its own.
      const publicReport = await getPublicDeliveryReport(db, token);
      expect(publicReport?.project.id).toBe(project.id);
      expect(await getPublicDeliveryReport(db, "not a token")).toBeNull();

      await signOffDelivery(db, organisationId, {
        token, signedName: "Shumaila Khan", signedEmail: "office@grayscabline.test", now: NOW,
      });

      const countersigned = await countersignDeliveryReport(db, organisationId, { projectId: project.id }, DEPS, ENV);
      expect(countersigned?.kind).toBe("delivery_report");
      // The stamp is the column, so a retried job renders nothing.
      expect(await countersignDeliveryReport(db, organisationId, { projectId: project.id }, DEPS, ENV)).toBeNull();

      const signOff = await getDeliverySignOff(db, organisationId, project.id);
      expect(signOff!.documentId).toBe(countersigned!.id);

      // And a signed report cannot be re-rendered underneath the signature.
      await expect(renderDeliveryReport(db, organisationId, { projectId: project.id }, DEPS, ENV))
        .rejects.toThrow(DeliveryRefused);
    });
  });
});
