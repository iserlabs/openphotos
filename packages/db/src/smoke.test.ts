import { describe, it, expect } from "vitest";
import { DB_PACKAGE } from "./index.js";
describe("workspace", () => { it("resolves", () => expect(DB_PACKAGE).toBe("@luminance/db")); });
