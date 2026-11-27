// 生成冒烟测试用的极小素材：带声音的小视频、一段音频、一张透明底图片。
// 用法: swiftc -O -o gen-fixtures gen-fixtures.swift && ./gen-fixtures <输出目录>
import Foundation
import AVFoundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

let outDir = URL(fileURLWithPath: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "test/fixtures")
try FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)

/// 生成 Linear PCM 的采样缓冲，交给 AVAssetWriter 去编码成 AAC
func pcmBuffer(tone: Double, seconds: Double, rate: Double, at pts: CMTime, frames: Int) -> CMSampleBuffer? {
    var samples = [Int16]()
    let start = Int(pts.seconds * rate)
    for i in 0..<frames {
        let t = Double(start + i) / rate
        let on = t < seconds
        samples.append(on ? Int16(sin(2 * .pi * tone * t) * 9000) : 0)
    }
    var asbd = AudioStreamBasicDescription(mSampleRate: rate, mFormatID: kAudioFormatLinearPCM,
                                           mFormatFlags: kLinearPCMFormatFlagIsSignedInteger | kLinearPCMFormatFlagIsPacked,
                                           mBytesPerPacket: 2, mFramesPerPacket: 1, mBytesPerFrame: 2, mChannelsPerFrame: 1,
                                           mBitsPerChannel: 16, mReserved: 0)
    var fmt: CMAudioFormatDescription?
    CMAudioFormatDescriptionCreate(allocator: kCFAllocatorDefault, asbd: &asbd, layoutSize: 0, layout: nil,
                                   magicCookieSize: 0, magicCookie: nil, extensions: nil, formatDescriptionOut: &fmt)
    guard let fmt = fmt else { return nil }
    let data = samples.withUnsafeBufferPointer { Data(buffer: $0) }
    var bb: CMBlockBuffer?
    CMBlockBufferCreateWithMemoryBlock(allocator: kCFAllocatorDefault, memoryBlock: nil, blockLength: data.count,
                                       blockAllocator: kCFAllocatorDefault, customBlockSource: nil, offsetToData: 0,
                                       dataLength: data.count, flags: kCMBlockBufferAssureMemoryNowFlag, blockBufferOut: &bb)
    guard let block = bb else { return nil }
    data.withUnsafeBytes { _ = CMBlockBufferReplaceDataBytes(with: $0.baseAddress!, blockBuffer: block, offsetIntoDestination: 0, dataLength: data.count) }
    var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: Int32(rate)), presentationTimeStamp: pts, decodeTimeStamp: .invalid)
    var sb: CMSampleBuffer?
    CMSampleBufferCreate(allocator: kCFAllocatorDefault, dataBuffer: block, dataReady: true, makeDataReadyCallback: nil, refcon: nil,
                         formatDescription: fmt, sampleCount: frames, sampleTimingEntryCount: 1, sampleTimingArray: &timing,
                         sampleSizeEntryCount: 0, sampleSizeArray: nil, sampleBufferOut: &sb)
    return sb
}

func audioInput() -> AVAssetWriterInput {
    AVAssetWriterInput(mediaType: .audio, outputSettings: [
        AVFormatIDKey: kAudioFormatMPEG4AAC, AVNumberOfChannelsKey: 1, AVSampleRateKey: 44100, AVEncoderBitRateKey: 48000,
    ])
}

func finish(_ writer: AVAssetWriter, name: String) throws {
    let done = DispatchSemaphore(value: 0)
    writer.finishWriting { done.signal() }
    done.wait()
    guard writer.status == .completed else { throw NSError(domain: "fixtures", code: 1, userInfo: [NSLocalizedDescriptionKey: "\(name): \(writer.error?.localizedDescription ?? "?")"]) }
    print("\(name)  \(try Data(contentsOf: outDir.appendingPathComponent(name)).count) bytes")
}

// 1) 配音：0.8 秒 660Hz 的提示音
do {
    let url = outDir.appendingPathComponent("voice.m4a")
    try? FileManager.default.removeItem(at: url)
    let writer = try AVAssetWriter(outputURL: url, fileType: .m4a)
    let input = audioInput()
    input.expectsMediaDataInRealTime = false
    writer.add(input)
    writer.startWriting()
    writer.startSession(atSourceTime: .zero)
    let rate = 44100.0
    var n = 0
    while n < 35 {
        let pts = CMTime(value: Int64(n * 1024), timescale: Int32(rate))
        while !input.isReadyForMoreMediaData && n < 35 { usleep(1000) }
        guard let sb = pcmBuffer(tone: 660, seconds: 0.8, rate: rate, at: pts, frames: 1024), input.append(sb) else { break }
        n += 1
    }
    input.markAsFinished()
    try finish(writer, name: "voice.m4a")
}

// 2) 视频头像：160×200、15 帧、1.2 秒，一个左右移动的橙色方块，带 0.5 秒提示音
do {
    let url = outDir.appendingPathComponent("clip.mp4")
    try? FileManager.default.removeItem(at: url)
    let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
    let video = AVAssetWriterInput(mediaType: .video, outputSettings: [
        AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: 160, AVVideoHeightKey: 200,
    ])
    video.expectsMediaDataInRealTime = false
    let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: video, sourcePixelBufferAttributes: [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA, kCVPixelBufferWidthKey as String: 160, kCVPixelBufferHeightKey as String: 200,
    ])
    let audio = audioInput()
    audio.expectsMediaDataInRealTime = false
    writer.add(video)
    writer.add(audio)
    writer.startWriting()
    writer.startSession(atSourceTime: .zero)
    // 每一帧：先补上这一帧时间内的音频，再写视频画面
    let audioFrames = 44100 / 15
    for i in 0..<18 {
        var pb: CVPixelBuffer?
        CVPixelBufferCreate(kCFAllocatorDefault, 160, 200, kCVPixelFormatType_32BGRA,
                            [kCVPixelBufferCGImageCompatibilityKey: true, kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary, &pb)
        guard let buffer = pb else { break }
        CVPixelBufferLockBaseAddress(buffer, [])
        if let c = CGContext(data: CVPixelBufferGetBaseAddress(buffer), width: 160, height: 200, bitsPerComponent: 8,
                             bytesPerRow: CVPixelBufferGetBytesPerRow(buffer), space: CGColorSpaceCreateDeviceRGB(),
                             bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue) {
            c.setFillColor(CGColor(red: 0.25, green: 0.45, blue: 0.85, alpha: 1))
            c.fill(CGRect(x: 0, y: 0, width: 160, height: 200))
            c.setFillColor(CGColor(red: 1, green: 0.6, blue: 0.15, alpha: 1))
            c.fill(CGRect(x: 20 + i * 4, y: 80, width: 44, height: 44))
        }
        CVPixelBufferUnlockBaseAddress(buffer, [])
        while !audio.isReadyForMoreMediaData { usleep(1000) }
        if let sb = pcmBuffer(tone: 440, seconds: 0.5, rate: 44100,
                              at: CMTime(value: Int64(i * audioFrames), timescale: 44100), frames: audioFrames) {
            audio.append(sb)
        }
        // 编码器队列满了就等一下再写，否则会丢帧
        while !video.isReadyForMoreMediaData { usleep(1000) }
        guard adaptor.append(buffer, withPresentationTime: CMTime(value: Int64(i), timescale: 15)) else { break }
    }
    video.markAsFinished()
    audio.markAsFinished()
    try finish(writer, name: "clip.mp4")
}

// 3) 图片头像：64×64 的透明底圆
do {
    let img = CGContext(data: nil, width: 64, height: 64, bitsPerComponent: 8, bytesPerRow: 256, space: CGColorSpaceCreateDeviceRGB(),
                        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    img.setFillColor(CGColor(red: 1, green: 0.42, blue: 0.55, alpha: 1))
    img.fillEllipse(in: CGRect(x: 4, y: 4, width: 56, height: 56))
    let dest = CGImageDestinationCreateWithURL(outDir.appendingPathComponent("head.png") as CFURL, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(dest, img.makeImage()!, nil)
    CGImageDestinationFinalize(dest)
    print("head.png  \(try Data(contentsOf: outDir.appendingPathComponent("head.png")).count) bytes")
}
