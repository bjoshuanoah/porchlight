import { HomeService } from "./services/home.service.js";
import { AreaService } from "./services/area.service.js";
import { DeviceService } from "./services/device.service.js";
import { DeviceAdapterManager } from "./services/adapter.registry.js";
import { SceneService } from "./services/scene.service.js";
import { AutomationService } from "./services/automation.service.js";
import { GrantService } from "./services/grant.service.js";
import { HomeAuditService } from "./services/audit.service.js";
import { CameraService } from "./services/camera.service.js";
import { EventService } from "./services/event.service.js";
import { HomeController } from "./controllers/home.controller.js";
import { DeviceController } from "./controllers/device.controller.js";
import { AutomationController } from "./controllers/automation.controller.js";
import { CameraController } from "./controllers/camera.controller.js";
import { EventController } from "./controllers/event.controller.js";
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
 *   engine?: object | null,
 *     PORCH-139: the engine bridge seam (see camera.service.js) — the hub
 *     builds the transport adapters from the runtime config of record.
 *     Absent → every camera surface fails closed with plain language.
 *   engineSecret?: string | null,
 *     The shared engine-token secret of record; the bridge mints scoped
 *     camera-view tokens the engine verifies.
 *   interpreter?: { name, describe({ event, gate }) } | null,
 *     The Tier-1 interpretation seam (Ollama-class). Absent/unwired →
 *     events open with the factual fallback label only.
 *   onEngineEvent?: (handler: (detection: object) => Promise<unknown>) => void,
 *     The engine's detection bus subscription (DetectedObject facts). The
 *     handler resolves BOTH family consumers: the event pipeline's dedup
 *     and the automation rules. Absent → tests drive the services directly.
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
  // PORCH-139: the camera association store, its separate authorization
  // scope class, and the family event pipeline's documents.
  const cameras = collection("cameras");
  const cameraAccess = collection("camera_access");
  const events = collection("home_events");

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

  // PORCH-139: the camera bridge + the family event/alert pipeline. The
  // engine seam is injected (the hub builds the transport adapters from the
  // runtime config); absent, every camera surface fails closed with plain
  // language and the event pipeline still captures — the engine is
  // consumed here, never built.
  const cameraService = new CameraService(
    cameras, cameraAccess, homeService, areas, events,
    options.engine ?? null, audit,
    { verifySession, registeredDeviceKey },
    options.engineSecret ? { secret: options.engineSecret, now } : null,
    now,
  );
  const eventService = new EventService(events, cameras, areas, audit, options.interpreter ?? null, {
    now,
    auth: cameraService,
  });
  eventService.setEngine(options.engine ?? null);
  eventService.dedupWindowSec = options.dedupWindowSec
    ? Math.max(1, Math.floor(options.dedupWindowSec))
    : eventService.dedupWindowSec;

  if (typeof options.onDeviceEvent === "function") {
    options.onDeviceEvent((event) => automationService.handleEvent(event));
  }

  // PORCH-139: the engine's detection bus feeds BOTH family consumers —
  // the event pipeline (dedup, observation/inference split, evidence) and
  // the automation rules — off one subscription. The home/area resolution
  // lives in the event service's association lookups; automations see the
  // same home-scoped facts.
  if (typeof options.onEngineEvent === "function") {
    options.onEngineEvent(async (detection) => {
      const result = await eventService.ingest(detection);
      if (result?.event) {
        await automationService.handleEvent({
          homeId: result.event.homeId,
          areaId: result.event.areaId,
          eventClass: String(detection?.cls ?? ""),
        });
      }
      return result;
    });
  }

  const controllers = {
    home: new HomeController({
      homes: homeService,
      areas: areaService,
      audit,
      grants: grantService,
    }),
    device: new DeviceController(deviceService),
    automation: new AutomationController({ scenes: sceneService, automations: automationService }),
    camera: new CameraController(cameraService),
    event: new EventController(eventService, verifySession),
  };

  // PORCH-149: the surface-list callables surfacesForActor composes — the
  // exact list services the controller surfaces() aggregates, wired after
  // the services exist (the grantResolver pattern).
  homeService.surfaceLists = {
    areas: ({ did, homeId }) => areaService.listForActor({ did, homeId }),
    devices: ({ did, homeId }) => deviceService.listForActor({ did, homeId }),
    scenes: ({ did, homeId }) => sceneService.listForActor({ did, homeId }),
    automations: ({ did, homeId }) => automationService.listForActor({ did, homeId }),
  };

  // PORCH-149: the home module's session-free actor tool surface — every
  // callable IS the service path its UI route resolves to (the session
  // methods delegate into these seams; no hidden API, no parallel
  // authorization: each call enforces the member's authorizeMember verdicts
  // live). The agent tool registry consumes this through injected callbacks;
  // the agent module imports no home source (CI-enforced boundary).
  const toolSurface = {
    homes: ({ did }) => homeService.homesForActor({ did }),
    /** GET /homes/:homeId (the controller surfaces() payload), session-free. */
    status: ({ did, homeId }) => homeService.surfacesForActor({ did, homeId }),
    listDevices: ({ did, homeId }) => deviceService.listForActor({ did, homeId }),
    /** POST /devices/:deviceId/command's verdict path; detail carries agent attribution. */
    sendCommand: ({ did, deviceId, command, detail = {} }) =>
      deviceService.commandForActor({ did, deviceId, command, source: "agent", detail }),
    /** POST /scenes/:sceneId/run's verdict path; detail carries agent attribution. */
    runScene: ({ did, sceneId, detail = {} }) =>
      sceneService.runForActor({ did, sceneId, detail }),
    reviewEvents: ({ did, homeId, limit, offset }) =>
      eventService.listForActor({ did, homeId, limit, offset }),
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
    cameraService,
    eventService,
    toolSurface,
  };
}

export default assembleHomeModule;
