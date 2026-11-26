// audit-types.js — the PORCH-142 watchlist audit record types of record.
// They ride the recognition plane's audit log of record (one JSONL trail
// under <root>/config/recognition/) so the whole Overwatch & Recognition
// plane keeps one audit family. Training, retraining (with the measured
// held-replay trade), corrections, per-class calibration, and purges all
// land here.

export const WATCHLIST_AUDIT_TYPES = {
	TRAIN: "watchlist-train",
	RETRAIN: "watchlist-retrain",
	CORRECTION: "watchlist-correction",
	THRESHOLD: "watchlist-threshold",
	PURGE: "watchlist-purge",
};
