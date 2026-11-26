/**
 * Shared transport error mapping for the home module's controllers (the
 * ONE member-facing failure vocabulary: typed code → status + plain
 * language, never an internal message leak).
 */
const STATUS_BY_CODE = {
  E_MUST_SIGN_IN: 401,
  E_SIGNATURE_REQUIRED: 401,
  E_SIGNATURE_INVALID: 403,
  E_NOT_PERMITTED: 403,
  E_HOME_NOT_FOUND: 404,
  E_AREA_NOT_FOUND: 404,
  E_DEVICE_NOT_FOUND: 404,
  E_SCENE_NOT_FOUND: 404,
  E_AUTOMATION_NOT_FOUND: 404,
  E_GRANT_NOT_FOUND: 404,
  E_GRANT_ALREADY_REVOKED: 409,
  E_GRANTEE_UNKNOWN: 404,
  E_FAMILY_NOT_FOUND: 404,
  E_FAMILY_MEMBER_UNKNOWN: 404,
  E_ENVELOPE_EXCEEDED: 403,
  E_NAME_REQUIRED: 400,
  E_NAME_TOO_LONG: 400,
  E_VALIDATION: 400,
  E_COMMAND_UNKNOWN: 400,
  E_DEVICE_UNREACHABLE: 502,
  E_NO_ADAPTER: 409,
  E_ADAPTER_INVALID: 400,
  E_AUDIT_REQUIRED: 400,
};

/** Map one typed domain error onto its member-facing HTTP answer. */
export function memberError(res, error) {
  const status = STATUS_BY_CODE[error?.code];
  if (status) {
    return res.status(status).json({
      error: error.message,
      code: error.code,
      ...(error.device ? { device: error.device } : {}),
    });
  }
  return res.status(500).json({ error: "The home surface hit an unexpected error." });
}

/** Controller delegation: run the service, answer JSON or the error map. */
export function delegate(res, run) {
  return run()
    .then((result) => res.json(result))
    .catch((error) => memberError(res, error));
}
