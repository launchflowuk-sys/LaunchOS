import { describe, expect, it } from "vitest";
import { createPushAdapterFromEnv, hasPushCredentials, pushSubjectProblem } from "./factory.js";
import { MockPushAdapter } from "./mock.js";
import { PUSH_TTL_SECONDS, WebPushAdapter, isValidVapidSubject, type SendNotificationFn } from "./web-push.js";

const subscription = {
  endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
  keys: { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" },
};
const payload = { title: "Site down: grayscabline.co.uk", body: "Incident opened at 09:12", url: "https://os.launchflow.test/incidents/1", tag: "launchos:n1" };
const vapid = { subject: "mailto:shoji@launchflow.test", publicKey: "BPublic", privateKey: "private" };

/** A `WebPushError` the way the package throws it: a plain Error carrying `statusCode`. */
function pushServiceError(statusCode: number): Error & { statusCode: number } {
  return Object.assign(new Error(`Received unexpected response code ${statusCode}`), { statusCode });
}

describe("WebPushAdapter", () => {
  it("encrypts the payload as JSON, signs with the VAPID pair per call, and reports sent", async () => {
    const calls: Parameters<SendNotificationFn>[] = [];
    const sendNotification: SendNotificationFn = async (...args) => {
      calls.push(args);
      return { statusCode: 201, body: "", headers: {} };
    };
    const adapter = new WebPushAdapter({ vapid, sendNotification });

    const result = await adapter.send(subscription, payload);

    expect(result).toEqual({ outcome: "sent", statusCode: 201 });
    expect(calls).toHaveLength(1);
    const [sub, body, options] = calls[0]!;
    expect(sub).toEqual(subscription);
    expect(JSON.parse(body)).toEqual(payload);
    expect(options).toEqual({ vapidDetails: vapid, TTL: PUSH_TTL_SECONDS, urgency: "high" });
  });

  it("turns a 410 or 404 from the push service into gone — the row is to be removed — and never throws", async () => {
    const gone = new WebPushAdapter({ vapid, sendNotification: async () => { throw pushServiceError(410); } });
    expect(await gone.send(subscription, payload)).toEqual({ outcome: "gone", statusCode: 410, error: "Received unexpected response code 410" });
    const missing = new WebPushAdapter({ vapid, sendNotification: async () => { throw pushServiceError(404); } });
    expect((await missing.send(subscription, payload)).outcome).toBe("gone");
  });

  it("reports any other response, and a network failure with no status, as failed", async () => {
    const throttled = new WebPushAdapter({ vapid, sendNotification: async () => { throw pushServiceError(429); } });
    expect(await throttled.send(subscription, payload)).toEqual({ outcome: "failed", statusCode: 429, error: "Received unexpected response code 429" });
    const offline = new WebPushAdapter({ vapid, sendNotification: async () => { throw new Error("ECONNRESET"); } });
    expect(await offline.send(subscription, payload)).toEqual({ outcome: "failed", error: "ECONNRESET" });
  });

  it("refuses a malformed subscription or payload up front, since the push service would too", async () => {
    const adapter = new WebPushAdapter({ vapid, sendNotification: async () => ({ statusCode: 201, body: "", headers: {} }) });
    await expect(adapter.send({ endpoint: "not-a-url", keys: subscription.keys }, payload)).rejects.toThrow();
    await expect(adapter.send(subscription, { ...payload, title: "" })).rejects.toThrow();
  });

  it("refuses to construct without keys or with a subject that is not mailto: or https:", () => {
    expect(() => new WebPushAdapter({ vapid: { ...vapid, privateKey: "" } })).toThrow(/VAPID public and private keys/);
    expect(() => new WebPushAdapter({ vapid: { ...vapid, subject: "shoji@launchflow.test" } })).toThrow(/mailto: address or an https: URL/);
    expect(isValidVapidSubject("mailto:a@b.test")).toBe(true);
    expect(isValidVapidSubject("https://os.launchflow.test")).toBe(true);
    expect(isValidVapidSubject("http://os.launchflow.test")).toBe(false);
  });
});

describe("MockPushAdapter", () => {
  it("records sends, and plays a dead or failing endpoint on request", async () => {
    const mock = new MockPushAdapter();
    expect(await mock.send(subscription, payload)).toEqual({ outcome: "sent", statusCode: 201 });
    expect(mock.sent).toEqual([{ subscription, payload }]);

    mock.failEndpoint(subscription.endpoint, 410);
    expect((await mock.send(subscription, payload)).outcome).toBe("gone");
    mock.failEndpoint(subscription.endpoint, 500);
    expect(await mock.send(subscription, payload)).toMatchObject({ outcome: "failed", statusCode: 500 });
    mock.restoreEndpoint(subscription.endpoint);
    expect((await mock.send(subscription, payload)).outcome).toBe("sent");
    // Only the successful sends are recorded.
    expect(mock.sent).toHaveLength(2);
  });
});

describe("createPushAdapterFromEnv", () => {
  it("is the mock unless both VAPID keys are set, blank counting as unset", () => {
    expect(createPushAdapterFromEnv({} as NodeJS.ProcessEnv).name).toBe("mock");
    expect(createPushAdapterFromEnv({ VAPID_PUBLIC_KEY: "pub" } as NodeJS.ProcessEnv).name).toBe("mock");
    expect(createPushAdapterFromEnv({ VAPID_PUBLIC_KEY: "pub", VAPID_PRIVATE_KEY: " " } as NodeJS.ProcessEnv).name).toBe("mock");
    expect(hasPushCredentials({ VAPID_PUBLIC_KEY: "pub", VAPID_PRIVATE_KEY: "priv" } as NodeJS.ProcessEnv)).toBe(true);
  });

  it("builds web push once both keys and a well-formed subject are set", () => {
    const env = { VAPID_PUBLIC_KEY: "pub", VAPID_PRIVATE_KEY: "priv", VAPID_SUBJECT: "mailto:shoji@launchflow.test" } as NodeJS.ProcessEnv;
    expect(createPushAdapterFromEnv(env).name).toBe("web-push");
    expect(pushSubjectProblem(env)).toBeNull();
  });

  it("throws — never downgrades — when the keys are set but the subject is missing or malformed", () => {
    const keys = { VAPID_PUBLIC_KEY: "pub", VAPID_PRIVATE_KEY: "priv" } as NodeJS.ProcessEnv;
    expect(() => createPushAdapterFromEnv(keys)).toThrow(/VAPID_SUBJECT is required/);
    expect(() => createPushAdapterFromEnv({ ...keys, VAPID_SUBJECT: "shoji@launchflow.test" })).toThrow(/mailto: address or an https: URL/);
    expect(pushSubjectProblem(keys)).toMatch(/VAPID_SUBJECT is required/);
  });
});
