// 白小纯桌宠 · 素材管线
// 从视频里提取：头像（透明底静态抠头 / 透明底动态抠头 APNG）、2–3 秒的头部特写视频、按语音停顿分段的配音，
// 文件名带上字幕文字说明。
//
// 用法：
//   swiftc -O -o media-pipeline media-pipeline.swift
//   ./media-pipeline <视频目录> <输出目录>                              提取（文件名用画面字幕 OCR，识别不出写「无字幕」）
//   ./media-pipeline <视频目录> <输出目录> --table 说明表.json           提取，并按人工校对过的字幕说明命名
//   ./media-pipeline <视频目录> <输出目录> --name 说明表.json             只按说明表给已有文件重命名
//
// 说明表格式（时间单位秒；花字字幕 OCR 不准时手工校对）：
//   { "素材1": { "subs": [ { "from": 0, "to": 3.2, "text": "喂 能听到吗" } ] },
//     "素材3": { "perSubtitle": true, "subs": [ ... ] } }   // perSubtitle：一句字幕切一段配音
//
// 只依赖 macOS 自带框架（AVFoundation / Vision / Compression），不需要 ffmpeg。

import Foundation
import AVFoundation
import Vision
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
import Compression
import CoreImage

// MARK: - 小工具

func clamp<T: Comparable>(_ v: T, _ lo: T, _ hi: T) -> T { min(hi, max(lo, v)) }
func smoothstep(_ e0: Double, _ e1: Double, _ x: Double) -> Double {
    let t = clamp((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)
}

func cgImage(from pb: CVPixelBuffer) -> CGImage? {
    CVPixelBufferLockBaseAddress(pb, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(pb, .readOnly) }
    guard let base = CVPixelBufferGetBaseAddress(pb) else { return nil }
    let bpr = CVPixelBufferGetBytesPerRow(pb)
    let data = Data(bytes: base, count: bpr * CVPixelBufferGetHeight(pb))
    guard let provider = CGDataProvider(data: data as CFData) else { return nil }
    return CGImage(width: CVPixelBufferGetWidth(pb), height: CVPixelBufferGetHeight(pb), bitsPerComponent: 8, bitsPerPixel: 32,
                   bytesPerRow: bpr, space: CGColorSpaceCreateDeviceRGB(),
                   bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue),
                   provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)
}

/// 把 CGImage 画进指定格式的位图上下文，返回 (上下文, 像素)。行 0 是顶部。
func pixels(_ img: CGImage, gray: Bool) -> (CGContext, UnsafeMutablePointer<UInt8>)? {
    let w = img.width, h = img.height
    let ctx = gray
        ? CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w, space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue)
        : CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
    guard let ctx = ctx, let data = ctx.data else { return nil }
    ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
    return (ctx, data.assumingMemoryBound(to: UInt8.self))
}

// MARK: - APNG 编码（动态 PNG，透明底，Chromium 的 <img> 原生支持）

func crc32(_ bytes: [UInt8]) -> UInt {
    var c: UInt = 0xFFFFFFFF
    for b in bytes {
        c ^= UInt(b)
        for _ in 0..<8 { c = (c & 1) != 0 ? 0xEDB88320 ^ (c >> 1) : c >> 1 }
    }
    return c ^ 0xFFFFFFFF
}

func adler32(_ bytes: [UInt8]) -> UInt {
    var a: UInt = 1, b: UInt = 0
    for x in bytes { a = (a + UInt(x)) % 65521; b = (b + a) % 65521 }
    return (b << 16) | a
}

func be32(_ v: UInt32) -> [UInt8] { [UInt8(v >> 24 & 255), UInt8(v >> 16 & 255), UInt8(v >> 8 & 255), UInt8(v & 255)] }
func be16(_ v: UInt16) -> [UInt8] { [UInt8(v >> 8 & 255), UInt8(v & 255)] }

func pngChunk(_ type: String, _ payload: [UInt8]) -> [UInt8] {
    let t = Array(type.utf8)
    var crcInput: [UInt8] = t
    crcInput += payload
    return be32(UInt32(payload.count)) + t + payload + be32(UInt32(crc32(crcInput)))
}

/// Compression 框架的 COMPRESSION_ZLIB 输出的是裸 DEFLATE，这里补上 zlib 头和 Adler-32，才是 PNG 要的数据流
func zlibData(_ raw: [UInt8]) -> [UInt8] {
    var dst = [UInt8](repeating: 0, count: raw.count + 4096)
    let n = compression_encode_buffer(&dst, dst.count, raw, raw.count, nil, COMPRESSION_ZLIB)
    return [0x78, 0x9C] + (n > 0 ? Array(dst.prefix(n)) : storedBlocks(raw)) + be32(UInt32(adler32(raw)))
}

/// 压缩器兜底：DEFLATE 存储块（原样搬运）
func storedBlocks(_ raw: [UInt8]) -> [UInt8] {
    var out: [UInt8] = []
    var i = 0
    repeat {
        let n = min(65535, raw.count - i)
        out.append(i + n >= raw.count ? 1 : 0)
        out += [UInt8(n & 255), UInt8(n >> 8), UInt8(~n & 255), UInt8((~n >> 8) & 255)]
        out += raw[i..<(i + n)]
        i += n
    } while i < raw.count
    return out
}

/// PNG 行过滤：每行在 None / Sub / Paeth 里选绝对值和最小的一种，照片内容能小两三成
func filterRows(_ px: [UInt8], w: Int, h: Int) -> [UInt8] {
    let stride = w * 4
    var out = [UInt8](repeating: 0, count: (stride + 1) * h)
    func signedAbs(_ v: Int) -> Int { let u = v & 255; return min(u, 256 - u) }
    for y in 0..<h {
        let base = y * stride
        var none = [UInt8](repeating: 0, count: stride)
        var sub = [UInt8](repeating: 0, count: stride)
        var paeth = [UInt8](repeating: 0, count: stride)
        var sum = [0, 0, 0]
        for x in 0..<stride {
            let v = Int(px[base + x])
            let left = x >= 4 ? Int(px[base + x - 4]) : 0
            let up = y > 0 ? Int(px[base + x - stride]) : 0
            let ul = (y > 0 && x >= 4) ? Int(px[base + x - stride - 4]) : 0
            let p = left + up - ul
            let (pa, pb, pc) = (abs(p - left), abs(p - up), abs(p - ul))
            let pred = (pa <= pb && pa <= pc) ? left : (pb <= pc ? up : ul)
            none[x] = UInt8(v)
            sub[x] = UInt8(truncatingIfNeeded: v - left)
            paeth[x] = UInt8(truncatingIfNeeded: v - pred)
            sum[0] += signedAbs(v)
            sum[1] += signedAbs(v - left)
            sum[2] += signedAbs(v - pred)
        }
        let pick = sum.indices.min { sum[$0] < sum[$1] } ?? 0
        out[y * (stride + 1)] = UInt8([0, 1, 4][pick]) // PNG 行过滤类型：0=None 1=Sub 4=Paeth
        let row = [none, sub, paeth][pick]
        let rowStart = y * (stride + 1) + 1
        out.replaceSubrange(rowStart..<(rowStart + stride), with: row)
    }
    return out
}

func writeAPNG(_ url: URL, frames: [(w: Int, h: Int, px: [UInt8])], delayMs: Int) throws {
    guard let first = frames.first else { return }
    var png: [UInt8] = [137, 80, 78, 71, 13, 10, 26, 10]
    png += pngChunk("IHDR", be32(UInt32(first.w)) + be32(UInt32(first.h)) + [8, 6, 0, 0, 0])
    png += pngChunk("acTL", be32(UInt32(frames.count)) + be32(0))
    var seq: UInt32 = 0
    let (num, den) = (delayMs, 1000)
    for (i, f) in frames.enumerated() {
        let z = zlibData(filterRows(f.px, w: f.w, h: f.h))
        let ctl = be32(seq) + be32(UInt32(f.w)) + be32(UInt32(f.h)) + be32(0) + be32(0) + be16(UInt16(num)) + be16(UInt16(den)) + [0, 0]
        png += pngChunk("fcTL", ctl)
        seq += 1
        if i == 0 { png += pngChunk("IDAT", z) } else { png += pngChunk("fdAT", be32(seq) + z); seq += 1 }
    }
    png += pngChunk("IEND", [])
    try Data(png).write(to: url)
}

// MARK: - 视频源

final class VideoFrames {
    let asset: AVAsset
    let track: AVAssetTrack
    let natural: CGSize
    let upright: CGSize
    private let ctm: CGAffineTransform

    init?(asset: AVAsset) {
        guard let track = asset.tracks(withMediaType: .video).first else { return nil }
        self.asset = asset
        self.track = track
        natural = track.naturalSize
        let s = track.naturalSize.applying(track.preferredTransform)
        upright = CGSize(width: abs(s.width), height: abs(s.height))
        func flip(_ h: CGFloat) -> CGAffineTransform {
            CGAffineTransform(translationX: 0, y: h).concatenating(CGAffineTransform(scaleX: 1, y: -1))
        }
        ctm = flip(upright.height).concatenating(track.preferredTransform).concatenating(flip(natural.height))
    }

    /// 顺序解码。每个时间点取「不早于它的第一帧」，裁剪 crop（正立坐标，左上角原点）并缩放到 outW 宽。
    func render(times: [Double], crop: CGRect, outW: CGFloat, quality: CGInterpolationQuality = .high,
                _ body: (Int, CGImage) -> Void) {
        guard let reader = try? AVAssetReader(asset: asset), !times.isEmpty else { return }
        reader.timeRange = CMTimeRange(start: CMTime(seconds: max(0, times[0] - 0.1), preferredTimescale: 600),
                                       end: CMTime(seconds: times[times.count - 1] + 0.6, preferredTimescale: 600))
        let out = AVAssetReaderTrackOutput(track: track, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
        out.alwaysCopiesSampleData = false
        reader.add(out)
        guard reader.startReading() else { return }
        let crop = crop.intersection(CGRect(origin: .zero, size: upright))
        let scale = outW / crop.width
        let outH = Int((crop.height * scale).rounded())
        guard let ctx = CGContext(data: nil, width: Int(outW), height: outH, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return }
        ctx.interpolationQuality = quality
        var i = 0
        while let sb = out.copyNextSampleBuffer() {
            guard let pb = CMSampleBufferGetImageBuffer(sb), let img = cgImage(from: pb) else { continue }
            let pts = CMSampleBufferGetPresentationTimeStamp(sb).seconds
            while i < times.count && pts >= times[i] - 0.001 {
                ctx.setFillColor(CGColor(gray: 0, alpha: 1))
                ctx.fill(CGRect(x: 0, y: 0, width: outW, height: CGFloat(outH)))
                ctx.saveGState()
                ctx.scaleBy(x: scale, y: scale)
                ctx.translateBy(x: -crop.minX, y: -(upright.height - crop.maxY))
                ctx.concatenate(ctm)
                ctx.draw(img, in: CGRect(x: 0, y: 0, width: natural.width, height: natural.height))
                ctx.restoreGState()
                if let frame = ctx.makeImage() { body(i, frame) }
                i += 1
            }
            if i >= times.count { reader.cancelReading(); break }
        }
    }
}

struct Sample {
    let t: Double
    let diff: Double
    let face: CGRect?  // 正立整帧像素坐标（左上角原点）
    let contour: Int
    let mouth: CGFloat // 外唇高度 / 脸高，用来判断是不是在说话
}

final class Source {
    let url: URL
    let index: Int
    let asset: AVAsset
    let frames: VideoFrames
    let duration: Double
    var samples: [Sample] = []
    var shots: [(start: Double, end: Double)] = []
    var tag: String { "素材\(index)" }

    init?(url: URL, index: Int) {
        guard let frames = VideoFrames(asset: AVURLAsset(url: url)) else { return nil }
        self.url = url
        self.index = index
        self.asset = frames.asset
        self.frames = frames
        duration = asset.duration.seconds
    }

    func still(at t: Double, max: CGFloat) -> CGImage? {
        let gen = AVAssetImageGenerator(asset: asset)
        gen.appliesPreferredTrackTransform = true
        gen.maximumSize = CGSize(width: max, height: max)
        gen.requestedTimeToleranceBefore = CMTime(seconds: 0.05, preferredTimescale: 600)
        gen.requestedTimeToleranceAfter = CMTime(seconds: 0.05, preferredTimescale: 600)
        return try? gen.copyCGImage(at: CMTime(seconds: clamp(t, 0, duration - 0.05), preferredTimescale: 600), actualTime: nil)
    }
}

// MARK: - Vision：人脸 / 人像掩码 / 字幕

func detectFace(_ img: CGImage) -> (box: CGRect, contour: Int, mouth: CGFloat)? {
    let req = VNDetectFaceLandmarksRequest()
    try? VNImageRequestHandler(cgImage: img, options: [:]).perform([req])
    guard let face = (req.results ?? []).max(by: { $0.boundingBox.width < $1.boundingBox.width }) else { return nil }
    let b = face.boundingBox
    var mouth: CGFloat = 0
    if let lips = face.landmarks?.outerLips, lips.normalizedPoints.count >= 8 {
        let ys = lips.normalizedPoints.map { $0.y }
        mouth = ((ys.max() ?? 0) - (ys.min() ?? 0)) / max(b.height, 0.001)
    }
    return (CGRect(x: b.minX, y: 1 - b.maxY, width: b.width, height: b.height), face.landmarks?.faceContour?.normalizedPoints.count ?? 0, mouth)
}

/// 人像分割掩码：直接读 Vision 输出的像素缓冲（仅 alpha 的单通道图，不能当普通图片画，否则全是黑的）。
/// 返回 (宽, 高, 每像素 0–255)，行 0 是顶部；尺寸可能与输入不同，用 maskAt 按比例采样。
func personMask(_ img: CGImage) -> (Int, Int, [UInt8])? {
    let req = VNGeneratePersonSegmentationRequest()
    req.qualityLevel = .accurate
    req.outputPixelFormat = kCVPixelFormatType_OneComponent8
    try? VNImageRequestHandler(cgImage: img, options: [:]).perform([req])
    guard let pb = req.results?.first?.pixelBuffer else { return nil }
    CVPixelBufferLockBaseAddress(pb, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(pb, .readOnly) }
    guard let base = CVPixelBufferGetBaseAddress(pb) else { return nil }
    let w = CVPixelBufferGetWidth(pb), h = CVPixelBufferGetHeight(pb), bpr = CVPixelBufferGetBytesPerRow(pb)
    let p = base.assumingMemoryBound(to: UInt8.self)
    var out = [UInt8](repeating: 0, count: w * h)
    for y in 0..<h { for x in 0..<w { out[y * w + x] = p[y * bpr + x] } }
    return (w, h, out)
}

/// 在掩码上按目标图尺寸做双线性采样
func maskAt(_ mask: (Int, Int, [UInt8]), size: (Int, Int), _ x: Double, _ y: Double) -> Double {
    let (mw, mh, m) = mask
    let fx = clamp(x * Double(mw) / Double(size.0) - 0.5, 0, Double(mw - 1))
    let fy = clamp(y * Double(mh) / Double(size.1) - 0.5, 0, Double(mh - 1))
    let x0 = Int(fx), y0 = Int(fy), x1 = min(mw - 1, x0 + 1), y1 = min(mh - 1, y0 + 1)
    let tx = fx - Double(x0), ty = fy - Double(y0)
    let top = Double(m[y0 * mw + x0]) * (1 - tx) + Double(m[y0 * mw + x1]) * tx
    let bot = Double(m[y1 * mw + x0]) * (1 - tx) + Double(m[y1 * mw + x1]) * tx
    return (top * (1 - ty) + bot * ty) / 255.0
}

let WATERMARKS = ["抖音", "douyin", "www", "http", "com", "AI助手", "美味", "蟹黄堡", "PELAR", "PELIR"]

/// 抖音水印、账号名、纯数字的抖音号，以及贴在画面四角的角标，都不算字幕
func isWatermark(_ l: (text: String, box: CGRect, conf: Float)) -> Bool {
    let t = l.text.lowercased()
    if WATERMARKS.contains(where: { t.contains($0.lowercased()) }) { return true }
    let digits = l.text.filter { $0.isNumber }.count
    if digits >= 4 && digits * 2 >= l.text.count { return true }
    // 全大写的英文串（抖音 Logo 被识别成 HOPELARS 之类）
    let letters = l.text.filter { $0.isLetter }
    if letters.count >= 5, letters.allSatisfy({ $0.isASCII && $0.isUppercase }) { return true }
    let (x, y) = (l.box.midX, l.box.midY)
    return (x > 0.7 && y < 0.24) || (x < 0.2 && y > 0.86) || (x > 0.8 && y > 0.86)
}

func ocrLines(_ img: CGImage) -> [(text: String, box: CGRect, conf: Float)] {
    let req = VNRecognizeTextRequest()
    req.recognitionLevel = .accurate
    req.recognitionLanguages = ["zh-Hans", "en-US"]
    req.usesLanguageCorrection = false
    try? VNImageRequestHandler(cgImage: img, options: [:]).perform([req])
    return (req.results ?? []).compactMap { obs in
        guard let c = obs.topCandidates(1).first else { return nil }
        return (c.string, obs.boundingBox, c.confidence)
    }
}

/// 从画面字幕里挑出一句：优先画面下半部分的大字，同一行的拼在一起
func pickSubtitle(_ lines: [(text: String, box: CGRect, conf: Float)]) -> String {
    let usable = lines.filter { l in l.conf >= 0.5 && !isWatermark(l) && l.text.count >= 2 }
    let lower = usable.filter { $0.box.midY < 0.55 }
    guard let best = (lower.isEmpty ? usable : lower).max(by: { $0.box.height < $1.box.height }) else { return "" }
    let row = lines.filter { l in
        abs(l.box.midY - best.box.midY) < 0.06 && l.conf >= 0.3 && !isWatermark(l)
    }.sorted { $0.box.minX < $1.box.minX }
    return row.map { $0.text }.joined()
}

/// 只保留文字和数字，去掉文件名里不能用的符号
func sanitizeName(_ s: String, limit: Int = 14) -> String {
    var out = ""
    for ch in s where ch.isLetter || ch.isNumber {
        out.append(ch)
        if out.count >= limit { break }
    }
    return out
}

// MARK: - 抠头

/// 「头部区域」系数：脖子半宽、下巴以下保留、两侧斜率、最大半宽、下颌弧度（都相对脸框）
struct HeadCut { var halfW = 0.5; var cutBelow = 0.08; var slope = 1.1; var maxHalf = 1.9; var curve = 0.12 }

/// 返回每个像素的保留系数：人像掩码 × 头部区域，再向内收 1px 去掉背景毛边（face 用目标图像素坐标）
func headAlpha(mask: (Int, Int, [UInt8]), size: (Int, Int), face: CGRect, cut: HeadCut) -> [UInt8] {
    let (w, h) = size
    guard face.width > 1, face.height > 1 else { return [UInt8](repeating: 255, count: w * h) }
    let fw = Double(face.width), fh = Double(face.height)
    let cx = Double(face.midX)
    let y0 = Double(face.maxY) + cut.cutBelow * fh
    let feather = 0.05 * fh
    var a = [Double](repeating: 0, count: w * h)
    for y in 0..<h {
        let dy = Double(y)
        for x in 0..<w {
            let d = abs(Double(x) - cx)
            if d > cut.maxHalf * fw { continue }
            let r = min(1, d / (cut.halfW * fw))
            let yCut = y0 - cut.curve * fh * r * r - cut.slope * max(0, d - cut.halfW * fw)
            let k = (1 - smoothstep(yCut - feather, yCut + feather, dy)) * (1 - smoothstep(cut.maxHalf * fw - 0.15 * fw, cut.maxHalf * fw, d))
            if k <= 0 { continue }
            a[y * w + x] = maskAt(mask, size: size, Double(x), dy) * k
        }
    }
    var out = [UInt8](repeating: 0, count: w * h)
    for y in 0..<h {
        for x in 0..<w {
            var v = a[y * w + x]
            if v > 0 {
                for yy in max(0, y - 1)...min(h - 1, y + 1) {
                    for xx in max(0, x - 1)...min(w - 1, x + 1) { v = min(v, a[yy * w + xx]) }
                }
            }
            out[y * w + x] = UInt8(max(0, min(255, (v * 255).rounded())))
        }
    }
    return out
}

/// 只保留从 seed 出发连通的那一块（脸和连着的头发），旁边的人、离得远的物体都会被清掉。
/// seed 落在透明像素上时，在附近找一个不透明的点再开始。
func keepConnected(_ alpha: inout [UInt8], w: Int, h: Int, seed: (Int, Int)) {
    func solid(_ x: Int, _ y: Int) -> Bool { x >= 0 && y >= 0 && x < w && y < h && alpha[y * w + x] > 40 }
    var start: (Int, Int)? = nil
    if solid(seed.0, seed.1) { start = seed } else {
        var best: (Int, Int)? = nil
        var bestA: UInt8 = 0
        for dy in -40...40 { for dx in -40...40 {
            let x = seed.0 + dx, y = seed.1 + dy
            if solid(x, y), alpha[y * w + x] > bestA { bestA = alpha[y * w + x]; best = (x, y) }
        } }
        start = best
    }
    guard let s0 = start else { return }
    var seen = [UInt8](repeating: 0, count: w * h)
    var stack = [s0.0 + s0.1 * w]
    seen[stack[0]] = 1
    while let p = stack.popLast() {
        let x = p % w, y = p / w
        for (dx, dy) in [(-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (1, -1), (-1, 1), (1, 1)] {
            let nx = x + dx, ny = y + dy
            if solid(nx, ny), seen[ny * w + nx] == 0 { seen[ny * w + nx] = 1; stack.append(ny * w + nx) }
        }
    }
    // 边缘 2 像素的羽化带也留着，别把抗锯齿边切掉
    for y in 0..<h { for x in 0..<w where seen[y * w + x] == 0 {
        var near = false
        if alpha[y * w + x] > 0 {
            loop: for dy in -2...2 { for dx in -2...2 { if solid(x + dx, y + dy), seen[(y + dy) * w + (x + dx)] == 1 { near = true; break loop } } }
        }
        if !near { alpha[y * w + x] = 0 }
    } }
}

/// 静态抠头：整帧里抠出头，裁掉空白，导出透明 PNG
func cutHeadStill(_ img: CGImage, face: CGRect, to url: URL) -> Bool {
    let w = img.width, h = img.height
    guard let mask = personMask(img) else { return false }
    var alpha = headAlpha(mask: mask, size: (w, h), face: face, cut: HeadCut())
    keepConnected(&alpha, w: w, h: h, seed: (Int(face.midX), Int(face.minY + face.height * 0.45)))
    // 原图分辨率较高时先缩小，控制文件体积
    let k = min(1.0, 720.0 / Double(max(w, h)))
    let ow = Int(Double(w) * k), oh = Int(Double(h) * k)
    let out = CGContext(data: nil, width: ow, height: oh, bitsPerComponent: 8, bytesPerRow: ow * 4, space: CGColorSpaceCreateDeviceRGB(),
                        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    out.interpolationQuality = .high
    out.draw(img, in: CGRect(x: 0, y: 0, width: ow, height: oh))
    guard let op = out.data?.assumingMemoryBound(to: UInt8.self) else { return false }
    var minX = ow, minY = oh, maxX = 0, maxY = 0
    for y in 0..<oh {
        for x in 0..<ow {
            let i = y * ow + x
            let sx = min(w - 1, Int(Double(x) / k)), sy = min(h - 1, Int(Double(y) / k))
            let a = Double(alpha[sy * w + sx]) / 255.0
            op[i * 4] = UInt8(Double(op[i * 4]) * a)
            op[i * 4 + 1] = UInt8(Double(op[i * 4 + 1]) * a)
            op[i * 4 + 2] = UInt8(Double(op[i * 4 + 2]) * a)
            op[i * 4 + 3] = UInt8(a * 255)
            if a > 0.5 { minX = min(minX, x); maxX = max(maxX, x); minY = min(minY, y); maxY = max(maxY, y) }
        }
    }
    guard maxX > minX + 8, maxY > minY + 8 else { return false }
    let crop = CGRect(x: max(0, minX - 6), y: max(0, minY - 6), width: min(ow, maxX - minX + 13), height: min(oh, maxY - minY + 13))
    guard let cropped = out.makeImage()?.cropping(to: crop) else { return false }
    guard let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else { return false }
    CGImageDestinationAddImage(dest, cropped, nil)
    return CGImageDestinationFinalize(dest)
}

/// 头部特写的裁剪框（正立坐标），比例与桌宠的头像框一致
func headCrop(face: CGRect, in size: CGSize, aspect: CGFloat = 152.0 / 186.0) -> CGRect {
    let fh = max(face.height * 2.6, face.width * 1.7)
    let fw = fh * aspect
    var r = CGRect(x: face.midX - fw / 2, y: face.minY - face.height * 0.95, width: fw, height: fh)
    if r.width > size.width || r.height > size.height {
        let s = min(size.width / r.width, size.height / r.height)
        r = CGRect(x: r.midX - r.width * s / 2, y: r.minY, width: r.width * s, height: r.height * s)
    }
    r.origin.x = clamp(r.origin.x, 0, size.width - r.width)
    r.origin.y = clamp(r.origin.y, 0, size.height - r.height)
    return r.integral
}

// MARK: - 分析：镜头切分 + 人脸 + 说话程度

func analyze(_ src: Source) {
    let small: CGFloat = src.frames.upright.width >= src.frames.upright.height ? 640 : 360
    var times: [Double] = []
    for t in stride(from: 0.0, to: src.duration, by: 0.25) { times.append(t) }
    // 检测结果是 0–1 的归一化坐标，换算成正立整帧的像素坐标
    let uw = src.frames.upright.width, uh = src.frames.upright.height
    var prev: [UInt8]? = nil
    var samples: [Sample] = []
    src.frames.render(times: times, crop: CGRect(origin: .zero, size: src.frames.upright), outW: small, quality: .medium) { i, img in
        var diff = 0.0
        if let (ctx, px) = pixels(img, gray: true) {
            let w = ctx.width, h = ctx.height
            let cur = Array(UnsafeBufferPointer(start: px, count: w * h))
            if let p = prev {
                var sum = 0
                let n = w * h
                for k in stride(from: 0, to: n, by: 7) { sum += abs(Int(cur[k]) - Int(p[k])) }
                diff = Double(sum) / Double((n + 6) / 7)
            }
            prev = cur
        }
        var face: CGRect? = nil
        var contour = 0
        var mouth: CGFloat = 0
        if let f = detectFace(img) {
            face = CGRect(x: f.box.minX * uw, y: f.box.minY * uh, width: f.box.width * uw, height: f.box.height * uh)
            contour = f.contour
            mouth = f.mouth
        }
        samples.append(Sample(t: times[i], diff: diff, face: face, contour: contour, mouth: mouth))
    }
    src.samples = samples
    var bounds: [Double] = [0]
    for s in samples where s.diff > 24 && s.t > 0.4 { bounds.append(s.t) }
    bounds.append(src.duration)
    var shots: [(Double, Double)] = []
    for i in 0..<(bounds.count - 1) {
        let a = bounds[i], b = bounds[i + 1]
        if b - a < 0.5, let last = shots.indices.last { shots[last].1 = b } else { shots.append((a, b)) }
    }
    src.shots = shots
}

func samples(in range: ClosedRange<Double>, of samples: [Sample]) -> [Sample] {
    samples.filter { $0.t >= range.lowerBound && $0.t <= range.upperBound }
}

// MARK: - 配音：按语音停顿分段

func audioSegments(_ src: Source) -> [(Double, Double)] {
    guard let track = src.asset.tracks(withMediaType: .audio).first, let reader = try? AVAssetReader(asset: src.asset) else { return [] }
    let out = AVAssetReaderTrackOutput(track: track, outputSettings: [
        AVFormatIDKey: kAudioFormatLinearPCM, AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false,
        AVLinearPCMIsBigEndianKey: false, AVLinearPCMIsNonInterleaved: false,
    ])
    reader.add(out)
    guard reader.startReading() else { return [] }
    var mono: [Double] = []
    var rate = 0.0
    var channels = 1
    while let sb = out.copyNextSampleBuffer() {
        if rate == 0, let fd = CMSampleBufferGetFormatDescription(sb),
           let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(fd)?.pointee {
            rate = asbd.mSampleRate
            channels = max(1, Int(asbd.mChannelsPerFrame))
        }
        guard let bb = CMSampleBufferGetDataBuffer(sb) else { continue }
        var length = 0
        var ptr: UnsafeMutablePointer<Int8>?
        guard CMBlockBufferGetDataPointer(bb, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &length, dataPointerOut: &ptr) == noErr,
              let p = ptr, length > 0 else { continue }
        p.withMemoryRebound(to: Int16.self, capacity: length / 2) { sp in
            let n = length / 2
            var i = 0
            while i + channels <= n {
                var sum = 0.0
                for c in 0..<channels { sum += Double(sp[i + c]) }
                mono.append(sum / Double(channels))
                i += channels
            }
        }
    }
    guard rate > 0, mono.count > Int(rate) else { return [] }
    let hop = Int(rate * 0.02)
    var db: [Double] = []
    for s in stride(from: 0, to: mono.count - hop, by: hop) {
        var sum = 0.0
        for k in s..<(s + hop) { sum += mono[k] * mono[k] }
        db.append(20 * log10(max(sqrt(sum / Double(hop)) / 32768.0, 1e-7)))
    }
    let smooth = db.enumerated().map { i, _ in (max(0, i - 2)...min(db.count - 1, i + 2)).reduce(0.0) { $0 + db[$1] } / 5 }
    let sorted = smooth.sorted()
    let noise = sorted[sorted.count / 10], peak = sorted[sorted.count * 95 / 100]
    let thr = max(noise + 6, peak - 26)
    var voiced = smooth.map { $0 > thr }
    for _ in 0..<12 { voiced = voiced.enumerated().map { i, v in (i > 0 && voiced[i - 1]) || v || (i + 1 < voiced.count && voiced[i + 1]) } }
    var runs: [(Double, Double)] = []
    var start = -1
    for (i, v) in voiced.enumerated() {
        if v && start < 0 { start = i }
        if !v && start >= 0 { runs.append((Double(start) * 0.02, Double(i) * 0.02)); start = -1 }
    }
    if start >= 0 { runs.append((Double(start) * 0.02, src.duration)) }
    runs = runs.filter { $0.1 - $0.0 >= 0.4 }
    var merged: [(Double, Double)] = []
    for r in runs {
        if let last = merged.last, r.0 - last.1 < 0.45 { merged[merged.count - 1].1 = r.1 } else { merged.append(r) }
    }
    // 太长的在能量最低处切开，最长 12 秒
    var result: [(Double, Double)] = []
    func split(_ seg: (Double, Double)) {
        if seg.1 - seg.0 <= 12 || result.count > 60 { result.append(seg); return }
        let lo = Int(seg.0 / 0.02), hi = Int(seg.1 / 0.02)
        var bestI = (lo + hi) / 2, bestV = Double.greatestFiniteMagnitude
        for i in (lo + Int(2.5 / 0.02))..<(hi - Int(2.5 / 0.02)) where smooth[i] < bestV {
            bestV = smooth[i]; bestI = i
        }
        split((seg.0, Double(bestI) * 0.02)); split((Double(bestI) * 0.02, seg.1))
    }
    for seg in merged { split(seg) }
    return result
        .map { (max(0, $0.0 - 0.08), min(src.duration, $0.1 + 0.2)) }
        .filter { $0.1 - $0.0 >= 0.6 }
}

// MARK: - 主流程

struct IndexItem: Codable {
    var file: String
    var base: String   // 不含文字说明的文件名主体
    var kind: String   // 头像 / 头像动态 / 动态视频 / 配音
    var source: Int
    var start: Double
    var end: Double
}

/// 文件名 = 主体 + "-" + 说明
func named(_ base: String, _ desc: String, _ ext: String, _ counts: inout [String: Int]) -> (name: String, base: String) {
    let name = uniqueName(&counts, desc.isEmpty ? base : base + "-" + desc, ext)
    return (name, base)
}


// MARK: - 说明表（字幕 OCR 不准时人工校对用）

struct Sub: Codable { var from: Double; var to: Double; var text: String }
struct SourceTable: Codable { var perSubtitle: Bool? = nil; var subs: [Sub] }
typealias Table = [String: SourceTable]

/// 某个时间段对应的文字：先取有时间重叠的条目；没有重叠就取最近的一条（0.6 秒内）
func tableText(_ table: Table?, _ tag: String, _ start: Double, _ end: Double, maxPieces: Int = 2) -> String {
    guard let subs = table?[tag]?.subs, !subs.isEmpty else { return "" }
    func gap(_ s: Sub) -> Double { start > s.to ? start - s.to : (end < s.from ? s.from - end : 0) }
    var picked: [String] = []
    for sub in subs where gap(sub) == 0 && (end - start < 0.05 || min(sub.to, end) - max(sub.from, start) >= 0.25) {
        let t = sanitizeName(sub.text, limit: 12)
        if !t.isEmpty && !picked.contains(t) { picked.append(t) }
    }
    if picked.isEmpty, let near = subs.min(by: { gap($0) < gap($1) }), gap(near) <= 0.6 {
        picked = [sanitizeName(near.text, limit: 14)]
    }
    if picked.count > maxPieces { picked = Array(picked.prefix(maxPieces - 1)) + [picked[picked.count - 1]] }
    return picked.joined(separator: "-")
}

/// 说明表优先；没有就退回画面字幕 OCR；再没有就写「无字幕」
func describe(_ src: Source, _ range: (Double, Double), _ table: Table?, maxPieces: Int = 2) -> String {
    let t = tableText(table, src.tag, range.0, range.1, maxPieces: maxPieces)
    if !t.isEmpty { return t }
    let o = subtitle(src, range: range)
    return o.isEmpty ? "无字幕" : o
}

/// 写出索引（给重命名用）和给人看的素材清单
func writeManifest(_ index: [IndexItem], to outDir: URL) throws {
    let enc = JSONEncoder()
    enc.outputFormatting = [.prettyPrinted, .sortedKeys]
    try (try enc.encode(index)).write(to: outDir.appendingPathComponent("_index.json"))
    var lines = "白小纯桌宠 · 素材清单（共 \(index.count) 个）\n"
    lines += "文件名里带「s」的是在原视频里的起始时间；「素材N」是视频目录里按文件名排序的第 N 个视频。\n"
    lines += "类型：头像 = 透明底静态抠头（PNG）；头像-动态 = 透明底会动的抠头（动态 PNG）；动态视频 = 2–3 秒头部特写（MP4）；配音 = 分段音频（M4A）。\n\n"
    for item in index.sorted(by: { ($0.source, $0.start) < ($1.source, $1.start) }) {
        lines += "[\(item.kind)] \(item.file)    ← 素材\(item.source) \(String(format: "%.1f", item.start))s–\(String(format: "%.1f", item.end))s\n"
    }
    try lines.write(to: outDir.appendingPathComponent("素材清单.txt"), atomically: true, encoding: .utf8)
}

func uniqueName(_ counts: inout [String: Int], _ base: String, _ ext: String) -> String {
    let count = (counts[base] ?? 0) + 1
    counts[base] = count
    return count == 1 ? "\(base).\(ext)" : "\(base)-\(count).\(ext)"
}

/// 某一时刻画面上的字幕（OCR）
func subtitle(_ src: Source, at t: Double) -> String {
    guard let img = src.still(at: t, max: 1280) else { return "" }
    return sanitizeName(pickSubtitle(ocrLines(img)))
}

/// 一段时间里出现过的字幕：最多取两句
func subtitle(_ src: Source, range: (Double, Double)) -> String {
    var parts: [String] = []
    for f in [0.15, 0.5, 0.85] {
        let s = subtitle(src, at: range.0 + (range.1 - range.0) * f)
        if !s.isEmpty && !parts.contains(s) { parts.append(s) }
        if parts.count >= 2 { break }
    }
    return parts.joined(separator: "-")
}

/// 导出 2–3 秒的头部特写视频（H.264，15 帧，无声）
func writeMP4(_ src: Source, start: Double, end: Double, crop: CGRect, to url: URL) -> Bool {
    let outW = 400
    let outH = Int((crop.height * 400 / crop.width).rounded()) / 2 * 2
    var times: [Double] = []
    for t in stride(from: start, to: end, by: 1.0 / 15.0) { times.append(t) }
    guard let writer = try? AVAssetWriter(outputURL: url, fileType: .mp4) else { return false }
    let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
        AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: outW, AVVideoHeightKey: outH,
        AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 2_400_000, AVVideoProfileLevelKey: AVVideoProfileLevelH264MainAutoLevel],
    ])
    input.expectsMediaDataInRealTime = false
    let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA, kCVPixelBufferWidthKey as String: outW, kCVPixelBufferHeightKey as String: outH,
    ])
    writer.add(input)
    guard writer.startWriting() else { return false }
    writer.startSession(atSourceTime: .zero)
    var written = 0
    src.frames.render(times: times, crop: crop, outW: CGFloat(outW)) { i, img in
        while !input.isReadyForMoreMediaData { usleep(1000) } // 编码器没就绪就等，不能丢帧
        var pb: CVPixelBuffer?
        CVPixelBufferCreate(kCFAllocatorDefault, outW, outH, kCVPixelFormatType_32BGRA,
                            [kCVPixelBufferCGImageCompatibilityKey: true, kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary, &pb)
        guard let buffer = pb else { return }
        CVPixelBufferLockBaseAddress(buffer, [])
        if let c = CGContext(data: CVPixelBufferGetBaseAddress(buffer), width: outW, height: outH, bitsPerComponent: 8,
                             bytesPerRow: CVPixelBufferGetBytesPerRow(buffer), space: CGColorSpaceCreateDeviceRGB(),
                             bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue) {
            c.draw(img, in: CGRect(x: 0, y: 0, width: outW, height: outH))
        }
        CVPixelBufferUnlockBaseAddress(buffer, [])
        // 最后一帧再写一次，保证片尾时长正确
        adaptor.append(buffer, withPresentationTime: CMTime(seconds: times[i] - start, preferredTimescale: 600))
        if i == times.count - 1 {
            adaptor.append(buffer, withPresentationTime: CMTime(seconds: end - start, preferredTimescale: 600))
        }
        written += 1
    }
    input.markAsFinished()
    let done = DispatchSemaphore(value: 0)
    writer.finishWriting { done.signal() }
    done.wait()
    return writer.status == .completed && written == times.count
}

/// 透明底的动态抠头（APNG，每秒 10 帧）：逐帧做人像分割，只保留头部
func writeAPNGHead(_ src: Source, start: Double, end: Double, crop: CGRect, seedFace: CGRect, to url: URL) -> Bool {
    let outW = Int(min(340, max(200, crop.width)).rounded())
    var times: [Double] = []
    for t in stride(from: start, to: end - 0.05, by: 0.1) { times.append(t) }
    var frames: [(w: Int, h: Int, px: [UInt8])] = []
    var lastFace: CGRect? = seedFace
    src.frames.render(times: times, crop: crop, outW: CGFloat(outW)) { _, img in
        let w = img.width, h = img.height
        // 注意：ctx 必须一直持有到像素用完，否则上下文释放后 rgb 指向的内存会失效
        guard let (ctx, rgb) = pixels(img, gray: false), let mask = personMask(img) else { return }
        var face: CGRect? = nil
        if let f = detectFace(img) {
            let box = CGRect(x: f.box.minX * CGFloat(w), y: f.box.minY * CGFloat(h), width: f.box.width * CGFloat(w), height: f.box.height * CGFloat(h))
            if let l = lastFace, abs(l.midX - box.midX) < CGFloat(w) * 0.3, abs(l.midY - box.midY) < CGFloat(h) * 0.3 {
                face = CGRect(x: l.minX * 0.6 + box.minX * 0.4, y: l.minY * 0.6 + box.minY * 0.4, width: l.width * 0.6 + box.width * 0.4, height: l.height * 0.6 + box.height * 0.4)
            } else { face = box }
            lastFace = face
        }
        let use = face ?? lastFace ?? CGRect(x: 0, y: 0, width: w / 3, height: h / 4)
        var alpha = headAlpha(mask: mask, size: (w, h), face: use, cut: HeadCut())
        keepConnected(&alpha, w: w, h: h, seed: (Int(use.midX), Int(use.minY + use.height * 0.45)))
        var px = [UInt8](repeating: 0, count: w * h * 4)
        for i in 0..<(w * h) {
            px[i * 4] = rgb[i * 4]
            px[i * 4 + 1] = rgb[i * 4 + 1]
            px[i * 4 + 2] = rgb[i * 4 + 2]
            px[i * 4 + 3] = alpha[i]
        }
        frames.append((w, h, px))
        _ = ctx
    }
    guard frames.count >= 3, (try? writeAPNG(url, frames: frames, delayMs: 100)) != nil else { return false }
    return true
}

func run(videosDir: URL, outDir: URL, only: Int?, table: Table?) throws {
    let fm = FileManager.default
    let videos = try fm.contentsOfDirectory(at: videosDir, includingPropertiesForKeys: nil)
        .filter { ["mp4", "mov", "m4v"].contains($0.pathExtension.lowercased()) }
        .sorted { $0.lastPathComponent < $1.lastPathComponent }
    let dirs = ["头像", "视频", "配音"].map { outDir.appendingPathComponent($0, isDirectory: true) }
    for d in dirs { try fm.createDirectory(at: d, withIntermediateDirectories: true) }
    var index: [IndexItem] = []
    var counts: [String: Int] = [:]

    for (i, url) in videos.enumerated() {
        guard let src = Source(url: url, index: i + 1), only == nil || only == i + 1 else { continue }
        let t0 = Date()
        analyze(src)
        let short = src.duration < 6
        let faces = src.samples.compactMap { s in s.face.map { (s, $0) } }.filter { $0.1.width >= (short ? 120 : 100) }
        print("[\(src.tag)] \(url.lastPathComponent) \(String(format: "%.1f", src.duration))s \(Int(src.frames.upright.width))x\(Int(src.frames.upright.height))"
            + " 镜头 \(src.shots.count) 有人脸采样 \(faces.count)/\(src.samples.count)")

        // 1) 静态抠头：每个镜头只取一张（脸最大、嘴闭着的），再按脸从大到小排序，相近的只留一张
        var kept = 0
        var seen: [[UInt8]] = []
        var perShot: [(t: Double, width: CGFloat)] = []
        for shot in src.shots {
            let inShot = faces.filter { $0.0.t >= shot.start && $0.0.t <= shot.end }
            guard !inShot.isEmpty else { continue }
            let top = inShot.sorted { $0.1.width * CGFloat($0.0.contour) > $1.1.width * CGFloat($1.0.contour) }.prefix(3)
            if let best = top.min(by: { $0.0.mouth < $1.0.mouth }) { perShot.append((best.0.t, best.1.width)) }
        }
        for cand in perShot.sorted(by: { $0.width > $1.width }) {
            if kept >= (short ? 3 : 12) { break }
            guard let img = src.still(at: cand.t, max: 1400), let f = detectFace(img) else { continue }
            let kx = CGFloat(img.width), ky = CGFloat(img.height)
            let facePx = CGRect(x: f.box.minX * kx, y: f.box.minY * ky, width: f.box.width * kx, height: f.box.height * ky)
            guard let (sigCtx, sigPx) = pixels(img, gray: true) else { continue }
            var sig = [UInt8]()
            for yy in 0..<24 { for xx in 0..<24 {
                let px = Int(facePx.minX * CGFloat(sigCtx.width) + CGFloat(xx) * facePx.width * CGFloat(sigCtx.width) / 24)
                let py = Int(facePx.minY * CGFloat(sigCtx.height) + CGFloat(yy) * facePx.height * CGFloat(sigCtx.height) / 24)
                sig.append(sigPx[min(sigCtx.height - 1, py) * sigCtx.width + min(sigCtx.width - 1, px)])
            } }
            if seen.contains(where: { other in
                var sum = 0
                for k in 0..<576 { sum += abs(Int(sig[k]) - Int(other[k])) }
                return sum < 576 * 9
            }) { continue }
            seen.append(sig)
            let n = named("头像-\(src.tag)-\(String(format: "%.1f", cand.t))s", describe(src, (cand.t, cand.t), table), "png", &counts)
            if cutHeadStill(img, face: facePx, to: dirs[0].appendingPathComponent(n.name)) {
                kept += 1
                index.append(IndexItem(file: "头像/" + n.name, base: n.base, kind: "头像", source: src.index, start: cand.t, end: cand.t))
            }
        }

        // 2) 动态视频：每个有人脸的镜头里挑最能看出在说话的 2.5 秒
        var clips: [(start: Double, end: Double, crop: CGRect, score: Double, face: CGRect, midFace: CGRect)] = []
        for shot in src.shots where shot.end - shot.start >= (short ? 1.0 : 1.8) {
            let ss = samples(in: shot.start...shot.end, of: src.samples)
            let fs = ss.compactMap { s in s.face.map { (s, $0) } }
            guard !fs.isEmpty, Double(fs.count) / Double(max(ss.count, 1)) >= 0.6 else { continue }
            let meanW = fs.map { $0.1.width }.reduce(0, +) / CGFloat(fs.count)
            guard meanW >= (short ? 120 : 130) else { continue }
            let len = min(2.5, shot.end - shot.start - 0.05)
            var best: (Double, Double, Double) = (shot.start, shot.start + len, -1)
            var ws = shot.start
            while ws + len <= shot.end + 0.001 {
                let win = samples(in: (ws + 0.05)...(ws + len - 0.05), of: src.samples)
                let mouths = win.compactMap { $0.face == nil ? nil : $0.mouth }
                let motion = mouths.isEmpty ? 0 : Double((mouths.max()! - mouths.min()!) / max(mouths.reduce(0, +) / CGFloat(mouths.count), 0.01))
                if motion > best.2 { best = (ws, ws + len, motion) }
                ws += 0.25
            }
            let win = samples(in: (best.0)...(best.1), of: src.samples).compactMap { $0.face }
            let union = win.dropFirst().reduce(win[0]) { $0.union($1) }
            let crop = headCrop(face: union, in: src.frames.upright)
            let score = Double(meanW) * (1 + 3 * best.2)
            let midFace = win[win.count / 2].insetBy(dx: -win[win.count / 2].width * 0.15, dy: -win[win.count / 2].height * 0.15)
            clips.append((best.0, best.1, crop, score, union, midFace))
        }
        clips.sort { $0.score > $1.score }
        clips = Array(clips.prefix(short ? 2 : 8))
        for c in clips {
            let n = named("动态视频-\(src.tag)-\(String(format: "%.1f", c.start))s", describe(src, (c.start, c.end), table), "mp4", &counts)
            if writeMP4(src, start: c.start, end: c.end, crop: c.crop, to: dirs[1].appendingPathComponent(n.name)) {
                index.append(IndexItem(file: "视频/" + n.name, base: n.base, kind: "动态视频", source: src.index, start: c.start, end: c.end))
            }
        }

        // 3) 动态抠头（透明底 APNG）：脸足够大的片段
        for c in clips.prefix(short ? 2 : 5) where c.face.width >= 150 {
            let n = named("头像-动态-\(src.tag)-\(String(format: "%.1f", c.start))s", describe(src, (c.start, c.end), table), "png", &counts)
            let crop = headCrop(face: c.midFace, in: src.frames.upright)
            let seed = CGRect(x: c.midFace.minX - crop.minX, y: c.midFace.minY - crop.minY, width: c.midFace.width, height: c.midFace.height)
            if writeAPNGHead(src, start: c.start, end: c.end, crop: crop, seedFace: seed, to: dirs[0].appendingPathComponent(n.name)) {
                index.append(IndexItem(file: "头像/" + n.name, base: n.base, kind: "头像动态", source: src.index, start: c.start, end: c.end))
            }
        }

        // 4) 配音：默认按语音停顿分段；说明表标了「一句一条」的（perSubtitle），直接按每句字幕切
        var segs: [(Double, Double, String)] = audioSegments(src).map { ($0.0, $0.1, describe(src, $0, table, maxPieces: 3)) }
        if let st = table?[src.tag], st.perSubtitle == true, !st.subs.isEmpty {
            var bySub: [(Double, Double, String)] = []
            for sub in st.subs {
                let text = sanitizeName(sub.text, limit: 16)
                if !bySub.isEmpty, sub.from - bySub[bySub.count - 1].1 < 0.35 {
                    bySub[bySub.count - 1].1 = sub.to + 0.18
                    bySub[bySub.count - 1].2 += "-" + text
                } else {
                    bySub.append((max(0, sub.from - 0.12), sub.to + 0.18, text))
                }
            }
            if let first = bySub.first, first.0 > 1.5 { bySub.insert((0, first.0 - 0.2, "开场"), at: 0) } // 字幕开始前的片头
            segs = bySub
        }
        for seg in segs {
            let n = named("配音-\(src.tag)-\(String(format: "%.1f", seg.0))s", seg.2, "m4a", &counts)
            guard let export = AVAssetExportSession(asset: src.asset, presetName: AVAssetExportPresetAppleM4A) else { continue }
            let out = dirs[2].appendingPathComponent(n.name)
            try? fm.removeItem(at: out)
            export.outputURL = out
            export.outputFileType = .m4a
            export.timeRange = CMTimeRange(start: CMTime(seconds: seg.0, preferredTimescale: 600), end: CMTime(seconds: min(seg.1, src.duration), preferredTimescale: 600))
            let done = DispatchSemaphore(value: 0)
            export.exportAsynchronously { done.signal() }
            done.wait()
            if export.status == .completed {
                index.append(IndexItem(file: "配音/" + n.name, base: n.base, kind: "配音", source: src.index, start: seg.0, end: seg.1))
            }
        }
        print("   头像 \(kept) 动态视频 \(clips.count) 配音 \(segs.count) 用时 \(String(format: "%.0f", Date().timeIntervalSince(t0)))s")
    }

    try writeManifest(index, to: outDir)
    print("完成：\(index.count) 个文件 → \(outDir.path)")
}

/// 按说明表给已经提取好的文件重新命名（提取时字幕还没校对完的情况）
func rename(outDir: URL, table: Table) throws {
    let fm = FileManager.default
    let idxURL = outDir.appendingPathComponent("_index.json")
    var index = try JSONDecoder().decode([IndexItem].self, from: Data(contentsOf: idxURL))
    var counts: [String: Int] = [:]
    for i in index.indices {
        let item = index[i]
        let range: (Double, Double) = item.kind == "配音" ? (item.start, item.end) : (item.start + 0.2, item.start + 0.2)
        let desc = tableText(table, "素材\(item.source)", range.0, range.1, maxPieces: item.kind == "配音" ? 3 : 2)
        guard !desc.isEmpty else { continue }
        let ext = (item.file as NSString).pathExtension
        let dir = (item.file as NSString).deletingLastPathComponent
        let name = uniqueName(&counts, item.base + "-" + desc, ext)
        try fm.moveItem(at: outDir.appendingPathComponent(item.file), to: outDir.appendingPathComponent(dir).appendingPathComponent(name))
        index[i].file = dir + "/" + name
    }
    try writeManifest(index, to: outDir)
    print("已按说明表重命名，共 \(index.count) 个文件")
}

func loadTable(_ path: String) throws -> Table {
    try JSONDecoder().decode(Table.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
}

let args = CommandLine.arguments
guard args.count >= 3 else {
    print("usage: media-pipeline <视频目录> <输出目录> [--only=N] [--table=说明表.json] | --name 说明表.json")
    exit(1)
}
let videosDir = URL(fileURLWithPath: args[1])
let outDir = URL(fileURLWithPath: args[2])
func option(_ flag: String) -> String? {
    guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return nil }
    return args[i + 1]
}
if let name = option("--name") {
    try rename(outDir: outDir, table: loadTable(name))
} else {
    var only: Int? = nil
    if let o = args.first(where: { $0.hasPrefix("--only=") }) { only = Int(o.dropFirst(7)) }
    try run(videosDir: videosDir, outDir: outDir, only: only, table: try option("--table").map(loadTable))
}
