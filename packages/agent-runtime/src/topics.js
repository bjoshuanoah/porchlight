// topics.js — per-member conversation topics (PORCH-147).
//
// Topics organize the member's memory stream; every topic record and every
// entry lives inside the member's own namespace (scope "topics").

import { randomUUID } from "node:crypto";

/**
 * @typedef {object} Topic
 * @property {string} id
 * @property {string} name
 * @property {number} entryCount
 * @property {string} createdAt
 */

export class TopicsStore {
	/** @param {{ store: import("./store.js").MemberStore }} opts */
	constructor({ store }) {
		this.#store = store;
	}

	#store;

	/** @returns {Promise<string>} next sequence number (a key-safe counter) */
	async #nextId() {
		const current = await this.#store.get("seq");
		const seq = (typeof current === "number" ? current : 0) + 1;
		await this.#store.set("seq", seq);
		return `t${String(seq).padStart(6, "0")}-${randomUUID().slice(0, 8)}`;
	}

	/**
	 * Ensure a topic exists by name; returns it either way (idempotent).
	 * @returns {Promise<Topic>}
	 */
	async ensure(name) {
		if (typeof name !== "string" || !name.trim()) {
			throw new TypeError("TopicsStore.ensure: topic name required");
		}
		const existing = (await this.list()).find((t) => t.name === name);
		if (existing) return existing;
		const topic = { id: await this.#nextId(), name, entryCount: 0, createdAt: new Date().toISOString() };
		await this.#store.set(`topic:${topic.id}`, topic);
		return topic;
	}

	/**
	 * Count a memory entry against a topic (called by the memory stream).
	 * @returns {Promise<Topic | null>}
	 */
	async touch(topicId) {
		const topic = await this.get(topicId);
		if (!topic) return null;
		topic.entryCount += 1;
		await this.#store.set(`topic:${topicId}`, topic);
		return topic;
	}

	/** @returns {Promise<Topic | null>} */
	async get(id) {
		return (await this.#store.get(`topic:${id}`)) ?? null;
	}

	/** @returns {Promise<Topic[]>} every topic of the member, oldest first */
	async list() {
		const rows = await this.#store.list("topic:");
		return rows
			.map((r) => r.value)
			.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || String(a.id).localeCompare(String(b.id)));
	}
}
