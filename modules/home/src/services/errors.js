/** Plain-language typed error helper — the home domain's one failure shape. Throws; `return fail(...)` never falls through. */
export function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

export default fail;
