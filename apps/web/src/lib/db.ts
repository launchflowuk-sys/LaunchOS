import { createDb } from "@launchos/db";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");

export const db = createDb(url);
