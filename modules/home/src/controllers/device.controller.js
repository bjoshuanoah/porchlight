import { delegate } from "./transport.js";

/**
 * Device controller (PORCH-137). Transport-specific translation between
 * HTTP and DeviceService — the command lifecycle endpoints the dashboard
 * rides (loading → confirmed/failed are the service's single code path).
 */
export class DeviceController {
  constructor(devices) {
    this.devices = devices;
  }

  bearer(req) {
    const header = req.headers?.authorization ?? "";
    return header.startsWith("Bearer ") ? header.slice(7) : null;
  }

  register = async (req, res) => {
    const { payload, signature } = req.body ?? {};
    return delegate(res, () => this.devices.register({
      accessToken: this.bearer(req),
      homeId: req.params?.homeId,
      payload,
      signature,
    }));
  };

  update = async (req, res) => {
    const { payload, signature } = req.body ?? {};
    return delegate(res, () => this.devices.update({
      accessToken: this.bearer(req),
      deviceId: req.params?.deviceId,
      payload,
      signature,
    }));
  };

  list = async (req, res) => {
    return delegate(res, () => this.devices.list({ accessToken: this.bearer(req), homeId: req.params?.homeId }));
  };

  get = async (req, res) => {
    return delegate(res, () => this.devices.get({
      accessToken: this.bearer(req),
      homeId: req.params?.homeId,
      deviceId: req.params?.deviceId,
    }));
  };

  /** POST /devices/:deviceId/command — confirmed on read-back, failed with the device attached. */
  command = async (req, res) => {
    const { payload, signature } = req.body ?? {};
    return delegate(res, () => this.devices.command({
      accessToken: this.bearer(req),
      homeId: req.params?.homeId,
      deviceId: req.params?.deviceId,
      payload,
      signature,
    }));
  };

  /** GET /devices/:deviceId/state — hub-side read-back refresh. */
  readState = async (req, res) => {
    return delegate(res, () => this.devices.readState({
      accessToken: this.bearer(req),
      homeId: req.params?.homeId,
      deviceId: req.params?.deviceId,
    }));
  };
}

export default DeviceController;
