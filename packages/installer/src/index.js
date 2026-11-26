// index.js — public surface of @porchlight/installer (PORCH-134).

export { buildLaunchDaemonPlist, launchDaemonPath, launchctlCommands } from "./daemon.js";
export {
	DEFAULT_ROOT,
	DEFAULT_LABEL,
	DEFAULT_STATUS_PORT,
	DEFAULT_STATUS_HOST,
	defaultConfigDocument,
	ensureBootstrapConfig,
	loadPlatformConfig,
	parseInputs,
	renderConfigYaml,
	validatePlatformConfig,
} from "./config.js";
export { runBootstrap, resolveNodeRuntime, verifyInstall, verifyHealth, writeDaemonPlist } from "./bootstrap.js";
export { aggregateHealth, createStatusServer, renderStatusHtml } from "./status-page.js";
export { startPlatformRuntime, runDaemon, platformPosture } from "./runtime.js";
export {
	LOCAL_NETWORK_FACTS,
	buildResetCommand,
	renderLocalNetworkPosture,
	runNetworkProbe,
	siteAdminAllowCommands,
} from "./tcc.js";
export { UNSIGNED_NOTICE, codesignRequirement, parseIdentities, resolveSigningIdentity } from "./signing.js";
export { assemblePayload, copyTree, launcherScript, PAYLOAD_MODULES, PAYLOAD_PACKAGES } from "./payload.js";
export { buildInstallScripts, buildPkg } from "./pkgspec.js";
