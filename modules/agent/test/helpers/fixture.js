import { createMemoryStore } from "@porchlight/shared";
import { assembleAgentModule } from "../../src/index.js";

/**
 * The agent module over the REAL services on an in-memory store, with the
 * identity plane faked the hub would inject it: sessions, the hub-admin
 * fact, and the family facts the parental narrowing composes against.
 */
export function makeAgentHub({ admins = [], families = [] } = {}) {
  const store = createMemoryStore();
  const sessions = new Map();
  const events = [];
  const familyFacts = {
    familiesForMember: async (did) => families.filter((f) => f.parentIdentityRefs.includes(did) || f.memberIdentityRefs.includes(did)),
  };
  const adminFacts = { isAdmin: async (did) => admins.includes(did) };
  const mod = assembleAgentModule(store, {
    verifySession: async (token) => sessions.get(token) ?? null,
    adminFacts,
    familyFacts,
    onProfileChange: (event) => events.push(event),
  });
  const sign = (did, deviceId = "dev-1") => {
    const token = `tok-${did}-1`;
    sessions.set(token, { did, deviceId });
    return token;
  };
  return { mod, store, sign, events, admins, families };
}

export function assertDenied(result, code, message) {
  if (!(result instanceof Error) || result.code !== code) {
    throw new Error(`expected a ${code} error, got: ${JSON.stringify(String(result))}`);
  }
  if (message) {
    if (!new RegExp(message).test(result.message)) {
      throw new Error(`expected message to match /${message}/, got: ${result.message}`);
    }
  }
  return result;
}
