import { describe, expect, it } from "vitest";
import { endpointHost, subscriptionBody, urlBase64ToUint8Array } from "./push";

describe("urlBase64ToUint8Array", () => {
  it("decodes a URL-safe, unpadded key the way web-push prints it", () => {
    // "hello?" in URL-safe base64 is aGVsbG8_ (standard: aGVsbG8/); the length is 8, so no padding is needed.
    const bytes = urlBase64ToUint8Array("aGVsbG8_");
    expect(Array.from(bytes)).toEqual([104, 101, 108, 108, 111, 63]);
  });

  it("adds the padding a bare key is missing", () => {
    expect(Array.from(urlBase64ToUint8Array("YQ"))).toEqual([97]);
    expect(Array.from(urlBase64ToUint8Array("YWI"))).toEqual([97, 98]);
  });

  it("refuses a blank or non-base64 value rather than subscribing to nowhere", () => {
    expect(() => urlBase64ToUint8Array("   ")).toThrow(/empty/);
    expect(() => urlBase64ToUint8Array("not a key!")).toThrow(/not base64/);
  });
});

describe("subscriptionBody", () => {
  it("narrows PushSubscription.toJSON() to endpoint and the two keys", () => {
    expect(
      subscriptionBody({ endpoint: "https://push.example/abc", keys: { p256dh: "p", auth: "a", extra: "x" } }),
    ).toEqual({ endpoint: "https://push.example/abc", keys: { p256dh: "p", auth: "a" } });
  });

  it("is null when the browser handed back no keys", () => {
    expect(subscriptionBody({ endpoint: "https://push.example/abc" })).toBeNull();
    expect(subscriptionBody({ endpoint: "not-a-url", keys: { p256dh: "p", auth: "a" } })).toBeNull();
  });
});

describe("endpointHost", () => {
  it("shows the push service's host, never the whole endpoint", () => {
    expect(endpointHost("https://fcm.googleapis.com/fcm/send/secret-token")).toBe("fcm.googleapis.com");
    expect(endpointHost("nonsense")).toBe("unknown push service");
  });
});
