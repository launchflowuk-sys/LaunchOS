#!/usr/bin/env node
/**
 * A thin, read-mostly client for this deployment's Coolify instance.
 *
 * Credentials come from the repository's own .env (COOLIFY_API_URL,
 * COOLIFY_API_TOKEN) — the same two variables the hosting adapter reads — so
 * no token is ever typed on a command line, put in a shell history or printed
 * by this script. .env is gitignored; nothing here is committable.
 *
 *   node scripts/coolify.mjs apps                 list applications
 *   node scripts/coolify.mjs deployments [name]   recent deployments
 *   node scripts/coolify.mjs logs [name]          last deployment's log
 *   node scripts/coolify.mjs migrate [name]       run the db migration in the container
 *   node scripts/coolify.mjs exec <name> <cmd>    run a command in the container
 *   node scripts/coolify.mjs redeploy [name]      trigger a deployment
 *
 * `name` defaults to launchos-web.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readEnv() {
  const file = path.join(ROOT, ".env");
  if (!fs.existsSync(file)) fail(`no .env at ${file}`);
  const out = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

function fail(msg) {
  console.error(`coolify: ${msg}`);
  process.exit(1);
}

const env = readEnv();
const BASE = (env.COOLIFY_API_URL || "").replace(/\/+$/, "");
const TOKEN = env.COOLIFY_API_TOKEN || "";
if (!BASE || !TOKEN) {
  fail("COOLIFY_API_URL and COOLIFY_API_TOKEN must both be set in .env");
}

async function api(pathname, { method = "GET", body } = {}) {
  const res = await fetch(`${BASE}/api/v1${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

const asList = (b) => (Array.isArray(b) ? b : b?.deployments ?? b?.data ?? []);

async function findApp(name = "launchos-web") {
  const r = await api("/applications");
  if (r.status !== 200) fail(`GET /applications -> ${r.status}`);
  const app = asList(r.body).find((a) => a.name === name);
  if (!app) fail(`no application named ${name}`);
  return app;
}

/** Coolify stores a deployment's log as a JSON array of {output} records. */
function logLines(deployment) {
  try {
    return JSON.parse(deployment.logs).map((o) => String(o.output ?? "")).filter(Boolean);
  } catch {
    return String(deployment.logs || "").split(/\r?\n/);
  }
}

const [cmd = "apps", ...rest] = process.argv.slice(2);

if (cmd === "apps") {
  const r = await api("/applications");
  console.log(`GET /applications -> ${r.status}`);
  for (const a of asList(r.body)) {
    console.log(`  ${a.name}`);
    console.log(`     uuid=${a.uuid}  status=${a.status}  branch=${a.git_branch}`);
    console.log(`     fqdn=${(a.fqdn || "").split(",")[0]}`);
    console.log(`     pre_deployment_command=${JSON.stringify(a.pre_deployment_command)}`);
  }
} else if (cmd === "deployments") {
  const app = await findApp(rest[0]);
  const r = await api(`/deployments/applications/${app.uuid}`);
  console.log(`${app.name}: GET deployments -> ${r.status}`);
  for (const d of asList(r.body).slice(0, 8)) {
    console.log(
      `  ${d.created_at}  ${String(d.status).padEnd(9)} commit=${String(d.commit).slice(0, 8)}` +
      `  webhook=${d.is_webhook}  api=${d.is_api}  uuid=${d.deployment_uuid}`,
    );
  }
} else if (cmd === "logs") {
  const app = await findApp(rest[0]);
  const r = await api(`/deployments/applications/${app.uuid}`);
  const d = asList(r.body)[0];
  if (!d) fail("no deployments");
  console.log(`${app.name}  deployment=${d.deployment_uuid}  commit=${String(d.commit).slice(0, 8)}  status=${d.status}`);
  const lines = logLines(d);
  console.log(`log lines: ${lines.length}`);
  const interesting = lines.filter((l) => /migrat|drizzle|pre-?deploy|error|fail/i.test(l));
  console.log(interesting.length ? "--- migration / error lines ---" : "--- tail ---");
  for (const l of (interesting.length ? interesting : lines.slice(-30))) {
    console.log("  " + l.replace(/\s+$/, "").slice(0, 220));
  }
} else if (cmd === "migrate" || cmd === "exec") {
  const name = cmd === "migrate" ? (rest[0] || "launchos-web") : rest[0];
  const command = cmd === "migrate"
    ? "pnpm --filter @launchos/db migrate"
    : rest.slice(1).join(" ");
  if (!command) fail("no command given");
  const app = await findApp(name);
  console.log(`${app.name} (${app.uuid})\n$ ${command}`);
  const r = await api(`/applications/${app.uuid}/execute`, { method: "POST", body: { command } });
  console.log(`-> HTTP ${r.status}`);
  const out = typeof r.body === "string" ? r.body : (r.body?.response ?? r.body?.message ?? JSON.stringify(r.body));
  console.log(String(out).slice(0, 4000));
} else if (cmd === "show") {
  const app = await findApp(rest[0]);
  // Long opaque strings are redacted: this object can carry tokens.
  const hide = (v) => (typeof v === "string" && v.length > 40 ? `<${v.length} chars>` : v);
  for (const [k, v] of Object.entries(app)) {
    if (rest[1] === "all" || /deploy|webhook|git|source|branch|name|uuid|status|manual/i.test(k)) {
      console.log(`  ${k} = ${JSON.stringify(hide(v))}`);
    }
  }
} else if (cmd === "instance") {
  const r = await api("/settings");
  console.log(`GET /settings -> ${r.status}`);
  const o = r.body || {};
  for (const [k, v] of Object.entries(o)) {
    if (/fqdn|url|domain|ip|instance/i.test(k)) console.log(`  ${k} = ${JSON.stringify(v)}`);
  }
} else if (cmd === "sources") {
  const r = await api("/sources");
  console.log(`GET /sources -> ${r.status}`);
  for (const s of asList(r.body)) {
    console.log(`  ${s.name}  type=${s.type ?? ""}  uuid=${s.uuid}`);
    for (const [k, v] of Object.entries(s)) {
      if (/webhook|html_url|api_url|app_id|installation|custom_user|organization/i.test(k)) {
        console.log(`     ${k} = ${JSON.stringify(typeof v === "string" && v.length > 60 ? "<long>" : v)}`);
      }
    }
  }
} else if (cmd === "autodeploy") {
  const app = await findApp(rest[0]);
  const want = rest[1];
  const cur = await api(`/applications/${app.uuid}`);
  const obj = cur.body || {};
  const keys = Object.keys(obj).filter((k) => /auto_deploy|force_https|preview/i.test(k));
  console.log(`${app.name}: GET /applications/{uuid} -> ${cur.status}`);
  for (const k of keys) console.log(`  ${k} = ${JSON.stringify(obj[k])}`);
  if (obj.settings) {
    for (const [k, v] of Object.entries(obj.settings)) {
      if (/auto_deploy/i.test(k)) console.log(`  settings.${k} = ${JSON.stringify(v)}`);
    }
  }
  if (want === "on" || want === "off") {
    const r = await api(`/applications/${app.uuid}`, {
      method: "PATCH",
      body: { is_auto_deploy_enabled: want === "on" },
    });
    console.log(`PATCH is_auto_deploy_enabled=${want === "on"} -> HTTP ${r.status}`);
    console.log(typeof r.body === "string" ? r.body.slice(0, 400) : JSON.stringify(r.body).slice(0, 400));
  }
} else if (cmd === "set") {
  const app = await findApp(rest[0]);
  const field = rest[1];
  const value = rest[2] === "true" ? true : rest[2] === "false" ? false : rest[2];
  const r = await api(`/applications/${app.uuid}`, { method: "PATCH", body: { [field]: value } });
  console.log(`PATCH ${app.name} ${field}=${value} -> HTTP ${r.status}`);
  console.log(typeof r.body === "string" ? r.body.slice(0, 300) : JSON.stringify(r.body).slice(0, 300));
} else if (cmd === "redeploy") {
  const app = await findApp(rest[0]);
  const r = await api(`/deploy?uuid=${app.uuid}&force=false`);
  console.log(`redeploy ${app.name} -> HTTP ${r.status}`);
  console.log(typeof r.body === "string" ? r.body.slice(0, 300) : JSON.stringify(r.body).slice(0, 300));
} else {
  fail(`unknown command: ${cmd}`);
}
