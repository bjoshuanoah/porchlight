// Switch-identity regression (PORCH-075): the WhoIsHere switch-user action
// must not reference state setters the component never declares. The consumer
// bug this pins: PORCH-072 retired the ranked feed and removed the
// `const [ranked, setRanked] = useState([])` declaration, but four closures
// kept calling `setRanked([])` — so every switch-user openDeviceSession +
// restore that returned its documented success classes (200/201) still threw
// `ReferenceError: setRanked is not defined` between setIdentity and the
// navigate, and useOperation dressed the client-side crash as hub-failure
// copy ("The hub could not complete this action. Check with your family
// owner if it continues.") on a healthy route sequence. Orphaned setters in
// connect, finishJoin, switchIdentity, and signOut all fail the same way.
// The test reads the component's source and walks its real binding surface:
// every `set[A-Z]\…` identifier referenced in code must be a declared
// binding — useState-style array destructuring, object destructuring, a
// function declaration, or an arrow-function binding. Property access
// (`operation.setError`) is not a free reference; comments are stripped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const mainSource = await readFile(join(here, "..", "src", "main.jsx"), "utf8");

// Comments and strings never bind or reference anything; strip both so prose
// (e.g. a note that names the removed setter) cannot count.
function asCode(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
    .replace(/(`(?:[^`\\]|\\.)*`)/g, " ")
    .replace(/("(?:[^"\\]|\\.)*")/g, " ")
    .replace(/('(?:[^'\\]|\\.)*')/g, " ");
}

function collect(codes, pattern) {
  const found = new Set();
  for (const code of codes) for (const match of code.matchAll(pattern)) found.add(match[1]);
  return found;
}

test("PORCH-075: main.jsx references no undeclared state setters", () => {
  const code = asCode(mainSource);

  // Declared bindings: array destructuring after const/let/var, any
  // destructuring group bound by `=`, a declared `const setX =`, and
  // `function setX(`.
  const declared = collect(
    [
      ...[...code.matchAll(/\b(?:const|let|var)\s*\[([^\][]*)\]\s*=/g)].map((m) => m[1]),
      ...[...code.matchAll(/[[{]\s*([^\]{}]{0,300}?)\s*[}\]]\s*=\s*(?!=>)/g)].map((m) => m[1]),
    ],
    /\b(set[A-Z]\w*)\b/g,
  );
  collect([code], /\bconst\s+(set[A-Z]\w*)\b/g).forEach((s) => declared.add(s));
  collect([code], /\bfunction\s+(set[A-Z]\w*)\b/g).forEach((s) => declared.add(s));
  // Imported members (e.g. `import { setUnauthorizedHandler } from "./api.js"`)
  // are module-scope bindings too.
  collect(
    [...code.matchAll(/\bimport\s*\{([^}]*)\}\s*from/g)].map((m) => m[1]),
    /\b(set[A-Z]\w*)\b/g,
  ).forEach((s) => declared.add(s));

  // Free references: a setter identifier not preceded by `.` (property
  // access) or `props`-style qualification, excluding declaration sites.
  // Timer globals (`setTimeout`, `setInterval`, `setImmediate`) share the
  // naming shape but are host built-ins, never component state.
  const referenced = collect([code], /(?<![.\w])(set[A-Z]\w*)\b(?!\s*:)/g);
  for (const timer of ["setTimeout", "setInterval", "setImmediate"]) referenced.delete(timer);

  const orphans = [...referenced].filter((name) => !declared.has(name)).sort();
  assert.deepEqual(orphans, [],
    "main.jsx calls state setters the component never declares — the call throws ReferenceError at runtime and memberError renders it as false hub-failure copy on the switch-user, join, and sign-out flows (PORCH-075)");
});

test("PORCH-075: no ranked-feed remnants in the timeline-turn actions", () => {
  const code = asCode(mainSource);
  // The ranked feed was retired wholesale (PORCH-072); any surviving ranked
  // identifier in main.jsx is by definition an orphaned reference.
  assert.doesNotMatch(code, /\bsetRanked\b/, "ranked-feed setter must not be referenced anywhere in main.jsx");
  assert.doesNotMatch(code, /\[`?ranked`?\]/, "ranked-feed state slot must not be declared anywhere in main.jsx");
});