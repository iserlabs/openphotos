const req = (k: string): string => { const v = process.env[k]; if (!v) throw new Error(`missing env ${k}`); return v; };
export const env = {
  get DATABASE_URL() { return req("DATABASE_URL"); },
  get PUBLIC_URL() { return req("PUBLIC_URL"); },
  get SESSION_SECRET() { return req("SESSION_SECRET"); },
  get ADMIN_DIDS() { return (process.env.ADMIN_DIDS ?? "").split(",").filter(Boolean); },
  get OAUTH_JWK_1() { return req("OAUTH_JWK_1"); },
};
