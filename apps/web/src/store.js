// Browser-local preferences and cached reads are scoped by the hub origin.
const prefix = "porchlight:v1:";

export const storagePrefix = prefix;

export function readLocal(storage, origin, field, fallback) {
  try {
    const value = storage.getItem(`${prefix}${origin}:${field}`);
    return value === null ? fallback : JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function writeLocal(storage, origin, field, value) {
  storage.setItem(`${prefix}${origin}:${field}`, JSON.stringify(value));
}

export function hiddenPosts(storage, origin) {
  return new Set(readLocal(storage, origin, "hidden", []));
}

export function hidePost(storage, origin, id) {
  const ids = hiddenPosts(storage, origin);
  ids.add(id);
  writeLocal(storage, origin, "hidden", [...ids]);
  return ids;
}

export function unhidePost(storage, origin, id) {
  const ids = hiddenPosts(storage, origin);
  ids.delete(id);
  writeLocal(storage, origin, "hidden", [...ids]);
  return ids;
}

export function cachedTimeline(storage, origin, now = Date.now(), ttl = 24 * 60 * 60 * 1000) {
  const cached = readLocal(storage, origin, "timeline", null);
  return cached && now - cached.savedAt < ttl ? cached.posts : [];
}

export function saveTimeline(storage, origin, posts, now = Date.now()) {
  writeLocal(storage, origin, "timeline", { posts, savedAt: now });
}

export function readConnections(storage, origin) {
  return readLocal(storage, origin, "connections", []);
}

export function saveConnections(storage, origin, connections) {
  writeLocal(storage, origin, "connections", connections);
}

// Token custody keys: where renewed token sets are published between tabs
// (PORCH-028) and which tab is currently renewing for this origin.
export function connectionsStorageKey(origin) {
  return `${prefix}${origin}:connections`;
}

export function renewSlotKey(origin) {
  return `${prefix}${origin}:renew-slot`;
}
