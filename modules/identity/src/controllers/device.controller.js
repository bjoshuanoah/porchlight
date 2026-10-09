
import { requireSessionOr401 } from "../util/session-guard.js";

/**
 * Device-continuity controller: transport only. Device registrations
 * (per identity, keys transported as public halves only), self-serve pairing
 * codes, owner-routed device links, registration revocation. Every rule
 * lives in DeviceService.
 */
export class DeviceController {
  /**
   * @param {import("deviceService").DeviceService} deviceService
   * @param {import("authService").AuthService} authService
   * @param {((line: string) => void) | null} [log] - auth-failure capture sink (PORCH-019).
   */
  constructor(deviceService, authService, log = null) {
    this.deviceService = deviceService;
    this.authService = authService;
    this.log = log;
  }

  async requireSession(req, res) {
    return requireSessionOr401({ req, res, authService: this.authService, log: this.log });
  }

  /** GET /devices?did= — registrations for an identity, revoked rows included. */
  listRegistrations = async (req, res) => {
    const identity = await this.requireSession(req, res);
    if (!identity) return;
    const did = req.query.did ?? identity.did;
    if (did !== identity.did) {
      // Owner-wide view lands with the perimeter work (PORCH-005); the
      // identity core only exposes an identity's own registrations.
      return res.status(403).json({ error: "registrations are visible to their own identity", code: "E_FORBIDDEN" });
    }
    try {
      res.json({ did, registrations: await this.deviceService.listRegistrations({ did }) });
    } catch (error) {
      res.status(500).json({ error: error.message, code: error.code ?? "E_INTERNAL" });
    }
  };

  /** POST /pairing-code {did} — self-serve add-device from a working device (ac-12). */
  mintPairingCode = async (req, res) => {
    const identity = await this.requireSession(req, res);
    if (!identity) return;
    const { did } = req.body ?? {};
    if (!did) return res.status(400).json({ error: "did required", code: "E_FIELDS_REQUIRED" });
    if (did !== identity.did) return res.status(403).json({ error: "pairing codes are minted by the member", code: "E_FORBIDDEN" });
    try {
      const result = await this.deviceService.mintPairingCode({ did });
      res.status(201).json(result);
    } catch (error) {
      if (error.code === "E_IDENTITY_NOT_FOUND") return res.status(404).json({ error: error.message, code: error.code });
      res.status(500).json({ error: error.message, code: error.code ?? "E_INTERNAL" });
    }
  };

  /** POST /pair {code, device{deviceId, label, publicKeyJwk}} — new device binds its own key (ac-12). */
  consumePairingCode = async (req, res) => {
    const { code, device } = req.body ?? {};
    const deviceError = this.devicePayloadError(device);
    if (!code || deviceError) return res.status(400).json({ error: deviceError ?? "code required", code: "E_FIELDS_REQUIRED" });
    try {
      const registration = await this.deviceService.consumePairingCode({ code, ...devicePayload(device) });
      res.status(201).json({ registration });
    } catch (error) {
      const statusByCode = {
        E_PAIRING_CODE_UNKNOWN: 404,
        E_PAIRING_CODE_EXPIRED: 410,
        E_PAIRING_CODE_CONSUMED: 409,
      };
      this.registrationError(error, res, statusByCode);
    }
  };

  /** POST /device-link {did} — owner-routed continuity link (ac-11). */
  mintDeviceLink = async (req, res) => {
    const identity = await this.requireSession(req, res);
    if (!identity) return;
    const { did } = req.body ?? {};
    if (!did) return res.status(400).json({ error: "did required", code: "E_FIELDS_REQUIRED" });
    if (did !== identity.did) return res.status(403).json({ error: "device links are minted for the member", code: "E_FORBIDDEN" });
    try {
      const result = await this.deviceService.mintDeviceLink({ did });
      res.status(201).json(result);
    } catch (error) {
      if (error.code === "E_IDENTITY_NOT_FOUND") return res.status(404).json({ error: error.message, code: error.code });
      res.status(500).json({ error: error.message, code: error.code ?? "E_INTERNAL" });
    }
  };

  /** POST /device-link/consume {token, device} — new device binds to the existing DID (ac-11). */
  consumeDeviceLink = async (req, res) => {
    const { token, device } = req.body ?? {};
    const deviceError = this.devicePayloadError(device);
    if (!token || deviceError) return res.status(400).json({ error: deviceError ?? "token required", code: "E_FIELDS_REQUIRED" });
    try {
      const registration = await this.deviceService.consumeDeviceLink({ token, ...devicePayload(device) });
      res.status(201).json({ registration });
    } catch (error) {
      const statusByCode = {
        E_DEVICE_LINK_UNKNOWN: 404,
        E_DEVICE_LINK_EXPIRED: 410,
        E_DEVICE_LINK_CONSUMED: 409,
        E_DEVICE_LINK_REVOKED: 403,
      };
      this.registrationError(error, res, statusByCode);
    }
  };

  /** POST /devices/revoke {registrationId} — retire a key registration (visible, revocable). */
  revokeRegistration = async (req, res) => {
    const identity = await this.requireSession(req, res);
    if (!identity) return;
    const { registrationId } = req.body ?? {};
    if (!registrationId) return res.status(400).json({ error: "registrationId required", code: "E_FIELDS_REQUIRED" });
    try {
      const registration = await this.deviceService.getRegistration({ registrationId });
      if (!registration) return res.status(404).json({ error: "no such registration", code: "E_REGISTRATION_UNKNOWN" });
      if (registration.did !== identity.did) {
        return res.status(403).json({ error: "registrations are revoked by their own identity", code: "E_FORBIDDEN" });
      }
      res.json(await this.deviceService.revokeRegistration({ registrationId }));
    } catch (error) {
      res.status(500).json({ error: error.message, code: error.code ?? "E_INTERNAL" });
    }
  };

  devicePayloadError(device) {
    if (!device?.deviceId || !device?.publicKeyJwk) return "device.deviceId and device.publicKeyJwk required";
    if (device.publicKeyJwk.d) return "private key material is never accepted (keys stay on the device)";
    return null;
  }

  registrationError(error, res, statusByCode) {
    res.status(statusByCode[error.code] ?? 500).json({ error: error.message, code: error.code ?? "E_INTERNAL" });
  }
}

function devicePayload(device) {
  return { deviceId: device.deviceId, label: device.label ?? null, publicKeyJwk: device.publicKeyJwk };
}

export default DeviceController;