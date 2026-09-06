"use client";

import type { ProposalLineKind } from "@launchos/db/schema";
import { Plus, Trash2 } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { formatPence } from "@/lib/format";
import { addLineAction, removeLineAction, updateLineAction } from "../actions";
import { LINE_KIND_LABEL, poundsField } from "../schemas";

export type EditableLine = {
  id: string;
  kind: ProposalLineKind;
  description: string;
  quantity: number;
  unitPence: number;
};

type Result = { status: "ok"; id?: string } | { status: "error"; message: string };

/**
 * The priced schedule, and the only way a proposal gets a price.
 *
 * There is no field anywhere on these screens for a total: core derives the
 * three figures from these lines and rewrites them inside the same transaction
 * as every change, so a headline that disagrees with the schedule beneath it
 * is not a state this product can reach.
 *
 * `allowedKinds` comes from the shape. A monthly-on-delivery proposal has one
 * kind of line, so the picker is not drawn at all — a select with one option
 * is a question with no answer. A setup-plus-monthly proposal has two and the
 * picker matters, because which one a line is decides whether it is charged
 * once or twelve times a year.
 *
 * Each line is the description on its own row and everything narrow on a
 * second, wrapping row. The editor sits in a column beside the document
 * preview, so the row has to survive about 430px as well as a 390px phone —
 * and a `sm:` media query, which asks about the viewport rather than about
 * the column, would have laid three columns out in half that space.
 */
export function LineEditor({
  proposalId,
  lines,
  allowedKinds,
  editable,
}: {
  proposalId: string;
  lines: readonly EditableLine[];
  allowedKinds: readonly ProposalLineKind[];
  editable: boolean;
}) {
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);

  function run(key: string, action: (formData: FormData) => Promise<Result>, formData: FormData, success: string, after?: () => void) {
    setBusy(key);
    start(async () => {
      const result = await action(formData);
      setBusy(null);
      if (result.status === "error") return void toast.error(result.message);
      toast.success(success);
      after?.();
    });
  }

  return (
    <div className="min-w-0 space-y-3">
      <ul className="grid gap-3">
        {lines.map((line) => (
          <li key={line.id} className="rounded-xl border bg-card p-3">
            <form
              aria-label={`Line: ${line.description}`}
              className="grid gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                run(line.id, updateLineAction, new FormData(event.currentTarget), "Line saved");
              }}
            >
              <input type="hidden" name="proposalId" value={proposalId} />
              <input type="hidden" name="lineId" value={line.id} />
              {allowedKinds.length === 1 ? <input type="hidden" name="kind" value={allowedKinds[0]} /> : null}

              <div className="min-w-0 space-y-1.5">
                <Label htmlFor={`d-${line.id}`} className="label-caps text-muted-foreground">
                  Description
                </Label>
                <Input id={`d-${line.id}`} name="description" defaultValue={line.description} maxLength={300} required disabled={!editable} />
              </div>

              <div className="flex flex-wrap items-end gap-2">
                <div className="w-16 space-y-1.5">
                  <Label htmlFor={`q-${line.id}`} className="label-caps text-muted-foreground">
                    Qty
                  </Label>
                  <Input id={`q-${line.id}`} name="quantity" type="number" min={1} max={999} defaultValue={line.quantity} disabled={!editable} className="tabular-nums" />
                </div>
                <div className="w-28 space-y-1.5">
                  <Label htmlFor={`p-${line.id}`} className="label-caps text-muted-foreground">
                    Price (£)
                  </Label>
                  <Input id={`p-${line.id}`} name="unitPence" inputMode="decimal" defaultValue={poundsField(line.unitPence)} required disabled={!editable} className="tabular-nums" />
                </div>
                {allowedKinds.length > 1 ? (
                  <div className="w-40 space-y-1.5">
                    <Label htmlFor={`k-${line.id}`} className="label-caps text-muted-foreground">
                      Charged
                    </Label>
                    <NativeSelect id={`k-${line.id}`} name="kind" defaultValue={line.kind} disabled={!editable} className="h-9">
                      {allowedKinds.map((kind) => (
                        <option key={kind} value={kind}>
                          {LINE_KIND_LABEL[kind]}
                        </option>
                      ))}
                    </NativeSelect>
                  </div>
                ) : null}
                {editable ? (
                  <div className="ml-auto flex items-end gap-2">
                    <Button type="submit" variant="secondary" loading={pending && busy === line.id}>
                      Save
                    </Button>
                    <Button
                      type="button"
                      variant="destructive-quiet"
                      size="icon"
                      aria-label={`Remove ${line.description}`}
                      loading={pending && busy === `remove-${line.id}`}
                      onClick={() => {
                        const data = new FormData();
                        data.set("proposalId", proposalId);
                        data.set("lineId", line.id);
                        run(`remove-${line.id}`, removeLineAction, data, "Line removed");
                      }}
                    >
                      <Trash2 aria-hidden />
                    </Button>
                  </div>
                ) : (
                  <p className="ml-auto text-sm tabular-nums text-muted-foreground">{formatPence(line.quantity * line.unitPence)}</p>
                )}
              </div>
            </form>
          </li>
        ))}
      </ul>

      {editable ? (
        <form
          aria-label="Add a line"
          className="grid gap-3 rounded-xl border border-dashed bg-card p-3"
          onSubmit={(event) => {
            event.preventDefault();
            const form = event.currentTarget;
            run("add", addLineAction, new FormData(form), "Line added", () => form.reset());
          }}
        >
          <input type="hidden" name="proposalId" value={proposalId} />
          {allowedKinds.length === 1 ? <input type="hidden" name="kind" value={allowedKinds[0]} /> : null}

          <div className="min-w-0 space-y-1.5">
            <Label htmlFor="new-description" className="label-caps text-muted-foreground">
              Description
            </Label>
            <Input id="new-description" name="description" maxLength={300} required placeholder="Five-page website, designed and built" />
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <div className="w-16 space-y-1.5">
              <Label htmlFor="new-quantity" className="label-caps text-muted-foreground">
                Qty
              </Label>
              <Input id="new-quantity" name="quantity" type="number" min={1} max={999} defaultValue={1} className="tabular-nums" />
            </div>
            <div className="w-28 space-y-1.5">
              <Label htmlFor="new-unit" className="label-caps text-muted-foreground">
                Price (£)
              </Label>
              <Input id="new-unit" name="unitPence" inputMode="decimal" required placeholder="1250.00" className="tabular-nums" />
            </div>
            {allowedKinds.length > 1 ? (
              <div className="w-40 space-y-1.5">
                <Label htmlFor="new-kind" className="label-caps text-muted-foreground">
                  Charged
                </Label>
                <NativeSelect id="new-kind" name="kind" defaultValue={allowedKinds[0]} className="h-9">
                  {allowedKinds.map((kind) => (
                    <option key={kind} value={kind}>
                      {LINE_KIND_LABEL[kind]}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            ) : null}
            <Button type="submit" loading={pending && busy === "add"} className="ml-auto">
              <Plus aria-hidden /> Add line
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
