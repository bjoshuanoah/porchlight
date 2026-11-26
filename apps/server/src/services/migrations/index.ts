import type { MigrationStep } from "../migration.service.js";
import { POST_TEXT_CONSOLIDATION_V1 } from "./caption-consolidation.migration.js";

/**
 * The hub's versioned migration catalog. Every data change that requires a
 * migration declares exactly one entry here, ordered by declared version —
 * the runner's execution order — and the catalog is the only registration
 * surface a migration has (a change without an entry runs; never).
 *
 * Current entries, in version order:
 * - v1  post-text-consolidation — the caption retirement's data passenger
 *       (PORCH-157), declared first per the mixed-media amendment; inert on
 *       hub updates until the consolidation cut stamps its activating
 *       release (the release-ledger call stays Brian's).
 */
export const HUB_MIGRATIONS: MigrationStep[] = [POST_TEXT_CONSOLIDATION_V1];
