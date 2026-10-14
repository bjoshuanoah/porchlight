// Avatar faces (PORCH-070): the committed rung URL contract, the pending
// preview URL, the own-account face resolution (metas → legacy data URL →
// initials), the blob-loader cache contract (one load per content identity,
// repeat renders answer from memory), and the wiring pins that hold every
// surface to the one avatar-face code path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  avatarUrl,
  pendingAvatarUrl,
  ownFaceSources,
  loadAvatarFace,
} from "../src/avatar-face.js";
import {
  mediaBlobKey,
  readMediaBlob,
  clearMediaBlobs,
  mediaBlobCount,
} from "../src/media-blob.js";
import { directoryRows } from "../src/member-directory.js";
import { sha256Hex } from "../src/device-crypto.js";

const webRoot = fileURLToPath(new URL("../", import.meta.url));
const src = async (file) => await readFile(join(webRoot, file), "utf8");

const ORIGIN = "https://hub.family";
const DID = "did:example:member-1";

const METAS = {
  header: { kind: "header", width: 72, height: 72, contentType: "image/webp", sha256: "a".repeat(64) },
  chooser: { kind: "chooser", width: 144, height: 144, contentType: "image/webp", sha256: "b".repeat(64) },
};

test("PORCH-070: the committed rung URL is content-addressed and encodes the member", () => {
  const header = avatarUrl(ORIGIN, DID, METAS, "header");
  assert.match(header, new RegExp(`^${ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/api/identity/avatars/${encodeURIComponent(DID)}/renditions/header\\?v=${"a".repeat(64)}$`));
  // The chooser rung carries its own content address — never the header's.
  const chooser = avatarUrl(ORIGIN, DID, METAS, "chooser");
  assert.ok(chooser.includes(`/renditions/chooser?v=${"b".repeat(64)}`), `chooser rung URL: ${chooser}`);
  // A did with characters that must not ride the URL raw.
  const odd = avatarUrl(ORIGIN, "did:weird:id#x", METAS, "header");
  assert.ok(odd.includes("/avatars/did%3Aweird%3Aid%23x/"), `odd did stays encoded: ${odd}`);
});

test("PORCH-070: metas without the kind's rung render no URL — initials stay", () => {
  assert.equal(avatarUrl(ORIGIN, DID, null, "header"), null);
  assert.equal(avatarUrl(ORIGIN, DID, {}, "header"), null);
  assert.equal(avatarUrl(ORIGIN, DID, { header: { kind: "header" } }, "header"), null);
  assert.equal(avatarUrl("", DID, METAS, "header"), null);
  assert.equal(avatarUrl(ORIGIN, "", METAS, "header"), null);
  assert.equal(avatarUrl(ORIGIN, DID, METAS[0], "header"), null);
});

test("PORCH-070: the pending preview URL adds the pending token to the chooser rung", () => {
  const url = pendingAvatarUrl(ORIGIN, DID, METAS, "pending-token-1");
  assert.ok(url.startsWith(`${ORIGIN}/api/identity/avatars/${encodeURIComponent(DID)}/renditions/chooser?`), `pending base: ${url}`);
  assert.ok(url.includes(`v=${"b".repeat(64)}`), `pending version: ${url}`);
  assert.ok(url.includes("&pending=pending-token-1"), `pending token: ${url}`);
  assert.equal(pendingAvatarUrl(ORIGIN, DID, null, "t"), null);
  assert.equal(pendingAvatarUrl(ORIGIN, DID, METAS, ""), null);
  // A pending rungs array (the ingest response shape) resolves the chooser rung.
  const fromArray = pendingAvatarUrl(ORIGIN, DID, [...Object.values(METAS)], "t2");
  assert.ok(fromArray.includes("/renditions/chooser?"), `array rungs: ${fromArray}`);
});

test("PORCH-070: the own-account face prefers hub metas, then the legacy data URL, then initials", () => {
  const metas = ownFaceSources({ did: DID, avatar: METAS, profile: { avatar: "data:image/png;base64,legacy" } });
  assert.equal(metas.kind, "metas");
  assert.equal(metas.did, DID);
  assert.equal(metas.metas, METAS);
  assert.equal(metas.legacy, null);

  const legacy = ownFaceSources({ did: DID, avatar: null, profile: { avatar: "data:image/png;base64,legacy" } });
  assert.equal(legacy.kind, "legacy");
  assert.equal(legacy.legacy, "data:image/png;base64,legacy");
  assert.equal(legacy.metas, null);

  const initials = ownFaceSources({ did: DID, avatar: null, profile: {} });
  assert.equal(initials.kind, "initials");
  assert.equal(initials.metas, null);
  assert.equal(initials.legacy, null);
  assert.equal(ownFaceSources(null).kind, "initials");
  // A shape lacking rungs never becomes a bogus fetch.
  assert.equal(ownFaceSources({ did: DID, avatar: {} }).kind, "initials");
});

test("PORCH-070: the avatar-face loader answers one identity from one load — cache-first", async () => {
  clearMediaBlobs();
  const blob = new Blob(["avatar-bytes-1"], { type: "image/webp" });
  let loads = 0;
  const load = async () => {
    loads += 1;
    return blob;
  };
  // A metas-less view loads nothing and renders no URL.
  assert.equal(await loadAvatarFace({ origin: ORIGIN, did: DID, metas: null, kind: "chooser", load }), null);
  assert.equal(loads, 0);
  const first = await loadAvatarFace({ origin: ORIGIN, did: DID, metas: METAS, kind: "chooser", load });
  assert.equal(loads, 1);
  assert.ok(first.url.startsWith("blob:"), `first row object URL: ${first.url}`);
  assert.ok(first.blob instanceof Blob);
  // The same face (same origin+did+kind+sha) answers from the blob cache:
  // no second network read, the SAME object URL — no face remount.
  const second = await loadAvatarFace({ origin: ORIGIN, did: DID, metas: METAS, kind: "chooser", load });
  assert.equal(loads, 1);
  assert.equal(second.url, first.url);
  // The blob cache entry is the identity the media map serves (mediaId avatar:<did>).
  const identity = mediaBlobKey({ origin: ORIGIN, mediaId: `avatar:${DID}`, kind: "chooser", version: METAS.chooser.sha256 });
  assert.equal(readMediaBlob(identity)?.url, first.url);
  // A different kind (or a new sha) is its own identity: header fetches once for itself.
  const header = await loadAvatarFace({ origin: ORIGIN, did: DID, metas: METAS, kind: "header", load });
  assert.equal(loads, 2);
  assert.ok(header.url.startsWith("blob:"));
  // Without a load function (the action is not wired) the loader stays null, never throws.
  assert.equal(await loadAvatarFace({ origin: ORIGIN, did: "did:example:x2", kind: "header", metas: METAS, load: undefined }), null);
  // A non-Blob answer (the action mapped a hub refusal) stays null, initials carry.
  assert.equal(await loadAvatarFace({ origin: ORIGIN, did: "did:example:x3", kind: "header", metas: METAS, load: async () => ({ no: "bytes" }) }), null);
  assert.equal(mediaBlobCount() >= 2, true);
  clearMediaBlobs();
});

test("PORCH-070: the ingest computes the file's sha256 hex (subtle here, hex64 shape)", async () => {
  const hex = await sha256Hex(new TextEncoder().encode("porchlight-avatar"));
  assert.match(hex, /^[0-9a-f]{64}$/);
  const empty = await sha256Hex(new Uint8Array(0));
  assert.equal(empty, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

test("PORCH-070: the directory rows keep the member's did and avatar rung verbatim", () => {
  const rows = directoryRows([
    { _id: "m1", name: "Ada", role: "owner", did: DID, avatar: METAS, state: "active" },
    { _id: "m2", name: "Grace", role: "member", did: "did:example:g", avatar: null, state: "active" },
  ], "did:example:me");
  const ada = rows.find((row) => row.name === "Ada");
  const grace = rows.find((row) => row.name === "Grace");
  assert.deepEqual(ada.avatar, METAS, "the avatar rung map passes through untouched");
  assert.equal(ada.did, DID);
  assert.equal(grace.avatar, null);
  assert.equal(grace.did, "did:example:g");
});

test("PORCH-070: the profile photo block is wired into the identity card", async () => {
  const identity = await src("src/identity.jsx");
  // The photo block rides the first card and owns its own states.
  assert.match(identity, /function AvatarPanel/);
  assert.match(identity, /<AvatarPanel account=\{data\?\.identityAccount/);
  assert.match(identity, /name=\{named\(identity\)\}/);
  // Hidden file input, image types only — the member never crops.
  assert.match(identity, /type="file"/);
  assert.match(identity, /accept="image\/\*"/);
  assert.match(identity, /hidden\s+onChange=/);
  // Buttons carry a 48px tap area and the contract's labels.
  assert.match(identity, /\{hasFace \? 'Change photo' : 'Add photo'\}/);
  assert.match(identity, /Remove photo<\/Button>/);
  assert.match(identity, /const control = \{ minHeight: 48 \}/);
  // The confirm affordance and the retake affordance exist verbatim.
  assert.match(identity, />Use this photo<\/Button>/);
  assert.match(identity, />Try another<\/Button>/);
  assert.match(identity, />Cancel<\/Button>/);
  // The commit lands the family-facing promise copy.
  assert.match(identity, /Your photo is updated — it shows everywhere the family sees you\./);
  // A typed refusal renders the hub's own copy, not a generic stand-in:
  // the panel shows cause.message verbatim.
  assert.match(identity, /\(cause\?\.message \|\| 'The hub could not complete this action\. No change was made\.'\)/);
  // The pending preview never enters the blob cache: it is fetched through
  // the pendingToken action, then object-URLed once by the panel itself.
  assert.match(identity, /loadAvatarRendition\(\{ did: face\.did, kind: 'chooser', version: rung\.sha256, pendingToken: result\.pending\.token \}\)/);
});

test("PORCH-070: the chooser and the directory render faces through the one code path", async () => {
  const identity = await src("src/identity.jsx");
  // The chooser reads each face with that connection's own identity token.
  assert.match(identity, /faceSignature = faces\.map/);
  assert.match(identity, /actions\.readAccount\(face\)/);
  assert.match(identity, /kind="chooser"/);
  assert.match(identity, /loadAvatarRendition\(\{ \.\.\.args, connection: item \}\)/);
  // The Members directory row rides its header rung.
  assert.match(identity, /metas=\{person\.avatar\} kind="header"/);
  const social = await src("src/social.jsx");
  assert.match(social, /from '\.\/avatar-face\.js'/);
  // Post header + reply rows: the author's face, metas-beside-authorName.
  assert.match(social, /metas=\{post\.authorAvatar \?\? null\} load=\{actions\?\.loadAvatarRendition\}/);
  assert.match(social, /metas=\{reply\.authorAvatar \?\? null\} load=\{actions\?\.loadAvatarRendition\}/);
});

test("PORCH-070: the session-bound actions wire the identity plane", async () => {
  const main = await src("src/main.jsx");
  // Own-account read and the face state.
  assert.match(main, /readAccount: async \(connection = active\)/);
  assert.match(main, /"identity\/accounts\/me"/);
  assert.match(main, /const \[identityAccount, setIdentityAccount\] = useState\(null\)/);
  assert.match(main, /identityAccount,/);
  // Ingest: raw bytes, the file's own MIME, the declaration header, the
  // device signature, and the identity bearer token.
  assert.match(main, /async \(file\) => \{/);
  assert.match(main, /"x-porchlight-avatar-payload"/);
  assert.match(main, /"x-porchlight-signature"/);
  assert.match(main, /scope: "identity-avatar", action: "ingest"/);
  assert.match(main, /sha256Hex\(bytes\)/);
  // Commit and clear are device-signed JSON writes on the same route; commit
  // repaints the face in state so the Profile shows it without re-login.
  assert.match(main, /scope: "identity-avatar", action: "commit", token \}/);
  assert.match(main, /scope: "identity-avatar", action: "clear" \}/);
  assert.match(main, /setIdentityAccount\(\(current\) => \(\{ \.\.\.\(current \?\? \{\}\), \.\.\.result \}\)\)/);
  // Rendition bytes ride the connection's identity token; pending previews
  // are authorized once with no-store, committed rungs ride the content address.
  assert.match(main, /authorization: `Bearer/);
  assert.match(main, /cache: pendingToken \? "no-store" : "default"/);
  assert.match(main, /target\.searchParams\.set\("pending", pendingToken\)/);
  // The account read effect keys on the active identity's credential.
  assert.match(main, /activeIdentityId, active\?\.identityToken\]/);
});

test("PORCH-070: the rendition worker needs no avatar change — no bare rung img src anywhere", async () => {
  // Faces never render a bare identity-plane rung URL (the loader owns the
  // bytes), so the auth-relaying worker intercept as-built covers both plan.
  const sw = await src("public/sw.js");
  assert.match(sw, /pathname\.includes\("\/renditions\/"\)/);
  const social = await src("src/social.jsx");
  assert.doesNotMatch(social, /src=\{avatarUrl\(/);
  assert.doesNotMatch(social, /\/api\/identity\/avatars/);
  const identity = await src("src/identity.jsx");
  assert.doesNotMatch(identity, /\/api\/identity\/avatars/);
  const avatarFace = await src("src/avatar-face.js");
  assert.match(avatarFace, /\/api\/identity\/avatars/);
  // Loader + cache only via avatar-face.js — one code path for every face.
  assert.match(social, /AvatarFace/);
});