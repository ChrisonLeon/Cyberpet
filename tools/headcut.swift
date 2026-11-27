// 抠头工具：用 macOS 自带的 Vision 人像分割，从一张正面照片里抠出带透明通道的脑袋。
// 用法见 README「换头图」。
//   swiftc -O -o headcut headcut.swift
//   ./headcut 输入.jpg 输出.png [最长边=2600] [输出高=677] [脖宽=0.5] [下巴以下=0.08] [斜率=1.1] [最大半宽=2.4] [去毛边px=1] [弧度=0.12]

import Foundation
import Vision
import ImageIO
import CoreGraphics

let a = CommandLine.arguments
let inURL = URL(fileURLWithPath: a[1]), outURL = URL(fileURLWithPath: a[2])
func arg(_ i: Int, _ d: Double) -> Double { a.count > i ? Double(a[i])! : d }
let maxDim = Int(arg(3, 2600)), target = Int(arg(4, 760))
let halfW = arg(5, 0.8), cutBelow = arg(6, 0.05), slope = arg(7, 0.9), maxHalf = arg(8, 2.4), erode = Int(arg(9, 1)), curve = arg(10, 0.05)

let src = CGImageSourceCreateWithURL(inURL as CFURL, nil)!
let topts: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceThumbnailMaxPixelSize: maxDim,
                              kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceShouldCache: false]
let img = CGImageSourceCreateThumbnailAtIndex(src, 0, topts as CFDictionary)!
let W = img.width, H = img.height

let lmReq = VNDetectFaceLandmarksRequest()
try VNImageRequestHandler(cgImage: img, options: [:]).perform([lmReq])
guard let face = (lmReq.results ?? []).max(by: { $0.boundingBox.width < $1.boundingBox.width }) else { fatalError("no face") }
let fb = face.boundingBox
let fw = fb.width * Double(W), fh = fb.height * Double(H)
let fx = fb.origin.x * Double(W)
let fyTop = (1 - fb.origin.y - fb.height) * Double(H)
let fbBottom = fyTop + fh
let cx = fx + fw / 2

let seg = VNGeneratePersonSegmentationRequest()
seg.qualityLevel = .accurate
seg.outputPixelFormat = kCVPixelFormatType_OneComponent8
try VNImageRequestHandler(cgImage: img, options: [:]).perform([seg])
guard let obs = seg.results?.first else { fatalError("no mask") }
let pb = obs.pixelBuffer
let mw = CVPixelBufferGetWidth(pb)
let mh = CVPixelBufferGetHeight(pb)
let mbpr = CVPixelBufferGetBytesPerRow(pb)
CVPixelBufferLockBaseAddress(pb, .readOnly)
let mb = CVPixelBufferGetBaseAddress(pb)!.assumingMemoryBound(to: UInt8.self)
func maskAt(_ x: Double, _ y: Double) -> Double {   // bilinear, y from top
    let sx: Double = Double(mw) / Double(W)
    let sy: Double = Double(mh) / Double(H)
    let fxp: Double = min(Double(mw) - 1.0, max(0.0, x * sx - 0.5))
    let fyp: Double = min(Double(mh) - 1.0, max(0.0, y * sy - 0.5))
    let x0 = Int(fxp), y0 = Int(fyp)
    let x1 = min(mw - 1, x0 + 1), y1 = min(mh - 1, y0 + 1)
    let tx = fxp - Double(x0), ty = fyp - Double(y0)
    let p00 = Double(mb[y0 * mbpr + x0]), p10 = Double(mb[y0 * mbpr + x1])
    let p01 = Double(mb[y1 * mbpr + x0]), p11 = Double(mb[y1 * mbpr + x1])
    let top = p00 * (1 - tx) + p10 * tx
    let bot = p01 * (1 - tx) + p11 * tx
    return (top * (1 - ty) + bot * ty) / 255.0
}
func smooth(_ e0: Double, _ e1: Double, _ x: Double) -> Double { let t = min(1, max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t) }

let cs = CGColorSpaceCreateDeviceRGB()
let bctx = CGContext(data: nil, width: W, height: H, bitsPerComponent: 8, bytesPerRow: W * 4, space: cs, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
bctx.draw(img, in: CGRect(x: 0, y: 0, width: W, height: H))
let buf = bctx.data!.assumingMemoryBound(to: UInt8.self)
var alpha = [Double](repeating: 0, count: W * H)
let y0 = fbBottom + cutBelow * fh, feather = 0.05 * fh
var minX = W, maxX = 0, minY = H, maxY = 0
for y in 0..<H {
    for x in 0..<W {
        let d = abs(Double(x) - cx)
        if d > maxHalf * fw { continue }
        let yCut = y0 - curve * fh * min(1, d / (halfW * fw)) * min(1, d / (halfW * fw)) - slope * max(0, d - halfW * fw)
        let k = (1 - smooth(yCut - feather, yCut + feather, Double(y))) * (1 - smooth(maxHalf * fw - 0.15 * fw, maxHalf * fw, d))
        if k <= 0 { continue }
        let v = maskAt(Double(x), Double(y)) * k
        if v <= 0 { continue }
        alpha[y * W + x] = v
        if v > 0.5 { minX = min(minX, x); maxX = max(maxX, x); minY = min(minY, y); maxY = max(maxY, y) }
    }
}
CVPixelBufferUnlockBaseAddress(pb, .readOnly)
// erode by N px (min filter) to trim background fringe
var out = alpha
if erode > 0 {
    for y in 0..<H { for x in 0..<W {
        var m = alpha[y * W + x]
        if m > 0 { for dy in -erode...erode { for dx in -erode...erode {
            let xx = x + dx, yy = y + dy
            if xx < 0 || yy < 0 || xx >= W || yy >= H { m = 0 } else { m = min(m, alpha[yy * W + xx]) }
        } } }
        out[y * W + x] = m
    } }
}
for i in 0..<(W * H) {
    let al = out[i]
    buf[i * 4] = UInt8(max(0, min(255, (Double(buf[i * 4]) * al).rounded())))
    buf[i * 4 + 1] = UInt8(max(0, min(255, (Double(buf[i * 4 + 1]) * al).rounded())))
    buf[i * 4 + 2] = UInt8(max(0, min(255, (Double(buf[i * 4 + 2]) * al).rounded())))
    buf[i * 4 + 3] = UInt8(max(0, min(255, (al * 255).rounded())))
}
let pad = 6
let cropMinX = max(0, minX - pad), cropMinY = max(0, minY - pad)
let cropW = min(W - cropMinX, maxX - minX + 1 + pad * 2), cropH = min(H - cropMinY, maxY - minY + 1 + pad * 2)
let scale = Double(target) / Double(max(cropW, cropH))
let ow = Int(Double(cropW) * scale), oh = Int(Double(cropH) * scale)
let octx = CGContext(data: nil, width: ow, height: oh, bitsPerComponent: 8, bytesPerRow: ow * 4, space: cs, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
octx.interpolationQuality = .high
octx.draw(bctx.makeImage()!, in: CGRect(x: -Double(cropMinX) * scale, y: -Double(H - cropMinY - cropH) * scale, width: Double(W) * scale, height: Double(H) * scale))
let dest = CGImageDestinationCreateWithURL(outURL as CFURL, "public.png" as CFString, 1, nil)!
CGImageDestinationAddImage(dest, octx.makeImage()!, nil)
CGImageDestinationFinalize(dest)
print("face \(Int(fw))x\(Int(fh)) mask \(mw)x\(mh) crop \(cropMinX),\(cropMinY) \(cropW)x\(cropH) -> \(ow)x\(oh)")
