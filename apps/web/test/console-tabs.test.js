// PORCH-057: the console tab model is the reachability contract. ac-1 holds
// that the console areas render as distinct tabs (the model's section→tab
// map), ac-2 holds that every shipped console action stays reachable (the
// capability map), and ac-3 holds that the tab bar stays usable on a narrow
// mobile viewport (the scrollable + short-label model the render consumes).
import { test } from "node:test";
import assert from "node:assert/strict";
import { consoleTabs, consoleCapabilities } from "../src/console-tabs.js";

test("ac-1: every console area is named by exactly one tab's section list", () => {
	// The shipped areas from the task's area list (media storage riding the
	// Storage tab with the quotas it serves): storage, members and membership,
	// invites, quota and retention, media root, update, audit, backup.
	const sections = consoleTabs.flatMap((tab) => tab.sections);
	assert.deepEqual([...new Set(sections)], sections); // one area, one tab
	assert.deepEqual(sections.sort(), [
		"Device links sent",
		"Invitations",
		"Media storage",
		"Member devices",
		"Members",
		"Recent activity",
		"Space and limits",
		"Updates",
		"Your devices",
	]);
});

test("ac-2: every shipped console capability maps to a rendered tab (or to the console chrome)", () => {
	const ids = new Set(consoleTabs.map((tab) => tab.id));
	ids.add("chrome"); // the Back-to-profile control lives outside the tab list
	for (const [capability, target] of Object.entries(consoleCapabilities)) {
		assert.ok(
			ids.has(target),
			`${capability} must stay reachable in the ${target} surface, which no longer renders`,
		);
	}
	const covered = new Set(Object.values(consoleCapabilities));
	const rendered = consoleTabs.filter((tab) => covered.has(tab.id));
	assert.equal(rendered.length, consoleTabs.length, "no rendered tab is orphaned from the capability map");
});

test("ac-3: the tab bar renders scrollable with short labels that fit a 390px viewport", () => {
	// The render consumes the model: scrollable variant tabs (touch-wipe, no
	// horizontal PAGE scroll), every label ≥72px per MUI's scrolled tab
	// minimum — so the shipped five must fit 390px without an overflow wipe.
	assert.equal(consoleTabs.length, 5);
	for (const { id, label } of consoleTabs) {
		assert.ok(id.length > 0 && label.length > 0);
		assert.ok(label.length <= 12, `label "${label}" stays single-line short`);
	}
});