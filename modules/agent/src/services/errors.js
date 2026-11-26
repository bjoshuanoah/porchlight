/**
 * The agent domain's one failure shape (the module-local fail helper, the
 * home module's pattern): typed code + plain language. `fail` throws —
 * `return fail(...)` never falls through. The typed codes map onto HTTP in
 * the controllers' transport layer.
 */
export function fail(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  throw error;
}

/**
 * The non-throwing constructor for typed error objects that a caller hands
 * BACK deliberately (the profile router's degradation path returns the
 * typed verdict so the caller records it before rethrowing).
 */
export function typed(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}
