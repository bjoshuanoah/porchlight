// store.js — atomic YAML persistence for the config console (PORCH-135).
//
// Docs live under <root>/config/console/ (root passed in; default
// /Library/Porchlight). Every write goes tmp+rename so a reader — including a
// brand new service instance over the same dir (restart persistence) — always
// sees a complete YAML document, never a torn write.

import fsDefault from "node:fs";
import pathDefault from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export const DOC_NAMES = Object.freeze([
	"cameras",
	"zones",
	"masks",
	"speed",
	"profiles",
	"base",
	"active-profile",
	"storage",
	"compute",
	"setup",
]);

/** The console document directory for a Porchlight root. */
export function consoleDirFor(root) {
	return pathDefault.join(root, "config", "console");
}

export class Store {
	/**
	 * @param {string} root Porchlight root dir
	 * @param {{ fs?: typeof fsDefault }} [opts]
	 */
	constructor(root, opts = {}) {
		this.fs = opts.fs ?? fsDefault;
		this.root = root;
		this.dir = consoleDirFor(root);
		/** @type {Map<string, object>} parsed docs by name, loaded lazily */
		this.cache = new Map();
	}

	/** Read a doc (parsed YAML), cached after first load. `{}` when absent. */
	readDoc(name) {
		const cached = this.cache.get(name);
		if (cached) return cached;
		const file = pathDefault.join(this.dir, `${name}.yaml`);
		let doc = {};
		if (this.fs.existsSync(file)) {
			const raw = this.fs.readFileSync(file, "utf8");
			if (raw.trim() !== "") doc = parseYaml(raw) ?? {};
		}
		if (!doc || typeof doc !== "object") {
			throw new Error(`${name}.yaml: expected a YAML mapping`);
		}
		this.cache.set(name, doc);
		return doc;
	}

	/**
	 * Atomically persist a doc: stringify to a tmp file in the same directory,
	 * then rename over the target. Rename within one filesystem is the atomic
	 * step, so crash windows leave either the old or the new full document.
	 */
	writeDoc(name, doc) {
		this.cache.set(name, doc);
		this.fs.mkdirSync(this.dir, { recursive: true });
		const file = pathDefault.join(this.dir, `${name}.yaml`);
		const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
		this.fs.writeFileSync(tmp, stringifyYaml(doc), "utf8");
		this.fs.renameSync(tmp, file);
		return file;
	}
}
