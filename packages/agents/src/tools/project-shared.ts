/**
 * What the two P4 agents' tools share: their keys, and the ceilings the
 * prompts and the tools agree on.
 */

/** `audit_log.actor_id` and `agent_enablement.agent_key` for the weekly update. */
export const PROJECT_REPORTER_KEY = "project-reporter";

/** The same for the writer of the public story. */
export const CASE_STUDY_WRITER_KEY = "case-study-writer";

/**
 * The longest a weekly update may be.
 *
 * A client on a build wants to know three things — what moved, what is next,
 * whether anything is waiting on them — and every extra paragraph makes those
 * three harder to find. `PROJECT_UPDATE_MAX_CHARS` in core is the hard
 * ceiling; this is the one the prompt asks for.
 */
export const PROJECT_UPDATE_TARGET_WORDS = 160;

/**
 * The longest each section of a case-study brief may be.
 *
 * `built` gets more room than the rest because it is the section that carries
 * the actual work; the other three are a paragraph each on the public page.
 */
export const CASE_STUDY_SECTION_MAX_CHARS = 1200;
export const CASE_STUDY_BUILT_MAX_CHARS = 2400;
