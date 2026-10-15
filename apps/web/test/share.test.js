// Share a post (PORCH-078): the post detail surface's share entry opens the
// browser's native share dialog with the post's canonical deep link and a
// share text derived only from the author display name, the photo count, and
// Brian's fixed template frames (Oct 14, 2026); copy-link covers browsers
// without navigator.share; the payload never carries the post's body text,
// comment content, or media bytes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { photoCountOf, shareAuthorName, postShareText, postDeepLink, sharePost } from "../src/share.js";

const ME = "did:porch:me";
const SIS = "did:porch:sis";
const ownTextPost = { _id: "p1", type: "text", body: "Lake day secret body text", authorName: "June", authorId: SIS };

const neverCopy = () => { throw new Error("copy must not run when the native share rides"); };

test("ac-1: a share from the detail surface opens the native dialog with the deep link", async () => {
	const calls = [];
	const share = (payload) => { calls.push(payload); return Promise.resolve(); };
	const result = await sharePost({
		post: ownTextPost, ownDid: ME, data: {}, base: "https://family.example", share, copy: neverCopy,
	});
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0], {
		title: "Porchlight",
		text: "June posted on Porchlight",
		url: "https://family.example/posts/p1",
	});
	assert.deepEqual(result, { mode: "native" });
});

test("ac-1: a browser without navigator.share falls back to copying the link, confirmed", async () => {
	let copied = "";
	const copy = async (link) => { copied = link; return true; };
	const result = await sharePost({
		post: ownTextPost, ownDid: ME, data: {}, base: "https://family.example", share: undefined, copy,
	});
	assert.deepEqual(result, {
		mode: "copy", copied: true, link: "https://family.example/posts/p1",
		text: "June posted on Porchlight",
	});
	assert.equal(copied, "https://family.example/posts/p1");
});

test("ac-1: a member dismissing the native dialog is a quiet exit — no error, no stray copy", async () => {
	const share = () => Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
	const result = await sharePost({
		post: ownTextPost, ownDid: ME, data: {}, base: "https://family.example", share, copy: neverCopy,
	});
	assert.deepEqual(result, { mode: "native", dismissed: true });
});

test("ac-1: a native share that fails for any other reason still leaves the copy path standing", async () => {
	let copied = "";
	const share = () => Promise.reject(new TypeError("NotAllowedError"));
	const copy = async (link) => { copied = link; return true; };
	const result = await sharePost({
		post: ownTextPost, ownDid: SIS, data: {}, base: "https://family.example", share, copy,
	});
	assert.equal(result.mode, "copy");
	assert.equal(result.copied, true);
	assert.equal(copied, "https://family.example/posts/p1");
});

test("ac-2: the sharer's own non-photo post reads 'View my post on Porchlight'", () => {
	assert.equal(postShareText(
		{ _id: "p1", type: "text", body: "Hello", authorName: "June", authorId: SIS },
		SIS, {},
	), "View my post on Porchlight");
	// Video and audio posts are non-photo posts too: same own-post frame.
	assert.equal(postShareText({ _id: "p2", type: "video", mediaRefs: ["v1"], authorId: ME }, ME), "View my post on Porchlight");
	assert.equal(postShareText({ _id: "p3", type: "audio", mediaRefs: [{ mediaId: "a1" }], authorName: "June", authorId: ME }, ME, {}), "View my post on Porchlight");
});

test("ac-2: a photo post reads '[Author] shared N photos on Porchlight', N = its photo count", () => {
	assert.equal(postShareText(
		{ _id: "p4", type: "photo", mediaRefs: ["m1", "m2", "m3"], authorName: "Brian", authorId: ME },
		ME, {},
	), "Brian shared 3 photos on Porchlight");
	// The count mirrors exactly what the post renders (id-extraction semantics).
	assert.equal(photoCountOf({ _id: "p4", type: "photo", mediaRefs: ["m1", { mediaId: "m2" }, { mediaRef: "junk" }] }), 2);
});

test("ac-2: another member's text post uses the generalized line '[Author] posted on Porchlight'", () => {
	assert.equal(postShareText(ownTextPost, ME, {}), "June posted on Porchlight");
});

test("ac-2: the frame choice is exact — photo posts keep the photo frame even when the sharer is the author", () => {
	assert.equal(postShareText(
		{ _id: "p5", type: "photo", mediaRefs: ["m1"], authorName: "You", authorId: ME },
		ME, {},
	), "You shared 1 photos on Porchlight");
});

test("ac-2: unattributed posts resolve the name from the sharer's own identity, never a void", () => {
	assert.equal(shareAuthorName({ _id: "p6", authorId: ME }, { identity: { id: ME, name: "Brian" } }), "Brian");
	assert.equal(shareAuthorName({ _id: "p7", authorId: "did:porch:quiet" }, {}), "A family member");
});

test("ac-3: the shared link is the post detail route on the hub origin (member lands in detail)", () => {
	assert.equal(postDeepLink({ _id: "p1" }, "https://family.example"), "https://family.example/posts/p1");
	assert.equal(postDeepLink({ id: "odd/id here" }, "https://family.example"), "https://family.example/posts/odd%2Fid%20here");
	// Trailing slashes on the hub origin never double up.
	assert.equal(postDeepLink({ _id: "p1" }, "https://family.example/"), "https://family.example/posts/p1");
});

test("ac-3: the deep link is the one route the SPA mounts as post detail", async () => {
	// main.jsx:1193 mounts PostDetail for route.startsWith("/posts/"); the
	// member's shared link resolves there on the hub origin, and the
	// non-member rides the existing member-gated read (post.service.js get()
	// refuses with E_POST_NOT_FOUND — the perimeter, nothing leaks).
	const link = postDeepLink({ _id: "p1" }, "https://family.example");
	assert.match(link, /^https:\/\/family\.example\/posts\/p1$/);
});

test("ac-4: the share payload carries no post body, no comments, no media bytes", async () => {
	const payloads = [];
	const share = (payload) => { payloads.push(payload); return Promise.resolve(); };
	const post = {
		_id: "p1", type: "photo",
		body: "the body text of the post is SECRET",
		caption: "caption is also SECRET",
		mediaRefs: [{ mediaId: "bytes-a" }, { mediaId: "bytes-b" }],
		reactionRows: [{ emoji: "🌻", memberDid: SIS, _id: "r1" }],
		authorName: "Brian", authorId: ME,
	};
	await sharePost({ post, ownDid: SIS, data: {}, base: "https://family.example", share, copy: neverCopy });
	assert.deepEqual(Object.keys(payloads[0]).sort(), ["text", "title", "url"]);
	assert.equal(payloads[0].text, "Brian shared 2 photos on Porchlight");
	assert.equal(payloads[0].text.includes("SECRET"), false);
	// The copy fallback carries the link alone — same discipline.
	const copyPayloads = [];
	await sharePost({
		post, ownDid: SIS, data: {}, base: "https://family.example", share: undefined,
		copy: async (link) => { copyPayloads.push(link); return true; },
	});
	assert.deepEqual(copyPayloads, ["https://family.example/posts/p1"]);
});