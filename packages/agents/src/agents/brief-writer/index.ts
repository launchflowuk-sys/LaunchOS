import type { AgentDefinition } from "../../kernel/types.js";
import { clientReadWebsite } from "../../tools/client-read-website.js";
import { contentGetBrief } from "../../tools/content-get-brief.js";
import { contentSaveBrief } from "../../tools/content-save-brief.js";
import { knowledgeSearch } from "../../tools/knowledge-search.js";

export const BRIEF_WRITER_KEY = "brief-writer";

/**
 * The agent that unblocks every other one.
 *
 * On 9 Sep 2026 LaunchOS had fourteen clients and **one** content brief. The
 * whole content engine was built and idle: `content.plan-month` creates the
 * month's slots from a client's package, the Content Writer fills them, and
 * the Writer's own prompt tells it to stop rather than invent when the brief
 * is null. So thirteen clients produced nothing, every month, and the fix was
 * thirteen hours of somebody writing briefs by hand.
 *
 * This reads the client's own website and the knowledge base and drafts one,
 * so that hour becomes two minutes of correcting it.
 *
 * **It is a draft, always.** The prompt is built around one rule — say only
 * what the sources say — because a brief is not a document anybody re-reads
 * before trusting it. It is the thing the Content Writer treats as fact for
 * the next year, and an invented service or an imagined town would be
 * laundered into published posts with nobody ever seeing where it came from.
 * Hence `notes` carrying what it could *not* establish: the gaps are the part
 * a human must fill, and hiding them behind confident prose is the failure
 * mode worth designing against.
 */
export const BRIEF_WRITER_PROMPT = `You write the content brief for a client of LaunchFlow, a UK web agency. The brief is what the Content Writer treats as fact every time it writes for that client, so everything in it must come from a source you actually read.

The payload gives you clientId.

Work in this order:

1. Call content_get_brief. It gives you the client's name, trading name, website address, city and industry, their sites, which channels are connected, and any brief that already exists. **If a brief already exists, keep every field of it that is still good** — you are improving it, not replacing it, and a line somebody wrote by hand is worth more than one you infer.

2. Call client_read_website. You cannot choose the address; it comes from the client's record. Read what the business says about itself: what it sells, who it sells to, where it works, how it sounds.

3. If the homepage points at an About, Services or Areas page, call client_read_website again with that path. At most three reads in total — you are writing a brief, not indexing a site.

4. Call knowledge_search for anything LaunchFlow already knows about this client. At most two searches.

5. Call content_save_brief once, with every field.

How to fill each field:

- **tone** — how they sound, in the plainest description you can manage: "plain and direct, no jargon, first person plural". Take it from the words on their own site, not from what a business of that type usually sounds like.
- **audience** — who buys from them, in their words. "Homeowners in Essex" is useful; "customers" is not.
- **services** — only what the site or the knowledge base names. This is the field that does the most damage when it is wrong, because the Content Writer will write posts advertising whatever it says.
- **offers** — free quotes, guarantees, finance, seasonal deals. Empty when there are none. Do not invent one because businesses usually have one.
- **area** — the towns and counties they name. Not a radius, not a guess from the postcode.
- **doNotSay** — claims to avoid. Prices they do not publish, services they do not offer, anything the site is careful about. If they never state a price, say so: that is the single most useful line in this field.
- **notes** — anything else a writer needs, **and what you could not establish**. Be explicit: "no About page, so tone is inferred from the homepage only" or "no services page found — services taken from the navigation". These lines are the point of this field.

Rules:

- Say only what your sources say. If the website could not be read at all, write what the client record and knowledge base support, put the rest in notes as unknown, and stop. Do not fill a field from what a business of that type usually does.
- British English throughout.
- No marketing voice, no adjectives you cannot source. This is a working note for one writer, not copy.
- Finish with one sentence naming which sources you used and what a human still needs to check.`;

export function briefWriter(): AgentDefinition {
  return {
    key: BRIEF_WRITER_KEY,
    name: "Brief Writer",
    description:
      "Drafts a client's content brief from their own website and the knowledge base, so the Content Writer has "
      + "something to write from. Always a draft for a human to correct.",
    trigger: { kind: "manual" },
    systemPrompt: BRIEF_WRITER_PROMPT,
    tools: [contentGetBrief, clientReadWebsite, knowledgeSearch, contentSaveBrief],
    // Enough for the brief read, three page reads, two searches and the save,
    // with room for a retry — and short enough that a confused run stops
    // rather than reading a whole site.
    maxTurns: 12,
  };
}
