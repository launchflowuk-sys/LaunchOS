"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { TextField } from "@/components/form-fields";
import { InlineAlert } from "@/components/inline-alert";
import { KeyValue } from "@/components/key-value";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/format";
import { saveWordPressConnectionAction, testWordPressConnectionAction } from "./actions";
import { WordPressConnectionSchema, type WordPressConnectionValues } from "./schemas";

/**
 * The site's WordPress connection: whether one exists, as whom, and the form
 * that sets or replaces it.
 *
 * Write-only by construction — the stored application password is never sent to
 * the browser, so there is nothing to prefill and no "reveal" control. Proving
 * the credential still works is the Test button's job, not the field's.
 */
export function WordPressConnection({
  siteId,
  platform,
  encryptionConfigured,
  connectedAs,
  connectedAt,
}: {
  siteId: string;
  platform: string;
  encryptionConfigured: boolean;
  connectedAs: string | null;
  connectedAt: Date | null;
}) {
  const router = useRouter();
  const [testing, setTesting] = useState(false);
  const defaults: WordPressConnectionValues = { siteId, username: "", appPassword: "" };
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<WordPressConnectionValues>({
    resolver: zodResolver(WordPressConnectionSchema),
    defaultValues: defaults,
  });

  const isWordPress = platform === "wordpress";
  const canEdit = isWordPress && encryptionConfigured;

  async function runTest() {
    setTesting(true);
    try {
      const result = await testWordPressConnectionAction({ siteId });
      if (result.status === "error") toast.error(result.message);
      else toast.success(result.message ?? "Connected");
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="space-y-4 rounded-xl border bg-card p-4">
      {isWordPress ? null : (
        <InlineAlert tone="warning">
          This website is recorded as {platform}. Application passwords only apply to WordPress — change the platform on
          the website record first.
        </InlineAlert>
      )}
      {encryptionConfigured ? null : (
        <InlineAlert tone="warning">
          SECRETS_ENCRYPTION_KEY is not set, so credentials cannot be encrypted and LaunchOS is running on the mock CMS.
        </InlineAlert>
      )}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <KeyValue
          className="min-w-0 flex-1"
          columns={2}
          items={[
            {
              label: "Status",
              // Not a database status, so the tone is given rather than looked
              // up in the shared vocabulary.
              value: connectedAs ? (
                <StatusBadge value="connected" tone="success" />
              ) : (
                <StatusBadge value="not connected" tone="neutral" />
              ),
            },
            { label: "WordPress user", value: connectedAs ?? "—" },
            { label: "Last set", value: formatDateTime(connectedAt) },
          ]}
        />
        {connectedAs ? (
          <Button type="button" variant="secondary" onClick={runTest} loading={testing} className="max-sm:w-full">
            Test connection
          </Button>
        ) : null}
      </div>

      <form
        className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
        onSubmit={handleSubmit(async (values) => {
          const result = await saveWordPressConnectionAction(values);
          if (result.status === "error") return void toast.error(result.message);
          toast.success(result.message ?? "WordPress connection saved");
          reset(defaults);
          router.refresh();
        })}
      >
        <input type="hidden" {...register("siteId")} />
        <TextField
          name="username"
          label="WordPress username"
          register={register}
          error={errors.username}
          placeholder="shoji"
          required
        />
        <TextField
          name="appPassword"
          label="Application password"
          type="password"
          register={register}
          error={errors.appPassword}
          placeholder="abcd EFGH 1234 ijkl MNOP 5678"
          required
        />
        <div className="flex items-end">
          <Button type="submit" loading={isSubmitting} disabled={!canEdit} variant="secondary" className="w-full">
            {connectedAs ? "Replace connection" : "Save connection"}
          </Button>
        </div>
      </form>

      <p className="text-sm text-muted-foreground">
        In the client&apos;s WordPress admin, open <span className="font-medium">Users → Profile</span>, scroll to
        Application Passwords, add one named <span className="font-mono">LaunchOS</span> and paste the generated value
        here. It is stored encrypted and can be revoked from that same screen at any time.
      </p>
    </div>
  );
}
