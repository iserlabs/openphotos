import { describe, it, expect } from "vitest";
import { resolvePdsEndpoint } from "./identity.js";

const didDoc = {
  id: "did:plc:abc",
  service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: "https://pds.example.com" }],
};
describe("resolvePdsEndpoint", () => {
  it("resolves did:plc via plc.directory", async () => {
    const fetchJson = async (url: string) => { expect(url).toBe("https://plc.directory/did:plc:abc"); return didDoc; };
    expect(await resolvePdsEndpoint("did:plc:abc", fetchJson)).toBe("https://pds.example.com");
  });
  it("rejects a PDS endpoint that is not https", async () => {
    const bad = { ...didDoc, service: [{ ...didDoc.service[0], serviceEndpoint: "http://internal:2583" }] };
    await expect(resolvePdsEndpoint("did:plc:abc", async () => bad)).rejects.toThrow();
  });
  it("resolves did:web via https://<host>/.well-known/did.json", async () => {
    const webDoc = {
      id: "did:web:pds.example.com",
      service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: "https://pds.example.com" }],
    };
    const fetchJson = async (url: string) => {
      expect(url).toBe("https://pds.example.com/.well-known/did.json");
      return webDoc;
    };
    expect(await resolvePdsEndpoint("did:web:pds.example.com", fetchJson)).toBe("https://pds.example.com");
  });
});
