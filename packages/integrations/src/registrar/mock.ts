import type { RegistrarAdapter, RegistrarDomain } from "./types.js";

/**
 * Knows nothing, and says so.
 *
 * An empty list rather than invented dates on purpose: the sync writes a
 * renewal date onto a real domain, and a mock that guessed would fill the
 * whole estate with fiction that then drives the warnings. "The registrar told
 * us nothing" and "the registrar says it expires on Tuesday" must never be
 * confusable, so the mock only ever produces the first.
 */
export class MockRegistrarAdapter implements RegistrarAdapter {
  readonly name = "mock" as const;

  constructor(private readonly domains: readonly RegistrarDomain[] = []) {}

  async listDomains(): Promise<RegistrarDomain[]> {
    return [...this.domains];
  }
}
