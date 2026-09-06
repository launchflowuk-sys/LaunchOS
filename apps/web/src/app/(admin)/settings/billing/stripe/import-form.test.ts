import { describe, expect, it } from "vitest";
import { initialFileUnderChoice, LEAVE, NEW_CLIENT, readImportForm } from "./import-form";

const CLIENT_ID = "3b3d1f8e-6d1a-4b8f-9a4e-2f0c1a7e5d21";

function form(entries: [string, string][]): FormData {
  const data = new FormData();
  for (const [key, value] of entries) data.append(key, value);
  return data;
}

describe("readImportForm", () => {
  it("reads the ticked products, the names typed for new clients and the File-under choices", () => {
    const read = readImportForm(form([
      ["product", "prod_basic"],
      ["product", "prod_growth"],
      ["fileUnder:cus_a", NEW_CLIENT],
      ["clientName:cus_a", "  Someone Else Ltd "],
      ["fileUnder:cus_b", CLIENT_ID],
      ["clientName:cus_b", "Ignored because filed under an existing client"],
    ]));
    expect(read.selectedProductIds).toEqual(["prod_basic", "prod_growth"]);
    expect(read.fileUnder).toEqual({ cus_a: NEW_CLIENT, cus_b: CLIENT_ID });
    // Names travel whatever the choice: core only reads the one for "new".
    expect(read.clientNames).toEqual({ cus_a: "Someone Else Ltd", cus_b: "Ignored because filed under an existing client" });
  });

  it("drops a blank choice, a blank name and anything that is neither new nor a uuid", () => {
    const read = readImportForm(form([
      ["fileUnder:cus_left", ""],
      ["fileUnder:cus_guess", "not-an-id"],
      ["clientName:cus_left", "   "],
    ]));
    expect(read.selectedProductIds).toEqual([]);
    expect(read.fileUnder).toEqual({});
    expect(read.clientNames).toEqual({});
  });

  it("starts the select on the email match, on 'leave it' for an unknown cancelled subscription, else on a new client", () => {
    expect(initialFileUnderChoice({ matchedClientId: CLIENT_ID, status: "cancelled" })).toBe(CLIENT_ID);
    expect(initialFileUnderChoice({ matchedClientId: null, status: "cancelled" })).toBe(LEAVE);
    expect(initialFileUnderChoice({ matchedClientId: null, status: "active" })).toBe(NEW_CLIENT);
  });

  it("refuses a product id that is empty", () => {
    expect(() => readImportForm(form([["product", "   "]]))).toThrow();
  });
});
