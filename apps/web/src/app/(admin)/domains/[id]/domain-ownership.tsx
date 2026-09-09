import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { deleteDomainAction, moveDomainAction } from "../actions";

/**
 * The two doors that were missing.
 *
 * A domain added by hand against the wrong client used to be stuck there: the
 * unique index is on (organisation, name), archiving a client does not release
 * it, and nothing in the product could move or remove it. Either of these
 * frees the name.
 *
 * Moving is offered first and deleting last, because moving keeps the DNS
 * records and the history and deleting does not.
 */
export function DomainOwnership({
  domainId,
  domainName,
  clientId,
  clients,
}: {
  domainId: string;
  domainName: string;
  clientId: string;
  clients: readonly { id: string; name: string }[];
}) {
  return (
    <div className="space-y-4">
      <ActionForm
        action={moveDomainAction}
        ariaLabel="Move domain to another client"
        success="Domain moved"
        className="flex flex-col gap-3 sm:flex-row sm:items-end"
      >
        <input type="hidden" name="domainId" value={domainId} />
        <div className="min-w-0 flex-1 space-y-1.5 sm:max-w-sm">
          <Label htmlFor={`move-${domainId}`}>Client</Label>
          <NativeSelect id={`move-${domainId}`} name="clientId" required defaultValue={clientId}>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </NativeSelect>
          <p className="text-meta text-muted-foreground">
            Moving keeps the DNS records and detaches the website, which belongs to the old client.
          </p>
        </div>
        <Button type="submit" variant="secondary" className="max-sm:w-full">
          Move domain
        </Button>
      </ActionForm>

      <ActionForm
        action={deleteDomainAction}
        ariaLabel="Delete domain"
        success="Domain deleted"
        className="flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-end"
      >
        <input type="hidden" name="domainId" value={domainId} />
        <div className="min-w-0 flex-1 space-y-1.5 sm:max-w-sm">
          <Label htmlFor={`delete-${domainId}`}>Delete this domain</Label>
          <Input id={`delete-${domainId}`} name="confirmName" placeholder={domainName} autoComplete="off" />
          <p className="text-meta text-muted-foreground">
            Type <span className="font-mono">{domainName}</span> to confirm. Its DNS records go with it, and the name
            becomes available again.
          </p>
        </div>
        <Button type="submit" variant="destructive-quiet" className="max-sm:w-full">
          Delete domain
        </Button>
      </ActionForm>
    </div>
  );
}
