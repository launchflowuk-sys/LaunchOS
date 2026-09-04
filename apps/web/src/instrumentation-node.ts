/**
 * Node-runtime half of `instrumentation.ts`: importing `lib/env` runs the
 * startup validation (adapters, secrets, URLs) and throws on a refusal, which
 * aborts the boot. Kept in its own file so the Edge compilation of
 * `instrumentation.ts` never sees this import graph.
 */
import "./lib/env";
