// setup.test.js — the first-run wizard service of record (PORCH-130).
//
// Covers the wizard REST contract end to end: the initial state, the
// verbatim plain-language refusals (deployment/owner bounds, photo
// discipline), the photo round trip (bound via set, kept on absent, cleared
// on null, served only through photo(), never leaked as data in state), the
// complete refusal naming what's missing, and persistence across a service
// reboot over the same root.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fsDefault from "node:fs";
import osDefault from "node:os";
import pathDefault from "node:path";

import { createConfigService } from "../src/index.js";

const PHOTO = "data:image/png;base64," + "iVBORw0KGgo".repeat(8);

function tmpRoot(prefix) {
	return fsDefault.mkdtempSync(pathDefault.join(osDefault.tmpdir(), prefix));
}

async function boot(root, t, opts = {}) {
	const service = createConfigService({ root, consoleDist: null, ...opts });
	const handle = await service.start(0);
	t.after(() => handle.close());
	return { service, handle, api };
	async function api(method, pathname, body) {
		const res = await fetch(`http://127.0.0.1:${handle.port}${pathname}`, {
			method,
			headers: body === undefined ? {} : { "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		return { status: res.status, headers: res.headers, body: await res.json() };
	}
}

describe("first-run wizard REST contract", () => {
	test("the fresh state asks for everything in plain language", async (t) => {
		const root = tmpRoot("porch-setup-");
		t.after(() => fsDefault.rmSync(root, { recursive: true, force: true }));
		const { api } = await boot(root, t);

		const res = await api("GET", "/api/setup");
		assert.equal(res.status, 200);
		assert.deepEqual(res.body, {
			completed: false,
			deployment: { name: null },
			owner: { firstName: null, lastName: null, photo: false },
			missing: ["deployment name", "owner first name", "owner last name"],
		});
		assert.deepEqual((await api("GET", "/api/setup/photo")).body, { photo: null });
	});

	test("setDeployment trims and refuses in plain language", async (t) => {
		const root = tmpRoot("porch-setup-");
		t.after(() => fsDefault.rmSync(root, { recursive: true, force: true }));
		const { api } = await boot(root, t);

		const ok = await api("PUT", "/api/setup/deployment", { name: "  Home Base " });
		assert.equal(ok.status, 200);
		assert.equal(ok.body.deployment.name, "Home Base");
		assert.deepEqual(ok.body.missing, ["owner first name", "owner last name"]);

		for (const [body, message] of [
			[{ name: "   " }, "deployment name: required"],
			[{}, "deployment name: required"],
			[{ name: "x".repeat(81) }, "deployment name: must be 1-80 characters"],
		]) {
			const res = await api("PUT", "/api/setup/deployment", body);
			assert.equal(res.status, 422);
			assert.deepEqual(res.body, { error: message });
		}
	});

	test("setOwner validates names and the photo discipline with verbatim refusals", async (t) => {
		const root = tmpRoot("porch-setup-");
		t.after(() => fsDefault.rmSync(root, { recursive: true, force: true }));
		const { api } = await boot(root, t);
		await api("PUT", "/api/setup/deployment", { name: "Home Base" });

		for (const [body, message] of [
			[{ lastName: "Lovelace" }, "owner first name: required"],
			[{ firstName: "Ada" }, "owner last name: required"],
			[{ firstName: "   ", lastName: "Lovelace" }, "owner first name: required"],
			[{ firstName: "A".repeat(61), lastName: "Lovelace" }, "owner first name: must be 1-60 characters"],
			[{ firstName: "Ada", lastName: "L".repeat(61) }, "owner last name: must be 1-60 characters"],
			[{ firstName: "Ada", lastName: "Lovelace", photo: "http://portrait" }, "photo: must be an image data URL"],
			[{ firstName: "Ada", lastName: "Lovelace", photo: "data:image/png;base64," + "A".repeat(600_000) }, "photo too large, keep it under about 500 KB"],
		]) {
			const res = await api("PUT", "/api/setup/owner", body);
			assert.equal(res.status, 422);
			assert.deepEqual(res.body, { error: message });
		}

		// The photo binds: the flag floats on every state surface, the bytes
		// ride only through the photo surface.
		const set = await api("PUT", "/api/setup/owner", { firstName: "Ada", lastName: "Lovelace", photo: PHOTO });
		assert.equal(set.status, 200);
		assert.deepEqual(set.body, {
			completed: false,
			deployment: { name: "Home Base" },
			owner: { firstName: "Ada", lastName: "Lovelace", photo: true },
			missing: [],
		});
		assert.deepEqual((await api("GET", "/api/setup/photo")).body, { photo: PHOTO });
	});

	test("absent photo keeps the stored one; explicit null clears it; state never leaks bytes", async (t) => {
		const root = tmpRoot("porch-setup-");
		t.after(() => fsDefault.rmSync(root, { recursive: true, force: true }));
		const { api, service } = await boot(root, t);
		await api("PUT", "/api/setup/deployment", { name: "Home Base" });
		await api("PUT", "/api/setup/owner", { firstName: "Ada", lastName: "Lovelace", photo: PHOTO });

		const kept = await api("PUT", "/api/setup/owner", { firstName: "Grace", lastName: "Hopper" });
		assert.equal(kept.body.owner.photo, true);
		assert.deepEqual((await api("GET", "/api/setup/photo")).body, { photo: PHOTO });

		const cleared = await api("PUT", "/api/setup/owner", { firstName: "Grace", lastName: "Hopper", photo: null });
		assert.equal(cleared.body.owner.photo, false);
		assert.deepEqual((await api("GET", "/api/setup/photo")).body, { photo: null });

		// Leash: no console surface output ever carries the data URL.
		await api("PUT", "/api/setup/owner", { firstName: "Grace", lastName: "Hopper", photo: PHOTO });
		const done = await api("POST", "/api/setup/complete");
		assert.equal(JSON.stringify(done.body).includes("data:image"), false);
		assert.equal(done.body.owner.photo, true);
		assert.equal(service.setup.photo(), PHOTO);
	});

	test("complete names what the wizard still needs; success stamps the instant", async (t) => {
		const root = tmpRoot("porch-setup-");
		t.after(() => fsDefault.rmSync(root, { recursive: true, force: true }));
		const { api, service } = await boot(root, t);

		const refused = await api("POST", "/api/setup/complete");
		assert.equal(refused.status, 422);
		assert.deepEqual(refused.body, {
			error: "the wizard isn't finished — still needed: deployment name, owner first name, owner last name",
		});

		await api("PUT", "/api/setup/deployment", { name: "Home Base" });
		const stillRefused = await api("POST", "/api/setup/complete");
		assert.equal(stillRefused.status, 422);
		assert.deepEqual(stillRefused.body, {
			error: "the wizard isn't finished — still needed: owner first name, owner last name",
		});
		await api("PUT", "/api/setup/owner", { firstName: "Ada", lastName: "Lovelace" });

		const done = await api("POST", "/api/setup/complete");
		assert.equal(done.status, 200);
		assert.equal(done.body.completed, true);
		assert.deepEqual(done.body.missing, []);
		assert.ok(!Number.isNaN(new Date(service.store.readDoc("setup").completed?.at ?? "").getTime()));
	});

	test("wizard state survives a service reboot over the same root (photo as bytes, never in state)", async (t) => {
		const root = tmpRoot("porch-setup-");
		t.after(() => fsDefault.rmSync(root, { recursive: true, force: true }));
		{
			const first = await boot(root, t);
			await first.api("PUT", "/api/setup/deployment", { name: "Home Base" });
			await first.api("PUT", "/api/setup/owner", { firstName: "Ada", lastName: "Lovelace", photo: PHOTO });
			await first.api("POST", "/api/setup/complete");
			await first.handle.close();
		}
		{
			const rebooted = await boot(root, t);
			const state = await rebooted.api("GET", "/api/setup");
			assert.deepEqual(state.body, {
				completed: true,
				deployment: { name: "Home Base" },
				owner: { firstName: "Ada", lastName: "Lovelace", photo: true },
				missing: [],
			});
			assert.deepEqual((await rebooted.api("GET", "/api/setup/photo")).body, { photo: PHOTO });
			// An already-complete wizard still answers plainly (idempotent re-stamp).
			const again = await rebooted.api("POST", "/api/setup/complete");
			assert.equal(again.status, 200);
			assert.equal(again.body.completed, true);
			await rebooted.handle.close();
		}
	});
});
