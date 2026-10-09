// `porchlight bootstrap` — drives the remaining bootstrap steps over the hub
// URL (tunnel first, local fallback). Resumable and re-runnable: completed
// steps are listed and skipped; a failed step keeps completed work, names the
// error, and leaves re-run instructions (Porchlight Server TS 2).
// The remote path is the served /bootstrap page; this CLI driver is the
// server-adjacent convenience flow hitting the same endpoints.
import { loadHomeConfig, hubUrl, hubJson } from "./httpx.mjs";
import { ensureOwnerDevice } from "./owner-device.mjs";
import { ask, printer } from "./prompts.mjs";

const STEP_ORDER = ["account", "network", "invite", "quota"];

async function postJson(config, path, body) {
  return hubJson(config, path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
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
    out("bootstrap already complete — nothing to do.");
    return;
  }

  // The owner did from the account step tags the network the owner creates —
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
      ? "bootstrap complete — the hub is ready. Invites and settings are owner-managed from the hub."
      : "bootstrap still incomplete — re-run `porchlight bootstrap`.",
  );
}

async function runStep(step, base, args, out, config, ctx = {}) {
  switch (step) {
    case "account": {
      const create = await ask(
        "First account: (c)reate here or (a)adopt an identity from another hub? [c/a, default c]: ",
        "c",
      );
      if (args.name || args.email) {
        await createAccount(config, args, out, ctx);
        return;
      }
      if (create.toLowerCase() === "a") {
        const sourceHubUrl = await ask("Your other hub's URL: ");
        const externalIdentityId = await ask("Your identity id on that hub: ");
        const displayName = await ask("Display name [optional]: ", null);
        const response = await postJson(config, "/api/identity/bootstrap/adopt", {
          sourceHubUrl,
          externalIdentityId,
          displayName,
        });
        if (response.status >= 400) throw new Error(response.body.error ?? `HTTP ${response.status}`);
        const did = response.body?.account?.did ?? null;
        if (did) ctx.ownerDid = did;
        out(`[done] account — identity adopted from ${sourceHubUrl}`);
        return;
      }
      await createAccount(config, args, out, ctx);
      return;
    }
    case "network": {
      const name = args.network ?? (await ask("Network name: "));
      const body = { name };
      // Founder rule: the owner identity recorded at the account step is the
      // network's owner.
      if (ctx.ownerDid) body.ownerDid = ctx.ownerDid;
      const response = await postJson(config, "/api/social/bootstrap/network", body);
      if (response.status >= 400) throw new Error(response.body.error ?? `HTTP ${response.status}`);
      out(`[done] network — "${response.body.network.name}" created (or already present)`);
      return;
    }
    case "invite": {
      const response = await postJson(config, "/api/social/bootstrap/invite", { hubUrl: base });
      if (response.status >= 400) throw new Error(response.body.error ?? `HTTP ${response.status}`);
      out(`[done] invite — token ${response.body.invite.token}`);
      if (response.body.joinUrl) out(`       join link: ${response.body.joinUrl}`);
      return;
    }
    case "quota": {
      const argsStore = args.quotaStore != null ? Number(args.quotaStore) : null;
      const argsDays = args.quotaDays != null ? Number(args.quotaDays) : null;
      const answer = Number.isFinite(argsStore) ? argsStore : await ask("Storage ceiling in MB [enter = unset]: ", null);
      const answerDays = Number.isFinite(argsDays) ? argsDays : await ask("Retention window in days [enter = unset]: ", null);
      const payload = {
        storageCeilingMb: answer == null || Number.isNaN(Number(answer)) ? null : Number(answer),
        retentionDays: answerDays == null || Number.isNaN(Number(answerDays)) ? null : Number(answerDays),
      };
      const response = await postJson(config, "/api/bootstrap/quotas", payload);
      if (response.status >= 400) throw new Error(response.body.error ?? `HTTP ${response.status}`);
      out(`[done] quota — runtime config now holds ${JSON.stringify(response.body.quota)}`);
      return;
    }
    default:
      throw new Error(`unknown bootstrap step ${step}`);
  }
}

async function createAccount(config, args, out, ctx = {}) {
  let name = args.name ?? "Owner";
  let email = args.email ?? null;
  if (!args.name) {
    name = (await ask("Owner display name: ")) ?? name;
    email = await ask("Owner email [optional]: ", null);
  }
  // Keys on device: the CLI machine is the owner's control-plane device; the
  // identity core requires the binding at first-account creation, so the
  // owner's local key pairs it before the request (public JWK only).
  const device = ensureOwnerDevice(ctx.paths?.root);
  const response = await postJson(config, "/api/identity/bootstrap/account", { displayName: name, email, device });
  if (response.status >= 400) throw new Error(response.body.error ?? `HTTP ${response.status}`);
  const did = response.body?.account?.did ?? null;
  if (did) ctx.ownerDid = did;
  out(
    response.body.created
      ? `[done] account — owner account ${response.body.account._id} created`
      : "[done] account — already present",
  );
}