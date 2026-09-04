import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";

export const ListPackagesInput = z.object({ activeOnly: z.boolean().default(false) });
export type ListPackagesInput = z.input<typeof ListPackagesInput>;

export async function listPackages(db: Db, organisationId: string, input: ListPackagesInput = {}) {
  const v = ListPackagesInput.parse(input);
  const where = v.activeOnly
    ? and(eq(schema.packages.organisationId, organisationId), eq(schema.packages.active, true))
    : eq(schema.packages.organisationId, organisationId);
  return db.select().from(schema.packages).where(where).orderBy(asc(schema.packages.name));
}

export async function getPackage(db: Db, organisationId: string, packageId: string) {
  const [row] = await db.select().from(schema.packages)
    .where(and(eq(schema.packages.id, packageId), eq(schema.packages.organisationId, organisationId)));
  return row ?? null;
}
