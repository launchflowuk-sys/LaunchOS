import { Mail, MessageSquare, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { CONTACT_EMAIL, REPLY_PROMISE } from "@/lib/marketing/site";

export interface PurchaseSummary {
  /** The plan as the client will see it named everywhere else. */
  packageName: string;
  /** Monthly price in pence, from the package we charged — never re-derived. */
  monthlyPricePence: number;
  /** Where the portal login was sent. Shown so a typo is obvious now, not in a week. */
  email: string;
  /** Their first name, for one line of address. */
  firstName: string | null;
  /** True when they paid by card; false on the invoice route. */
  paidByCard: boolean;
}

function money(pence: number): string {
  return `£${(pence / 100).toFixed(pence % 100 === 0 ? 0 : 2)}`;
}

/**
 * What happens next, after the money.
 *
 * This page replaced a single alert box reading "You're in. Check your email."
 * and a Sign in button. That was true but it is not what somebody who has just
 * handed over a card wants: they want to know what they bought, that it worked,
 * and who is going to do what.
 *
 * **Every claim here is one the system actually keeps, and the list is short
 * because of it.** What provably happens on payment is: the client record, the
 * subscription, a portal login with a one-time password, the welcome email, and
 * a bell on Shoji's phone. What does *not* happen — despite the welcome email
 * saying otherwise — is any onboarding task list: those come from
 * `task_templates` and there are none configured, so `generateOnboardingTasks`
 * writes nothing. So this page promises a person getting in touch, which is
 * real, rather than a process that is not.
 *
 * `REPLY_PROMISE` is reused rather than reworded: "within one working day" is
 * already published on the contact page, and a second, different promise on the
 * page where somebody has just paid is the one they would hold us to.
 *
 * The temporary password is deliberately **not** shown. It is in the email and
 * nowhere else — this page can be reached again from browser history on a
 * shared machine, and `completeSignup` is idempotent so a revisit renders the
 * same thing.
 */
export function NextSteps({ summary }: { summary: PurchaseSummary }) {
  const steps = [
    {
      icon: Mail,
      title: "Open the email we just sent",
      body: (
        <>
          It has your portal login and a temporary password, sent to{" "}
          <span className="font-medium break-all text-foreground">{summary.email}</span>. Sign in and change the
          password from your account page. If it is not there in a few minutes, check the spam folder before you
          worry — it is almost always there.
        </>
      ),
    },
    {
      icon: MessageSquare,
      title: "Shoji gets in touch",
      body: (
        <>
          You do not need to do anything to start this. {REPLY_PROMISE} He will ask what your business does, what you
          want the site to do, and which logins he needs — and nothing gets built or published without you seeing it
          first.
        </>
      ),
    },
    {
      icon: ShieldCheck,
      title: "Everything lands in your portal",
      body: (
        <>
          Invoices, the work in progress, anything waiting on you, and every post before it goes out. One place, and
          it is yours to look at whenever you like.
        </>
      ),
    },
  ];

  return (
    <div className="grid gap-8">
      {/* The receipt first: what was bought, at what price, on what terms.
          Somebody who has just paid checks this before they read anything. */}
      <div className="rounded-[20px] border bg-card p-6">
        <p className="text-meta text-muted-foreground">Your plan</p>
        <p className="mt-1 text-xl font-medium">{summary.packageName}</p>
        <p className="mt-1 text-sm text-muted-foreground">
          {money(summary.monthlyPricePence)} a month
          {summary.paidByCard ? ", starting today" : ", invoiced today"}. No VAT is charged.
        </p>
        <p className="mt-3 border-t pt-3 text-sm text-muted-foreground">
          It runs month to month. Either of us can end it with thirty days&rsquo; notice, and if you leave we hand over
          your files and help whoever takes it on.
        </p>
      </div>

      <div className="grid gap-5">
        <h2 className="text-base font-medium">
          {summary.firstName ? `What happens now, ${summary.firstName}` : "What happens now"}
        </h2>
        <ol className="grid gap-5">
          {steps.map((step, index) => (
            <li key={step.title} className="grid grid-cols-[2rem_1fr] gap-x-4">
              <span
                aria-hidden
                className="grid size-8 place-items-center rounded-full bg-primary-soft text-sm font-medium text-primary"
              >
                {index + 1}
              </span>
              <div className="min-w-0">
                <p className="flex items-center gap-2 text-sm font-medium">
                  <step.icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                  {step.title}
                </p>
                <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{step.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        <Button asChild size="lg" className="btn btn-ink">
          <Link href="/sign-in">Go to your portal</Link>
        </Button>
        <Button asChild size="lg" variant="secondary" className="btn btn-white">
          <a href={`mailto:${CONTACT_EMAIL}`}>Email us a question</a>
        </Button>
      </div>

      <p className="text-sm text-muted-foreground">
        Something not right — wrong plan, wrong email, charged twice? Reply to the welcome email or write to{" "}
        <a href={`mailto:${CONTACT_EMAIL}`} className="underline underline-offset-4">
          {CONTACT_EMAIL}
        </a>{" "}
        and it gets fixed by a person. Nothing here is automated to the point of being stuck.
      </p>
    </div>
  );
}
