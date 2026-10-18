// PORCH-102: the beyond-window freshness note recovers itself. The driver
// unit tests below prove the bounded, event-driven, no-cadence contract; the
// source assertions prove the wiring rides exactly the Check again refetch
// (actions.refreshFeeds → reload) inside the reconnect catch-up path, with
// the standing in-place merge machinery and the untouched family copy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	runStaleRecovery, staleRecoveryDelayMs, STALE_RECOVERY_MAX_ATTEMPTS, STALE_RECOVERY_BASE_DELAY_MS,
} from "../src/stale-recovery.js";

const here = dirname(fileURLToPath(import.meta.url));
const mainSource = readFile(join(here, "..", "src", "main.jsx"), "utf8");
const recoverySource = readFile(join(here, "..", "src", "stale-recovery.js"), "utf8");
const socialSource = readFile(join(here, "..", "src", "social.jsx"), "utf8");

test("staleRecoveryDelayMs backoff is exponential (1s, 2s, …) from the ~1s base", () => {
	assert.equal(STALE_RECOVERY_BASE_DELAY_MS, 1000);
	assert.equal(staleRecoveryDelayMs(1), 1000);
	assert.equal(staleRecoveryDelayMs(2), 2000);
	assert.equal(staleRecoveryDelayMs(3), 4000);
});

test("ac-1: a beyond-window reconnect recovers on its own — one fresh serve, no retries", async () => {
	const attempts = [];
	const slept = [];
	const outcome = await runStaleRecovery({
		attempt: async () => {
			attempts.push(true);
			return true; // fresh state landed (applyFeeds cleared the note)
		},
		sleep: async (ms) => slept.push(ms),
	});
	assert.equal(outcome.recovered, true);
	assert.equal(outcome.attempts, 1);
	assert.equal(attempts.length, 1);
	assert.deepEqual(slept, [], "a first-attempt recovery never schedules a retry");
});

test("ac-2: recovery tries stay bounded — 3 attempts, exponential backoff, then the note persists", async () => {
	const sleeps = [];
	let calls = 0;
	const outcome = await runStaleRecovery({
		attempt: async () => {
			calls += 1;
			return false; // transport still degraded / refetch errors
		},
		sleep: async (ms) => sleeps.push(ms),
	});
	assert.equal(calls, STALE_RECOVERY_MAX_ATTEMPTS, "exactly the bounded three attempts");
	assert.equal(outcome.recovered, false, "exhaustion is a defined outcome — the manual CTA persists");
	assert.equal(outcome.attempts, STALE_RECOVERY_MAX_ATTEMPTS);
	assert.deepEqual(sleeps, [staleRecoveryDelayMs(1), staleRecoveryDelayMs(2)],
		"backoff between attempts is the 1s/2s exponential run, never a fixed cadence");
});

test("ac-2: an attempt failure waits out its backoff step, then the next attempt closes it", async () => {
	const sleeps = [];
	let calls = 0;
	const outcome = await runStaleRecovery({
		attempt: async () => (calls += 1) === 3, // fails twice, third lands fresh
		sleep: async (ms) => sleeps.push(ms),
	});
	assert.equal(outcome.recovered, true);
	assert.equal(outcome.attempts, 3);
	assert.deepEqual(sleeps, [1000, 2000]);
});

test("ac-2: exhaustion never throws — the driver resolves and leaves no lingering timers", async () => {
	const outcome = await runStaleRecovery({
		attempt: async () => { throw new Error("hub unreachable"); },
		sleep: async () => {},
	});
	assert.equal(outcome.recovered, false);
	assert.equal(outcome.attempts, STALE_RECOVERY_MAX_ATTEMPTS);
});

test("ac-2: the real bounded run completes with real timers (tiny base) and no interval machinery", async () => {
	const outcome = await runStaleRecovery({
		attempt: async () => false,
		baseDelayMs: 5, // build-tuned base stands in for the 1s default here
	});
	assert.equal(outcome.recovered, false);
	assert.equal(outcome.attempts, STALE_RECOVERY_MAX_ATTEMPTS);
});

test("ac-4: the recovery module carries no interval machinery — nothing re-arms itself", async () => {
	const source = await recoverySource;
	assert.ok(!/setInterval/.test(source), "no periodic refetch machinery exists in the driver");
	assert.match(source, /runStaleRecovery/);
});

test("ac-1: the stale resolve inside the reconnect catch-up triggers the auto-recovery", async () => {
	const source = await mainSource;
	const inCatchUp = source.slice(source.indexOf("const catchUpOrigin = useCallback"));
	assert.match(inCatchUp, /setBehind\(result\.stale\);\s*\n[^]*?if \(result\.stale\) startStaleRecovery\(\);/,
		"the beyond-window replay itself fires the recovery — no tap, no cadence");
	assert.match(inCatchUp, /\}, \[startStaleRecovery\]\);/, "the trigger rides catchUpOrigin's dependency list");
});

test("ac-1: the recovery attempt IS the Check again refetch — actions.refreshFeeds unchanged", async () => {
	const source = await mainSource;
	assert.match(source, /refreshFeeds: \(\) => reload\(\)/,
		"the manual CTA still rides the same reload the driver's attempt runs");
	assert.match(source, /attempt: \(\) => reloadRef\.current\?\.\(\)/,
		"one driver attempt = one full fresh serve through reload (throws count as failures in the driver)");
	assert.match(source, /const feedsServed = !result\.failures\.length;/,
		"reload resolves true exactly when fresh state landed (the note-clearing condition)");
});

test("ac-2: the trigger is guarded — a concurrent stale event never stacks a second driver run", async () => {
	const source = await mainSource;
	const block = source.slice(source.indexOf("PORCH-102: the freshness-note auto-recovery."));
	assert.match(block, /if \(staleRecoveryBusy\.current\) return;/);
	assert.match(block, /staleRecoveryBusy\.current = true;/);
	assert.match(block, /finally \{\s*\n\s*staleRecoveryBusy\.current = false;\s*\n\s*\}/,
		"exhaustion releases the guard so the next reconnect event may retry");
});

test("ac-3: recovery re-serves through the standing merge machinery, never a redraw", async () => {
	const source = await mainSource;
	const applyFeeds = source.slice(source.indexOf("const applyFeeds = useCallback"));
	assert.match(applyFeeds, /captureFeedAnchor\(\)/);
	assert.match(applyFeeds, /applyFeedCompensation\(before, captureFeedAnchor\(\)\)/,
		"the reading anchor is compensated once post-paint — no scroll-jack");
	assert.match(applyFeeds, /postsRef\.current = result\.posts;/);
	assert.match(applyFeeds, /setBehind\(false\);/,
		"fresh state landing clears the note in the same commit that serves it");
});

test("ac-4: no interval enters the PORCH-102 block — the trigger rides the reconnect event only", async () => {
	const source = await mainSource;
	const block = source.slice(
		source.indexOf("PORCH-102: the freshness-note auto-recovery."),
		source.indexOf("Live consumption (PORCH-081 ac-1)"),
	);
	assert.ok(!/setInterval/.test(block), "no periodic refetch machinery exists on the recovery path");
});

test("ac-4 + copy: the freshness note and its Check again CTA carry unchanged (PORCH-081 verbatim)", async () => {
	const source = await socialSource;
	assert.ok(source.includes("Some newer moments could not be replayed from the server while this device was away, so this view may be missing recent activity."));
	assert.ok(source.includes("Some newer moments could not be replayed from the server, so this view may be missing recent activity."));
	assert.match(source, /actions\.refreshFeeds/);
	assert.match(source, />Check again</, "the CTA persists as the manual path past the recovery bound");
});