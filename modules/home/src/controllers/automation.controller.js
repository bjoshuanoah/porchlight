import { delegate } from "./transport.js";

/**
 * Scene + automation controller (PORCH-137). Transport-specific
 * translation between HTTP and SceneService/AutomationService — the
 * everyday automation surfaces and the property audit of fires.
 */
export class AutomationController {
  constructor({ scenes, automations }) {
    this.scenes = scenes;
    this.automations = automations;
  }

  bearer(req) {
    const header = req.headers?.authorization ?? "";
    return header.startsWith("Bearer ") ? header.slice(7) : null;
  }

  createScene = async (req, res) => {
    const { payload, signature } = req.body ?? {};
    return delegate(res, () => this.scenes.create({
      accessToken: this.bearer(req),
      homeId: req.params?.homeId,
      payload,
      signature,
    }));
  };

  listScenes = async (req, res) => {
    return delegate(res, () => this.scenes.list({ accessToken: this.bearer(req), homeId: req.params?.homeId }));
  };

  runScene = async (req, res) => {
    return delegate(res, () => this.scenes.run({ accessToken: this.bearer(req), sceneId: req.params?.sceneId }));
  };

  createAutomation = async (req, res) => {
    const { payload, signature } = req.body ?? {};
    return delegate(res, () => this.automations.create({
      accessToken: this.bearer(req),
      homeId: req.params?.homeId,
      payload,
      signature,
    }));
  };

  listAutomations = async (req, res) => {
    return delegate(res, () => this.automations.list({ accessToken: this.bearer(req), homeId: req.params?.homeId }));
  };

  updateAutomation = async (req, res) => {
    const { payload, signature } = req.body ?? {};
    return delegate(res, () => this.automations.update({
      accessToken: this.bearer(req),
      automationId: req.params?.automationId,
      payload,
      signature,
    }));
  };
}

export default AutomationController;
