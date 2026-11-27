// index.js — public surface of @porchlight/wyze (PORCH-131).

// Protocol primitives (crypto + IOTC wire layer).
export {
	reverseTransCodePartial, transCodePartial,
	reverseTransCodeBlob, transCodeBlob,
	xxteaDecrypt16, xxteaDecryptVar,
	CHALLENGE_STATUS as TUTK_CHALLENGE_STATUS,
} from "./crypto.js";
export {
	IOTC_CMD, IOTC_MAGIC, IOTC_MAGIC_DATA, IOTC_MAGIC_KEEPALIVE, SDK_VERSION,
	IOTC_HEADER_SIZE, DISCOVERY_STAGE, DISCOVERY_PORT, DISCOVERY_INTERVAL_MS,
	DISCOVERY_TIMEOUT_MS, genSessionID, buildDisco, buildSession,
	buildKeepaliveReq, buildSessionDataTx, parseIotc, decodeIotcDatagram,
	encodeIotcDatagram, isCc51Datagram,
} from "./iotc.js";

// AV layer (HL/K auth + control channel + login/ACK framing).
export {
	K_CMD, AV_MAGIC, MEDIA_TYPE, DEFAULT_CAPS,
	FRAME_SIZE, BITRATE, buildHL, parseHL, findHL, buildK10000, buildK10002,
	parseK10001, parseK10003, buildK10010, buildK10056, buildK10052,
	generateChallengeResponse, is2KModel, isDoorbellResolutionModel,
	isFloodlightModel, buildAVLogin, parseAVLoginResp, buildIOCtrl, buildACK,
	buildAVLoginResponse, extractHLFromAv,
} from "./av.js";

// DTLS engine.
export {
	DtlsPskClient,
	DtlsPskServer,
	derivePsk, calculateAuthKey, generateEcdhKeypair, ecdhShared,
	NAMED_CURVE, CIPHER_SUITE, SUITE_PARAMS, SUITE_HASH_MODE, isAeadSuite,
} from "./dtls/index.js";

// Frame reassembly.
export {
	FrameHandler, CHANNEL, CODEC, FRAME_TYPE, parseFrameInfo, isVideoCodec,
	isAudioCodec,
} from "./frame.js";

// The camera session + stream-manager factory.
export { WyzeCameraSession, parseWyzeUrl, SESSION_STATES } from "./session.js";
export {
	WyzePumpHandle, createWyzeStreamFactory,
	buildPumpArgs, PUMP_STDIO, isWyzeCamera,
} from "./source.js";
