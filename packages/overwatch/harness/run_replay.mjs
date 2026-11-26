// Harness runner (harness/run_replay.mjs): feeds per-camera DetectedObject
// JSONL streams into the EntityMergeService and writes the merged
// PropertyEntity chains + joins. Plain node, part of the PORCH-126 spike.

// Usage: node harness/run_replay.mjs <config.json> <streams-dir> <out.json>
//   config.json { adjacency, overlapSide, travelTime, joinThreshold, ... }
//   streams-dir contains <camera>.jsonl files ({camera,trackId,cls,conf,bbox,t,reid})

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { EntityMergeService } from "../src/service.js";

const [configPath, streamsDir, outPath] = process.argv.slice(2);
if (!configPath || !streamsDir || !outPath) {
	console.error("usage: run_replay.mjs <config.json> <streams-dir> <out.json>");
	process.exit(1);
}

const config = JSON.parse(readFileSync(configPath, "utf8"));
const service = new EntityMergeService(config);

// Interleave all streams by timestamp: merge-sort across per-camera sorted jsonl.
const readers = readdirSync(streamsDir)
	.filter((f) => f.endsWith(".jsonl"))
	.map((f) => ({
		camera: f.replace(/\.jsonl$/, ""),
		lines: readFileSync(join(streamsDir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)),
		next: 0,
	}));
for (;;) {
	let earliest = null;
	for (const r of readers) {
		if (r.next < r.lines.length && (earliest === null || r.lines[r.next].t < earliest.lines[earliest.next].t)) {
			earliest = r;
		}
	}
	if (!earliest) break;
	service.add(earliest.lines[earliest.next++]);
}

const out = service.finalize();
writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
console.log(`entities=${out.entities.length} joins=${out.joins.length} -> ${outPath}`);
