"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect, useRef, useState } from "react";
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
  const router = useRouter();
  const [state, formAction, pending] = useActionState(saveConnectionAction, INITIAL);
  const [provider, setProvider] = useState<"hetzner_cloud" | "coolify">(editing?.provider ?? "hetzner_cloud");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const isCoolify = provider === "coolify";

  // "On saved reset the form" (spec): `useActionState` keeps returning the
  // same `saved` state until another action runs, so the form has to reset
  // itself here rather than relying on state to fall back to idle. Editing
  // saves instead navigate away — there is nothing left on this page to
  // reset once the row being edited no longer has a `?edit=` to match.
  useEffect(() => {
    if (state.status !== "saved") return;
    if (editing) {
      router.replace("/settings/infrastructure");
      return;
    }
    formRef.current?.reset();
    setProvider("hetzner_cloud");
    setTestResult(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

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

  return (
    <form
      ref={formRef}
      action={formAction}
      onReset={() => setTestResult(null)}
      aria-label={editing ? "Edit connection" : "Add a connection"}
      className="max-w-xl space-y-5"
    >
      {editing ? <input type="hidden" name="id" value={editing.id} /> : null}
      {/* The provider select below is disabled while editing, and a disabled
          control is left out of the form's FormData entirely — including by
          `testConnectionAction`'s direct `new FormData(form)` read. Without
          this hidden mirror, testing a Coolify connection in edit mode would
          silently test it as Hetzner. */}
      {editing ? <input type="hidden" name="provider" value={editing.provider} /> : null}

      <div className="space-y-1.5">
        <Label htmlFor="provider">Provider</Label>
        <NativeSelect
          id="provider"
          name={editing ? undefined : "provider"}
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
        <Input id="token" name="token" type="password" autoComplete="off" required={!editing} placeholder={editing ? "Leave blank to keep it — required if the URL changes" : undefined} />
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
      {state.status === "saved" && !editing ? (
        <InlineAlert tone="success">
          <strong>{state.label}</strong> saved.
        </InlineAlert>
      ) : null}

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
          <Button type="button" variant="ghost" onClick={() => router.push("/settings/infrastructure")}>
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}
