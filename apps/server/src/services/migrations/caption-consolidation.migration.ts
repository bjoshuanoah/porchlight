import type { MigrationContext, MigrationOutcome, MigrationStep } from "../migration.service.js";

/** The one shared filter: the step's workset is every post still carrying
 * either legacy key (finds the candidates; counts them for the settle pass;
 * guards each individual write). */
const WORKSET = { $or: [{ caption: { $exists: true } }, { body: { $exists: true } }] } as const;

/**
 * The caption consolidation (PORCH-157's data passenger), declared as the
 * migration runner's FIRST versioned step — Amendment 1 (Brian, Nov 26,
 * 2026): "Get rid of caption; the post text is the post text." One text
 * value per post, everywhere; the caption-bearing and body-bearing dual
 * shapes retire into the one `text` field on the Post document.
 *
 * Field mapping of record (confirmed-then-written): the shipped read
 * projection renders the post's text through the shape the PORCH-143 trail
 * recorded — media-shaped posts (mediaRefs nonempty) rendered `caption` as
 * the post text, text posts rendered `body`. So on a collision (both values
 * present) the survived value is the one the shipped projection rendered:
 * `caption` wins on media shapes, `body` wins on text shapes. The collision
 * count is part of the outcome, and the per-post resolution lands on the
 * carrier trail (PORCH-157) when this step runs against a hub's archive.
 *
 * Release sequencing (Brian, Nov 26, 2026): the runner builds now; the
 * caption retirement rides the consolidation cut, and cut calls stay
 * Brian's. The cut of record is the five-carrier v0.5.2 ruling of Nov 26,
 * renumbered to v0.5.3 on Brian's Nov 26 word ("just go to the next
 * version") after PORCH-124's Oct 22 cut had already published 0.5.2 — the
 * step activates in that release.
 *
 * Idempotency: the step's workset is every post still carrying either
 * legacy key; the write retires caption and body in the same operation that
 * lands `text`, so a re-run (or a crash-resume) finds an empty workset and
 * writes nothing — never a double-application.
 */
export const POST_TEXT_CONSOLIDATION_VERSION = 1;

export const POST_TEXT_CONSOLIDATION_V1: MigrationStep = {
  version: POST_TEXT_CONSOLIDATION_VERSION,
  name: "post-text-consolidation",
  activatesIn: "0.5.3",
  destructive: false,
  async workRemaining({ store }: Pick<MigrationContext, "store" | "log">): Promise<number> {
    return await store.collection("posts").countDocuments(WORKSET);
  },
  async apply({ store, log }: MigrationContext): Promise<MigrationOutcome> {
    const posts = store.collection("posts");
    const legacy: Array<Record<string, unknown>> = await posts.find(WORKSET);
    const read = legacy.length;
    let written = 0;
    let collisions = 0;
    log(`migration v1 (post-text-consolidation): ${read} post(s) still carry the legacy dual-text fields`);
    for (const row of legacy) {
      const mediaShaped = Array.isArray(row.mediaRefs) && (row.mediaRefs as unknown[]).length > 0;
      // Empty strings count as no text: a blank legacy value retires the
      // same way a null one does.
      const caption = typeof row.caption === "string" && row.caption.length > 0 ? row.caption : null;
      const body = typeof row.body === "string" && row.body.length > 0 ? row.body : null;
      const text = mediaShaped ? (caption ?? body) : (body ?? caption);
      if (caption !== null && body !== null) collisions += 1;
      // The once-only guard rides the filter: a crash-resumed run only
      // touches posts whose legacy fields survived, so counted writes are
      // exactly the documents the step actually retired.
      const result = await posts.updateOne(
        { _id: row._id, $or: [{ caption: { $exists: true } }, { body: { $exists: true } }] },
        { $set: { text }, $unset: { caption: "", body: "" } },
      );
      if (result.matchedCount > 0) written += 1;
    }
    return { read, written, collisions };
  },
};
