// Offscreen rig for mac/render.swift (RENDER, the Metal path tracer): a small scene, traced without the app.
//   swiftc -O -o /tmp/render-rig mac/render.swift test/render-rig/main.swift -framework Cocoa -framework Metal -framework MetalKit -framework MetalFX
//   /tmp/render-rig <out dir> [ortho] [studio]
// Writes moving-before.png (one full-size sample: a moving view without MetalFX), reference.png (converged), moving.png (the last
// frame of an orbit through MetalFX's denoising upscaler), still.png (30 frames later), handoff.png (the samples fading in over it),
// and prints the time a moving frame takes. moving.png should be clean and close to reference.png.
import MetalKit

func f32(_ a: [Float]) -> Data { a.withUnsafeBufferPointer { Data(buffer: $0) } }
func u32(_ a: [UInt32]) -> Data { a.withUnsafeBufferPointer { Data(buffer: $0) } }
var v: [Float] = [], ix: [UInt32] = [], tm: [UInt32] = []
func sphere(_ c: SIMD3<Float>, _ r: Float, _ m: UInt32) {
    let base = UInt32(v.count / 6), N = 48, M = 24
    for j in 0...M { for i in 0...N {
        let th = Float(j) / Float(M) * .pi, ph = Float(i) / Float(N) * 2 * .pi
        let n = SIMD3(sin(th) * cos(ph), sin(th) * sin(ph), cos(th)), p = c + n * r
        v += [p.x, p.y, p.z, n.x, n.y, n.z]
    } }
    for j in 0..<M { for i in 0..<N {
        let a = base + UInt32(j * (N + 1) + i), b = a + 1, c2 = a + UInt32(N + 1), d = c2 + 1
        ix += [a, c2, b, b, c2, d]; tm += [m, m]
    } }
}
func box(_ lo: SIMD3<Float>, _ hi: SIMD3<Float>, _ m: UInt32) {
    let faces: [(SIMD3<Float>, [SIMD3<Float>])] = [
        (SIMD3(0, 0, 1), [SIMD3(0, 0, 1), SIMD3(1, 0, 1), SIMD3(1, 1, 1), SIMD3(0, 1, 1)]), (SIMD3(0, 0, -1), [SIMD3(0, 1, 0), SIMD3(1, 1, 0), SIMD3(1, 0, 0), SIMD3(0, 0, 0)]),
        (SIMD3(1, 0, 0), [SIMD3(1, 0, 0), SIMD3(1, 1, 0), SIMD3(1, 1, 1), SIMD3(1, 0, 1)]), (SIMD3(-1, 0, 0), [SIMD3(0, 1, 0), SIMD3(0, 0, 0), SIMD3(0, 0, 1), SIMD3(0, 1, 1)]),
        (SIMD3(0, 1, 0), [SIMD3(1, 1, 0), SIMD3(0, 1, 0), SIMD3(0, 1, 1), SIMD3(1, 1, 1)]), (SIMD3(0, -1, 0), [SIMD3(0, 0, 0), SIMD3(1, 0, 0), SIMD3(1, 0, 1), SIMD3(0, 0, 1)])]
    for (n, q) in faces {
        let base = UInt32(v.count / 6)
        for t in q { let p = lo + t * (hi - lo); v += [p.x, p.y, p.z, n.x, n.y, n.z] }
        ix += [base, base + 1, base + 2, base, base + 2, base + 3]; tm += [m, m]
    }
}
box(SIMD3(-60, -40, 0), SIMD3(60, 40, 12), 0)                 // anodized plate
sphere(SIMD3(-25, 0, 32), 20, 1)                              // polished steel ball
sphere(SIMD3(25, 5, 27), 15, 2)                               // red plastic ball
box(SIMD3(10, -35, 12), SIMD3(40, -20, 40), 3)                // brass block
for i in 0..<8 { box(SIMD3(-55 + Float(i) * 4, 25, 12), SIMD3(-53 + Float(i) * 4, 36, 30), 4) }   // thin fins: fine detail for the upscaler
let mats: [[Double]] = [[0.03, 0.03, 0.035, 1, 0.38, 0, 1.5], [0.56, 0.57, 0.58, 1, 0.12, 0, 1.5], [0.6, 0.02, 0.02, 0, 0.35, 0, 1.5], [0.78, 0.57, 0.11, 1, 0.3, 0, 1.5], [0.8, 0.8, 0.8, 0, 0.6, 0, 1.5]]

guard let t = PathTracer(frame: .zero) else { print("no ray tracing"); exit(1) }
t.setScene(verts: f32(v), idx: u32(ix), tri: u32(tm), mats: mats, cap: [0.5, 0.5, 0.5], bg: [1, 1, 1])
let W = 1600, H = 1000
func cam(_ a: Double) -> [String: Any] {
    let target = SIMD3<Double>(0, 0, 15), pos = target + SIMD3(cos(a) * 190, sin(a) * 190, 110)
    let fwd = normalize(target - pos), right = normalize(cross(fwd, SIMD3(0, 0, 1))), up = cross(right, fwd)
    return ["pos": [pos.x, pos.y, pos.z], "fwd": [fwd.x, fwd.y, fwd.z], "right": [right.x, right.y, right.z], "up": [up.x, up.y, up.z], "fov": 40.0, "ortho": CommandLine.arguments.contains("ortho"), "orthoH": 70.0, "light": CommandLine.arguments.contains("studio") ? "studio" : "sun"]
}
let dev = t.view.device!, q = dev.makeCommandQueue()!
func target() -> MTLTexture {
    let td = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm, width: W, height: H, mipmapped: false)
    td.usage = [.shaderRead, .shaderWrite]; td.storageMode = .shared
    return dev.makeTexture(descriptor: td)!
}
func save(_ tex: MTLTexture, _ name: String) {
    var px = [UInt8](repeating: 0, count: W * H * 4)
    tex.getBytes(&px, bytesPerRow: W * 4, from: MTLRegionMake2D(0, 0, W, H), mipmapLevel: 0)
    let info = CGImageAlphaInfo.noneSkipFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
    let ctx = CGContext(data: &px, width: W, height: H, bitsPerComponent: 8, bytesPerRow: W * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: info)!
    try! NSBitmapImageRep(cgImage: ctx.makeImage()!).representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: name))
}
let out = CommandLine.arguments[1], a1 = 0.9
// the old way while moving: one full-size sample
t.setCamera(cam(a1))
let one = target(); var cb = q.makeCommandBuffer()!; _ = t.encode(into: one, cb); cb.commit(); cb.waitUntilCompleted(); save(one, "\(out)/moving-before.png")
// the converged picture
t.setCamera(cam(a1))
try! t.png(size: CGSize(width: W, height: H))!.data.write(to: URL(fileURLWithPath: "\(out)/reference.png"))
if #available(macOS 26.0, *) {
    let tex = target()
    // warm up (MetalFX compiles its pipelines in the background), then an orbit that ends on a1, timed
    for pass in 0..<2 {
        let n = 60, t0 = CFAbsoluteTimeGetCurrent()
        for i in 0..<n {
            t.setCamera(cam(a1 - Double(n - 1 - i) * 0.012))
            cb = q.makeCommandBuffer()!
            guard t.encodeUpscaled(into: tex, cb) else { print("no MetalFX denoising upscaler here"); exit(1) }
            cb.commit(); cb.waitUntilCompleted()
        }
        if pass == 1 { print(String(format: "%.2f ms a frame moving, %d x %d", (CFAbsoluteTimeGetCurrent() - t0) / Double(n) * 1000, W, H)) }
    }
    save(tex, "\(out)/moving.png")
    for _ in 0..<30 { cb = q.makeCommandBuffer()!; _ = t.encodeUpscaled(into: tex, cb); cb.commit(); cb.waitUntilCompleted() }   // held still: 30 more frames
    save(tex, "\(out)/still.png")
    for _ in 0..<12 { cb = q.makeCommandBuffer()!; _ = t.encode(into: tex, cb, blend: 0.5); cb.commit(); cb.waitUntilCompleted() }   // the full-size samples, half faded in
    save(tex, "\(out)/handoff.png")
}
