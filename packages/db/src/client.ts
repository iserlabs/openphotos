import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";
export type Db = ReturnType<typeof createDb>;
export function createDb(url: string) {
  return drizzle(postgres(url, { prepare: false }), { schema });
}
