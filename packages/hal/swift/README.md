# VisionHelper.swift — Apple Vision framework detection helper (owned by the HAL).

The Swift component of the platform HAL (PORCH-132): the only OS-framework
code in the monorepo lives under `packages/hal`. It runs Apple Vision
primitives natively on macOS; the detection service consumes it through the
HAL contract (`hal.visionHelper()` — never by importing or compiling OS
frameworks from service code).

Reads framed frames on stdin, runs Apple Vision primitives, and writes one
JSON line per frame to stdout:

Frame message (stdin, one line followed by raw payload bytes):

    FRAME <payloadBytes> <width> <height> <epochSeconds> <format: rgb|rgba|jpeg>\n<payload bytes>

Response (stdout, one line):

    {"engine":"vision","detections":[{"cls":"person","conf":0.83,"bbox":[x,y,w,h],"t":1735215600.0}]}

bboxes are normalized [0,1] origin top-left (Vision reports normalized boxes
origin bottom-left; the helper flips y). Detections: person
(VNDetectHumanRectanglesRequest) and animals (VNRecognizeAnimalsRequest).
Compile once with swiftc (source path resolved via `@porchlight/hal`'s
`visionHelper().sourcePath` — originally introduced with PORCH-128):

    swiftc -O VisionHelper.swift -o vision-helper

The provider (`packages/detection/src/provider.vision.js`) speaks this framed
stdin/stdout protocol over the subprocess wires.
