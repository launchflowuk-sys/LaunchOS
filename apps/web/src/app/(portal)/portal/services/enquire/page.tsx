import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { PortalForm } from "@/components/portal/portal-form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { requireClient } from "@/lib/portal-session";
import { submitEnquiryAction } from "../actions";

export const dynamic = "force-dynamic";

export const metadata = { title: "Ask for something else" };

/**
 * Everything we do not sell off the shelf.
 *
 * Two fields, because a client who wants a new website does not know what we
 * need to know, and a long form is how an enquiry becomes an abandoned form.
 * It lands as a lead in the pipeline rather than a support ticket: it is new
 * business, and treating it as support means it never gets priced.
 */
export default async function EnquirePage() {
  await requireClient();

  return (
    <div className="mx-auto max-w-xl">
      <Link
        href="/portal/services"
        className="mb-5 inline-flex items-center gap-1.5 text-row font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft aria-hidden strokeWidth={2} className="size-4" />
        All services
      </Link>

      <h1 className="text-title font-bold tracking-[-0.01em]">Tell us what you need</h1>
      <p className="mt-2 text-base text-muted-foreground">
        A new website, or anything not on the list. We will come back with a price and a plan — nothing is
        charged until you have agreed to it.
      </p>

      <div className="mt-6 rounded-[20px] border bg-card p-5">
        <PortalForm action={submitEnquiryAction} submitLabel="Send it over" ariaLabel="Ask for a service">
          <div className="grid gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="summary">What are you after?</Label>
              <Input id="summary" name="summary" required maxLength={200} placeholder="A new website for the second branch" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="detail">Anything else we should know?</Label>
              <Textarea
                id="detail"
                name="detail"
                rows={5}
                maxLength={4000}
                placeholder="Roughly when you need it, anything you have already got, anything you definitely do not want."
              />
            </div>
          </div>
        </PortalForm>
      </div>
    </div>
  );
}
