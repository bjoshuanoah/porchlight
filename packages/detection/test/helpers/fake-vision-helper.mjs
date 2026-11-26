// helpers/fake-vision-helper.mjs — test stand-in for the compiled Swift
// VisionHelper: same framed stdin/stdout protocol, deterministic detections.

import process from "node:process";

/** @type {Buffer} */
let acc = Buffer.alloc(0);

process.stdin.on("data", (/** @type {Buffer} */ chunk) => {
	acc = Buffer.concat([acc, chunk]);
	processInput();
});
process.stdin.on("end", () => process.exit(0));

function processInput() {
	const nl = acc.indexOf(0x0a);
	if (nl === -1) return;
	const header = acc.subarray(0, nl).toString("utf8");
	const parts = header.split(" ");
	if (parts[0] !== "FRAME" || parts.length !== 6) {
		stdout('{"engine":"vision","error":"bad header"}\n');
		acc = acc.subarray(nl + 1);
		return;
	}
	const nbytes = Number(parts[1]);
	if (acc.length < nl + 1 + nbytes) return;
	acc = acc.subarray(nl + 1 + nbytes);
	const t = Number(parts[4]);
	const response = {
		engine: "vision",
		detections: [
			{ cls: "person", conf: 0.8, bbox: [0.2, 0.3, 0.2, 0.2], t },
			{ cls: "dog", conf: 0.6, bbox: [0.6, 0.55, 0.25, 0.25], t },
		],
	};
	stdout(`${JSON.stringify(response)}\n`);
	processInput();
}

/** @param {string} s */
function stdout(s) {
	process.stdout.write(s);
}
