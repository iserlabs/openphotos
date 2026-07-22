const req = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};

export const config = {
  get DATABASE_URL() { return req("DATABASE_URL"); },
  get JETSTREAM_URL() { return process.env.JETSTREAM_URL ?? "wss://jetstream2.us-east.bsky.network"; },
  get HEALTH_PORT() { return Number(process.env.HEALTH_PORT ?? 8080); },
};
