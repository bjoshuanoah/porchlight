import { HomeService } from "./services/home.service.js";
import { AreaService } from "./services/area.service.js";
import { DeviceService } from "./services/device.service.js";
import { DeviceAdapterManager } from "./services/adapter.registry.js";
import { SceneService } from "./services/scene.service.js";
import { AutomationService } from "./services/automation.service.js";
import { GrantService } from "./services/grant.service.js";
import { HomeAuditService } from "./services/audit.service.js";
import { HomeController } from "./controllers/home.controller.js";
import { DeviceController } from "./controllers/device.controller.js";
import { AutomationController } from "./controllers/automation.controller.js";
import { createHomeRouter } from "./routes.js";

/**
 * Home module assembly. Builds the full route → controller → service →
 * model path from an injected domain store — the same pure-DI shape
 * assembleSocialModule uses. The home domain owns every home collection;
 * the identity plane is referenced only through the injected callbacks
 * (home imports no identity source — CI-enforced by the boundary check).
 *
 * @param {import("@porchlight/shared").StoreLike} store
 * @param {{
 *   verifySession: (token: string | null) => Promise<{ did: string, deviceId?: string } | null>,
 *     The identity-plane access-token verifier (apps/server wires it from
 *     the identity module's public entry — the device-bound identity plane
 *     is the only auth surface; no new passwords, emails, or vendor auth).
 *   registeredDeviceKey?: (did: string, deviceId: string) => Promise<{ publicKeyJwk: object } | null>,
 *     The possession-proven device key resolution behind member-signed
 *     writes (audit stores the signature where member-issued).
 *   adapters?: import("./services/adapter.registry.js").DeviceAdapterManager,
 *     The device adapter seam implementations (Matter multi-admin and
 *     vendor adapters register here at the transport layer). Absent → an
 *     empty registry: devices register but refuse commands with plain
 *     language until an adapter connects (never a silent no-op).
 *   orgId?: (() => string | null) | null,
 *     The hub installation's org of record, stamped on homes.
 *   dark?: (() => boolean | null) | null,
 *     Hub-local after-dark resolution for automation time windows
 *     (sunset computed locally — the WAN is never consulted). Unwired →
 *     afterDark conditions fail closed.
 *   onDeviceEvent?: (handler: (event: object) => Promise<unknown>) => void,
 *     The bus subscription seam: the engine (PORCH-I-009) publishes
 *     detection/entity events; the home module subscribes and applies its
 *     rules. The handler resolves AutomationService.handleEvent. Absent →
 *     rules ride the REST surfaces and tests drive handleEvent directly.
 *   identityFacts?: {
 *     resolveIdentity: (did) => Promise<{ did, displayName? } | null>,
 *       The resolve of a grantee's EXISTING Porchlight identity (grants never
 *       mint identities); absent → grant creation fails closed.
 *     familyById: (familyId) => Promise<family | null>, and
 *     familiesForMember: (did) => Promise<family[]>,
 *       The identity-plane family facts family grants consume (resolved
 *       through the family organizer, never a model import).
 *   },
 *   log?: ((line: string) => void) | null,
 *     Auth-failure capture sink (PORCH-019 shape); defaults to console.
 *   now?: () => string,
 * }} [options]
 */
export function assembleHomeModule(store, options = {}) {
  const now = options.now ?? (() => new Date().toISOString());
  const collection = store.collection.bind(store);
  const homes = collection("homes");
  const homeMembers = collection("home_members");
  const areas = collection("areas");
  const devices = collection("devices");
  const scenes = collection("scenes");
  const automations = collection("automations");
  const homeAudit = collection("home_audit");
  const grants = collection("grants");

  const audit = new HomeAuditService(homeAudit, now);
  const verifySession = (token) => (options.verifySession ? options.verifySession(token) : Promise.resolve(null));
  const registeredDeviceKey = options.registeredDeviceKey
    ? (did, deviceId) => options.registeredDeviceKey(did, deviceId)
    : null;
  const adapters = options.adapters ?? new DeviceAdapterManager();

  const homeService = new HomeService(homes, homeMembers, {
    verifySession,
    registeredDeviceKey,
    orgId: options.orgId ?? null,
    now,
  });
  const areaService = new AreaService(areas, homeService, now, { devices });
  const deviceService = new DeviceService(devices, areas, homeService, audit, adapters, { verifySession, registeredDeviceKey }, now);
  const sceneService = new SceneService(scenes, homeService, deviceService, now);
  const automationService = new AutomationService(automations, homeService, deviceService, audit, {
    verifySession,
    registeredDeviceKey,
    dark: options.dark ?? null,
  }, now);
  // PORCH-138: the grant layer. identityFacts is the injected identity-plane
  // resolve (existing-identity check + family facts) — never an import of
  // identity; unwired facts fail closed (no grant can be created).
  const grantService = new GrantService(
    grants, homeService,
    { devices, scenes, areas },
    audit,
    { verifySession, registeredDeviceKey },
    options.identityFacts ?? null,
    now,
  );
  // Membership wins the resolution: the HomeService seam consults the grant
  // side only when no membership matches, so exactly one of the three V1
  // access classes applies with no parallel mechanism.
  homeService.grantResolver = ({ did, homeId = null }) => grantService.resolveFor({ did, homeId });

  if (typeof options.onDeviceEvent === "function") {
    options.onDeviceEvent((event) => automationService.handleEvent(event));
  }

  const controllers = {
    home: new HomeController({
      homes: homeService,
      areas: areaService,
      audit,
      deviceService,
      sceneService,
      automationService,
      grants: grantService,
    }),
    device: new DeviceController(deviceService),
    automation: new AutomationController({ scenes: sceneService, automations: automationService }),
  };

  return {
    api: createHomeRouter(controllers),
    controllers,
    homeService,
    areaService,
    deviceService,
    sceneService,
    automationService,
    grantService,
    auditService: audit,
    adapters,
  };
}

export default assembleHomeModule;
