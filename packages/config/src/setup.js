// setup.js — the first-run wizard service of record (PORCH-130).
//
// The wizard asks exactly two things before the console lands a deployment:
// name the deployment, say who owns it (first/last name, optional photo).
// The answers persist as the console `setup` doc (<root>/config/console/
// setup.yaml); a rebooted service over the same root resumes the same state.
//
// Copy law (Porchlight pattern): the stored state NEVER carries the photo's
// data URL — state()/complete() expose the boolean flag only, so every
// console surface can render without hauling bytes; the data URL is served
// once through photo(). Every refusal is a plain-language 422 naming the
// field and its rule.

import { ValidationError, assertObject } from "./types.js";

const DEPLOYMENT_NAME_MAX = 80;
const OWNER_NAME_MAX = 60;
const PHOTO_MAX_CHARS = 600_000;
const PHOTO_PREFIX = "data:image/";

/**
 * @param {{ store: import("./store.js").Store, now?: () => Date }} opts
 */
export function createSetupService(opts = {}) {
	const store = opts.store;
	const now = opts.now ?? (() => new Date());

	/** The wizard doc of record (`{}` when nothing was answered yet). */
	function readDoc() {
		return store.readDoc("setup");
	}

	function persist(doc) {
		store.writeDoc("setup", doc);
	}

	/** State for every console surface — boolean photo flag, never the bytes. */
	function state() {
		const doc = readDoc();
		const name = typeof doc.deployment?.name === "string" && doc.deployment.name !== "" ? doc.deployment.name : null;
		const firstName = typeof doc.owner?.firstName === "string" && doc.owner.firstName !== "" ? doc.owner.firstName : null;
		const lastName = typeof doc.owner?.lastName === "string" && doc.owner.lastName !== "" ? doc.owner.lastName : null;
		const photo = typeof doc.owner?.photoDataUrl === "string" && doc.owner.photoDataUrl !== "";
		const completed = typeof doc.completed?.at === "string" && doc.completed.at !== "";
		const missing = [
			...(name === null ? ["deployment name"] : []),
			...(firstName === null ? ["owner first name"] : []),
			...(lastName === null ? ["owner last name"] : []),
		];
		return { completed, deployment: { name }, owner: { firstName, lastName, photo }, missing };
	}

	/** Name the deployment: trimmed, 1-80 characters. */
	function setDeployment(input) {
		assertObject(input ?? {}, "deployment body");
		if (typeof input.name !== "string" || input.name.trim() === "") {
			throw new ValidationError("deployment name: required");
		}
		const name = input.name.trim();
		if (name.length > DEPLOYMENT_NAME_MAX) {
			throw new ValidationError("deployment name: must be 1-80 characters");
		}
		const doc = readDoc();
		doc.deployment = { ...(doc.deployment ?? {}), name };
		persist(doc);
		return state();
	}

	/**
	 * Name the owner: first/last required (trimmed, 1-60 chars). The photo is
	 * optional: absent/undefined keeps the stored one, explicit null clears
	 * it, a data URL must be an image and stays under the size bound.
	 */
	function setOwner(input) {
		assertObject(input ?? {}, "owner body");
		const firstName = requireName(input.firstName, "owner first name");
		const lastName = requireName(input.lastName, "owner last name");
		const doc = readDoc();
		const owner = {
			firstName,
			lastName,
			photoDataUrl: normalizePhoto(input.photo, doc.owner?.photoDataUrl ?? null),
		};
		if (owner.photoDataUrl === null) delete owner.photoDataUrl;
		doc.owner = owner;
		persist(doc);
		return state();
	}

	function requireName(value, label) {
		if (typeof value !== "string" || value.trim() === "") {
			throw new ValidationError(`${label}: required`);
		}
		const name = value.trim();
		if (name.length > OWNER_NAME_MAX) {
			throw new ValidationError(`${label}: must be 1-60 characters`);
		}
		return name;
	}

	/** Photo rule of record: keep | clear | set (image data URL, ≤ 600k chars). */
	function normalizePhoto(photo, existing) {
		if (photo === undefined) return existing;
		if (photo === null || photo === "") return null;
		if (typeof photo !== "string" || !photo.startsWith(PHOTO_PREFIX)) {
			throw new ValidationError("photo: must be an image data URL");
		}
		if (photo.length > PHOTO_MAX_CHARS) {
			throw new ValidationError("photo too large, keep it under about 500 KB");
		}
		return photo;
	}

	/**
	 * Complete the wizard: prerequisites are named in plain language while
	 * they last; on success the completion instant is stamped and the state
	 * returns (never the photo bytes).
	 */
	function complete() {
		const { missing } = state();
		if (missing.length > 0) {
			throw new ValidationError(`the wizard isn't finished — still needed: ${missing.join(", ")}`);
		}
		const doc = readDoc();
		doc.completed = { at: now().toISOString() };
		persist(doc);
		return state();
	}

	/** The owner photo's data URL, or null — the one surface that serves bytes. */
	function photo() {
		const value = readDoc().owner?.photoDataUrl;
		return typeof value === "string" && value !== "" ? value : null;
	}

	return { state, setDeployment, setOwner, complete, photo };
}
