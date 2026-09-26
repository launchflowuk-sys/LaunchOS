"use client";

import { useActionState, useState } from "react";
import { InlineAlert } from "@/components/inline-alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { saveConnectionAction, testConnectionAction, type ConnectionState } from "./actions";

const INITIAL: ConnectionState = { status: "idle" };

/**
 * Plain props, not `@launchos/core` types.
 *
 * `@launchos/core`'s barrel reaches `@launchos/channels`, which reaches
 * `web-push`, which requires node's `net` — importing so much as a type
 * from it into a **client** component drags a node builtin into the browser
 * bundle and the page 500s. TypeScript cannot see this; only the bundler
 * can. The server component already holds core safely and hands down only
 * what this form needs.
 */
export interface ServerChoice {
  readonly id: string;
  readonly name: string;
  readonly ipv4: string | null;
}

/** The row being edited, with no token — the token never round-trips to the browser. */
export interface EditingConnection {
  readonly id: string;
  readonly provider: "hetzner_cloud" | "coolify";
  readonly label: string;
  readonly baseUrl: string | null;
  readonly serverId: string | null;
}

type TestResult = { ok: true; detail: string } | { ok: false; message: string } | null;

export function ConnectionForm({ servers, editing }: { servers: readonly ServerChoice[]; editing?: EditingConnection }) {
  const [state, formAction, pending] = useActionState(saveConnectionAction, INITIAL);
  const [provider, setProvider] = useState<"hetzner_cloud" | "coolify">(editing?.provider ?? "hetzner_cloud");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult>(null);
  const isCoolify = provider === "coolify";

  async function runTest(form: HTMLFormElement) {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testConnectionAction(new FormData(form));
      setTestResult(result);
    } finally {
      setTesting(false);
    }
  }

  if (state.status === "saved") {
    return (
      <InlineAlert tone="success">
        <strong>{state.label}</strong> saved.
      </InlineAlert>
    );
  }

  return (
    <form
      action={formAction}
      onReset={() => setTestResult(null)}
      aria-label={editing ? "Edit connection" : "Add a connection"}
      className="max-w-xl space-y-5"
    >
      {editing ? <input type="hidden" name="id" value={editing.id} /> : null}

      <div className="space-y-1.5">
        <Label htmlFor="provider">Provider</Label>
        <NativeSelect
          id="provider"
          name="provider"
          value={provider}
          disabled={!!editing}
          onChange={(event) => setProvider(event.target.value === "coolify" ? "coolify" : "hetzner_cloud")}
        >
          <option value="hetzner_cloud">Hetzner Cloud</option>
          <option value="coolify">Coolify</option>
        </NativeSelect>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="label">Label</Label>
        <Input id="label" name="label" required maxLength={80} defaultValue={editing?.label} placeholder="Hetzner — account 1" />
      </div>

      {isCoolify ? (
        <div className="space-y-1.5">
          <Label htmlFor="baseUrl">Base URL</Label>
          <Input id="baseUrl" name="baseUrl" defaultValue={editing?.baseUrl ?? ""} placeholder="http://1.2.3.4:8000" />
        </div>
      ) : null}

      <div className="space-y-1.5">
        <Label htmlFor="token">Token</Label>
        <Input id="token" name="token" type="password" autoComplete="off" required={!editing} placeholder={editing ? "Leave blank to keep the current token" : undefined} />
      </div>

      {isCoolify ? (
        <div className="space-y-1.5">
          <Label htmlFor="serverId">Server</Label>
          <NativeSelect id="serverId" name="serverId" defaultValue={editing?.serverId ?? ""}>
            <option value="">Match by IP automatically</option>
            {servers.map((server) => (
              <option key={server.id} value={server.id}>
                {server.name}
                {server.ipv4 ? ` (${server.ipv4})` : ""}
              </option>
            ))}
          </NativeSelect>
        </div>
      ) : null}

      {testResult ? (
        <InlineAlert tone={testResult.ok ? "success" : "danger"}>{testResult.ok ? testResult.detail : testResult.message}</InlineAlert>
      ) : null}

      {state.status === "error" ? <InlineAlert tone="danger">{state.message}</InlineAlert> : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={pending}>{pending ? "Saving…" : editing ? "Save changes" : "Add connection"}</Button>
        <Button
          type="button"
          variant="secondary"
          disabled={testing}
          onClick={(event) => void runTest(event.currentTarget.form!)}
        >
          {testing ? "Testing…" : "Test"}
        </Button>
        {editing ? (
          <Button type="button" variant="ghost" onClick={() => window.location.assign("/settings/infrastructure")}>
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}
