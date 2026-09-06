import { describe, expect, it } from "vitest";
import { estimateTextWidth, renderTemplateImage, wrapHeadline } from "./image-template.js";

const BRAND = { primary: "#141b29", accent: "#0969ca" };
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** 300 characters of realistic post copy — the longest headline the caller could hand us. */
const LONG = (
  "Grays CabLine now runs airport transfers to Stansted, Gatwick, Heathrow and Luton around the clock, "
  + "with fixed fares agreed before you travel, a driver who tracks your flight, child seats on request "
  + "and card payment in the car, so there is never a surprise waiting for you at the kerb, whatever "
  + "the hour and wherever in Thurrock you are heading."
).slice(0, 300);

/** The PNG signature and the IHDR width and height, read straight out of the bytes. */
function pngHeader(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { magic: [...bytes.slice(0, 8)], width: view.getUint32(16), height: view.getUint32(20) };
}

describe("template image", () => {
  it.each([
    ["square", 1080, 1080],
    ["landscape", 1200, 630],
  ] as const)("draws a one-word headline at %s", async (size, width, height) => {
    const { bytes, mime } = await renderTemplateImage({ headline: "Open", wordmark: "Grays CabLine", brand: BRAND, size });

    expect(mime).toBe("image/png");
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(pngHeader(bytes)).toEqual({ magic: PNG_MAGIC, width, height });
  });

  it.each([
    ["square", 1080, 1080],
    ["landscape", 1200, 630],
  ] as const)("shrinks a 300-character headline to fit at %s", async (size, width, height) => {
    expect(LONG).toHaveLength(300);
    const { bytes } = await renderTemplateImage({
      headline: LONG, kicker: "Grays", wordmark: "Grays CabLine", brand: BRAND, size,
    });

    expect(pngHeader(bytes)).toEqual({ magic: PNG_MAGIC, width, height });
  });

  it("draws the logo instead of the wordmark when one is supplied", async () => {
    const logo = await renderTemplateImage({ headline: "Logo", wordmark: "X", brand: BRAND, size: "landscape" });
    const { bytes } = await renderTemplateImage({
      headline: "Book your airport run",
      wordmark: "Grays CabLine",
      logo: { bytes: logo.bytes, mime: "image/png" },
      brand: BRAND,
      size: "landscape",
    });

    expect(pngHeader(bytes)).toEqual({ magic: PNG_MAGIC, width: 1200, height: 630 });
  });

  it("refuses an empty headline and a colour that is not six-digit hex", async () => {
    await expect(renderTemplateImage({ headline: "  ", wordmark: "X", brand: BRAND, size: "square" })).rejects.toThrow();
    await expect(renderTemplateImage({
      headline: "Hello", wordmark: "X", brand: { primary: "red", accent: "#0969ca" }, size: "square",
    })).rejects.toThrow();
  });
});

describe("headline fitting", () => {
  it("wraps on words and never returns a line wider than the column", () => {
    const lines = wrapHeadline(LONG, 90, 904);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(estimateTextWidth(line, 90)).toBeLessThanOrEqual(904);
    expect(lines.join(" ")).toBe(LONG.replace(/\s+/g, " ").trim());
  });

  it("breaks a single word that is wider than the column rather than looping forever", () => {
    const lines = wrapHeadline("A".repeat(200), 90, 904);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join("")).toBe("A".repeat(200));
  });
});
