// helpers/silent-helper.mjs — a helper that never responds: times out the
// provider's per-frame deadline in tests.

import process from "node:process";

process.stdin.on("data", () => {});
process.stdin.resume();
