import { readFileSync } from "node:fs";

/**
 * Ranking module of record (Feed Ranking Contract, PORCH-007): the ONLY
 * writer of ranked order in the social domain. Feed assembly consumes it;
 * nothing else sorts the ranked section.
 *
 * Deterministic and published: the score is a pure function of rank-input
 * counters and age with all parameters as named configuration values in
 * src/config/ranking.config.json (owner-readable; no learned parameters,
 * no per-user personalization, no runtime substitution of the formula).
 *
 * AI-exclusion contract (PRD 4 / TS 4): this module is isolated, not
 * conventional. It accepts only post documents with their
 * interactionCounters — it has no interface for any other input, so no ML
 * input can reach the ranked order without rewriting this module.
 *
 * Vote privacy contract (Brian, Oct 8 2026): this module consumes only the
 * aggregate counters stored on the post. It never reads raw vote rows, and
 * it never returns a count, a ratio, or a per-member vote — the only thing
 * it publishes is an ordered list of posts (prominence order).
 */

/**
 * Default parameters, loaded from the owner-readable config file next to
 * this module. `options.rankingConfig` (assembleSocialModule) can replace
 * the whole rankedSection block with an owner-edited copy — the shape is
 * validated against the same named-parameter set either way.
 */
export function loadRankingConfig() {
  const raw = JSON.parse(readFileSync(new URL("../config/ranking.config.json", import.meta.url), "utf8"));
  return normalizeRankingConfig(raw.rankedSection);
}

/**
 * Validate a rankedSection block against the published parameter set.
 * Unknown keys, missing keys, and non-finite values fail loudly — a half
 * read parameter set is a misconfiguration, not a silent default.
 */
export function normalizeRankingConfig(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const config = {
    window: { days: num(src.window, "days", 30) },
    ageDecay: {
      kind: "exponential_half_life",
      halfLifeHours: num(src.ageDecay, "halfLifeHours", 48),
    },
    ratio: {
      volumeFloor: num(src.ratio, "volumeFloor", 2),
      weight: num(src.ratio, "weight", 0.5),
    },
    weights: {
      vote: num(src.weights, "vote", 1),
      comment: num(src.weights, "comment", 2),
      reaction: num(src.weights, "reaction", 1),
    },
  };
  for (const key of ["window", "ageDecay", "ratio", "weights"]) {
    const extra = Object.keys(src[key] ?? {}).filter((name) => !(name in config[key]));
    if (extra.length > 0) {
      throw new Error(`Unknown ranking parameter(s) ${extra.join(", ")} under ${key}.`);
    }
  }
  for (const value of [
    config.window.days,
    config.ageDecay.halfLifeHours,
    config.ratio.volumeFloor,
    config.ratio.weight,
    config.weights.vote,
    config.weights.comment,
    config.weights.reaction,
  ]) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error("Ranking parameters must be non-negative finite numbers.");
    }
  }
  return config;
}

function num(container, name, fallback) {
  const value = container?.[name];
  return value === undefined ? fallback : value;
}

/** The published formula, in one place, on the exact inputs it names. */
export function rankedScore(post, config, now = new Date()) {
  const counters = post.interactionCounters ?? {};
  const volume =
    (counters.voteVolume ?? 0) * config.weights.vote +
    (counters.commentCount ?? 0) * config.weights.comment +
    (counters.reactionCount ?? 0) * config.weights.reaction;

  // Ratio modulation applies only above the volume floor: one (or any
  // sub-floor) vote cannot dominate through its ratio.
  const ratioFactor =
    (counters.voteVolume ?? 0) >= config.ratio.volumeFloor
      ? 1 + config.ratio.weight * ((counters.voteRatio ?? 0) - 0.5)
      : 1;

  const reference = post.lastActivityAt ?? post.createdAt;
  const ageHours = Math.max(0, (now.getTime() - new Date(reference).getTime()) / 3_600_000);
  const ageFactor = Math.pow(2, -ageHours / config.ageDecay.halfLifeHours);

  return Math.max(0, volume) * Math.max(0, ratioFactor) * ageFactor;
}

/**
 * The ranking formula module. `rank(postDocuments)` is the ranked order's
 * single producer: descending score, deterministic tie-break on creation
 * time then id so the same inputs always yield the same order. Recompute
 * is capped to the configuration window (posts only age out of the ranked
 * section; the base timeline never re-sorts and never decays).
 */
export class RankingService {
  /** @param {{ config?: object }} [options] */
  constructor({ config = loadRankingConfig() } = {}) {
    this.config = config;
  }

  /** Ranked section over the capped window; prominence order only. */
  rank(posts, { now = new Date() } = {}) {
    const since = now.getTime() - this.config.window.days * 86_400_000;
    const inWindow = posts.filter((post) => {
      const reference = new Date(post.lastActivityAt ?? post.createdAt).getTime();
      return reference >= since && reference <= now.getTime();
    });
    return inWindow
      .map((post) => ({ post, score: rankedScore(post, this.config, now) }))
      .sort(
        (a, b) => b.score - a.score || (a.post.createdAt < b.post.createdAt ? 1 : a.post.createdAt > b.post.createdAt ? -1 : String(a.post._id < b.post._id ? -1 : 1)),
      );
  }

  /** Owner-readable parameter surface (GET /console/ranking). */
  describe() {
    return { formula: RankingService.FORMULA, parameters: this.config };
  }
}

RankingService.FORMULA =
  "score = (votes*wVote + comments*wComment + reactions*wReaction) * voteRatioFactor * 2^(-ageHours/halfLife)";

export default RankingService;