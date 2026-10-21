// Media slot fetch contract (PORCH-116, Brian Oct 21, 2026): the slot
// state machine (pending → loaded | failed-retryable | failed-terminal),
// the response-class boundary (404/410 terminal, everything else the
// retryable-transient class), the bounded backoff retries, and the
// re-arm funnels (visibility entry, hub recovery). The pure helpers are
// pinned as a contract module; the slot surfaces (MediaItem, viewer
// slide, transport) are pinned as source contracts (house style:
// photo-first/media-carousel pins).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  mediaFailureClass,
  mediaRetryDelayMs,
  MEDIA_RETRY_BUDGET,
  MEDIA_RETRY_BACKOFF_MS,
  MEDIA_ATTEMPT_TIMEOUT_MS,
} from "../src/media-slot.js";
import {
  signalMediaRecovery,
  onMediaRecovery,
  mediaRecoveryListenerCount,
  clearMediaRecoveryListeners,
} from "../src/media-recovery.js";

const webRoot = fileURLToPath(new URL("../", import.meta.url));
const social = await readFile(join(webRoot, "src/social.jsx"), "utf8");
const viewer = await readFile(join(webRoot, "src/photo-viewer.jsx"), "utf8");
const main = await readFile(join(webRoot, "src/main.jsx"), "utf8");

test("PORCH-116 ac-3: 404/410 is the terminal class; every other answer is retryable-transient", () => {
  assert.equal(mediaFailureClass(404), "failed-terminal");
  assert.equal(mediaFailureClass(410), "failed-terminal");
  // The retryable-transient class: network/timeout answers carry no status
  // (0 or undefined), the restart-window pause answers 503, the unexpected
  // 5xx answers 500, the boot-window credential race answers 401.
  for (const status of [0, undefined, 401, 403, 429, 500, 502, 503, 507, 200]) {
    assert.equal(mediaFailureClass(status), "failed-retryable", `status ${String(status)} classifies retryable`);
  }
});

test("PORCH-116 ac-3: the retries are bounded with a small backoff", () => {
  assert.equal(MEDIA_RETRY_BUDGET, 2);
  assert.equal(mediaRetryDelayMs(1), MEDIA_RETRY_BACKOFF_MS); // 1200ms
  assert.equal(mediaRetryDelayMs(2), MEDIA_RETRY_BACKOFF_MS * 2); // 2400ms
  // The helper clamps: a mis-argued call can never schedule a runaway wait.
  assert.equal(mediaRetryDelayMs(0), MEDIA_RETRY_BACKOFF_MS);
  assert.equal(mediaRetryDelayMs(9), MEDIA_RETRY_BACKOFF_MS * 2);
  // The attempt guard the stalled attempt resolves through is bounded too.
  assert.equal(typeof MEDIA_ATTEMPT_TIMEOUT_MS, "number");
  assert.ok(MEDIA_ATTEMPT_TIMEOUT_MS > 5_000);
});

test("PORCH-116 ac-5: the live transport's reconnect fact hands the recovery signal to the slots", () => {
  clearMediaRecoveryListeners();
  let fired = 0;
  const un = onMediaRecovery(() => { fired += 1; });
  assert.equal(mediaRecoveryListenerCount(), 1);
  signalMediaRecovery();
  signalMediaRecovery();
  assert.equal(fired, 2);
  un();
  signalMediaRecovery();
  assert.equal(fired, 2);
  assert.equal(mediaRecoveryListenerCount(), 0);
});

test("PORCH-116 ac-1: the slot machine lives on the slot, never on a page-load cycle", () => {
  // MediaItem owns the state machine; the failed phases are slot states.
  const item = social.slice(social.indexOf("function MediaItem"), social.indexOf("function mediaShape"));
  assert.match(item, /const \[phase, setPhase\] = useState\('pending'\)/);
  assert.match(item, /setPhase\('loaded'\)/);
  assert.match(item, /setPhase\('failed-retryable'\)/);
  assert.match(item, /setPhase\('failed-terminal'\)/);
  // The fetch attempt the machine re-issues is slot-owned (the keyed
  // remount), and the loader's contract deps carry the attempt.
  assert.match(item, /img-\$\{attempt\}/);
  assert.match(item, /vid-\$\{attempt\}/);
  assert.match(item, /\[id, getMedia, origin, direct, attempt, slotFailed\]/);
});

test("PORCH-116 ac-1/ac-2: visibility re-arms every entry funnel and cancels on exit/unmount", () => {
  const item = social.slice(social.indexOf("function MediaItem"), social.indexOf("function mediaShape"));
  // The observer rides the slot's own frame.
  assert.match(item, /new IntersectionObserver\(/);
  assert.match(item, /observe\(node\)/);
  // One entry funnel: the first entry, the return after scrolling past,
  // the remount's first observation, and the post-failure re-entry all go
  // through the same re-arm (failed-retryable → reset budget → refire).
  assert.match(item, /phaseRef\.current !== 'failed-retryable' \|\| retryTimerRef\.current\) return/);
  assert.match(item, /retriesRef\.current = MEDIA_RETRY_BUDGET/);
  assert.match(item, /setAttempt\(\(n\) => n \+ 1\)/);
  // Scrolling out cancels the scheduled attempt; unmount cancels the
  // slot's timers and disconnects the observer; the remount re-arms.
  assert.match(item, /if \(!entry\.isIntersecting\) \{/);
  assert.match(item, /return \(\) => \{ clearSlotTimers\(\); observer\.disconnect\(\); \};/);
});

test("PORCH-116 ac-5: the restart-window recovery re-arms the visible failed-retryable slots", () => {
  const item = social.slice(social.indexOf("function MediaItem"), social.indexOf("function mediaShape"));
  assert.match(item, /onMediaRecovery\(\(\) => \{/);
  assert.match(item, /phaseRef\.current !== 'failed-retryable' \|\| !visibleRef\.current\) return/);
  // main.jsx hands the transport's outage-to-connected transition over.
  assert.match(main, /signalMediaRecovery/);
  assert.match(main, /if \(connected && was === false\) signalMediaRecovery\(\)/);
});

test("PORCH-116 ac-3: the absence copy renders on the terminal class only, never on a retryable path", () => {
  const item = social.slice(social.indexOf("function MediaItem"), social.indexOf("function mediaShape"));
  // The old page-level error Alert is gone; the slot phases replaced it.
  assert.ok(!item.includes("setLoadError"));
  assert.ok(!item.includes("retriedRef"));
  assert.doesNotMatch(item, /loadError/);
  // Photo/video absence rides the terminal gate.
  assert.match(item, /phase === 'failed-terminal' && \(post\.type === 'photo' \|\| post\.type === 'video'\)/);
  // Audio absence rides the terminal gate too — the string renders nowhere
  // without a `failed-terminal` condition in its branch.
  assert.match(item, /post\.type === 'audio' && phase === 'failed-terminal'/);
  // The retryable states hold the quiet placeholder: the wash box renders
  // for every non-terminal state (pending AND failed-retryable), and the
  // spinner only ever renders while pending without a reserved frame.
  assert.match(item, /phase !== 'failed-terminal' && \(reserved\)/);
  assert.match(item, /phase === 'pending' && !reserved && <CircularProgress/);
  // No spinner or error chrome renders on a retryable slot: the Alert that
  // remains is the member-action failure surface (download/share), not the
  // fetch machine's.
  assert.doesNotMatch(item, /loadError/);
});

test("PORCH-116 ac-3: the transport attaches the response class status for the machine", () => {
  assert.match(main, /failure\.status = response\.status/);
  // Rendition attempts are bounded; the explicit original action is not
  // (big downloads ride slow tunnels).
  assert.match(main, /kind !== "original"[\s\S]*AbortSignal\.timeout\(30000\)/);
});

test("PORCH-116 ac-3: the direct slot classifies by reading the content address, not a status it cannot see", () => {
  const item = social.slice(social.indexOf("function MediaItem"), social.indexOf("function mediaShape"));
  assert.match(item, /const classifyDirectFailure = \(url\) => \{/);
  assert.match(item, /slotFailed\(probe\.status, at\)/);
  assert.match(item, /slotFailed\(0, at\)/);
  // Superseded classifications never touch the slot: the machine is
  // idempotent per attempt and ignores answers from replaced attempts.
  assert.match(item, /if \(at != null && at !== atNow\) return/);
  assert.match(item, /if \(failedAttemptRef\.current === atNow\) return/);
});

test("PORCH-116 ac-4: the failure states hold the reserved frame — the absence ride never reflows", () => {
  const item = social.slice(social.indexOf("function MediaItem"), social.indexOf("function mediaShape"));
  // Terminal copy renders INSIDE the reserved geometry (mediaSx + fitSx),
  // so the slot's layout box is identical across pending, failed, loaded.
  const terminalFrame = item.slice(item.indexOf("phase === 'failed-terminal' && (post.type === 'photo'"), item.indexOf("Loading media\""));
  assert.match(terminalFrame, /\.\.\.mediaSx, \.\.\.fitSx/);
  // The swap stays in-place: the loader's setResource phase change swaps
  // bytes without remounting the card (the elements render by props, the
  // keys only change across re-issued attempts on failed slots).
  assert.doesNotMatch(item, /key=\{`card/);
});

test("PORCH-116: the viewer slide rides the same slot machine", () => {
  const slide = viewer.slice(viewer.indexOf("function ViewerSlidePhoto"), viewer.indexOf("function PluralImages"));
  assert.match(slide, /const \[phase, setPhase\] = useState\('pending'\)/);
  assert.match(slide, /setPhase\('failed-terminal'\)/);
  assert.match(slide, /mediaFailureClass\(error\?\.status\)/);
  assert.match(slide, /mediaRetryDelayMs\(MEDIA_RETRY_BUDGET - retriesRef\.current\)/);
  // The direct slide re-issues through the keyed remount and classifies
  // by reading the same content-addressed URL.
  assert.match(slide, /key=\{`viewer-\$\{attempt\}`\}/);
  assert.match(slide, /Your hub did not return the media\./);
  // The terminal absence never renders on a retryable path.
  assert.match(slide, /if \(phase === 'failed-terminal'\) \{/);
});

test("PORCH-116 ac-2: a virtualized slot's cancelled attempt never double-fires", () => {
  const item = social.slice(social.indexOf("function MediaItem"), social.indexOf("function mediaShape"));
  // The re-arm guards against a stale classification and a double
  // classification within one attempt (probe resolution racing the
  // attempt guard).
  assert.match(item, /if \(!visibleRef\.current \|\| retriesRef\.current <= 0\) return/);
  // Recovery resets the episode before refiring; the visibility entry
  // only refires when no backoff attempt is still scheduled.
  assert.match(item, /clearSlotTimers\(\);\s*\n\s*retriesRef\.current = MEDIA_RETRY_BUDGET/);
  assert.match(item, /phaseRef\.current !== 'failed-retryable' \|\| retryTimerRef\.current\) return/);
});