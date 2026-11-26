// VisionHelper.swift — Apple Vision framework detection subprocess (PORCH-128).
//
// Protocol (see swift/README.md): stdin lines "FRAME <nbytes> <w> <h> <t> <fmt>"
// followed by `nbytes` raw payload bytes (rgb/rgba row-major, or jpeg bytes);
// stdout one JSON line per frame:
// {"engine":"vision","detections":[{"cls","conf","bbox":[x,y,w,h],"t"}...]}
// bbox normalized [0,1], origin top-left (Vision origin bottom-left is flipped).
//
// The provider keeps the subprocess alive per camera, so frames are parsed
// and answered incrementally as bytes arrive — never waiting for EOF.

import Foundation
import Vision
import ImageIO
import CoreGraphics

let stdinHandle = FileHandle.standardInput
let stdoutHandle = FileHandle.standardOutput

/// Build a CGImage from a raw bitmap payload (rgb = 3 bytes/px, rgba = 4).
func cgImage(fromRaw bytes: Data, width: Int, height: Int, channels: Int) -> CGImage? {
    let bitsPerPixel = channels * 8
    guard let provider = CGDataProvider(data: bytes as CFData) else { return nil }
    let alphaInfo: CGImageAlphaInfo = channels == 4 ? .premultipliedLast : .none
    return CGImage(
        width: width, height: height,
        bitsPerComponent: 8, bitsPerPixel: bitsPerPixel,
        bytesPerRow: width * channels,
        space: CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGBitmapInfo(rawValue: alphaInfo.rawValue),
        provider: provider, decode: nil, shouldInterpolate: false,
        intent: .defaultIntent
    )
}

/// Build a CGImage from encoded jpeg bytes.
func cgImage(fromJpeg bytes: Data) -> CGImage? {
    guard let src = CGImageSourceCreateWithData(bytes as CFData, [kCGImageSourceShouldCache: false] as CFDictionary) else { return nil }
    return CGImageSourceCreateImageAtIndex(src, 0, [kCGImageSourceShouldCache: false] as CFDictionary)
}

/// Run Vision requests and serialize normalized top-left detections.
func detect(in image: CGImage, at t: Double) -> String {
    var detections: [[String: Any]] = []
    let handler = VNImageRequestHandler(cgImage: image, orientation: .up, options: [:])

    func collect(request: VNRequest, label: String) {
        for observation in request.results ?? [] {
            guard let recognized = observation as? VNRecognizedObjectObservation else { continue }
            guard let top = recognized.labels.first else { continue }
            let cls = label == "animal" ? top.identifier : label
            let conf = top.confidence
            guard conf > 0.2 else { continue }
            let b = recognized.boundingBox // normalized, origin bottom-left
            detections.append([
                "cls": cls,
                "conf": conf,
                // Flip to origin top-left.
                "bbox": [Double(b.origin.x), Double(1 - b.origin.y - b.size.height), Double(b.size.width), Double(b.size.height)],
                "t": t,
            ])
        }
    }

    let humans = VNDetectHumanRectanglesRequest()
    humans.upperBodyOnly = false
    let animals = VNRecognizeAnimalsRequest()
    let pose = VNDetectHumanBodyPoseRequest()

    do {
        try handler.perform([humans, animals, pose])
    } catch {
        return "{\"engine\":\"vision\",\"error\":\(String(reflecting: error.localizedDescription)),\"detections\":[]}"
    }
    collect(request: humans, label: "person")
    collect(request: animals, label: "animal")

    var payload: [String: Any] = ["engine": "vision", "detections": detections]
    payload["poseAvailable"] = (pose.results?.count ?? 0) > 0
    guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]),
          var line = String(data: data, encoding: .utf8) else {
        return "{\"engine\":\"vision\",\"detections\":[]}"
    }
    line += "\n"
    return line
}

/// Pop one newline-terminated header line from the buffer, if present.
func readHeader(_ buffer: inout Data) -> String? {
    guard let nl = buffer.firstIndex(of: UInt8(ascii: "\n")) else { return nil }
    let line = String(decoding: buffer[buffer.startIndex..<nl], as: UTF8.self)
    buffer.removeSubrange(buffer.startIndex...nl)
    return line
}

/// Parsed header awaiting its payload.
struct PendingFrame { let nbytes: Int; let width: Int; let height: Int; let t: Double; let fmt: String }

var buffer = Data()
var pending: PendingFrame? = nil
while true {
    let chunk = stdinHandle.availableData
    if chunk.isEmpty { exit(0) } // EOF: the provider closed stdin
    chunk.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
        buffer.append(raw.bindMemory(to: UInt8.self).baseAddress!, count: raw.count)
    }
    process: while true {
        if let frame = pending {
            guard buffer.count >= frame.nbytes else { break process } // payload still arriving
            let payload = buffer.prefix(frame.nbytes)
            buffer.removeFirst(frame.nbytes)
            pending = nil
            var image: CGImage? = nil
            switch frame.fmt {
            case "rgb": image = cgImage(fromRaw: Data(payload), width: frame.width, height: frame.height, channels: 3)
            case "rgba": image = cgImage(fromRaw: Data(payload), width: frame.width, height: frame.height, channels: 4)
            case "jpeg": image = cgImage(fromJpeg: Data(payload))
            default: break
            }
            guard let img = image else {
                stdoutHandle.write(Data("{\"engine\":\"vision\",\"error\":\"unsupported frame\"}\n".utf8))
                continue
            }
            stdoutHandle.write(Data(detect(in: img, at: frame.t).utf8))
            continue
        }
        guard let header = readHeader(&buffer) else { break process }
        let parts = header.split(separator: " ")
        guard parts.count == 6, parts[0] == "FRAME",
              let nbytes = Int(parts[1]), let width = Int(parts[2]), let height = Int(parts[3]),
              let t = Double(parts[4]) else {
            stdoutHandle.write(Data("{\"engine\":\"vision\",\"error\":\"bad header\"}\n".utf8))
            continue
        }
        pending = PendingFrame(nbytes: nbytes, width: width, height: height, t: t, fmt: String(parts[5]))
    }
}
