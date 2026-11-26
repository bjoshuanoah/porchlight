/**
 * Shared transport error mapping for the agent module's controllers (the
 * ONE member-facing failure vocabulary: typed code → HTTP status + the
 * plain-language message, never an internal message leak).
 */
const STATUS_BY_CODE = {
  E_MUST_SIGN_IN: 401,
  E_NOT_PERMITTED: 403,
  E_PROFILE_NOT_FOUND: 404,
  E_PROFILE_UNAVAILABLE: 403,
  E_PROFILE_UNASSIGNED: 503,
  E_PARENTAL_BLOCKED: 403,
  E_PROVIDER_DEGRADED: 503,
  E_PROVIDER_UNCONFIGURED: 503,
  E_ASSIGNMENT_NOT_FOUND: 404,
  E_ASSIGNMENT_TARGET_INVALID: 400,
  E_FAMILY_NOT_FOUND: 404,
  E_FAMILY_MEMBER_UNKNOWN: 404,
  E_NAME_REQUIRED: 400,
  E_PROVIDER_CLASS_INVALID: 400,
  E_MODEL_REQUIRED: 400,
  E_VALIDATION: 400,
};

export function memberError(res, error) {
  const status = STATUS_BY_CODE[error?.code];
  if (status) {
    return res.status(status).json({ error: error.message, code: error.code });
  }
  return res.status(500).json({ error: "The agent surface hit an unexpected error." });
}

export function delegate(res, run) {
  return run()
    .then((result) => res.json(result))
    .catch((error) => memberError(res, error));
}
