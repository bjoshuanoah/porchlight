import { socialModels } from "../models.js";

/**
 * Social feed service. Owns the complete route → controller → service →
 * model path for social. Uses only social-owned models and never imports
 * identity internals (identity and social share zero models).
 */
export class FeedService {
  constructor() {
    this.models = socialModels;
  }

  createPost({ userId, body }) {
    return { id: `post_${crypto.randomUUID()}`, userId, body };
  }

  /**
   * NOTE: deliberately does NOT import identity models — identity and social
   * share zero models. Cross-domain data access goes through the module
   * boundary (controller → service of the other module), never a direct
   * internal import.
   */
  summarize(post) {
    return `${post.userId}: ${post.body}`;
  }
}

export default FeedService;
