/**
 * OG controller (PORCH-079). Transport-specific: serves the composed unfurl
 * image for a shareable link (invite token or post deep link id) as raw
 * bytes; no domain logic, no auth — the image is content-free (ac-5), so
 * unauthenticated unfetchers (iMessage, Slack, chat clients) fetch it.
 */
export class OgController {
  /**
   * @param {import("../services/og.service.js").OgService} og
   * @param {((line: string) => void) | null} [log]
   */
  constructor(og, log = null) {
    this.og = og;
    this.log = log;
  }

  /** GET /og/invite/:token — the join link's unfurl image (ac-1). */
  inviteImage = async (req, res) => this.#serve(req, res, "invite");

  /** GET /og/post/:postId — the post deep link's unfurl image (ac-2). */
  postImage = async (req, res) => this.#serve(req, res, "post");

  async #serve(req, res, kind) {
    try {
      const id = kind === "invite" ? req.params.token : req.params.postId;
      const { bytes, key, composed } = await this.og.image({ kind, id });
      // The served URL carries the sha256-style cache key; its bytes are
      // fixed, so the rendered-media cache contract applies: immutable,
      // long-lived. `composed` rides the local log only — miss on the first
      // request, hit (no re-composite) ever after (ac-3 evidence).
      this.log?.(`og serve ${composed ? "compose" : "cache-hit"} ${key}`);
      res.set("Content-Type", "image/jpeg");
      res.set("Cache-Control", "public, max-age=31536000, immutable");
      res.set("ETag", `"${key}"`);
      return res.status(200).send(bytes);
    } catch (error) {
      const typed = /** @type {{ code?: string }} */ (error);
      if (typed.code === "E_OG_NOT_FOUND") {
        res.set("Cache-Control", "no-store");
        return res.status(404).json({ error: "This link has no preview image.", code: "E_OG_NOT_FOUND" });
      }
      this.log?.(`og serve failed: ${typed.code ?? "unknown"} ${typed.message ?? ""}`);
      return res.status(500).json({ error: "Something went wrong on the hub. Try again, or contact the network owner.", code: "E_INTERNAL" });
    }
  }
}

export default OgController;