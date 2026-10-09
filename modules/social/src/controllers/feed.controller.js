import { FeedService } from "../services/feed.service.js";

/**
 * Social feed controller. Transport-specific: translates between HTTP and
 * the domain. Business logic and models stay in the service layer.
 */
export class FeedController {
  /**
   * @param {FeedService} [service]
   */
  constructor(service = new FeedService()) {
    this.service = service;
  }

  /**
   * POST /posts — creates a post owned by the social domain.
   */
  createPost = (req, res) => {
    const { userId, body } = req.body ?? {};
    if (!userId || !body) {
      return res.status(400).json({ error: "userId and body required" });
    }
    const post = this.service.createPost({ userId, body });
    res.status(201).json(post);
  };
}

export default FeedController;