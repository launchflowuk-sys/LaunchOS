import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schema } from "@launchos/db";
import type { Db } from "@launchos/db";
import type { ContentChannel } from "@launchos/db/schema";
import { MockImageGenAdapter, type GeneratedImage, type ImageGenAdapter, type ImageGenInput } from "@launchos/integrations";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { setClientBrand } from "../clients/brand.js";
import { createContentItem } from "./items.js";
import { headlineFrom, kickerFrom } from "./image-headline.js";
import { channelTakesImage, renderContentImage, IMAGE_CHANNELS } from "./render-image.js";
import { auditRows, contentFixture } from "./test-fixtures.js";

let storage: string;
let env: NodeJS.ProcessEnv;
beforeAll(async () => {
  storage = await mkdtemp(join(tmpdir(), "launchos-render-image-"));
  env = { STORAGE_DIR: storage, APP_URL: "https://os.test/" } as NodeJS.ProcessEnv;
});
afterAll(async () => { await rm(storage, { recursive: true, force: true }); });

const BODY = "Airport transfers from Grays, around the clock. Fixed fares agreed before you travel, and a driver who tracks your flight.";

/** A generator that costs real money, so the cap has something to count. Records every prompt it was asked for. */
class PricedAdapter implements ImageGenAdapter {
  readonly name = "openai" as const;
  readonly calls: ImageGenInput[] = [];
  async generate(input: ImageGenInput): Promise<GeneratedImage> {
    this.calls.push(input);
    return { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9, 9]), mime: "image/png", costPence: 4, model: "gpt-image-1" };
  }
}

async function seedItem(db: Db, orgId: string, clientId: string, over: { channel?: ContentChannel; body?: string | null; imagePrompt?: string } = {}) {
  return createContentItem(db, orgId, {
    clientId,
    channel: over.channel ?? "facebook",
    body: over.body === null ? undefined : (over.body ?? BODY),
    ...(over.imagePrompt ? { imagePrompt: over.imagePrompt } : {}),
  });
}

/** The brief, with or without the AI opt-in, written the way the Content tab will write it. */
async function seedBrief(db: Db, orgId: string, clientId: string, opts: { ai?: boolean; area?: string } = {}) {
  const metadata = opts.ai ? { images: { mode: "ai" } } : {};
  const area = opts.area ?? "Grays, Essex";
  await db.insert(schema.contentBriefs)
    .values({ organisationId: orgId, clientId, area, metadata })
    .onConflictDoUpdate({
      target: [schema.contentBriefs.organisationId, schema.contentBriefs.clientId],
      set: { area, metadata },
    });
}

const optInToAi = (db: Db, orgId: string, clientId: string) => seedBrief(db, orgId, clientId, { ai: true });

/** The PNG signature and the IHDR width and height, read straight out of the file. */
function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** An item that already carries a generated image, so a month has a spend to sum. */
async function seedSpend(db: Db, orgId: string, clientId: string, costPence: number, generatedAt: Date) {
  const item = await seedItem(db, orgId, clientId);
  await db.update(schema.contentItems)
    .set({ metadata: { image: { mode: "ai", model: "gpt-image-1", costPence, assetId: item.id, generatedAt: generatedAt.toISOString() } } })
    .where(eq(schema.contentItems.id, item.id));
}

function itemById(db: Db, itemId: string) {
  return db.select().from(schema.contentItems).where(eq(schema.contentItems.id, itemId));
}

describe("renderContentImage — template", () => {
  it("draws a branded graphic, stores it as a generated asset and stamps the item", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId, ownerId } = await contentFixture(db, { withSubscription: false });
      await setClientBrand(db, orgId, { clientId, primary: "#0B3D2E", accent: "#F4A300", wordmark: "Grays CabLine", actorId: ownerId });
      await seedBrief(db, orgId, clientId);
      const item = await seedItem(db, orgId, clientId);

      const result = await renderContentImage(db, orgId, { itemId: item.id, actorId: ownerId }, { imagegen: new MockImageGenAdapter() }, env);

      expect(result).toMatchObject({ rendered: true, itemId: item.id, mode: "template", costPence: 0 });
      if (!result.rendered) throw new Error("expected a render");
      expect(result.url).toBe(`https://os.test/api/assets/${result.assetId}`);
      expect(result.reason).toBeUndefined();

      const [asset] = await db.select().from(schema.contentAssets).where(eq(schema.contentAssets.id, result.assetId));
      expect(asset).toMatchObject({ source: "generated", mime: "image/png", clientId, alt: "Airport transfers from Grays, around the clock" });
      expect((await stat(join(storage, asset!.path))).size).toBe(asset!.sizeBytes);
      expect(pngSize(await readFile(join(storage, asset!.path)))).toEqual({ width: 1080, height: 1080 });

      const [after] = await itemById(db, item.id);
      expect(after!.imageUrl).toBe(result.url);
      expect(after!.metadata.image).toMatchObject({ mode: "template", model: "template", costPence: 0, assetId: result.assetId });
      expect((after!.metadata.image as { generatedAt: string }).generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(await auditRows(db, orgId, "content_item.image_rendered")).toHaveLength(1);
      expect(await auditRows(db, orgId, "content_asset.created")).toHaveLength(1);
    });
  });

  it("draws a landscape card for a blog post and a square for a feed", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId } = await contentFixture(db, { withSubscription: false });
      const blog = await createContentItem(db, orgId, { clientId, channel: "blog", title: "Five ways to cut your airport fare", body: BODY });
      const gbp = await seedItem(db, orgId, clientId, { channel: "gbp" });

      const drawn = [];
      for (const item of [blog, gbp]) {
        const result = await renderContentImage(db, orgId, { itemId: item.id }, { imagegen: new MockImageGenAdapter() }, env);
        if (!result.rendered) throw new Error(`expected a render, got ${result.reason}`);
        const [asset] = await db.select().from(schema.contentAssets).where(eq(schema.contentAssets.id, result.assetId));
        drawn.push({ ...asset!, bytes: await readFile(join(storage, asset!.path)) });
      }

      expect(pngSize(drawn[0]!.bytes)).toEqual({ width: 1200, height: 630 });
      expect(pngSize(drawn[1]!.bytes)).toEqual({ width: 1080, height: 1080 });
      // The blog's own title is the headline; the body is only a fallback.
      expect(drawn[0]!.alt).toBe("Five ways to cut your airport fare");
    });
  });
});

describe("renderContentImage — AI", () => {
  it("generates when the item has a prompt and the brief opted in, and records the model and cost", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId } = await contentFixture(db, { withSubscription: false });
      await optInToAi(db, orgId, clientId);
      const item = await seedItem(db, orgId, clientId, { imagePrompt: "A black taxi outside Grays station at dusk" });
      const imagegen = new MockImageGenAdapter();

      const result = await renderContentImage(db, orgId, { itemId: item.id }, { imagegen }, env);

      expect(result).toMatchObject({ rendered: true, mode: "ai", costPence: 0 });
      expect(imagegen.calls).toEqual([{ prompt: "A black taxi outside Grays station at dusk", size: "1024x1024" }]);
      const [after] = await itemById(db, item.id);
      expect(after!.metadata.image).toMatchObject({
        mode: "ai", model: "mock", costPence: 0, prompt: "A black taxi outside Grays station at dusk",
      });
      const [asset] = await db.select().from(schema.contentAssets).where(eq(schema.contentAssets.clientId, clientId));
      expect(asset!.alt).toBe("A black taxi outside Grays station at dusk");
    });
  });

  it("cuts a very long prompt down to fit the asset's alt text rather than failing the render", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId } = await contentFixture(db, { withSubscription: false });
      await optInToAi(db, orgId, clientId);
      const prompt = `A black taxi outside Grays station at dusk, ${"lit by the platform lights, ".repeat(40)}`.slice(0, 900);
      const item = await seedItem(db, orgId, clientId, { imagePrompt: prompt.slice(0, 2000) });

      const result = await renderContentImage(db, orgId, { itemId: item.id }, { imagegen: new MockImageGenAdapter() }, env);

      expect(result).toMatchObject({ rendered: true, mode: "ai" });
      if (!result.rendered) throw new Error("expected a render");
      const [asset] = await db.select().from(schema.contentAssets).where(eq(schema.contentAssets.id, result.assetId));
      expect(asset!.alt!.length).toBeLessThanOrEqual(500);
      expect(asset!.alt!.endsWith("…")).toBe(true);
      // The full prompt is still on the item, so nothing is lost — only the label is short.
      const [after] = await itemById(db, item.id);
      expect((after!.metadata.image as { prompt: string }).prompt).toHaveLength(prompt.trim().length);
    });
  });

  it("stays on the template when the client has not opted in, and when the item has no prompt", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId } = await contentFixture(db, { withSubscription: false });
      const optedOut = await seedItem(db, orgId, clientId, { imagePrompt: "A taxi at dusk" });
      const imagegen = new MockImageGenAdapter();

      // auto + a prompt but no brief opt-in: template, and nothing is asked of the generator.
      expect(await renderContentImage(db, orgId, { itemId: optedOut.id }, { imagegen }, env)).toMatchObject({ mode: "template" });
      expect(imagegen.calls).toHaveLength(0);

      // Asking for AI outright on an item with nothing to prompt with still gets a picture.
      await optInToAi(db, orgId, clientId);
      const noPrompt = await seedItem(db, orgId, clientId);
      expect(await renderContentImage(db, orgId, { itemId: noPrompt.id, mode: "ai" }, { imagegen }, env))
        .toMatchObject({ rendered: true, mode: "template", reason: "no_prompt" });
      expect(imagegen.calls).toHaveLength(0);
    });
  });

  it("falls back to the template — without calling the generator — when the month's cap is spent", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId } = await contentFixture(db, { withSubscription: false });
      await optInToAi(db, orgId, clientId);
      await seedSpend(db, orgId, clientId, 8, new Date());
      const item = await seedItem(db, orgId, clientId, { imagePrompt: "A taxi at dusk" });
      const imagegen = new PricedAdapter();
      const capped = { ...env, IMAGEGEN_MONTHLY_CAP_PENCE: "10" };

      const result = await renderContentImage(db, orgId, { itemId: item.id }, { imagegen }, capped);

      expect(result).toMatchObject({ rendered: true, mode: "template", costPence: 0, reason: "monthly_cap" });
      if (!result.rendered) throw new Error("expected a render");
      expect(result.message).toContain("0.10 pounds");
      expect(imagegen.calls).toHaveLength(0);
      const [after] = await itemById(db, item.id);
      expect(after!.imageUrl).toBe(result.url);
      expect(after!.metadata.image).toMatchObject({ mode: "template", costPence: 0, fellBackFrom: "monthly_cap" });
    });
  });

  it("counts only this Europe/London month, so last month's spend does not block this one", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId } = await contentFixture(db, { withSubscription: false });
      await optInToAi(db, orgId, clientId);
      const lastMonth = new Date();
      lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 1, 15);
      await seedSpend(db, orgId, clientId, 500, lastMonth);
      const item = await seedItem(db, orgId, clientId, { imagePrompt: "A taxi at dusk" });
      const imagegen = new PricedAdapter();

      const result = await renderContentImage(db, orgId, { itemId: item.id }, { imagegen }, { ...env, IMAGEGEN_MONTHLY_CAP_PENCE: "10" });

      expect(result).toMatchObject({ rendered: true, mode: "ai", costPence: 4 });
      expect(imagegen.calls).toHaveLength(1);
    });
  });
});

describe("renderContentImage — refusals", () => {
  it("refuses a second image unless force is set, and force replaces the first", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId } = await contentFixture(db, { withSubscription: false });
      const item = await seedItem(db, orgId, clientId);
      const deps = { imagegen: new MockImageGenAdapter() };

      const first = await renderContentImage(db, orgId, { itemId: item.id }, deps, env);
      if (!first.rendered) throw new Error("expected a render");

      const refused = await renderContentImage(db, orgId, { itemId: item.id }, deps, env);
      expect(refused).toMatchObject({ rendered: false, reason: "already_has_image" });

      const forced = await renderContentImage(db, orgId, { itemId: item.id, force: true }, deps, env);
      if (!forced.rendered) throw new Error("expected a render");
      expect(forced.assetId).not.toBe(first.assetId);
      const [after] = await itemById(db, item.id);
      expect(after!.imageUrl).toBe(forced.url);
      expect(after!.metadata.image).toMatchObject({ assetId: forced.assetId });
    });
  });

  it("refuses an empty slot, a published post and an item that is not there", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId } = await contentFixture(db, { withSubscription: false });
      const deps = { imagegen: new MockImageGenAdapter() };

      const empty = await seedItem(db, orgId, clientId, { body: null });
      expect(await renderContentImage(db, orgId, { itemId: empty.id }, deps, env))
        .toMatchObject({ rendered: false, reason: "empty_body", message: "Write the post before drawing its image." });

      const published = await seedItem(db, orgId, clientId);
      await db.update(schema.contentItems).set({ status: "published" }).where(eq(schema.contentItems.id, published.id));
      expect(await renderContentImage(db, orgId, { itemId: published.id }, deps, env))
        .toMatchObject({ rendered: false, reason: "not_editable" });

      expect(await renderContentImage(db, orgId, { itemId: "00000000-0000-0000-0000-000000000000" }, deps, env))
        .toMatchObject({ rendered: false, reason: "not_found" });
      expect(await db.select().from(schema.contentAssets).where(eq(schema.contentAssets.organisationId, orgId))).toHaveLength(0);
    });
  });

  it("only draws for a channel that carries an image", () => {
    // Every channel that exists today takes one, so the refusal cannot be
    // reached through the database — the enum has nothing else in it. The guard
    // is here for the next channel (an email or a newsletter slot), and this is
    // the test that will fail the day one is added without a decision.
    expect([...IMAGE_CHANNELS].sort()).toEqual([...schema.contentChannelEnum.enumValues].sort());
    for (const channel of schema.contentChannelEnum.enumValues) expect(channelTakesImage(channel)).toBe(true);
    expect(channelTakesImage("newsletter" as ContentChannel)).toBe(false);
  });

  it("cannot see another organisation's item", async () => {
    await withTestDb(async (db) => {
      const mine = await contentFixture(db, { withSubscription: false });
      const theirs = await contentFixture(db, { withSubscription: false, name: "Someone Else" });
      const item = await seedItem(db, theirs.orgId, theirs.clientId);

      const result = await renderContentImage(db, mine.orgId, { itemId: item.id }, { imagegen: new MockImageGenAdapter() }, env);

      expect(result).toMatchObject({ rendered: false, reason: "not_found" });
      const [untouched] = await itemById(db, item.id);
      expect(untouched!.imageUrl).toBeNull();
      expect(await db.select().from(schema.contentAssets).where(eq(schema.contentAssets.organisationId, mine.orgId))).toHaveLength(0);
    });
  });
});

describe("headlineFrom", () => {
  it("takes the first sentence, not the first N characters", () => {
    expect(headlineFrom(BODY)).toBe("Airport transfers from Grays, around the clock");
    expect(headlineFrom("Open all bank holiday weekend! Book early.")).toBe("Open all bank holiday weekend");
    expect(headlineFrom("Half term offer: 10% off every airport run")).toBe("Half term offer");
  });

  it("trims a long opening clause on a word boundary and says it did", () => {
    const long = `${"word ".repeat(40)}end.`;
    const headline = headlineFrom(long, 60);

    expect(headline.endsWith("…")).toBe(true);
    expect(headline.length).toBeLessThanOrEqual(61);
    expect(headline.slice(0, -1).endsWith("word")).toBe(true);
  });

  it("reads markdown as words and an empty body as nothing", () => {
    expect(headlineFrom("## Our new depot\n\nWe have moved.")).toBe("Our new depot");
    expect(headlineFrom("Read [our fare guide](https://grays.test/fares) first.")).toBe("Read our fare guide first");
    expect(headlineFrom("   ")).toBe("");
    expect(headlineFrom("")).toBe("");
  });

  it("cuts an unbroken word only when there is no space to cut at", () => {
    const headline = headlineFrom("Antidisestablishmentarianism".repeat(6), 40);
    expect(headline).toHaveLength(41);
    expect(headline.endsWith("…")).toBe(true);
  });
});

describe("kickerFrom", () => {
  it("takes the first place named and drops anything too long to set", () => {
    expect(kickerFrom("Grays, Essex")).toBe("Grays");
    expect(kickerFrom("Thurrock")).toBe("Thurrock");
    expect(kickerFrom(null)).toBeUndefined();
    expect(kickerFrom("   ")).toBeUndefined();
    expect(kickerFrom("a".repeat(50))).toBeUndefined();
  });
});
