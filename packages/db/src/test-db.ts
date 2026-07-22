import { fileURLToPath } from "node:url";
import path from "node:path";
import * as schema from "./schema.js";

// `@electric-sql/pglite`, `drizzle-orm/pglite`, and the pglite migrator are
// devDependencies used only by tests. They MUST be imported lazily (inside
// createTestDb) so the package barrel — `export * from "./test-db.js"` — does
// not pull them into the production runtime graph, where they aren't installed
// (see the ingestor's --prod Docker image).
const migrationsFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");

export async function createTestDb() {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const db = drizzle(new PGlite(), { schema });
  await migrate(db, { migrationsFolder });
  return db as unknown as import("./client.js").Db;
}
