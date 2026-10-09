// `porchlight service` — launchd-class process supervision so the hub comes
// back after a crash and on reboot (Porchlight Server TS 2: launchd on
// macOS; systemd equivalent on Linux [Assumed, confirm at build]). Windows
// supervision is not wired in V1 — `porchlight start` stays manual there and
// the limitation is reported rather than faked.
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { home } from "./state.mjs";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

const LAUNCHD_LABEL = "com.porchlight.hub";
const LAUNCHD_PLIST = () => join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
const SYSTEMD_UNIT = () => join(homedir(), ".config", "systemd", "user", "porchlight.service");

function cliEntry() {
  // bin entry of THIS package (repo dev = packages/cli/bin/porchlight.mjs;
  // global install = the npm-managed bin shim under the package dir).
  return join(dirname(require.resolve("../package.json")), "bin", "porchlight.mjs");
}

export async function run(args = {}) {
  const action = args.action ?? args._?.[0];
  if (action === "install" || action === "uninstall") {
    // The supervised home is THIS command's home (--home / PORCHLIGHT_HOME /
    // the platform default), never hardcoded — supervision installs for the
    // hub the owner actually operates (composition finding, PORCH-016).
    const paths = home({ PORCHLIGHT_HOME: args.home ?? process.env.PORCHLIGHT_HOME });
    const homeRoot = paths.root;
    return action === "install" ? install(homeRoot) : uninstall(homeRoot);
  }
  process.stdout.write("usage: porchlight service install|uninstall\n");
  process.exit(1);
}

function install(homeRoot) {
  if (process.platform === "darwin") return installLaunchd(homeRoot);
  if (process.platform === "linux") return installSystemd(homeRoot);
  throw new Error(
    "process supervision service wiring for windows is not part of V1 — run `porchlight start` manually (supervision inside the hub process group still applies)",
  );
}

function installLaunchd(homeRoot) {
  const plist = LAUNCHD_PLIST();
  const entry = cliEntry();
  mkdirSync(dirname(plist), { recursive: true });
  writeFileSync(
    plist,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${entry}</string>
    <string>start</string>
    <string>--foreground</string>
    <string>--home</string>
    <string>${homeRoot}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${join(homeRoot, "logs", "launchd.log")}</string>
  <key>StandardErrorPath</key><string>${join(homeRoot, "logs", "launchd.log")}</string>
</dict>
</plist>
`,
  );
  const uid = execFileSync("id", ["-u"]).toString().trim();
  try {
    execFileSync("launchctl", ["bootout", `gui/${uid}/${LAUNCHD_LABEL}`]); // idempotent re-install
  } catch {
    /* not loaded — fine on first install */
  }
  execFileSync("launchctl", ["bootstrap", `gui/${uid}`, plist]);
  // launchd owns automatic restart (KeepAlive) of the supervisor from now on.
  process.stdout.write(
    `launchd service installed (${LAUNCHD_LABEL}; KeepAlive — the hub process group restarts automatically and on boot).\n` +
      "verify: launchctl print gui/" + uid + "/" + LAUNCHD_LABEL + "\n" +
      "uninstall: porchlight service uninstall\n",
  );
}

function uninstall(homeRoot) {
  if (process.platform === "darwin") {
    const uid = execFileSync("id", ["-u"]).toString().trim();
    try {
      execFileSync("launchctl", ["bootout", `gui/${uid}/${LAUNCHD_LABEL}`]);
    } catch {
      /* already bootout */
    }
    rmSync(LAUNCHD_PLIST(), { force: true });
    void homeRoot;
    process.stdout.write("launchd service removed.\n");
    return;
  }
  if (process.platform === "linux") {
    try {
      execFileSync("systemctl", ["--user", "disable", "--now", "porchlight.service"]);
    } catch {
      /* already disabled */
    }
    rmSync(SYSTEMD_UNIT(), { force: true });
    void homeRoot;
    process.stdout.write("systemd user service removed.\n");
    return;
  }
  process.stdout.write("no service wiring on this platform (V1) — nothing to uninstall.\n");
}

function installSystemd(homeRoot) {
  const unit = SYSTEMD_UNIT();
  mkdirSync(dirname(unit), { recursive: true });
  writeFileSync(
    unit,
    `[Unit]
Description=porchlight hub (v${version})
After=network-online.target

[Service]
ExecStart=${process.execPath} ${cliEntry()} start --foreground --home ${homeRoot}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`,
  );
  try {
    execFileSync("systemctl", ["--user", "daemon-reload"]);
    execFileSync("systemctl", ["--user", "enable", "--now", "porchlight.service"]);
  } catch (error) {
    throw new Error(`systemd enable failed (${error.message}) — lingering user sessions require \`loginctl enable-linger\``);
  }
  process.stdout.write(`systemd user service installed (Restart=always — automatic restart).\n`);
}