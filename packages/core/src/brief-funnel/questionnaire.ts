import { z } from "zod";

/**
 * The eight stages, defined once.
 *
 * One definition feeds three things that must never disagree: the screens that
 * render the questions, the validation that decides whether a step is finished,
 * and the mapping that turns answers into a brief. Written separately, those
 * three drift — a field gets renamed on the form, the brief keeps reading the
 * old key, and nobody notices until a client is sent a brief with a blank in it.
 *
 * `sourcePath` is the thread through all of it. Every requirement in the
 * generated brief cites the answers it came from, so "you said you wanted
 * online bookings" can always be traced back to the tap that said so.
 *
 * Changing any `key` here, or the meaning of one, is a new
 * `QUESTIONNAIRE_VERSION`. Old drafts keep their number and stay readable.
 */

export type FieldKind =
  | "text"
  | "email"
  | "tel"
  | "textarea"
  | "select"
  | "single"
  | "multi"
  | "chips"
  | "date"
  | "upload";

export interface FieldOption {
  /** Stored on the answer. Stable when the label is reworded. */
  value: string;
  label: string;
  /** The quieter line under the label on a choice card. */
  hint?: string;
}

export interface FieldDef {
  key: string;
  label: string;
  kind: FieldKind;
  hint?: string;
  placeholder?: string;
  /** Required to finish the step it lives on. Nothing is required to *save*. */
  required?: boolean;
  options?: readonly FieldOption[];
  maxLength?: number;
  /** The browser autofill hint. Worth getting right: it is most of the mobile experience. */
  autoComplete?: string;
  /**
   * Shown only when another field holds one of these values — the conditional
   * detail panels. Answers to a hidden field stay in the draft but leave the
   * active scope, so deselecting a goal does not lose the work.
   */
  showWhen?: { key: string; hasAny: readonly string[] };
  /** Sits beside its neighbour on desktop — email and phone, town and postcode. */
  half?: boolean;
}

export interface StageDef {
  step: number;
  key: string;
  /** The short name under its segment in the stepper. Two or three words. */
  navLabel: string;
  /** The small grey line above the heading on the card. */
  eyebrow: string;
  title: string;
  blurb: string;
  /** The quiet line under the button telling them what is coming. */
  nextHint?: string;
  fields: readonly FieldDef[];
}

/** Illustrative discovery bands, not a quotation. Kept here so they are one edit. */
export const BUDGET_BANDS: readonly FieldOption[] = [
  { value: "under_1500", label: "Under £1,500", hint: "A few pages, done properly" },
  { value: "1500_3000", label: "£1,500 – £3,000", hint: "Most small business sites" },
  { value: "3000_5000", label: "£3,000 – £5,000", hint: "Bookings, accounts, more pages" },
  { value: "over_5000", label: "£5,000+", hint: "Shops and bespoke builds" },
  { value: "unsure", label: "I'd like guidance", hint: "Tell us what it should cost" },
];

const GOALS: readonly FieldOption[] = [
  { value: "enquiries", label: "More enquiries", hint: "Calls, forms, messages" },
  { value: "sales", label: "Sell online", hint: "Products or digital goods" },
  { value: "bookings", label: "Take bookings", hint: "Appointments or jobs" },
  { value: "credibility", label: "Look credible", hint: "Be taken seriously" },
  { value: "showcase", label: "Show the work", hint: "Photos of what you do" },
  { value: "other", label: "Something else" },
];

const PAGES: readonly FieldOption[] = [
  { value: "home", label: "Home" },
  { value: "about", label: "About" },
  { value: "services", label: "Services" },
  { value: "service_detail", label: "A page per service" },
  { value: "gallery", label: "Gallery" },
  { value: "testimonials", label: "Reviews" },
  { value: "faq", label: "FAQ" },
  { value: "blog", label: "Blog or news" },
  { value: "contact", label: "Contact" },
  { value: "shop", label: "Shop" },
  { value: "other", label: "Something else" },
];

const FEATURES: readonly FieldOption[] = [
  { value: "enquiry_form", label: "Enquiry form" },
  { value: "booking", label: "Online booking" },
  { value: "payments", label: "Take payments" },
  { value: "accounts", label: "Customer accounts" },
  { value: "chat", label: "Live chat" },
  { value: "newsletter", label: "Newsletter signup" },
  { value: "maps", label: "Map and directions" },
  { value: "languages", label: "More than one language" },
  { value: "other", label: "Something else" },
];

/** Yes / no / don't know. "Not sure" is a real answer and must not be forced into a guess. */
const TRIAGE: readonly FieldOption[] = [
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" },
  { value: "unsure", label: "Not sure" },
];

export const STAGES: readonly StageDef[] = [
  {
    step: 1,
    key: "contact",
    navLabel: "Your details",
    eyebrow: "YOUR DETAILS",
    nextHint: "Next: a little about your business",
    title: "First, let's meet",
    blurb: "So we can get back to you. Nothing else on this form is compulsory.",
    fields: [
      { key: "name", label: "Your name", kind: "text", required: true, autoComplete: "name", placeholder: "Sam Taylor", maxLength: 120 },
      { key: "email", label: "Email", kind: "email", half: true, autoComplete: "email", placeholder: "sam@business.co.uk", maxLength: 254 },
      { key: "phone", label: "Phone", kind: "tel", half: true, autoComplete: "tel", placeholder: "07700 900123", hint: "Either email or phone is enough to reach you.", maxLength: 40 },
      { key: "addressLine1", label: "Address", kind: "text", autoComplete: "street-address", maxLength: 200 },
      { key: "city", label: "Town or city", kind: "text", half: true, autoComplete: "address-level2", maxLength: 100 },
      { key: "postcode", label: "Postcode", kind: "text", half: true, autoComplete: "postal-code", maxLength: 20 },
    ],
  },
  {
    step: 2,
    key: "business",
    navLabel: "Your business",
    eyebrow: "YOUR BUSINESS",
    nextHint: "Next: what you want it to do",
    title: "Your business",
    blurb: "What you do, and who for.",
    fields: [
      { key: "business", label: "Business name", kind: "text", required: true, autoComplete: "organization", placeholder: "Taylor Plumbing", maxLength: 200 },
      { key: "industry", label: "What you do", kind: "text", required: true, hint: "A trade, a sector — whatever you'd say at a party.", placeholder: "Plumbing and heating", maxLength: 120 },
      { key: "description", label: "In your own words", kind: "textarea", hint: "A sentence or two. This is what the site ends up saying about you.", maxLength: 2000 },
      { key: "audience", label: "Who your customers are", kind: "textarea", placeholder: "Homeowners in Thurrock and east London", maxLength: 1000 },
      { key: "websiteUrl", label: "Existing website", kind: "text", hint: "Leave blank if you haven't got one.", placeholder: "https://", maxLength: 500 },
      { key: "serviceArea", label: "Areas you cover", kind: "text", placeholder: "Grays and across Thurrock", maxLength: 200 },
      // Ours, not the handoff's. For a local trade these two decide half the
      // build — whether there is a Google listing to feed and reviews to pull.
      { key: "hasGoogleListing", label: "Google Business listing?", kind: "single", options: TRIAGE },
      { key: "hasFacebookPage", label: "Facebook page?", kind: "single", options: TRIAGE },
    ],
  },
  {
    step: 3,
    key: "goals",
    navLabel: "Your goals",
    eyebrow: "YOUR GOALS",
    nextHint: "Next: how it should look",
    title: "What you want out of it",
    blurb: "Pick everything that applies.",
    fields: [
      { key: "goals", label: "Your goals", kind: "multi", required: true, options: GOALS },
      { key: "goalsOther", label: "Tell us more", kind: "text", showWhen: { key: "goals", hasAny: ["other"] }, maxLength: 500 },
    ],
  },
  {
    step: 4,
    key: "design",
    navLabel: "Design direction",
    eyebrow: "DESIGN DIRECTION",
    nextHint: "Next: pages and features",
    title: "How it should feel",
    blurb: "There is no wrong answer, and we can change it later.",
    fields: [
      {
        key: "designDirection", label: "Style", kind: "single", required: true,
        options: [
          { value: "clean", label: "Clean and simple", hint: "Lots of space, easy to read" },
          { value: "bold", label: "Bold", hint: "Strong colour, big type" },
          { value: "warm", label: "Warm and friendly", hint: "Soft, approachable" },
          { value: "classic", label: "Classic", hint: "Traditional, established" },
          { value: "unsure", label: "Help me choose", hint: "We'll suggest something" },
        ],
      },
      { key: "colours", label: "Colours you want used", kind: "text", hint: "Brand colours, or just what you like.", maxLength: 200 },
      { key: "referenceUrls", label: "Sites you like", kind: "textarea", hint: "One per line. Competitors count.", maxLength: 1000 },
    ],
  },
  {
    step: 5,
    key: "scope",
    navLabel: "Pages & features",
    eyebrow: "PAGES & FEATURES",
    nextHint: "Next: words and pictures",
    title: "Pages and features",
    blurb: "A rough idea is fine — we'll tell you what's missing.",
    fields: [
      { key: "pages", label: "Pages you want", kind: "chips", required: true, options: PAGES },
      { key: "features", label: "Things it needs to do", kind: "multi", options: FEATURES },
      // The conditional panels. Shown by what was chosen above, never as extra
      // stages — the progress bar stays at eight.
      { key: "shopProductCount", label: "Roughly how many products?", kind: "text", showWhen: { key: "goals", hasAny: ["sales"] }, hint: "A guess is fine, and \"not sure\" is a real answer.", maxLength: 100 },
      { key: "shopKind", label: "What are you selling?", kind: "single", showWhen: { key: "goals", hasAny: ["sales"] }, options: [
        { value: "physical", label: "Physical goods" }, { value: "digital", label: "Digital goods" },
        { value: "services", label: "Services" }, { value: "mixed", label: "A mixture" }, { value: "unsure", label: "Not sure" },
      ] },
      { key: "shopPlatform", label: "Anything you sell on already?", kind: "text", showWhen: { key: "goals", hasAny: ["sales"] }, hint: "Just the name — never a login.", maxLength: 200 },
      { key: "bookingServices", label: "What gets booked?", kind: "textarea", showWhen: { key: "goals", hasAny: ["bookings"] }, maxLength: 1000 },
      { key: "bookingTool", label: "Booking tool you use now", kind: "text", showWhen: { key: "goals", hasAny: ["bookings"] }, hint: "Just the name — never a login.", maxLength: 200 },
      { key: "accountsPurpose", label: "What should an account let people do?", kind: "textarea", showWhen: { key: "features", hasAny: ["accounts"] }, maxLength: 1000 },
      { key: "serviceNames", label: "Name your services", kind: "textarea", showWhen: { key: "pages", hasAny: ["service_detail"] }, hint: "One per line. These become the pages.", maxLength: 1000 },
      { key: "redesignKeep", label: "Anything on the current site that has to stay?", kind: "textarea", showWhen: { key: "websiteUrl", hasAny: ["*"] }, maxLength: 1000 },
      { key: "scopeNotes", label: "Anything else it needs", kind: "textarea", maxLength: 2000 },
    ],
  },
  {
    step: 6,
    key: "content",
    navLabel: "Your content",
    eyebrow: "YOUR CONTENT",
    nextHint: "Next: budget and timing",
    title: "Words and pictures",
    blurb: "Most people have less ready than they think. That's normal.",
    fields: [
      {
        key: "contentSupport", label: "What you need help with", kind: "multi",
        options: [
          { value: "ready", label: "I have the words", hint: "Text is written" },
          { value: "writing", label: "Write it for me" },
          { value: "photography", label: "I need photos" },
          { value: "branding", label: "I need a logo" },
        ],
      },
      { key: "attachments", label: "Anything you already have", kind: "upload", hint: "Logo, photos, an old brochure. PNG, JPEG, WebP or PDF." },
      { key: "contentNotes", label: "Notes", kind: "textarea", maxLength: 2000 },
    ],
  },
  {
    step: 7,
    key: "timing",
    navLabel: "Budget & timing",
    eyebrow: "BUDGET & TIMING",
    nextHint: "Next: check it over",
    title: "Budget and timing",
    blurb: "Ranges to plan against, not a quote. We'll price it properly once we know the shape.",
    fields: [
      { key: "budget", label: "Rough budget", kind: "single", required: true, options: BUDGET_BANDS },
      {
        key: "timeline", label: "When you need it", kind: "chips", required: true,
        options: [
          { value: "asap", label: "As soon as possible" },
          { value: "1_3_months", label: "1–3 months" },
          { value: "3_6_months", label: "3–6 months" },
          { value: "flexible", label: "No rush" },
        ],
      },
      { key: "targetDate", label: "A date it has to be live by", kind: "date", hint: "An opening, an event — leave blank if there isn't one." },
    ],
  },
  {
    step: 8,
    key: "review",
    navLabel: "Review your brief",
    eyebrow: "REVIEW YOUR BRIEF",
    title: "Check it over",
    blurb: "Change anything you like. Blanks are fine — we'll ask.",
    fields: [],
  },
];

/** Every field on every stage, by key. Built once. */
export const FIELDS_BY_KEY: ReadonlyMap<string, FieldDef> = new Map(
  STAGES.flatMap((stage) => stage.fields.map((field) => [field.key, field] as const)),
);

export function stageFor(step: number): StageDef | undefined {
  return STAGES.find((stage) => stage.step === step);
}

/**
 * Whether a conditional field is currently in scope.
 *
 * `"*"` means "any answer at all" — used for the redesign questions, which
 * appear because a website URL was given rather than because a particular one
 * was. A missing parent hides the child; that is what makes deselecting a goal
 * take its follow-up questions with it.
 */
export function isFieldActive(field: FieldDef, answers: Record<string, unknown>): boolean {
  if (!field.showWhen) return true;
  const parent = answers[field.showWhen.key];
  if (parent === undefined || parent === null || parent === "") return false;
  if (field.showWhen.hasAny.includes("*")) return true;
  const held = Array.isArray(parent) ? parent.map(String) : [String(parent)];
  return held.some((value) => field.showWhen!.hasAny.includes(value));
}

/**
 * The answers that count, with hidden ones dropped.
 *
 * A goal deselected on the way back leaves its follow-up answers in the draft —
 * reselecting it must not have lost the typing — but they are not requirements
 * any more, and a brief built from the raw draft would quietly reinstate them.
 */
export function activeAnswers(answers: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(answers)) {
    const field = FIELDS_BY_KEY.get(key);
    if (field && !isFieldActive(field, answers)) continue;
    out[key] = value;
  }
  return out;
}

/** Answers held in the draft that are no longer in scope — shown on review as excluded. */
export function excludedAnswerKeys(answers: Record<string, unknown>): string[] {
  return Object.keys(answers).filter((key) => {
    const field = FIELDS_BY_KEY.get(key);
    return Boolean(field && !isFieldActive(field, answers));
  });
}

export interface StepValidation {
  ok: boolean;
  /** Field key to the reason, so an error can be rendered beside its own input. */
  errors: Record<string, string>;
}

function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/**
 * Whether a step may be marked complete. Server-side, always.
 *
 * Step one is the exception worth stating: the form asks for six things, but
 * the only requirement to move on is a name and one way to be contacted.
 * Demanding an address here would lose people at the first screen for a detail
 * we can ask for later — which is what "I'll share my address later" is for.
 */
export function validateStep(step: number, answers: Record<string, unknown>): StepValidation {
  const stage = stageFor(step);
  if (!stage) return { ok: false, errors: { _: "that step does not exist" } };

  const errors: Record<string, string> = {};

  for (const field of stage.fields) {
    if (!field.required) continue;
    if (!isFieldActive(field, answers)) continue;
    if (isEmpty(answers[field.key])) errors[field.key] = `${field.label} is needed to carry on`;
  }

  if (step === 1) {
    const email = typeof answers.email === "string" ? answers.email.trim() : "";
    const phone = typeof answers.phone === "string" ? answers.phone.trim() : "";
    if (!email && !phone) {
      errors.email = "An email or a phone number — either is fine";
    }
    if (email && !z.string().email().safeParse(email).success) {
      errors.email = "That email does not look right";
    }
  }

  return { ok: Object.keys(errors).length === 0, errors };
}

/**
 * Steps whose requirements these answers meet.
 *
 * **Not the progress bar.** Some stages have nothing required on them, so an
 * empty draft "satisfies" them — which is true and useless, because nobody has
 * seen the screen. The bar reads `brief_sessions.completed_steps`, which is
 * written only when somebody actually finishes a step.
 *
 * This is for the questions the server has to answer itself: may this be
 * submitted, and on resume, which steps would still pass.
 */
export function satisfiedSteps(answers: Record<string, unknown>): number[] {
  return STAGES.filter((stage) => stage.step < 8 && validateStep(stage.step, answers).ok).map((s) => s.step);
}

/**
 * Whether the brief may be sent.
 *
 * Every stage that has requirements must meet them. Checked here rather than
 * trusted from the browser, because "I completed all the steps" is exactly the
 * claim a client cannot be allowed to make about itself.
 */
export function canSubmit(answers: Record<string, unknown>): StepValidation {
  const errors: Record<string, string> = {};
  for (const stage of STAGES) {
    if (stage.step === 8) continue;
    for (const [key, message] of Object.entries(validateStep(stage.step, answers).errors)) {
      errors[key] = message;
    }
  }
  return { ok: Object.keys(errors).length === 0, errors };
}
