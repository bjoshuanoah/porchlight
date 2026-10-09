// Each connection carries one origin's membership; API calls never cross origins.
export async function request(connection, path, init = {}) {
  const base = new URL(connection.url || window.location.origin);
  const target = new URL(`/api/${path.replace(/^\/+/, "")}`, base);
  const response = await fetch(target, {
    ...init,
    headers: {
      ...(init.body && !(init.body instanceof FormData) ? { "content-type": "application/json" } : {}),
      ...(connection.token ? { authorization: `Bearer ${connection.token}` } : {}),
      ...init.headers,
    },
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.error || `The hub returned ${response.status}.`);
    error.code = result.code;
    error.status = response.status;
    error.body = result;
    throw error;
  }
  return result;
}

export async function loadFeeds(connections) {
  const results = await Promise.allSettled(connections.map(async (connection) => {
    const [timeline, ranked] = await Promise.all([
      request(connection, "social/timeline"),
      request(connection, "social/ranked"),
    ]);
    const origin = new URL(connection.url).origin;
    const label = connection.name || origin;
    const annotate = (post) => ({ ...post, origin, network: label });
    return { origin, posts: timeline.posts.map(annotate), ranked: ranked.posts.map(annotate) };
  }));
  const posts = [], ranked = [], failures = [];
  for (let i = 0; i < results.length; i++) {
    const item = results[i];
    if (item.status === "fulfilled") {
      posts.push(...item.value.posts);
      ranked.push(...item.value.ranked);
    } else failures.push({ origin: connections[i].url, message: item.reason.message });
  }
  posts.sort((a, b) => new Date(b.lastActivityAt || b.createdAt) - new Date(a.lastActivityAt || a.createdAt));
  // Preserve each origin's published rank order. No invented cross-origin scoring.
  return { posts, ranked, failures };
}
