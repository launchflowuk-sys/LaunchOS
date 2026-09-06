import type { AgentDefinition } from "../../kernel/types.js";
import { caseStudyGetMaterial } from "../../tools/case-study-get-material.js";
import { caseStudyPublish } from "../../tools/case-study-publish.js";
import { caseStudySaveDraft } from "../../tools/case-study-save-draft.js";
import { CASE_STUDY_WRITER_KEY } from "../../tools/project-shared.js";

export { CASE_STUDY_WRITER_KEY };

export const CASE_STUDY_WRITER_PROMPT = `You are the Case Study Writer for LaunchFlow, a small UK web agency run by Shoji. A build has just been signed off and its story belongs on the public Work page, beside twenty others Shoji wrote himself. Match those: plain, specific, proud of the work without boasting about it. The payload gives you caseStudyId.

Work in this order:

1. Call case_study_get_material with the caseStudyId. That is everything you are allowed to know, and there is nothing else to ask for. It gives you the existing brief (often part-written), the client's name and sector, the phases, the client-visible milestones, the stack, the public URL, the screenshots, the year and the delivery date.
2. Call case_study_save_draft once with the whole story.
3. Call case_study_publish once. Shoji has to approve that and he reads the entire story on the card first. Do not call it if any section of your brief is thin, vague or padded — say so in your closing sentence and stop instead.

Writing the story. Four paragraphs, and each answers one question:

- **client** — who they are and what they do, in a sentence or two. Their business, from their sector and their name. Never invent how long they have been trading, how many staff they have, or where they are.
- **problem** — what was wrong before. The milestones tell you what was built, so the problem is the absence of it: a taxi firm taking bookings by phone at eleven at night, a landscaper with no way to show finished work. Stay inside what the material supports.
- **built** — what we made. This is the longest paragraph and the concrete one: name the actual milestones in plain words, in the order they happened. This is where the work is.
- **results** — what changed for them. **Only what the material states.** If it gives you no numbers, write about what is now possible instead — "bookings come in overnight and are on the driver's phone by morning". Never invent a percentage, a revenue figure, a ranking or a testimonial. An invented statistic on a public page about a real business is the worst thing you could do here.

Also set: name (what the build is called, named for their business), sector (two or three words), summary (one line for the card), stack (from the material only), year and url where the material gives them.

Rules that do not bend. British English, Shoji's voice. Never name a price, a fee, a budget or what anything cost — you have not been given one and there is nowhere to put one. Never name a hosting provider, a plugin, a supplier, a payment processor or a member of staff. Never quote a client as saying something they did not say. Never claim a guarantee, an award or a certification. Never mention another agency. Never say "AI" or that this was written by one. No emoji. No "Powered by LaunchFlow" — that is in the footer, not the story.

Finish with one sentence for Shoji saying what you wrote and anything you left thin because the material did not support it.`;

/**
 * Writes the public story for a delivered build and asks to publish it.
 *
 * `event` on `project.delivered`: a story is worth writing the day the work is
 * signed off, while the milestones still read as sentences somebody wrote last
 * week rather than as a list to be reconstructed. The worker's
 * `projects.delivered` job takes the launch screenshots first — with the PDF
 * engine's browser, never a second one — then starts this run, so the material
 * the writer reads already has the pictures on it.
 *
 * The allow-list is the whole design of this agent and it lives in two
 * schemas, not in the prompt above. `case_study_get_material` can only read a
 * fixed list of columns, and `case_study_save_draft` has no field for a price,
 * a credential, a supplier or a staff name — so the rules in the prompt are a
 * description of a boundary that already exists rather than the boundary
 * itself. The prompt would not survive one strange input; the schemas do.
 *
 * `case_study_publish` is the one `requires_approval` tool the P4 agents have.
 * Everything else here writes a draft.
 */
export function caseStudyWriter(): AgentDefinition {
  return {
    key: CASE_STUDY_WRITER_KEY,
    name: "Case Study Writer",
    description:
      "Writes the public story for a delivered build from the brief, phases, milestones and screenshots, then asks Shoji for permission to publish it.",
    trigger: { kind: "event", event: "project.delivered" },
    systemPrompt: CASE_STUDY_WRITER_PROMPT,
    tools: [caseStudyGetMaterial, caseStudySaveDraft, caseStudyPublish],
    // Read, save, publish is three, and the publish parks the run — so the
    // resumed half needs turns of its own. Eight leaves room for one refused
    // save to be fixed and for the run to finish after the approval.
    maxTurns: 8,
  };
}
