import { defineConfig } from "drizzle-kit";
const url = process.env.DATABASE_URL;
if (!url && process.argv.some((a) => ["migrate", "studio", "push"].includes(a))) {
  throw new Error("DATABASE_URL must be set for migrate/studio/push");
}
export default defineConfig({
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  casing: "snake_case",
  dbCredentials: { url: url ?? "postgres://launchos:launchos@localhost:5432/launchos" },
});
