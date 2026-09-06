import { describe, expect, it } from "vitest";
import { describeRequestError, isControlFlowError } from "./request-error";

const request = { path: "/cases/abc?q=secret", method: "GET" };
const context = { routePath: "/app/(admin)/cases/[id]/page", routeType: "render" };

describe("describeRequestError", () => {
  it("keys the signature on the route file and the error class, and drops the query string", () => {
    const error = new TypeError("Cannot read properties of undefined");
    const report = describeRequestError(error, request, context);
    expect(report).toEqual({
      signature: "/app/(admin)/cases/[id]/page:TypeError",
      message: "Cannot read properties of undefined",
      details: { path: "/cases/abc", method: "GET", routeType: "render" },
    });
  });

  it("copes with a thrown non-Error", () => {
    const report = describeRequestError("boom", request, context);
    expect(report?.signature).toBe("/app/(admin)/cases/[id]/page:Error");
    expect(report?.message).toBe("boom");
  });

  it("carries a React digest so a processed error can still be identified", () => {
    const error = Object.assign(new Error("Server error"), { digest: "1234567890" });
    expect(describeRequestError(error, request, context)?.details["digest"]).toBe("1234567890");
  });

  it("ignores Next's redirect and not-found signals", () => {
    expect(isControlFlowError(Object.assign(new Error("x"), { digest: "NEXT_REDIRECT;replace;/sign-in;307;" }))).toBe(true);
    expect(isControlFlowError(Object.assign(new Error("x"), { digest: "NEXT_NOT_FOUND" }))).toBe(true);
    expect(isControlFlowError(new Error("x"))).toBe(false);
    expect(describeRequestError(Object.assign(new Error("x"), { digest: "NEXT_NOT_FOUND" }), request, context)).toBeNull();
  });
});
