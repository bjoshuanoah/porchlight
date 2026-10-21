// PORCH-117: the error display discipline — errors are earned states.
// The suite pins the ruling's four edges: an error element exists only
// after a fetch path's attempts are spent (no error renders while a fetch
// is pending or retrying), the boot/loading surface holds through the
// connect/session-open/first-fetch sequence (a boot never resolves into a
// flash-then-dismiss banner), the earned unreachable copy renders verbatim
// (the two strings of record, no variants, no product name — enforced by
// the copy audit), and an error surface's disappearance follows a state
// change, never a timer alone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = fileURLToPath(new URL("../", import.meta.url));
const src = async (name) => await readFile(join(webRoot, "src", name), "utf8");

const { runBootSequence } = await import("../src/boot-sequence.js");

test("ac-1: a failed attempt defers — the earned render happens once, after the chain exhausts", async () => {
	const events = [];
	const deferred = { failures: [{ origin: "https://hub.example", status: null }] };
	await runBootSequence({
		attempt: () => false,
		lastFailure: () => deferred,
		onEarnedFailure: (failure) => events.push(["earned", failure === deferred]),
		onSettle: () => events.push(["settle"]),
		maxAttempts: 3,
		sleep: () => {},
	});
	assert.deepEqual(events, [["earned", true], ["settle"]],
		"the deferred failure applies exactly once at exhaustion, and the settle decision follows it");
});

test("ac-1: retries pending render no error — but a mid-chain success never earned one", async () => {
	const events = [];
	let calls = 0;
	await runBootSequence({
		attempt: () => (++calls < 2 ? false : true),
		lastFailure: () => { throw new Error("a recovered chain must never read a deferred failure"); },
		onEarnedFailure: () => events.push("earned"),
		onSettle: () => events.push("settle"),
		sleep: () => {},
	});
	assert.deepEqual(events, ["settle"], "a self-resolving fetch produced no error element at any point");
	assert.equal(calls, 2, "the chain stopped at the first served attempt — no cadence");
});

test("ac-1: a failed connect alone earns nothing — the first fetch re-proves the hub", async () => {
	const events = [];
	await runBootSequence({
		connect: () => { throw new Error("hub down"); },
		attempt: () => true,
		onEarnedFailure: () => events.push("earned"),
		onSettle: () => events.push("settle"),
		sleep: () => {},
	});
	assert.deepEqual(events, ["settle"], "connect trouble while loading still shows renders loading only");
});

test("ac-2: the boot never strands — exhaustion and thrown attempts still settle", async () => {
	const events = [];
	await runBootSequence({
		attempt: () => { throw new Error("hub down"); },
		onSettle: () => events.push("settle"),
		maxAttempts: 2,
		sleep: () => {},
	});
	assert.deepEqual(events, ["settle"], "settle is unconditional in the chain");
});

test("ac-1: every offline set gates on the boot hold — loading covers connection trouble", async () => {
	const source = await src("main.jsx");
	const renewCatch = source.slice(source.indexOf("membershipFailed = failed;"), source.indexOf("next.renewedAt ="));
	assert.match(renewCatch, /if \(!bootHoldRef\.current\) setOffline\(true\);/,
		"a renewal failure during the hold renders the loading surface only");
	const onStateBlock = source.slice(source.indexOf("onState: ({ connected }) => {"), source.indexOf("void catchUpOrigin(eventUrl"));
	assert.match(onStateBlock, /if \(!membershipEndedRef\.current && !bootHoldRef\.current\) setOffline\(true\);/,
		"a transport flap mid-boot never banners");
	const catchUpBlock = source.slice(source.indexOf("const catchUpOrigin = useCallback"), source.indexOf("const liveSig ="));
	assert.match(catchUpBlock, /if \(!bootHoldRef\.current\) setOffline\(true\);/,
		"a failed replay resolve during the hold renders loading only");
	// The boot hold exists and settles through the boot chain, not at mount.
	assert.match(source, /const bootHoldRef = useRef\(true\);/);
	assert.match(source, /import \{ runBootSequence \} from "\.\/boot-sequence\.js";/);
	assert.match(source, /onSettle: settleBoot,/);
});

test("ac-1: the boot chain and the recovery driver run deferred attempts — failure applies at exhaustion only", async () => {
	const source = await src("main.jsx");
	const bootEffect = source.slice(source.indexOf("this effect owns the boot hold"), source.indexOf("}, [activeIdentityId, renew]);"));
	assert.match(bootEffect, /attempt: \(\) => reloadRef\.current\?\.\(\{ deferFailure: true \}\)/,
		"boot fetch attempts defer their failed result into the chain's slot");
	assert.match(bootEffect, /lastFailure: takeDeferredFeedsFailure,/);
	assert.match(source, /const reload = useCallback\(async \(\{ deferFailure = false \} = \{\}\) => \{/);
	const deferLine = source.slice(source.indexOf("if (deferFailure && !feedsServed)"));
	assert.match(deferLine, /deferredFeedsFailure\.current = result;/);
	const recoveryBlock = source.slice(source.indexOf("startStaleRecovery = useCallback"), source.indexOf("// Live consumption"));
	assert.match(recoveryBlock, /attempt: \(\) => reloadRef\.current\?\.\(\{ deferFailure: true \}\)/,
		"recovery retries defer too — no error element while a recovery attempt runs");
	assert.match(recoveryBlock, /if \(!outcome\.recovered\) \{[\s\S]*?takeDeferredFeedsFailure\(\)/,
		"only the spent bound applies the deferred failure");
});

test("ac-2: the solo silent reopen rides the bounded backoff and earns its error after the settle", async () => {
	const source = await src("main.jsx");
	const soloBlock = source.slice(source.indexOf("PORCH-117: the silent reopen is a session-open attempt"), source.indexOf("}, [identity, connections, frontDoor"));
	assert.match(soloBlock, /await runStaleRecovery\(/, "no bare setOffline-on-first-failure reopen");
	assert.match(soloBlock, /if \(!outcome\.recovered\) \{\s*\n\s*settleBoot\(\);\s*\n\s*setOffline\(true\);\s*\n\s*\}/,
		"the earned error lands on the settle decision, after the loading surface stops working the state");
});

test("ac-2: readiness settles with the sequence — boots with no sequence settle at mount", async () => {
	const source = await src("main.jsx");
	assert.match(source, /if \(!activeIdentityId \|\| signedOut\.current\) settleBoot\(\);/,
		"front door / WhoIsHere / signed-out boots announce readiness on mount, as before");
	const bootEffect = source.slice(source.indexOf("PORCH-117: this effect owns the boot hold"), source.indexOf("}, [activeIdentityId, renew]);"));
	assert.match(bootEffect, /if \(signedOut\.current \|\| !activeIdentityId\) \{ settleBoot\(\); return; \}/);
	assert.match(source, /onSettle: settleBoot,/);
	// lantern.jsx itself is untouched: the boot holds until the ready event
	// and dissolves on readiness, never a boot-end timer (lantern suite pins it).
});

test("ac-3: the notice variant is gone — the offline Alert carries the verbatim copy", async () => {
	const main = await src("main.jsx");
	const social = await src("social.jsx");
	assert.match(main, />A family server is unreachable\. Saved moments may be out of date\.<\/Alert>/);
	assert.match(social, />A family server is unreachable\. Saved moments may be out of date; new activity is not available until you reconnect\.<\/Alert>/);
	// The flash-then-vanish Snackbar variant is deleted everywhere.
	for (const text of [main, social]) {
		assert.doesNotMatch(text, /Your family server is unreachable\. Showing saved moments where available\./);
	}
	assert.doesNotMatch(main, /setNotice\(noticeText\)|noticeText/, "applyFeeds no longer renders an unreachable notice");
});

test("ac-4: error surfaces are never dismissed by a timer alone", async () => {
	const main = await src("main.jsx");
	const social = await src("social.jsx");
	assert.doesNotMatch(main, /autoHideDuration/, "the notice snackbar has no hide timer");
	assert.doesNotMatch(social, /autoHideDuration/, "the share snackbar has no hide timer");
	// The offline renders clear on state, not timers: offline flips only
	// through setOffline(false) on served reads / live (re)connects — the
	// standing sources, plus the boot gates pinned above.
	assert.match(main, /\{offline && <Alert severity="warning"[\s\S]*?<\/Alert>\}/);
});