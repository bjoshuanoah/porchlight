// publisher.js — in-process profile switch bus (PORCH-135).
//
// Live apply law (TS 12): a profile switch computes the changed knob set per
// camera and calls every registered subscriber synchronously — no restart.

export class Publisher {
	constructor() {
		/** @type {Set<(event: { activeProfileId: string | null, changed: object }) => void>} */
		this.subscribers = new Set();
	}

	/**
	 * Register a subscriber; returns an unsubscribe function.
	 * @param {(event: { activeProfileId: string | null, changed: object }) => void} fn
	 */
	subscribe(fn) {
		this.subscribers.add(fn);
		return () => {
			this.subscribers.delete(fn);
		};
	}

	/** Synchronously notify every subscriber with the switch event. */
	publish(event) {
		for (const fn of this.subscribers) fn(event);
	}
}
