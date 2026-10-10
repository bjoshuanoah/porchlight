// Render-time privacy pipeline (PORCH-046 ac-4): the hide rule and origin
// containment govern every feed render exactly the same way — loaded feed,
// live arrival, or cached timeline. There is no path that inserts a post
// into the feed without passing through this filter, so a foreign-network
// or hidden post never renders, live or cached.

export const identityOf = (row) => String(row?._id ?? row?.id ?? '');
export const originOf = (post) => post?.originNetworkId ?? post?.networkId ?? post?.origin?.id;
export const networkId = (data) => data?.network?._id ?? data?.network?.id;
/** The chip name: origin-labeled attribution, resolved per the containment rules. */
export const originName = (post, data) =>
  post?.origin?.name ?? post?.network
  ?? (String(originOf(post)) === String(networkId(data)) || !originOf(post) ? data?.network?.name : null)
  ?? originOf(post) ?? 'This network';
export const postKey = (post) => `${post?.origin ?? originOf(post) ?? ''}:${identityOf(post)}`;

export function visibleAtOrigin(post, data) {
  return !originOf(post)
    || !networkId(data)
    || String(originOf(post)) === String(networkId(data))
    || data.connections?.some(
      (connection) => String(connection.networkId) === String(originOf(post))
        || (post.origin && String(connection.url).replace(/\/$/, '') === String(post.origin).replace(/\/$/, '')),
    );
}

/** The one filter every feed render rides: origin containment plus the member's hidden set. */
export function visibleFeedPosts(posts, data, hidden) {
  return (posts ?? []).filter(
    (post) => visibleAtOrigin(post, data)
      && !hidden?.has(postKey(post)),
  );
}