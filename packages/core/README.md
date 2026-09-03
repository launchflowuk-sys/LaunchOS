# @launchos/core
Domain services. One folder per domain (`clients`, `sites`, `support`, `ads`, `knowledge`, `monitoring`, `incidents`, `approvals`, `audit`, `events`). Every function: `(db, organisationId, input)`. Zod input types exported next to the function. Writes are audited. No LLM calls here.
