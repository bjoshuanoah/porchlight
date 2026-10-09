// `porchlight bootstrap` — drives the remaining bootstrap steps over the hub
// URL (tunnel first, local fallback). Resumable and re-runnable: completed
// steps are listed and skipped; a failed step keeps completed work, names the
// error, and leaves re-run instructions (Porchlight Server TS 2).
// The flow asks exactly two things (PORCH-020): the network's name and who
// you are. Invites and network settings are owner-console actions taken from
// inside the network, never bootstrap steps.
import { loadHomeConfig, hubUrl, hubJson } from "./httpx.mjs";
import { ensureOwnerDevice } from "./owner-device.mjs";
import { ask, printer } from "./prompts.mjs";

const STEP_ORDER = ["account", "network"];

async function postJson(config, path, body) {
  return hubJson(config, path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
}

export async function run(args = {}) {
  const out = printer();
  const { config, paths } = loadHomeConfig(args);
  const base = hubUrl(config);
  out(`hub URL: ${base} (from the tunnel; the local listener is http://127.0.0.1:${config.hub.httpPort})`);

  const { body: state } = await hubJson(config, "/api/bootstrap/state");
  const steps = state.steps ?? {};
  for (const step of STEP_ORDER.filter((step) => steps[step]?.status === "complete")) {
    out(`[skip] ${step} — already complete (bootstrap resumed)`);
  }
  const remaining = STEP_ORDER.filter((step) => steps[step]?.status !== "complete");
  if (remaining.length === 0) {
    out("bootstrap already complete — the owner is bound to the network. Invites and settings live in the owner console.");
    return;
  }

  // The owner DID from the account step tags the network the owner creates —
  // on resume, the account response is gone and the field falls back absent.
  const ctx = { paths };
  for (const step of remaining) {
    if (steps[step]?.status === "failed" && steps[step]?.detail) {
      out(`[warn] ${step} previously failed: ${steps[step].detail} — retrying (completed steps are kept)`);
    }
    try {
      await runStep(step, base, args, out, config, ctx);
    } catch (error) {
      out(`[stop] ${step} failed: ${error.message}`);
      out("bootstrap is resumable — completed steps are kept. Re-run `porchlight bootstrap` to continue.");
      process.exit(1);
    }
  }

  const { body: final } = await hubJson(config, "/api/bootstrap/state");
  const complete = STEP_ORDER.every((step) => final.steps[step]?.status === "complete");
  out(
    complete
      ? "bootstrap complete — the owner is bound to the network. Invites and settings are owner-console actions from inside."
      : "bootstrap still incomplete — re-run `porchlight bootstrap`.",
  );
  // Owner-bind handoff (PORCH-031): bootstrap itself is the authorization —
  // the URL comes from the hub's founder-bound network response of THIS run,
  // never a prior state. The link rides the identity device-link class:
  // single use, 24-hour TTL, consumed by the hub's /device-link page.
  if (complete) {
    const ownerBind = ctx.ownerBind ?? null;
    if (ownerBind?.token) {
      out("");
      out("To open the network on the owner's device, open this one-time link in a browser:");
      out(`  ${base.replace(/\/+$/, "")}/device-link/${ownerBind.token}`);
      out("It signs the device in — no password, no login form anywhere. It works once and expires in 24 hours.");
    } else {
      out("(this run issued no device-bind link — the owner binding did not complete; check the hub log)");
    }
  }
}

async function runStep(step, base, args, out, config, ctx = {}) {
  switch (step) {
    case "account": {
      await createAccount(config, args, out, ctx);
      return;
    }
    case "network": {
      const name = args.network ?? (await ask("Network name: "));
      const body = { name };
      // Founder rule: the owner identity recorded at the account step is the
      // network's owner. On resume the account step is already complete and
      // its response is gone, so the owner DID re-resolves from the hub
      // account surface — the network step still binds the founder.
      if (!ctx.ownerDid) {
        const { body: accountState } = await hubJson(config, "/api/identity/account");
        ctx.ownerDid = accountState?.account?.did ?? null;
      }
      if (ctx.ownerDid) body.ownerDid = ctx.ownerDid;
      const response = await postJson(config, "/api/social/bootstrap/network", body);
      if (response.status >= 400) throw new Error(response.body.error ?? `HTTP ${response.status}`);
      out(`[done] network — "${response.body.network.name}" created (or already present)`);
      // Founder-root binding (PORCH-018): the owner who created the network
      // is already a member of it — the hub account is the proof, never an invite.
      if (response.body.membership) out(`  owner bound to this network (role: ${response.body.membership.role})`);
      // Owner-bind handoff (PORCH-031): the hub mints the single-use
      // device-link grant alongside the founder binding; the run carries it
      // to the completion print below.
      if (response.body.ownerBind) ctx.ownerBind = response.body.ownerBind;
      return;
    }
    default:
      throw new Error(`unknown bootstrap step ${step}`);
  }
}

async function createAccount(config, args, out, ctx = {}) {
  // Required names (PORCH-024): first and last, both non-empty. The hub
  // validates them server-side regardless of client state; the display
  // name is composed there from the two.
  const firstName = args.firstName ?? (await ask("First name: "));
  const lastName = args.lastName ?? (await ask("Last name: "));
  if (!firstName?.trim() || !lastName?.trim()) {
    throw new Error("First name and last name are both required to create the owner account.");
  }
  // Keys on device: the CLI machine is the owner's control-plane device; the
  // identity core requires the binding at first-account creation, so the
  // owner's local key pairs it before the request (public JWK only).
  const device = ensureOwnerDevice(ctx.paths?.root);
  const response = await postJson(config, "/api/identity/bootstrap/account", {
    firstName: firstName.trim(),
    lastName: lastName.trim(),
    device,
  });
  if (response.status >= 400) throw new Error(response.body.error ?? `HTTP ${response.status}`);
  const did = response.body?.account?.did ?? null;
  if (did) ctx.ownerDid = did;
  out(
    response.body.created
      ? `[done] account — owner account ${response.body.account._id} created`
      : "[done] account — already present",
  );
}
