# VisionHelper.swift — Apple Vision framework detection helper (PORCH-128).

Reads framed frames on stdin, runs Apple Vision primitives, and writes one
JSON line per frame to stdout:

Frame message (stdin, one line followed by raw payload bytes):

    FRAME <payloadBytes> <width> <height> <epochSeconds> <format: rgb|rgba|jpeg>\n<payload bytes>

Response (stdout, one line):

    {"engine":"vision","detections":[{"cls":"person","conf":0.83,"bbox":[x,y,w,h],"t":1735215600.0}...]}

bboxes are normalized [0,1] origin top-left (Vision reports normalized boxes
origin bottom-left; the helper flips y). Detections: person
(VNDetectHumanRectanglesRequest) and animals (VNRecognizeAnimalsRequest).
Compile once with swiftc:

    swiftc -O VisionHelper.swift -o vision-helper

The provider (packages/detection/src/provider.vision.js) speaks this protocol
over the subprocess stdin/stdout.
