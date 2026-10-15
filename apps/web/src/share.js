/**
 * Share a post (PORCH-078). From the post surfaces' ··· overflow menus —
 * both the timeline card and the post detail card (Brian, Oct 15, 2026) —
 * the share entry opens the browser's native share dialog (navigator.share
 * on iOS Safari and the installed app) pre-filled with the post's canonical
 * deep link, and copies the link where navigator.share is unsupported
 * (with an immediate in-view confirmation the surface renders).
 *
 * The share payload is deliberately skeletal: the share text derives ONLY
 * from the author display name, the post's photo count, and Brian's fixed
 * template frames (Oct 14, 2026) — the post's body text, comment content,
 * and media bytes never enter the share. Recipients ride the deep link: a
 * current member lands in post detail on the hub origin; a non-member hits
 * the existing perimeter (the member-gated post read refuses with
 * E_POST_NOT_FOUND, post.service.js get()) and nothing leaks.
 */

import { copyLink } from "./member-directory.js";
import { identityOf } from "./feed-filter.js";

/** The post's photo count: only photo-post media refs count (the composer
 *  attaches photos to photo posts; text, video, and audio posts carry none).
 *  The same id-extraction semantics the Media surface uses, so the count
 *  matches what the recipient sees in the post. */
export function photoCountOf(post) {
	if (post?.type !== "photo") return 0;
	const refs = Array.isArray(post?.mediaRefs) ? post.mediaRefs : [];
	return refs
		.map((ref) => (typeof ref === "string" ? ref : ref?.mediaId ?? ref?._id ?? ref?.id))
		.filter(Boolean)
		.length;
}

/** The author's display name for the share text, from the post payload's
 *  attribution only (the same precedence PostDetail renders). */
export function shareAuthorName(post, data) {
	const attributed = (post?.author?.name ?? post?.authorName ?? "").trim();
	if (attributed) return attributed;
	if (String(post?.authorId ?? post?.authorDid ?? "") === String(data?.identity?.id ?? "")) {
		return (data?.identity?.name ?? "").trim() || "A family member";
	}
	return "A family member";
}

/** The share text: Brian's templates (Oct 14, 2026), derived only from the
 *  author display name, the photo count, and the fixed frames. Own non-photo
 *  post: "View my post on Porchlight". Photo post (any author):
 *  "[Author] shared N photos on Porchlight". Another member's non-photo
 *  post: "[Author] posted on Porchlight" [Assumed: exact copy confirmed at
 *  build]. Nothing else ever enters the string. */
export function postShareText(post, ownDid, data = {}) {
	const count = photoCountOf(post);
	if (count > 0) return `${shareAuthorName(post, data)} shared ${count} photos on Porchlight`;
	const isOwn = ownDid != null
		&& String(post?.authorId ?? post?.authorDid ?? "") === String(ownDid);
	if (isOwn) return "View my post on Porchlight";
	return `${shareAuthorName(post, data)} posted on Porchlight`;
}

/** The post's canonical deep link: the existing post detail route on the
 *  hub origin — no new server machinery rides the share. */
export function postDeepLink(post, base) {
	return `${String(base ?? "").replace(/\/+$/, "")}/posts/${encodeURIComponent(identityOf(post))}`;
}

/**
 * One share of one post. Returns a deterministic outcome the surface renders:
 * - `{ mode: "native" }` — navigator.share ran (the dialog includes AbortError
 *   dismissals: the member cancelled, nothing failed).
 * - `{ mode: "copy", copied, link }` — the fallback: the link alone was copied.
 * A native call that fails for any reason other than a member dismissal falls
 * back to the copy path, so the share always has a working exit.
 */
export async function sharePost({
	post,
	ownDid,
	data = {},
	base,
	share,
	copy,
} = {}) {
	const link = postDeepLink(post, base);
	const text = postShareText(post, ownDid, data);
	const nativeShare = share ?? (typeof navigator !== "undefined" ? navigator?.share : undefined);
	if (typeof nativeShare === "function") {
		try {
			// The payload carries title, share text, and the deep link —
			// and nothing else: no body, no comments, no media bytes (ac-4).
			await nativeShare({ title: "Porchlight", text, url: link });
			return { mode: "native" };
		} catch (error) {
			// Member dismissed the dialog (iOS AbortError): quiet exit,
			// never an error, never a stray clipboard write.
			if (error?.name === "AbortError") return { mode: "native", dismissed: true };
		}
	}
	const copied = Boolean(await (copy ?? copyLink)(link));
	return { mode: "copy", copied, link, text };
}