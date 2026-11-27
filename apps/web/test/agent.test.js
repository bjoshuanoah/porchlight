// PORCH-150: the Agent surfaces — the member card (which model is running,
// per the never-silent law), the hub-admin profile/assignment screens, and
// the family organizer's parental narrowing control rendered inside
// FamilyCard (PRD 2's F9 resolution: the narrowing surfaces exactly there,
// nowhere else, and the enforcement of every narrowing stays hub-side in
// the agent module's assignment path).
//
// The pure model pins directly (node --test); the real screens bundle with
// esbuild and render with a stubbed api/connection (the share-flows
// render-sweep pattern) — no fetch, no MUI theme Provider, SSR-safe surface.
// The DOM sweeps are the privacy evidence: member-facing HTML carries no
// endpoint/token strings, and a withheld profile renders nowhere member-side.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import React from "react";
import { renderToString } from "react-dom/server";

import {
  PROVIDER_CLASSES, assignmentPayload, assignmentTargetLabel,
  memberStateCopy, narrowingPayload, profileFormReady, providerClassLabel,
} from "../src/agent-model.js";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = fileURLToPath(new URL("../", import.meta.url));
const src = async (file) => await readFile(join(webRoot, file), "utf8");
const mainSource = await src("src/main.jsx");
const homeSource = await src("src/home.jsx");
const actionsSource = await src("src/agent-actions.js");
const agentSource = await src("src/agent.jsx");

const EXTERNALS = ["react", "react-dom", "@mui/*", "@emotion/*", "@noble/*"];

const tmpRoot = join(here, `.tmp150-${process.pid}`);
await mkdir(tmpRoot, { recursive: true });
after(async () => { await rm(tmpRoot, { recursive: true, force: true }); });

/** The bundled entries for the render sweeps. */
let Surface = null;
let FamilySurface = null;
async function screenSurface() {
  if (Surface) return Surface;
  await build({
    stdin: { contents: 'export { Agent, MyAgentCard, ProfilesAdmin, TypeAssignmentState, AssignForm, CreateProfileDialog, AssignmentRow } from "./src/agent.jsx";', resolveDir: webRoot, loader: "jsx", sourcefile: "entry.jsx" },
    bundle: true, format: "esm", jsx: "automatic", platform: "neutral",
    external: EXTERNALS,
    outfile: join(tmpRoot, "screen.built.mjs"), logLevel: "silent",
  });
  Surface = await import(join(tmpRoot, "screen.built.mjs"));
  return Surface;
}
async function familySurface() {
  if (FamilySurface) return FamilySurface;
  await build({
    stdin: { contents: 'export { FamilyCard, NarrowingDialog } from "./src/home.jsx";', resolveDir: webRoot, loader: "jsx", sourcefile: "family.jsx" },
    bundle: true, format: "esm", jsx: "automatic", platform: "neutral",
    external: EXTERNALS,
    outfile: join(tmpRoot, "family.built.mjs"), logLevel: "silent",
  });
  FamilySurface = await import(join(tmpRoot, "family.built.mjs"));
  return FamilySurface;
}

/* ---- fixtures of record -------------------------------------------------- */

const KIDS = { profileId: "p_kids", name: "Kids model", providerClass: "native-mlx", modelId: "gemma4:e2b-mlx", selectable: true };
const GLM = { profileId: "p_glm", name: "Ollama GLM", providerClass: "local-server", modelId: "glm-5.3", selectable: true };
// The admin's withheld profile — existence rides admin projections only; the
// member-facing list never carries it (the hub's projection of record).
const PREMIUM_WITHHELD = { _id: "p_premium", name: "Premium", providerClass: "local-server", modelId: "premium-model", memberSelectable: false, endpointRef: "engine:premium-endpoint" };

const adminProfiles = [
  { ...GLM, _id: GLM.profileId, memberSelectable: true },
  { ...PREMIUM_WITHHELD },
];

const memberView = {
  state: "running",
  model: { modelId: "glm-5.3", providerClass: "local-server" },
  reason: null,
};

// The fixture states exactly as the hub's member surface read answers them.
const memberStateCopyFixtures = {
  degraded: {
    state: "degraded", model: { modelId: "glm-5.3", providerClass: "local-server" },
    reason: "Running the explicitly configured fallback (Kids model) — the assigned profile's provider could not answer.",
    fallback: { profileName: "Kids model" },
  },
  unassigned: { state: "unassigned", reason: "No model profile is assigned — the admin surface names the unassigned state; there is no silent default model." },
};

/* ---- the model ----------------------------------------------------------- */

test("model ac: the three compute classes label honestly; the form gates on field presence only", () => {
  assert.deepEqual(PROVIDER_CLASSES, ["native-mlx", "openai-spec", "local-server"]);
  assert.equal(providerClassLabel("native-mlx"), "Native on-device (MLX)");
  assert.equal(providerClassLabel("openai-spec"), "OpenAI-spec endpoint");
  assert.equal(providerClassLabel("local-server"), "Local server (Ollama-class)");
  assert.equal(providerClassLabel("bogus"), "bogus");

  const base = { name: "Kids", providerClass: "native-mlx", modelId: "gemma4:e2b-mlx", endpointRef: "" };
  assert.equal(profileFormReady(base), true);
  assert.equal(profileFormReady({ ...base, name: "  " }), false, "a profile needs a name");
  assert.equal(profileFormReady({ ...base, modelId: "" }), false);
  assert.equal(profileFormReady({ ...base, providerClass: "weird" }), false);
  // A native class carries no endpoint reference by law; any other class
  // shows the optional reference field — the ADDRESS law itself stays
  // hub-side and the field carries no client-side requirement.
  assert.equal(profileFormReady({ ...base, providerClass: "openai-spec" }), true);
  assert.equal(profileFormReady({ ...base, providerClass: "openai-spec", endpointRef: "engine:some-endpoint" }), true);
});

test("model ac: the assignment payload names exactly one target — an agent type or a member", () => {
  assert.deepEqual(assignmentPayload({ agentType: "household-member" }, "p1"), { target: { agentType: "household-member" }, profileId: "p1" });
  assert.deepEqual(assignmentPayload({ memberId: "did:porchlight:kid" }, "p1"), { target: { memberId: "did:porchlight:kid" }, profileId: "p1" });
  assert.deepEqual(assignmentPayload({}, "p1"), { target: {}, profileId: "p1" }, "the hub refuses anything else");
  assert.equal(assignmentTargetLabel({ agentType: "household-member" }), "Agent type · household-member");
  assert.equal(assignmentTargetLabel({ memberId: "did:porchlight:kid" }), "Member · did:porchlight:kid");
});

test("model ac: the member card copy names the hub's own state, verbatim where the hub spoke", () => {
  const running = memberStateCopy(memberView);
  assert.equal(running.tone, "success");
  assert.match(running.line, /Running glm-5\.3 — Local server/);

  const degraded = memberStateCopy({
    state: "degraded", model: { modelId: "glm-5.3", providerClass: "local-server" },
    reason: "Running the explicitly configured fallback (Kids model) — the assigned profile's provider could not answer.",
    fallback: { profileName: "Kids model" },
  });
  assert.equal(degraded.tone, "warning");
  assert.match(degraded.line, /Degraded/);
  assert.equal(degraded.reason, "Running the explicitly configured fallback (Kids model) — the assigned profile's provider could not answer.",
    "the hub's own never-silent reason renders verbatim, never a stand-in");

  const unassigned = memberStateCopy({
    state: "unassigned",
    reason: "No model profile is assigned — the admin surface names the unassigned state; there is no silent default model.",
  });
  assert.equal(unassigned.tone, "info");
  assert.match(unassigned.line, /No model assigned yet/);
  const blocked = memberStateCopy({ state: "parental-blocked", reason: "Your family settings do not include this model profile." });
  assert.equal(blocked.tone, "info");
  assert.equal(blocked.reason, "Your family settings do not include this model profile.");
});

test("model ac: the narrowing payload rides the available set only — list order, no duplicates", () => {
  const list = [GLM, KIDS];
  assert.deepEqual(narrowingPayload(list, [KIDS.profileId]), [KIDS.profileId]);
  assert.deepEqual(narrowingPayload(list, [KIDS.profileId, GLM.profileId, KIDS.profileId]), [GLM.profileId, KIDS.profileId],
    "the payload rides the list's order once each — wire shaping, never a parallel gate");
  assert.deepEqual(narrowingPayload(list, []), [], "an empty pick set clears the narrowing");
  assert.deepEqual(narrowingPayload(list, ["p_whatever"]), [], "an id outside the available set never rides");
  assert.deepEqual(narrowingPayload(null, null), []);
});

/* ---- the screens --------------------------------------------------------- */

test("screen ac: the member card names the running model and its class; earned states speak", async () => {
  const { MyAgentCard } = await (await screenSurface());
  const html = renderToString(React.createElement(MyAgentCard, {
    model: memberView, profiles: [KIDS], busy: false, error: "", chooseError: "",
    onChoose: () => {}, onRefresh: () => {},
  }));
  assert.match(html, /Running glm-5\.3/);
  assert.match(html, /Local server \(Ollama-class\)/);
  assert.match(html, /Kids model/);
  assert.match(html, /Use this model/);
  // The never-silent law in the earned states:
  const degraded = renderToString(React.createElement(MyAgentCard, {
    model: memberStateCopyFixtures.degraded, profiles: [], busy: false, error: "", chooseError: "",
    onChoose: () => {}, onRefresh: () => {},
  }));
  assert.match(degraded, /Degraded/);
  assert.match(degraded, /could not answer/, "the hub's own never-silent reason renders verbatim, never a stand-in");
  const unassigned = renderToString(React.createElement(MyAgentCard, {
    model: memberStateCopyFixtures.unassigned, profiles: [], busy: false, error: "", chooseError: "",
    onChoose: () => {}, onRefresh: () => {},
  }));
  assert.match(unassigned, /No model assigned yet/);
  assert.match(unassigned, /no silent default model/);
});

test("screen ac: withheld profiles render nowhere member-side; no endpoint/token strings leak — DOM sweep", async () => {
  const { MyAgentCard, Agent } = await (await screenSurface());
  // The member card: the selectable list carries nothing withheld (the hub's
  // projection already omits it) — and the admin-only Premium profile's very
  // name and its secrets reference must not leak into member HTML.
  const cardHtml = renderToString(React.createElement(MyAgentCard, {
    model: memberView, profiles: [KIDS, GLM], busy: false, error: "", chooseError: "",
    onChoose: () => {}, onRefresh: () => {},
  }));
  assert.ok(!cardHtml.includes("Premium"), "the withheld profile's name never renders member-side");
  assert.ok(!cardHtml.includes("engine:premium-endpoint"), "no secrets reference member-side");
  assert.ok(!cardHtml.includes("://"), "no URL-shaped strings render member-side");
  assert.ok(!cardHtml.includes("engine:"), "no token/secrets strings member-side");

  // The whole tab too — the member card is composed inside it.
  const tabHtml = renderToString(React.createElement(Agent, {
    actions: {
      loadMyModel: async () => memberView,
      loadSelectableProfiles: async () => ({ profiles: [KIDS, GLM] }),
      loadAdminProfiles: async () => { throw new Error("Only the hub admin can manage model profiles."); },
      loadAssignments: async () => { throw new Error("Only the hub admin can manage model profiles."); },
    },
  }));
  // SSR never runs effects, so the fixture reads above render first paint:
  // ...the admin sections open honestly empty at first paint (SSR runs no
  // effects) and carry the refusal slot of record; the non-admin's
  // plain-language refusal lands there at runtime (the hub's own error text).
  assert.match(agentSource, /\{error && <Alert severity="warning" sx=\{\{ mb: 1\.5 \}\}>\{error\}<\/Alert>\}/, "the admin sections render the hub's refusal verbatim, inline");
  assert.doesNotMatch(agentSource, /Only the hub admin/, "the refusal text is the hub's, never a client-pinned stand-in");
  // ...and the member-facing payloads that DID render stay privacy-clean.
  for (const needle of ["Premium", "engine:premium-endpoint", "engine:ollama-endpoint"]) {
    assert.ok(!tabHtml.includes(needle), `${needle} never rides the tab's first paint`);
  }
});

test("screen ac: the admin surface captures name, provider class, endpoint ref, and model (ac-1)", async () => {
  const { ProfilesAdmin } = await (await screenSurface());
  const adminHtml = renderToString(React.createElement(ProfilesAdmin, {
    profiles: adminProfiles, error: "", busy: false, onAvailability: () => {}, onOpenCreate: () => {},
  }));
  // Every defined profile rides the admin list — withholding is the admin's
  // own ruling to SEE and flip, audited hub-side on the flip.
  assert.match(adminHtml, /Ollama GLM/);
  assert.match(adminHtml, /Premium/);
  assert.match(adminHtml, /secrets ref engine:premium-endpoint/, "the admin projection carries the reference, not an address");
  assert.match(adminHtml, /Withheld from members/);
  assert.match(adminHtml, /Members can use/);
  // The create form's fields of record (MUI Dialog contents do not render
  // server-side, so the form pins at source the same way the repo's other
  // dialogs do): name, provider class, model, the secrets-reference field,
  // its not-an-address copy, and the memberSelectable switch.
  assert.match(agentSource, /label="Profile name"/);
  assert.match(agentSource, /labelId="agent-profile-class-label"/);
  assert.match(agentSource, /label="Model"/);
  assert.match(agentSource, /label="Endpoint reference \(secrets\)"/);
  assert.match(agentSource, /never an address/);
  assert.match(agentSource, /Available to members/);
});

test("screen ac: the explicit unassigned state renders the hub's own detail (ac-3)", async () => {
  const { TypeAssignmentState } = await (await screenSurface());
  const unassigned = renderToString(React.createElement(TypeAssignmentState, {
    typeState: {
      state: "unassigned", agentType: "household-member",
      detail: "No profile is assigned to this agent type. The admin must assign one — member agents of this type refuse to resolve a silent default.",
    },
    error: "",
  }));
  assert.match(unassigned, /Unassigned/);
  assert.match(unassigned, /agent type/, "the queried type's state names itself");
  assert.match(unassigned, /refuse to resolve a silent default/);
  const assigned = renderToString(React.createElement(TypeAssignmentState, {
    typeState: { state: "assigned", agentType: "household-member", profile: { name: "Ollama GLM", modelId: "glm-5.3" } },
    error: "",
  }));
  assert.match(assigned, /Ollama GLM/);
});

test("screen ac: assignments render target, profile, who/when — and the revoke act", async () => {
  const { AssignmentRow, AssignForm } = await (await screenSurface());
  const row = renderToString(React.createElement(AssignmentRow, {
    row: {
      _id: "passign_1", target: { memberId: "did:porchlight:kid" },
      profile: { name: "Kids model", modelId: "gemma4:e2b-mlx" },
      assignedBy: "did:porchlight:admin", assignedAt: "2026-11-26T10:00:00Z",
    },
    busy: false, onRevoke: () => {},
  }));
  assert.match(row, /Member · did:porchlight:kid/);
  assert.match(row, /Kids model · gemma4:e2b-mlx/);
  assert.match(row, /Revoke/);
  const form = renderToString(React.createElement(AssignForm, { profiles: adminProfiles, busy: false, error: "", onAssign: async () => true }));
  assert.match(form, /Assign a profile/);
  assert.match(form, /aria-label="Assignment target class"/, "the target pick (agent type or member) carries its affordance");
  assert.match(form, /aria-label="Profile to assign"/);
  assert.match(form, /A member-specific assignment wins over the type default/);
  assert.match(form, /never gated on member availability/, "the admin's own assignment power is not the member gate");
});

/* ---- the family organizer's narrowing control (ac-2) ---------------------- */

test("screen ac: the narrowing control renders exactly inside the family organizer's FamilyCard", async () => {
  const { FamilyCard } = await (await familySurface());
  const family = {
    _id: "fam_1", name: "The household",
    parentIdentityRefs: ["did:porchlight:parent"],
    memberIdentityRefs: ["did:porchlight:parent", "did:porchlight:kid"],
  };
  const wired = renderToString(React.createElement(FamilyCard, {
    family, myDid: "did:porchlight:parent", mutate: async () => {},
    agent: { loadMySelectableProfiles: async () => ({ profiles: [KIDS] }), loadNarrowing: async () => ({ narrowed: false }), setNarrowing: async () => ({}) },
  }));
  assert.match(wired, /Model profiles:/);
  assert.match(wired, /Profiles · /, "one narrowing entry point per member");
  assert.match(wired, /did:porchlight:kid/);
  // A non-parent sees no narrowing control at all.
  const memberViewed = renderToString(React.createElement(FamilyCard, {
    family, myDid: "did:porchlight:kid", mutate: async () => {},
    agent: { loadMySelectableProfiles: async () => ({ profiles: [KIDS] }), loadNarrowing: async () => ({ narrowed: false }), setNarrowing: async () => ({}) },
  }));
  assert.doesNotMatch(memberViewed, /Model profiles:/);
  // Unwired hub (older): the card renders, no narrowing affordance.
  const unwired = renderToString(React.createElement(FamilyCard, {
    family, myDid: "did:porchlight:parent", mutate: async () => {},
  }));
  assert.doesNotMatch(unwired, /Profiles ·/);
});

test("screen ac: the narrowing control's options ARE the available set — a withheld profile is never a parental option (ac-2)", async () => {
  // The parent's options come from the member-facing list (agent
  // loadMySelectableProfiles), which by construction omits admin-withheld
  // profiles; the payload shaping never re-adds one (model ac above). The
  // dialog contents don't render server-side (MUI Dialog), so the control's
  // composition pins at source the way the repo's other dialogs do.
  const optionsPin = homeSource.slice(homeSource.indexOf("export function NarrowingDialog"));
  assert.ok(optionsPin.length > 0, "the narrowing dialog's source is present");
  assert.match(optionsPin, /agent\.loadMySelectableProfiles|loadMySelectableProfiles\(\)/, "the options ARE the member-facing available set");
  assert.match(optionsPin, /\{profile\.name\} · \{profile\.modelId\} · \{providerClassLabel\(profile\.providerClass\)\}/, "each option names model and provider class");
  assert.match(optionsPin, /A profile the hub admin withheld never appears here — a parent can narrow, never widen/);
  assert.match(optionsPin, /No narrowing — any available profile/, "clearing rides the same ONE write (empty set)");
  assert.match(optionsPin, /narrowingPayload\(profiles, picks\)/, "the save rides the model's available-set-only payload");
  // The hub's plain-language refusal renders verbatim in the dialog — the
  // fail-closed parental refusal the hub itself composes.
  assert.match(optionsPin, /\{Boolean\(error\) && <Alert severity="warning"/);
});

/* ---- the wire half -------------------------------------------------------- */

/** The real agent-actions.js, bundled with its api.js import replaced by an
 * inline recorder — one self-contained module carrying both the factory and
 * the `record` array. The /api/ join is proven (api.js's own job). */
const ACTIONS_STUB = [
  "const record = [];",
  "export { record };",
  "async function request(connection, path, init = {}) {",
  "  const target = new URL(`/api/${String(path).replace(/^\\/+/, \"\")}`, connection.url);",
  "  record.push({",
  "    connection,",
  "    url: target.toString(),",
  "    method: init.method ?? \"GET\",",
  "    body: init.body ? JSON.parse(init.body) : null,",
  "  });",
  "  return { ok: true };",
  "}",
].join("\n");

async function bundledActions() {
  const real = await readFile(join(webRoot, "src/agent-actions.js"), "utf8");
  const seeded = real.replace('import { request } from "./api.js";', ACTIONS_STUB);
  assert.notEqual(seeded, real, "the api.js import is the stub seam");
  const outfile = join(tmpRoot, "actions.built.mjs");
  await build({
    stdin: {
      contents: `${seeded}\n`,
      resolveDir: webRoot, loader: "js", sourcefile: "agent-actions.js",
    },
    bundle: true, format: "esm", platform: "neutral",
    outfile, logLevel: "silent",
  });
  return await import(outfile);
}

test("wire ac: every contract route rides request() with the exact path, method, and body", async () => {
  const { createAgentActions, record } = await bundledActions();
  const active = { url: "https://hub.family", token: "device-token", identityToken: "identity-session", identity: { id: "did:porchlight:parent" } };

  const actions = createAgentActions({ active });
  record.length = 0;
  const run = async (label, promise, expected) => {
    await promise;
    const call = record.pop();
    assert.ok(call, label);
    assert.equal(call.connection.token, "identity-session", `${label} rides the identity session token`);
    assert.equal(call.url, expected.url, label);
    assert.equal(call.method, expected.method ?? "GET", label);
    if (expected.body) assert.deepEqual(call.body, expected.body, label);
  };
  const base = "https://hub.family/api/agent";
  await run("my-model", actions.loadMyModel(), { url: `${base}/me/model` });
  await run("selectable", actions.loadSelectableProfiles(), { url: `${base}/me/profiles` });
  await run("choose", actions.chooseModel("p_kids"), { method: "POST", url: `${base}/me/model`, body: { profileId: "p_kids" } });
  await run("admin-profiles", actions.loadAdminProfiles(), { url: `${base}/profiles` });
  await run("define", actions.defineProfile({ name: "Kids", providerClass: "native-mlx", modelId: "gemma4:e2b-mlx", endpointRef: "" }), {
    method: "POST", url: `${base}/profiles`,
    body: { name: "Kids", providerClass: "native-mlx", modelId: "gemma4:e2b-mlx", endpointRef: null, memberSelectable: true },
  });
  await run("flip", actions.setProfileAvailability("p_premium", false), { method: "PUT", url: `${base}/profiles/p_premium/availability`, body: { memberSelectable: false } });
  await run("assignments", actions.loadAssignments(), { url: `${base}/assignments` });
  await run("typed-assignment", actions.loadAssignments({ agentType: "household-member" }), { url: `${base}/assignments?agentType=household-member` });
  await run("assign", actions.assignProfile({ agentType: "household-member" }, "p_kids"), { method: "POST", url: `${base}/assignments`, body: { target: { agentType: "household-member" }, profileId: "p_kids" } });
  await run("revoke", actions.revokeAssignment("passign_1"), { method: "DELETE", url: `${base}/assignments/passign_1` });
  await run("narrowing-read", actions.loadNarrowing("fam_1", "did:porchlight:kid"), { url: `${base}/families/fam_1/members/did%3Aporchlight%3Akid/permitted-profiles` });
  await run("narrowing-write", actions.setNarrowing("fam_1", "did:porchlight:kid", [GLM.profileId]), {
    method: "POST", url: `${base}/families/fam_1/members/did%3Aporchlight%3Akid/permitted-profiles`,
    body: { profileIds: [GLM.profileId] },
  });
  assert.equal(record.length, 0, "each action rode exactly one request");

  // No open identity session: the honest guard, never a silent no-op.
  assert.throws(() => createAgentActions({ active: null }).loadMyModel(), /Open your connected identity/);
  assert.throws(() => createAgentActions({ active: { url: "https://hub.family" } }).loadMyModel(), /Open your connected identity/);
});

/* ---- the wiring of record -------------------------------------------------- */

test("wiring ac: the Agent tab registers exactly where the other screens do", () => {
  assert.match(mainSource, /else if \(route === "\/agent"\) page = <Agent \{\.\.\.props\} \/>;/);
  assert.match(mainSource, /import \{ Agent \} from "\.\/agent\.jsx";/);
  assert.match(mainSource, /import \{ createAgentActions \} from "\.\/agent-actions\.js";/);
  assert.match(mainSource, /\.\.\.createAgentActions\(\{ active, navigate \}\)/);
  // The nav affordance rides the same primary/labels/icons trio every family
  // tab uses (the header and the mobile bottom navigation both derive);
  // PORCH-150 appends Agent after Watchlists.
  assert.match(mainSource, /"\/settings", "\/overwatch", "\/people", "\/watchlists", "\/agent"\]/);
  assert.match(mainSource, /"Compose", "Settings", "Overwatch", "People & Things", "Watchlists", "Agent"\]/);
  assert.match(mainSource, /<LabelOutlined \/>, <SmartToyOutlined \/>/);
});

test("wiring ac: the narrowing control rides the agent actions ONLY in home.jsx's FamilyCard (F9)", () => {
  // The organizer renders the control with exactly the three narrowing
  // actions — the enforcement stays in the agent module's assignment path.
  assert.match(homeSource, /loadMySelectableProfiles: actions\.loadMySelectableProfiles/);
  assert.match(homeSource, /loadNarrowing: actions\.loadNarrowing/);
  assert.match(homeSource, /setNarrowing: actions\.setNarrowing/);
  // No parental profile control exists anywhere else: the Agent tab's source
  // never renders a narrowing editor of its own — the organizer's FamilyCard
  // is the ONE surface of record (PRD 2's F9 resolution).
  assert.doesNotMatch(agentSource, /setNarrowing|permitted-profiles|NarrowingDialog/);
});

test("wiring ac: the wire file carries the full contract of routes", () => {
  const routes = [
    ["loadMyModel", /"agent\/me\/model"/],
    ["chooseModel", /"agent\/me\/model"/],
    ["loadSelectableProfiles", /"agent\/me\/profiles"/],
    ["loadAdminProfiles", /"agent\/profiles"/],
    ["defineProfile", /"agent\/profiles"/],
    ["setProfileAvailability", /`agent\/profiles\/\$\{enc\(profileId\)\}\/availability`/],
    ["loadAssignments", /`agent\/assignments/],
    ["assignProfile", /"agent\/assignments"/],
    ["revokeAssignment", /`agent\/assignments\/\$\{enc\(assignmentId\)\}`/],
    ["loadNarrowing", /`agent\/families\/\$\{enc\(familyId\)\}\/members\/\$\{enc\(memberId\)\}\/permitted-profiles`/],
    ["setNarrowing", /`agent\/families\/\$\{enc\(familyId\)\}\/members\/\$\{enc\(memberId\)\}\/permitted-profiles`/],
  ];
  for (const [action, needle] of routes) {
    const start = actionsSource.indexOf(`${action}`);
    assert.notEqual(start, -1, `action ${action} exists`);
    const block = actionsSource.slice(start, start + 1000);
    assert.match(block, needle, `${action} rides its contract route`);
  }
  // Plain contract bodies — no signing envelope on the agent plane (the
  // identity session token rides instead).
  assert.match(actionsSource, /JSON\.stringify\(\{ profileId/);
  assert.match(actionsSource, /JSON\.stringify\(\{ profileIds/);
  assert.doesNotMatch(actionsSource, /payload.*signature|signDevicePayload/);
});
