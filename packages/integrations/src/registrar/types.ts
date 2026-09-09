/**
 * What a registrar can tell us about a domain we manage.
 *
 * Deliberately tiny. LaunchOS does not buy, transfer or renew domains through
 * an API — it *watches* them, because a domain that lapses takes the client's
 * website and their email with it and no monitor sees it coming. So the only
 * question this interface answers is the one that matters: when does it run
 * out, and is it set to renew itself.
 */

export interface RegistrarDomain {
  /** Apex name, lower-cased, no trailing dot — matched against `domains.name`. */
  name: string;
  /** When it lapses. Null when the registrar does not say. */
  expiresAt: Date | null;
  /** Null when the registrar does not report it, which is not the same as false. */
  autoRenew: boolean | null;
  /** The registrar's own word for the state, kept verbatim for the audit row. */
  status: string | null;
}

export interface RegistrarAdapter {
  readonly name: "hostinger" | "mock";
  /** Every domain on the account. Throws on auth or transport failure; never returns a partial list silently. */
  listDomains(): Promise<RegistrarDomain[]>;
}
