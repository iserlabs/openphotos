import { createDb, type Db } from "@luminance/db";
import { env } from "./env";

let db: Db | undefined;
export function getDb(): Db { return (db ??= createDb(env.DATABASE_URL)); }
