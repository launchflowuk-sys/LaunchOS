import { describe, expect, it } from "vitest";
import { isLocalDatabaseUrl, isProductionTarget, productionTargetReason } from "./env-target.js";

const url = (host: string) => `postgres://launchos:s3cret@${host}:5432/launchos`;

describe("isLocalDatabaseUrl", () => {
  it("accepts this machine and this compose network", () => {
    for (const host of ["localhost", "127.0.0.1", "127.1.2.3", "postgres", "db", "[::1]"]) {
      expect(isLocalDatabaseUrl(url(host)), host).toBe(true);
    }
  });

  it("accepts IPv6 loopback in every spelling, not just the two canonical ones", () => {
    // A developer on an IPv6-only docker network used to be told their
    // database "is not a local host".
    for (const host of ["[::1]", "[0:0:0:0:0:0:0:1]", "[0::1]", "[::0001]", "[::ffff:127.0.0.1]"]) {
      expect(isLocalDatabaseUrl(url(host)), host).toBe(true);
    }
  });

  it("accepts IPv6 unique-local addresses — a docker IPv6 network", () => {
    for (const host of ["[fd00::1]", "[fc00:1234::5]"]) {
      expect(isLocalDatabaseUrl(url(host)), host).toBe(true);
    }
  });

  it("rejects public and link-local IPv6", () => {
    for (const host of ["[2606:4700::1111]", "[fe80::1]", "[::ffff:1.2.3.4]"]) {
      expect(isLocalDatabaseUrl(url(host)), host).toBe(false);
    }
  });

  it("accepts RFC1918 addresses — a docker bridge or a LAN box", () => {
    for (const host of ["10.0.1.7", "172.16.0.2", "172.31.255.254", "192.168.1.9"]) {
      expect(isLocalDatabaseUrl(url(host)), host).toBe(true);
    }
  });

  it("rejects public hosts, including ones that merely look private", () => {
    for (const host of ["db.launchflow.co.uk", "1.2.3.4", "172.15.0.1", "172.32.0.1", "192.169.1.1", "11.0.0.1"]) {
      expect(isLocalDatabaseUrl(url(host)), host).toBe(false);
    }
  });

  it("rejects a host that only starts with a local name", () => {
    // `localhost.attacker.example` is not this machine.
    expect(isLocalDatabaseUrl(url("localhost.example.com"))).toBe(false);
    expect(isLocalDatabaseUrl(url("db.internal"))).toBe(false);
  });

  it("treats missing, unparseable and hostless URLs as not local", () => {
    // An unknown target is treated as live: erring that way costs a developer
    // one environment variable, the other way installs a published password on
    // a live tenant.
    expect(isLocalDatabaseUrl(undefined)).toBe(false);
    expect(isLocalDatabaseUrl("")).toBe(false);
    expect(isLocalDatabaseUrl("not a url")).toBe(false);
    expect(isLocalDatabaseUrl("postgres:///var/run/postgresql/launchos")).toBe(false);
    // postgres.js accepts a comma-separated host list; `new URL` cannot parse
    // the port that follows it, so it fails safe as production.
    expect(isLocalDatabaseUrl("postgres://u:p@localhost,prod.example.com:5432/launchos")).toBe(false);
  });
});

describe("isProductionTarget", () => {
  it("is true when NODE_ENV=production, even against localhost", () => {
    expect(isProductionTarget({ NODE_ENV: "production", DATABASE_URL: url("localhost") })).toBe(true);
  });

  it("is true against a remote host when NODE_ENV is unset", () => {
    // The failure this exists for: a one-off run from a restore box or a
    // laptop, in a shell where nobody exported NODE_ENV.
    expect(isProductionTarget({ DATABASE_URL: url("db.launchflow.co.uk") })).toBe(true);
  });

  it("is false against a local host when NODE_ENV is unset", () => {
    expect(isProductionTarget({ DATABASE_URL: url("localhost") })).toBe(false);
    expect(isProductionTarget({ DATABASE_URL: url("postgres") })).toBe(false);
  });

  it("is true when there is no DATABASE_URL to judge", () => {
    expect(isProductionTarget({})).toBe(true);
  });

  it("is not fooled by NODE_ENV=development against a remote host", () => {
    expect(isProductionTarget({ NODE_ENV: "development", DATABASE_URL: url("db.launchflow.co.uk") })).toBe(true);
  });
});

describe("productionTargetReason", () => {
  it("names NODE_ENV when that is what decided", () => {
    expect(productionTargetReason({ NODE_ENV: "production", DATABASE_URL: url("localhost") })).toBe(
      "NODE_ENV=production",
    );
  });

  it("names the host when NODE_ENV was never set", () => {
    expect(productionTargetReason({ DATABASE_URL: url("db.launchflow.co.uk") })).toMatch(/not a local host/);
  });
});
