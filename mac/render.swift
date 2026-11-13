// RENDER in the app: a Metal path tracer (hardware ray tracing on M3 and newer) drawn in an MTKView
// UNDER the page. The page goes transparent over its viewport while it is on, so every HTML control
// stays on top and nothing is copied back. The page sends the visible triangles once per change
// (renderScene) and the camera + section plane + viewport rect whenever they move (renderCam).
// Samples accumulate while the view holds still; any change starts them over.
// While the view moves (macOS 26+), it is traced at half size with a few samples and MetalFX's denoising
// upscaler (Apple's counterpart of DLSS ray reconstruction) makes the full-size picture of it, so a turning
// model is clean instead of grainy. Once the view has held still a moment the full-size samples take over.

import MetalKit
import MetalFX

struct RenderUniforms {
    var camPos = SIMD4<Float>(), camFwd = SIMD4<Float>(), camRight = SIMD4<Float>(), camUp = SIMD4<Float>()
    var sunDir = SIMD4<Float>(), sunCol = SIMD4<Float>(), skyTop = SIMD4<Float>(), skyBot = SIMD4<Float>()
    var bg = SIMD4<Float>(), clip = SIMD4<Float>()   // clip: keep where dot(xyz, p) + w >= 0; xyz = 0 is off
    var scene = SIMD4<Float>()                       // x: scene diagonal, y: ray offset, z: floor height, w: lamps
    var info = SIMD4<UInt32>()                       // x: samples so far, y: ortho, z: samples this frame, w: floor's first triangle
    var pPos = SIMD4<Float>(), pFwd = SIMD4<Float>(), pRight = SIMD4<Float>(), pUp = SIMD4<Float>()   // the camera of the frame before (motion)
    var fx = SIMD4<Float>()                          // x y: this frame's sub-pixel jitter, z: near (ortho: far) for depth, w: how much of the full-size samples shows over the upscaled picture
    var tick = SIMD4<UInt32>()                       // x: frame number, y: samples a pixel in the half-size pass
}

final class PathTracer: NSObject, MTKViewDelegate {
    let view: MTKView
    private let queue: MTLCommandQueue
    private let pipe: MTLComputePipelineState
    private var accel: MTLAccelerationStructure?
    private var vtx: MTLBuffer?, idx: MTLBuffer?, tri: MTLBuffer?, mats: MTLBuffer?, uvs: MTLBuffer?, lamps: MTLBuffer?
    private var texs: [MTLTexture] = []   // the bodies' pictures (a glTF's image textures), up to maxTextures
    static let maxTextures = 8
    private var accum: MTLTexture?
    private let gbufPipe: MTLComputePipelineState, resolvePipe: MTLComputePipelineState
    private var scaler: AnyObject?        // MTLFXTemporalDenoisedScaler (macOS 26+), made for the drawable's size
    private var noScaler = false          // this Mac has none: the samples alone, as before
    private var guides: [MTLTexture] = [] // half size: colour (a: background), depth, motion, diffuse, specular, normal, roughness, mirror reach
    private var upscaled: MTLTexture?, held: MTLTexture?   // MetalFX's picture (light), and it tone-mapped: what the full-size samples fade in over
    private var warm = 0                  // upscaled frames since the view last changed
    private var frame: UInt32 = 0, fresh = true            // fresh: nothing before this frame is worth keeping (a new scene, a new size)
    private var prev: (SIMD4<Float>, SIMD4<Float>, SIMD4<Float>, SIMD4<Float>)?
    static let settle = 30                // upscaled frames before the full-size samples start
    static let moving: UInt32 = 2         // samples a pixel in the half-size pass
    private var u = RenderUniforms()
    private var cam: [String: Any] = [:]
    static let maxSamples: UInt32 = 4096
    private var shooting = false, moved = false   // a CAPTURE is gathering (the screen's draws wait); the view changed while it was

    init?(frame: NSRect) {
        guard let dev = MTLCreateSystemDefaultDevice(), dev.supportsRaytracing, let q = dev.makeCommandQueue() else { return nil }
        do {
            let lib = try dev.makeLibrary(source: PathTracer.shader, options: nil)
            pipe = try dev.makeComputePipelineState(function: lib.makeFunction(name: "trace")!)
            gbufPipe = try dev.makeComputePipelineState(function: lib.makeFunction(name: "gbuf")!)
            resolvePipe = try dev.makeComputePipelineState(function: lib.makeFunction(name: "resolve")!)
        } catch { NSLog("cadgang render: \(error)"); return nil }
        queue = q
        view = MTKView(frame: frame, device: dev)
        super.init()
        view.colorPixelFormat = .bgra8Unorm
        view.framebufferOnly = false
        view.isHidden = true
        view.isPaused = true
        view.enableSetNeedsDisplay = false
        view.delegate = self
        u.sunDir = SIMD4(normalize(SIMD3<Float>(60, -80, 120)), 0.03)   // the viewer's key light; w: sun radius (rad), the soft shadow edge
        u.sunCol = SIMD4(2.6, 2.5, 2.35, 0)
        u.skyTop = SIMD4(0.55, 0.57, 0.62, 0)
        u.skyBot = SIMD4(0.22, 0.21, 0.2, 0)
        // A background tab or a minimised window stops tracing and picks up where it left off when it shows again.
        NotificationCenter.default.addObserver(forName: NSWindow.didChangeOcclusionStateNotification, object: nil, queue: .main) { [weak self] n in
            guard let self, n.object as? NSWindow === self.view.window, self.shown else { return }
            self.view.isPaused = self.accel == nil || self.u.info.x >= Self.maxSamples
        }
    }

    private var shown: Bool { view.window?.occlusionState.contains(.visible) ?? false }

    func stop() { view.isHidden = true; view.isPaused = true; fresh = true; accel = nil; vtx = nil; idx = nil; tri = nil; mats = nil; uvs = nil; lamps = nil; texs = [] }

    /// verts: [x y z nx ny nz] per vertex, world space. idx: 3 per triangle. tri: material per triangle.
    /// mats: [r g b metalness roughness transmission ior texture glow grain axes + 12] (linear colour; texture: an index into
    /// pngs or -1, glow: how much it lights itself, a screen's picture or a lamp's lens; grain: 0 none, 1 brushed, 2 bead blast,
    /// 3 wood, 4 3D printed, 5 laser cut sheet, 6 tumbled; axes: the grain's axis * 4 + the next (the body's longest and middle, a print's build direction first); then the three rows of world -> the body's own millimetres,
    /// where the grain lives, so it stays on a part that moves). uv: [u v] per vertex (zeros where untextured).
    /// lights: [x y z dx dy dz r g b cosOuter cosInner] per lamp (a glTF's spots and points; a point has cos -2, -1), colour times
    /// intensity in the sun's units at 1 m (scene mm), falling off with the square of the distance.
    func setScene(verts: Data, idx idxData: Data, tri triData: Data, mats matList: [[Double]], cap: [Double], bg: [Double], uv uvData: Data? = nil, pngs: [Data] = [], lights: [[Double]] = []) {
        let dev = view.device!
        var v = [Float](repeating: 0, count: verts.count / 4); _ = v.withUnsafeMutableBytes { verts.copyBytes(to: $0) }
        var ix = [UInt32](repeating: 0, count: idxData.count / 4); _ = ix.withUnsafeMutableBytes { idxData.copyBytes(to: $0) }
        var tm = [UInt32](repeating: 0, count: triData.count / 4); _ = tm.withUnsafeMutableBytes { triData.copyBytes(to: $0) }
        guard !ix.isEmpty else { stop(); return }
        // A floor under the bodies, far wider than them; it fades into the background (shader).
        var lo = SIMD3<Float>(repeating: .infinity), hi = SIMD3<Float>(repeating: -.infinity)
        for i in stride(from: 0, to: v.count, by: 6) { let p = SIMD3(v[i], v[i + 1], v[i + 2]); lo = simd_min(lo, p); hi = simd_max(hi, p) }
        let diag = max(simd_length(hi - lo), 1e-3), c = (lo + hi) / 2, r = diag * 40, z = lo.z - diag * 1e-4
        let base = UInt32(v.count / 6)
        for (x, y) in [(-r, -r), (r, -r), (r, r), (-r, r)] { v += [c.x + x, c.y + y, z, 0, 0, 1] }
        ix += [base, base + 1, base + 2, base, base + 2, base + 3]
        var m = matList.map { $0.map(Float.init) }
        m.append([0.035, 0.035, 0.035, 0, 0.9, 0, 1.5])                       // floor: dark matte (Oct 21, Che-Wei)
        m.append(cap.map(Float.init) + [0, 0.7, 0, 1.5])                       // section cap
        tm += [UInt32(m.count - 2), UInt32(m.count - 2)]
        let mats8: [Float] = m.flatMap { a -> [Float] in   // six float4 per material
            func at(_ i: Int, _ d: Float) -> Float { a.count > i ? a[i] : d }
            let rows: [Float] = a.count >= 23 ? Array(a[11..<23]) : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]
            return [a[0], a[1], a[2], 0, a[3], a[4], a[5], at(6, 1.5), at(7, -1), at(8, 0), at(9, 0), at(10, 0)] + rows
        }
        var uv = [Float](repeating: 0, count: v.count / 6 * 2)   // the floor's four corners included, untextured
        if let uvData { _ = uv.withUnsafeMutableBytes { uvData.copyBytes(to: $0, count: min(uvData.count, $0.count)) } }
        let loader = MTKTextureLoader(device: dev)
        texs = pngs.prefix(Self.maxTextures).compactMap { try? loader.newTexture(data: $0, options: [.SRGB: true, .textureUsage: MTLTextureUsage.shaderRead.rawValue, .textureStorageMode: MTLStorageMode.private.rawValue]) }
        if texs.count < pngs.prefix(Self.maxTextures).count { NSLog("cadgang render: a picture did not load") }
        vtx = dev.makeBuffer(bytes: v, length: v.count * 4, options: .storageModeShared)
        idx = dev.makeBuffer(bytes: ix, length: ix.count * 4, options: .storageModeShared)
        tri = dev.makeBuffer(bytes: tm, length: tm.count * 4, options: .storageModeShared)
        mats = dev.makeBuffer(bytes: mats8, length: mats8.count * 4, options: .storageModeShared)
        uvs = dev.makeBuffer(bytes: uv, length: uv.count * 4, options: .storageModeShared)
        let lm: [Float] = lights.filter { $0.count >= 11 }.flatMap { l in [0, 1, 2, 9, 3, 4, 5, 10, 6, 7, 8].map { Float(l[$0]) } + [0] }   // three float4 per lamp: pos + cosOuter, dir + cosInner, colour
        lamps = dev.makeBuffer(bytes: lm.isEmpty ? [Float](repeating: 0, count: 12) : lm, length: max(lm.count, 12) * 4, options: .storageModeShared)
        u.bg = SIMD4(Float(bg[0]), Float(bg[1]), Float(bg[2]), 1)
        fresh = true
        u.scene = SIMD4(diag, diag * 2e-5, z, Float(lm.count / 12))
        u.sunCol = SIMD4(2.6, 2.5, 2.35, 0) * (lm.isEmpty ? 1 : 0.35)   // the file's lamps light it; the sun drops to a fill so their pools read
        u.info.w = UInt32(ix.count / 3 - 2)

        let g = MTLAccelerationStructureTriangleGeometryDescriptor()
        g.vertexBuffer = vtx; g.vertexStride = 24; g.vertexFormat = .float3
        g.indexBuffer = idx; g.indexType = .uint32; g.triangleCount = ix.count / 3
        g.opaque = true
        let d = MTLPrimitiveAccelerationStructureDescriptor(); d.geometryDescriptors = [g]
        let sizes = dev.accelerationStructureSizes(descriptor: d)
        guard let a = dev.makeAccelerationStructure(size: sizes.accelerationStructureSize),
              let scratch = dev.makeBuffer(length: sizes.buildScratchBufferSize, options: .storageModePrivate),
              let cb = queue.makeCommandBuffer(), let enc = cb.makeAccelerationStructureCommandEncoder() else { return }
        enc.build(accelerationStructure: a, descriptor: d, scratchBuffer: scratch, scratchBufferOffset: 0)
        enc.endEncoding(); cb.commit(); cb.waitUntilCompleted()
        accel = a
        restart()
    }

    /// pos/fwd/right/up: the camera's world basis; fov (deg, vertical) or ortho with orthoH (half height);
    /// clip: the section plane [nx ny nz c] or nil; rect: the viewport in the page's points, top-left origin;
    /// light: "studio" for softboxes, else the sun.
    func setCamera(_ c: [String: Any]) {
        cam = c
        if let r = c["rect"] as? [Double], r.count == 4 {
            let f = NSRect(x: r[0], y: r[1], width: r[2], height: r[3])
            if view.frame != f { view.frame = f }
        }
        let p = (c["clip"] as? [Double]) ?? [0, 0, 0, 0]
        u.clip = SIMD4(Float(p[0]), Float(p[1]), Float(p[2]), Float(p[3]))
        u.skyTop.w = (c["light"] as? String) == "studio" ? 1 : 0   // the lighting: the sun and sky, or softboxes
        view.isHidden = false
        restart()
    }

    private func restart() { u.info.x = 0; warm = 0; moved = true; view.isPaused = accel == nil || !shown }

    private func basis(aspect: Float) {
        func v(_ k: String) -> SIMD3<Float> { let a = (cam[k] as? [Double]) ?? [0, 0, 0]; return SIMD3(Float(a[0]), Float(a[1]), Float(a[2])) }
        let ortho = (cam["ortho"] as? Bool) ?? false
        let h = ortho ? Float((cam["orthoH"] as? Double) ?? 1) : tan(Float((cam["fov"] as? Double) ?? 40) * .pi / 360)
        u.camPos = SIMD4(v("pos"), 0); u.camFwd = SIMD4(v("fwd"), 0)
        u.camRight = SIMD4(v("right") * h * aspect, 0); u.camUp = SIMD4(v("up") * h, 0)
        u.info.y = ortho ? 1 : 0
    }

    func mtkView(_ v: MTKView, drawableSizeWillChange size: CGSize) { restart() }

    func draw(in v: MTKView) {
        if !shown { v.isPaused = true; return }
        if shooting { return }   // accum and the sample count are the capture's for now
        guard let drawable = v.currentDrawable, let cb = queue.makeCommandBuffer() else { return }
        let t = drawable.texture
        var drawn = false
        if #available(macOS 26.0, *), warm < Self.settle { drawn = encodeUpscaled(into: t, cb) }
        if !drawn {   // the full-size samples, faded in over the upscaled picture as they gather (8 to 256)
            let over = warm > 0 && held?.width == t.width && held?.height == t.height
            let x = min(max((Float(u.info.x) - 8) / 248, 0), 1)
            drawn = encode(into: t, cb, blend: over ? x * x * (3 - 2 * x) : 1)
        }
        guard drawn else { return }
        cb.present(drawable); cb.commit()
        if u.info.x >= Self.maxSamples { v.isPaused = true }   // converged: stop spending the GPU
    }

    /// The picture as a PNG of `size` pixels (CAPTURE wants the window's, which the view is not): traced afresh into
    /// its own textures, to as many samples as the screen has gathered (64 at least), and read back. It gathers a few
    /// frames at a time and says how far it is (`progress`: samples so far, samples wanted), so the app stays live and
    /// the page can show a bar; the screen holds its picture meanwhile and gets its own samples back after. A view
    /// that changes under it starts the capture over. `done` gets nil with no scene loaded or a capture already going.
    func png(size: CGSize, progress: @escaping (UInt32, UInt32) -> Void = { _, _ in }, done: @escaping ((data: Data, width: Int, height: Int)?) -> Void) {
        let w = Int(size.width), h = Int(size.height)
        guard !shooting, accel != nil, w > 0, h > 0, let dev = view.device else { return done(nil) }
        let td = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm, width: w, height: h, mipmapped: false)
        td.usage = [.shaderRead, .shaderWrite]; td.storageMode = dev.hasUnifiedMemory ? .shared : .managed
        guard let tex = dev.makeTexture(descriptor: td) else { return done(nil) }
        let screen = (accum, u.info.x)
        let want = min(max(screen.1, 64), Self.maxSamples)
        accum = nil   // encode makes one of this size and counts from nought
        shooting = true; moved = false
        func finish(_ ok: Bool) {
            accum = screen.0; u.info.x = moved ? 0 : screen.1; shooting = false   // moved: the screen's samples are of the old view
            view.isPaused = accel == nil || !shown || u.info.x >= Self.maxSamples
            guard ok else { return done(nil) }
            var px = [UInt8](repeating: 0, count: w * h * 4)
            tex.getBytes(&px, bytesPerRow: w * 4, from: MTLRegionMake2D(0, 0, w, h), mipmapLevel: 0)
            let info = CGImageAlphaInfo.noneSkipFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue   // BGRA, alpha unused
            guard let ctx = CGContext(data: &px, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: info),
                  let img = ctx.makeImage(), let data = NSBitmapImageRep(cgImage: img).representation(using: .png, properties: [:]) else { return done(nil) }
            done((data, w, h))
        }
        func step() {   // eight frames, then a word to the page once the GPU has done them
            for i in 0..<8 {
                guard let cb = queue.makeCommandBuffer(), encode(into: tex, cb) else { return finish(false) }
                let end = u.info.x >= want
                if end, td.storageMode == .managed, let blit = cb.makeBlitCommandEncoder() { blit.synchronize(resource: tex); blit.endEncoding() }   // a discrete GPU: bring the pixels back
                if end || i == 7 {
                    cb.addCompletedHandler { _ in DispatchQueue.main.async {
                        progress(min(self.u.info.x, want), want)
                        if self.u.info.x >= want { finish(true) } else { step() }   // short again only if the view changed while these frames ran
                    } }
                }
                cb.commit()
                if end { break }
            }
        }
        step()
    }

    /// One frame of samples into accum, tone-mapped into out.
    func encode(into out: MTLTexture, _ cb: MTLCommandBuffer, blend: Float = 1) -> Bool {
        guard let accel = accel, let enc = cb.makeComputeCommandEncoder() else { return false }
        if accum?.width != out.width || accum?.height != out.height {
            let td = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .rgba32Float, width: out.width, height: out.height, mipmapped: false)
            td.usage = [.shaderRead, .shaderWrite]; td.storageMode = .private
            accum = view.device!.makeTexture(descriptor: td); u.info.x = 0
        }
        basis(aspect: Float(out.width) / Float(max(out.height, 1)))
        u.info.z = u.info.x < 4 ? 1 : 4   // one sample a frame while moving, four once it holds still
        u.fx.w = blend
        bind(enc, pipe, accel)
        enc.setTexture(accum, index: 0); enc.setTexture(out, index: 1); enc.setTexture(blend < 1 ? held : accum, index: 10)
        enc.dispatchThreadgroups(MTLSize(width: (out.width + 7) / 8, height: (out.height + 7) / 8, depth: 1), threadsPerThreadgroup: MTLSize(width: 8, height: 8, depth: 1))
        enc.endEncoding()
        u.info.x += u.info.z
        return true
    }

    private func bind(_ enc: MTLComputeCommandEncoder, _ p: MTLComputePipelineState, _ accel: MTLAccelerationStructure) {
        enc.setComputePipelineState(p)
        enc.setBytes(&u, length: MemoryLayout<RenderUniforms>.stride, index: 0)
        enc.setBuffer(vtx, offset: 0, index: 1); enc.setBuffer(idx, offset: 0, index: 2)
        enc.setBuffer(tri, offset: 0, index: 3); enc.setBuffer(mats, offset: 0, index: 4)
        enc.setAccelerationStructure(accel, bufferIndex: 5)
        enc.setBuffer(uvs, offset: 0, index: 6); enc.setBuffer(lamps, offset: 0, index: 7)
        for i in 0..<Self.maxTextures { enc.setTexture(i < texs.count ? texs[i] : (accum ?? upscaled), index: 2 + i) }   // unused slots get any texture; no material points at them
    }

    /// The denoising upscaler for a picture of w x h, with the half-size textures it reads. Nil where there is none.
    @available(macOS 26.0, *)
    private func upscaler(_ w: Int, _ h: Int) -> MTLFXTemporalDenoisedScaler? {
        if let s = scaler as? MTLFXTemporalDenoisedScaler, s.outputWidth == w, s.outputHeight == h { return s }
        guard !noScaler, w >= 64, h >= 64, let dev = view.device else { return nil }
        guard MTLFXTemporalDenoisedScalerDescriptor.supportsDevice(dev) else { noScaler = true; return nil }
        let iw = (w + 1) / 2, ih = (h + 1) / 2
        let d = MTLFXTemporalDenoisedScalerDescriptor()
        d.inputWidth = iw; d.inputHeight = ih; d.outputWidth = w; d.outputHeight = h
        let formats: [MTLPixelFormat] = [.rgba16Float, .r32Float, .rg16Float, .rgba16Float, .rgba16Float, .rgba16Float, .r16Float, .r32Float]
        d.colorTextureFormat = formats[0]; d.depthTextureFormat = formats[1]; d.motionTextureFormat = formats[2]
        d.diffuseAlbedoTextureFormat = formats[3]; d.specularAlbedoTextureFormat = formats[4]
        d.normalTextureFormat = formats[5]; d.roughnessTextureFormat = formats[6]
        d.outputTextureFormat = .rgba16Float
        d.isSpecularHitDistanceTextureEnabled = true; d.specularHitDistanceTextureFormat = formats[7]   // how far each mirror bounce went: reflections stay sharp
        guard let s = d.makeTemporalDenoisedScaler(device: dev) else { NSLog("cadgang render: no MetalFX denoising upscaler at \(w) x \(h)"); noScaler = true; return nil }
        func tex(_ f: MTLPixelFormat, _ w: Int, _ h: Int, _ usage: MTLTextureUsage) -> MTLTexture? {
            let td = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: f, width: w, height: h, mipmapped: false)
            td.usage = usage.union([.shaderRead, .shaderWrite]); td.storageMode = .private
            return dev.makeTexture(descriptor: td)
        }
        let usages = [s.colorTextureUsage, s.depthTextureUsage, s.motionTextureUsage, s.diffuseAlbedoTextureUsage, s.specularAlbedoTextureUsage, s.normalTextureUsage, s.roughnessTextureUsage, s.specularHitDistanceTextureUsage]
        guides = zip(formats, usages).compactMap { tex($0, iw, ih, $1) }
        upscaled = tex(.rgba16Float, w, h, s.outputTextureUsage); held = tex(.rgba16Float, w, h, [])
        guard guides.count == formats.count, upscaled != nil, held != nil else { noScaler = true; return nil }
        scaler = s; fresh = true
        return s
    }

    /// One frame the fast way: a few samples at half size with what the denoiser wants to know of each pixel
    /// (depth, motion, colours, normal, roughness), MetalFX's full-size picture of it, tone-mapped into out.
    @available(macOS 26.0, *)
    func encodeUpscaled(into out: MTLTexture, _ cb: MTLCommandBuffer) -> Bool {
        guard let accel = accel, let s = upscaler(out.width, out.height), let enc = cb.makeComputeCommandEncoder() else { return false }
        let ortho = u.info.y
        basis(aspect: Float(out.width) / Float(max(out.height, 1)))
        if u.info.y != ortho { fresh = true }
        let now = (u.camPos, u.camFwd, u.camRight, u.camUp)
        (u.pPos, u.pFwd, u.pRight, u.pUp) = fresh ? now : (prev ?? now)
        // sub-pixel jitter: 32 Halton(2, 3) points, the same for every pixel of a frame, so the upscaler can find what lies between them
        func halton(_ i: UInt32, _ b: UInt32) -> Float { var f: Float = 1, r: Float = 0, n = i; while n > 0 { f /= Float(b); r += f * Float(n % b); n /= b }; return r }
        let k = frame % 32 + 1, jx = halton(k, 2) - 0.5, jy = halton(k, 3) - 0.5
        let diag = u.scene.x, isOrtho = u.info.y == 1, zRange = isOrtho ? diag * 200 : diag * 1e-4   // ortho: far, else near
        u.fx = SIMD4(jx, jy, zRange, 1); u.tick = SIMD4(frame, Self.moving, 0, 0)
        bind(enc, gbufPipe, accel)
        for (i, t) in guides.enumerated() { enc.setTexture(t, index: 10 + i) }
        enc.dispatchThreadgroups(MTLSize(width: (s.inputWidth + 7) / 8, height: (s.inputHeight + 7) / 8, depth: 1), threadsPerThreadgroup: MTLSize(width: 8, height: 8, depth: 1))
        enc.endEncoding()

        s.colorTexture = guides[0]; s.depthTexture = guides[1]; s.motionTexture = guides[2]
        s.diffuseAlbedoTexture = guides[3]; s.specularAlbedoTexture = guides[4]; s.normalTexture = guides[5]; s.roughnessTexture = guides[6]; s.specularHitDistanceTexture = guides[7]
        s.outputTexture = upscaled
        s.jitterOffsetX = -jx; s.jitterOffsetY = -jy   // the way back to the pixel's centre (the other sign is blurred: test/render-rig/main.swift)
        s.motionVectorScaleX = Float(s.inputWidth); s.motionVectorScaleY = Float(s.inputHeight)   // the shader writes motion as a share of the picture
        s.shouldResetHistory = fresh
        s.isDepthReversed = true   // 1 at the eye, 0 far away
        // the eye looks down -z; an ortho view's rays start 4 diagonals behind the camera's point
        func v3(_ v: SIMD4<Float>) -> SIMD3<Float> { SIMD3(v.x, v.y, v.z) }
        let f = v3(u.camFwd), hx = simd_length(v3(u.camRight)), hy = simd_length(v3(u.camUp))
        let r = v3(u.camRight) / hx, up = v3(u.camUp) / hy
        let back: Float = isOrtho ? diag * 4 : 0
        let eye: SIMD3<Float> = v3(u.camPos) - f * back
        s.worldToViewMatrix = simd_float4x4(columns: (SIMD4(r.x, up.x, -f.x, 0), SIMD4(r.y, up.y, -f.y, 0), SIMD4(r.z, up.z, -f.z, 0), SIMD4(-dot(r, eye), -dot(up, eye), dot(f, eye), 1)))
        s.viewToClipMatrix = isOrtho
            ? simd_float4x4(columns: (SIMD4(1 / hx, 0, 0, 0), SIMD4(0, 1 / hy, 0, 0), SIMD4(0, 0, 1 / zRange, 0), SIMD4(0, 0, 1, 1)))
            : simd_float4x4(columns: (SIMD4(1 / hx, 0, 0, 0), SIMD4(0, 1 / hy, 0, 0), SIMD4(0, 0, 0, -1), SIMD4(0, 0, zRange, 0)))
        s.encode(commandBuffer: cb)

        guard let res = cb.makeComputeCommandEncoder() else { return false }
        res.setComputePipelineState(resolvePipe)
        res.setBytes(&u, length: MemoryLayout<RenderUniforms>.stride, index: 0)
        res.setTexture(upscaled, index: 0); res.setTexture(guides[0], index: 1); res.setTexture(held, index: 2); res.setTexture(out, index: 3)
        res.dispatchThreadgroups(MTLSize(width: (out.width + 7) / 8, height: (out.height + 7) / 8, depth: 1), threadsPerThreadgroup: MTLSize(width: 8, height: 8, depth: 1))
        res.endEncoding()
        prev = now; fresh = false; frame &+= 1; warm += 1
        return true
    }

    static let shader = """
    #include <metal_stdlib>
    #include <metal_raytracing>
    using namespace metal;
    using namespace raytracing;

    struct U { float4 camPos, camFwd, camRight, camUp, sunDir, sunCol, skyTop, skyBot, bg, clip, scene; uint4 info;
               float4 pPos, pFwd, pRight, pUp, fx; uint4 tick; };
    struct Vtx { packed_float3 p; packed_float3 n; };
    struct Mat { float4 color; float4 prm; float4 tex; float4 r0, r1, r2; };   // prm: metalness, roughness, transmission, ior; tex: picture index (-1 none), glow, grain, axes; r: world -> the body's own mm
    struct Lamp { float4 pos; float4 dir; float4 col; };     // pos.w: cos of the cone's edge, dir.w: cos where it is full

    static uint pcg(thread uint& s) { s = s * 747796405u + 2891336453u; uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u; return (w >> 22u) ^ w; }
    static float rnd(thread uint& s) { return float(pcg(s)) * (1.0 / 4294967296.0); }
    static float3 onb(float3 n, float3 v) {   // v in n's tangent frame → world
        float3 t = abs(n.z) < 0.999 ? normalize(cross(float3(0, 0, 1), n)) : float3(1, 0, 0);
        return v.x * t + v.y * cross(n, t) + v.z * n;
    }
    static float3 sky(constant U& u, float3 d) { return mix(u.skyBot.rgb, u.skyTop.rgb, smoothstep(-0.3, 0.8, d.z)); }

    // STUDIO lighting (u.skyTop.w): three softboxes far away in a dim room, in place of the sun and the sky. A softbox is
    // a rectangle seen in direction c, h the tangent of its half angles across and up. They show in what reflects them.
    struct Box { float3 c; float2 h; float3 col; };
    static Box softbox(int i) {
        Box b;
        if (i == 0) { b.c = normalize(float3(60, -80, 120)); b.h = float2(0.6, 0.45); b.col = float3(2.5, 2.45, 2.35); }         // key: where the sun is, as much light
        else if (i == 1) { b.c = normalize(float3(-110, -30, 50)); b.h = float2(0.7, 0.4); b.col = float3(0.55, 0.58, 0.65); }   // fill: the other side, cooler
        else { b.c = normalize(float3(-20, 110, 45)); b.h = float2(0.12, 0.7); b.col = float3(3.2, 3.2, 3.3); }                  // rim: a tall strip behind
        return b;
    }
    static void boxAxes(Box b, thread float3& t, thread float3& bt) { t = normalize(cross(float3(0, 0, 1), b.c)); bt = cross(b.c, t); }
    // The softboxes' light toward d (soft at their edges); pdf: the chance that sampling a softbox picks d.
    static float3 boxes(float3 d, thread float& pdf) {
        float3 L = 0.0; pdf = 0.0;
        for (int i = 0; i < 3; i++) {
            Box b = softbox(i);
            float cz = dot(d, b.c);
            if (cz <= 0.0) continue;
            float3 t, bt; boxAxes(b, t, bt);
            float2 q = abs(float2(dot(d, t), dot(d, bt))) / (cz * b.h);   // 0 at its middle, 1 at its edge
            if (q.x >= 1.0 || q.y >= 1.0) continue;
            pdf += 1.0 / (3.0 * 4.0 * b.h.x * b.h.y * cz * cz * cz);
            L += b.col * smoothstep(1.0, 0.85, q.x) * smoothstep(1.0, 0.85, q.y);
        }
        return L;
    }

    struct Hit { bool hit; float t; float3 ng; float3 n; uint mat; bool cap; uint prim; float2 bc; };

    // Closest hit on the KEPT side of the section plane. Hits on the cut-away side are stepped past.
    // A first kept hit on a back face means the ray entered a solid through the cut: that is the cap,
    // at the plane (the viewer's back-face trick).
    static Hit closest(constant U& u, primitive_acceleration_structure accel, device const Vtx* vtx, device const uint* idx,
                       device const uint* tri, float3 o, float3 d, float tmax) {
        intersector<triangle_data> isect;
        isect.assume_geometry_type(geometry_type::triangle);
        Hit h; h.hit = false; h.cap = false;
        bool clipOn = any(u.clip.xyz != 0.0);
        float tmin = 0.0;
        for (int k = 0; k < 64; k++) {
            ray r(o, d, tmin, tmax);
            auto x = isect.intersect(r, accel);
            if (x.type == intersection_type::none) return h;
            float3 p = o + d * x.distance;
            uint i = x.primitive_id;
            bool isFloor = i >= u.info.w;
            if (isFloor && d.z > 0.0) { tmin = x.distance + u.scene.y; continue; }   // met from underneath, it would hide the model: no floor (an ortho view looking up starts its rays under it while the camera is above)
            if (clipOn && !isFloor && dot(u.clip.xyz, p) + u.clip.w < 0.0) { tmin = x.distance + u.scene.y; continue; }
            float3 a = vtx[idx[3 * i]].p, b = vtx[idx[3 * i + 1]].p, c = vtx[idx[3 * i + 2]].p;
            float3 ng = normalize(cross(b - a, c - a));
            if (clipOn && !isFloor && dot(ng, d) > 0.0) {
                float den = dot(u.clip.xyz, d);
                float tp = den != 0.0 ? -(dot(u.clip.xyz, o) + u.clip.w) / den : -1.0;
                if (tp >= 0.0 && tp < x.distance && dot(u.clip.xyz, o) + u.clip.w < 0.0) {
                    h.hit = true; h.cap = true; h.t = tp; h.ng = -normalize(u.clip.xyz); h.n = h.ng; h.prim = i; return h;   // entering: den > 0, face the ray
                }
            }
            float2 bc = x.triangle_barycentric_coord;
            float3 n = normalize(vtx[idx[3 * i]].n * (1.0 - bc.x - bc.y) + vtx[idx[3 * i + 1]].n * bc.x + vtx[idx[3 * i + 2]].n * bc.y);
            if (any(isnan(n))) n = ng;
            h.hit = true; h.t = x.distance; h.ng = ng; h.n = dot(n, ng) < 0.0 ? -n : n; h.mat = tri[i]; h.prim = i; h.bc = bc;
            return h;
        }
        return h;
    }

    // How much sun gets through from o along d: clear bodies let it through tinted, anything else stops it.
    static float3 shadow(constant U& u, primitive_acceleration_structure accel, device const Vtx* vtx, device const uint* idx,
                         device const uint* tri, device const Mat* mats, float3 o, float3 d, float tmax = INFINITY) {
        float3 t = 1.0;
        for (int k = 0; k < 8; k++) {
            Hit h = closest(u, accel, vtx, idx, tri, o, d, tmax);
            if (!h.hit) return t;
            if (h.cap || mats[h.mat].prm.z < 0.5) return 0.0;
            t *= mats[h.mat].color.rgb;
            o += d * (h.t + u.scene.y); tmax -= h.t + u.scene.y;
        }
        return 0.0;
    }

    static float ggxD(float nh, float a2) { float d = nh * nh * (a2 - 1.0) + 1.0; return a2 / (M_PI_F * d * d); }
    static float smithG(float nv, float nl, float a2) {
        float gv = 2.0 * nv / (nv + sqrt(a2 + (1.0 - a2) * nv * nv)), gl = 2.0 * nl / (nl + sqrt(a2 + (1.0 - a2) * nl * nl));
        return gv * gl;
    }
    // Diffuse + GGX specular, metalness workflow. v, l point away from the surface.
    static float3 brdf(float3 n, float3 v, float3 l, float3 col, float metal, float a2) {
        float nl = dot(n, l), nv = max(dot(n, v), 1e-4);
        if (nl <= 0.0) return 0.0;
        float3 h = normalize(v + l);
        float3 f0 = mix(float3(0.04), col, metal);
        float3 F = f0 + (1.0 - f0) * pow(saturate(1.0 - dot(v, h)), 5.0);
        float3 spec = F * ggxD(max(dot(n, h), 0.0), a2) * smithG(nv, nl, a2) / (4.0 * nv * nl);
        return (1.0 - F) * (1.0 - metal) * col / M_PI_F + spec;
    }

    // The chance that the next-direction sampling (GGX lobe or cosine hemisphere) picks l.
    static float lobePdf(float3 n, float3 v, float3 l, float a2, float pSpec) {
        float3 hv = normalize(v + l);
        return pSpec * ggxD(max(dot(n, hv), 0.0), a2) * max(dot(n, hv), 0.0) / (4.0 * max(dot(v, hv), 1e-4)) + (1.0 - pSpec) * max(dot(n, l), 0.0) / M_PI_F;
    }

    static float3 neutral(float3 c) {   // Khronos PBR Neutral tone mapping
        float x = min(c.r, min(c.g, c.b)), off = x < 0.08 ? x - 6.25 * x * x : 0.04;
        c -= off;
        float peak = max(c.r, max(c.g, c.b));
        if (peak < 0.76) return c;
        float np = 1.0 - 0.0576 / (peak + 0.24 - 0.76);
        c *= np / peak;
        return mix(c, float3(np), 1.0 - 1.0 / (0.15 * (peak - np) + 1.0));
    }
    // neutral() backwards: the light that tone-maps to c. Nothing maps to full white, so c stops at 0.97.
    static float3 unneutral(float3 c) {
        float np = max(c.r, max(c.g, c.b));
        if (np >= 0.76) {
            np = min(np, 0.97); c = min(c, np);
            float peak = 0.52 + 0.0576 / (1.0 - np), g = 1.0 - 1.0 / (0.15 * (peak - np) + 1.0);
            c = (c - np * g) / (1.0 - g) * peak / np;
        }
        float x = min(c.r, min(c.g, c.b));
        return c + (x < 0.04 ? sqrt(max(x, 0.0) / 6.25) - x : 0.04);
    }
    static float3 srgb(float3 c) { c = saturate(c); return select(1.055 * pow(c, 1.0 / 2.4) - 0.055, 12.92 * c, c <= 0.0031308); }

    static float hash3(float3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
    static float vnoise(float3 x) {   // value noise, 0..1, one cell a unit
        float3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(mix(hash3(i), hash3(i + float3(1, 0, 0)), f.x), mix(hash3(i + float3(0, 1, 0)), hash3(i + float3(1, 1, 0)), f.x), f.y),
                   mix(mix(hash3(i + float3(0, 0, 1)), hash3(i + float3(1, 0, 1)), f.x), mix(hash3(i + float3(0, 1, 1)), hash3(i + float3(1, 1, 1)), f.x), f.y), f.z);
    }
    static float3 axis(int i) { return i == 0 ? float3(1, 0, 0) : i == 1 ? float3(0, 1, 0) : float3(0, 0, 1); }
    // A finish with a grain to it, at its true size: a STEP body has no texture coordinates, so the grain is worked out from
    // where the hit is in the body's own millimetres. It tilts the normal (n, world) and, for wood, shades the colour.
    //   1 brushed: scratches 0.07 to 0.3 mm apart along the body's length, tilting the normal across them (a highlight smears across the brushing)
    //   2 bead blast: 0.035 mm dimples (a fine glass bead, #200: a satin sheen at arm's length, a grain only up close)
    //   3 wood: growth lines 2 mm apart along the length, wandering, with fibres
    //   4 3D printed (FDM): 0.2 mm layers stacked along A, each a rounded bead, so the normal rocks along the build direction once a layer;
    //     a face square to the build direction (the top, the bed side) shows the 0.42 mm extrusion lines instead, laid along B
    //   5 laser cut sheet, deburred (a fibre laser with nitrogen, then a linear deburr): the two faces carry the deburrer's fine brushing
    //     along A, scratches 0.025 to 0.08 mm apart; every cut edge carries the laser's striations, fine lines through the thickness
    //     about 0.1 mm apart on a duller, slightly rough surface, with a patch of straw heat tint here and there
    //   6 tumbled (ceramic media): no direction, small scuffs 0.03 to 0.1 mm across, the same on faces and edges
    static void grain(Mat m, float3 pw, thread float3& n, thread float3& col) {
        int kind = int(m.tex.z + 0.5), code = int(m.tex.w + 0.5);
        float3 p = float3(dot(m.r0.xyz, pw) + m.r0.w, dot(m.r1.xyz, pw) + m.r1.w, dot(m.r2.xyz, pw) + m.r2.w);
        float3 no = normalize(float3(dot(m.r0.xyz, n), dot(m.r1.xyz, n), dot(m.r2.xyz, n)));
        float3 A = axis(code / 4), B = axis(code % 4), d = 0.0;
        float3 qa = p - A * dot(p, A), qb = p - B * dot(p, B);   // the same all along A (or B): lines
        if (kind == 1) {
            float ta = (vnoise(qa * 3.5) - 0.5) * 0.8 + (vnoise(qa * 14.0) - 0.5) * 1.2, tb = (vnoise(qb * 3.5) - 0.5) * 0.8 + (vnoise(qb * 14.0) - 0.5) * 1.2;
            d = mix(cross(no, A) * ta, cross(no, B) * tb, smoothstep(0.75, 0.95, abs(dot(no, A)))) * 0.35;   // an end face is brushed along the middle axis
        } else if (kind == 2) {
            d = (float3(vnoise(p * 28.0), vnoise(p * 28.0 + 31.7), vnoise(p * 28.0 + 71.3)) - 0.5) * 0.5;
        } else if (kind == 4) {
            float3 C = cross(A, B);
            float tl = fract(dot(p, A) / 0.2 + (vnoise(qa * 0.5 + A * dot(p, A) * 1.7) - 0.5) * 0.15) - 0.5;   // layers are not perfectly even
            float tt = fract(dot(p, C) / 0.42) - 0.5;
            d = mix((A - no * dot(no, A)) * tl * 1.3, (C - no * dot(no, C)) * tt * 0.7, smoothstep(0.9, 0.99, abs(dot(no, A))));
        } else if (kind == 5) {
            float3 T = cross(A, B), qt = p - T * dot(p, T);   // T: through the sheet
            float face = smoothstep(0.6, 0.9, abs(dot(no, T)));
            float tf = (vnoise(qa * 3.0) - 0.5) * 0.15 + (vnoise(qa * 12.0) - 0.5) * 0.6 + (vnoise(qa * 40.0) - 0.5) * 0.9;
            float te = (vnoise(qt * 9.0) - 0.5) * 1.0 + (vnoise(qt * 30.0) - 0.5) * 0.6;
            float3 rough = (float3(vnoise(p * 40.0), vnoise(p * 40.0 + 31.7), vnoise(p * 40.0 + 71.3)) - 0.5) * 0.3;
            d = mix(cross(no, T) * te * 0.45 + rough, cross(no, A) * tf * 0.18, face);
            float tint = smoothstep(0.5, 0.85, vnoise(qt * 0.3 + 3.0));
            col *= mix(mix(float3(0.84), float3(0.86, 0.76, 0.54), tint * 0.6), float3(1.0), face);
        } else if (kind == 6) {
            d = (float3(vnoise(p * 9.0), vnoise(p * 9.0 + 31.7), vnoise(p * 9.0 + 71.3)) - 0.5) * 0.22
              + (float3(vnoise(p * 30.0), vnoise(p * 30.0 + 17.3), vnoise(p * 30.0 + 53.9)) - 0.5) * 0.3;
        } else {
            float3 q = normalize(B + 0.5 * cross(A, B));   // across the width, leaning through the thickness: lines on the face and the edge
            float3 slow = qa * 0.05 + A * dot(p, A) * 0.012;   // the lines wander a little across the board and hardly at all along it
            float t = dot(p, q) / 2.2 + (vnoise(slow) - 0.5) * 1.6 + (vnoise(slow * 3.1 + 7.0) - 0.5) * 0.5, s = 0.5 + 0.5 * sin(6.2832 * t);
            float fib = vnoise(qa * 6.0 + A * dot(p, A) * 0.15);
            col *= mix(0.8, 1.05, s * s) * (0.9 + 0.2 * fib);
            d = cross(no, A) * (fib - 0.5) * 0.12;
        }
        no = normalize(no + d);
        n = normalize(m.r0.xyz * no.x + m.r1.xyz * no.y + m.r2.xyz * no.z);
    }

    struct First { bool hit; float3 p, n, diff, spec; float rough, reach; };   // what the camera's ray met: the denoiser's guides (reach: how far its mirror bounce went)

    // One path from the camera through px (-1..1, y up). rgb: its light, weighted by 1 - a; a: how much of it is background.
    static float4 path(constant U& u, primitive_acceleration_structure accel, device const Vtx* vtx, device const uint* idx,
                       device const uint* tri, device const Mat* mats, device const float2* uvs, device const Lamp* lamps,
                       array<texture2d<float>, 8> texs, float2 px, thread uint& seed, thread First& f) {
        constexpr sampler pic(filter::linear, address::clamp_to_edge);
        float diag = u.scene.x, eps = u.scene.y;
        float3 o = u.camPos.xyz, d;
        if (u.info.y == 1) { o += px.x * u.camRight.xyz + px.y * u.camUp.xyz - u.camFwd.xyz * diag * 4.0; d = u.camFwd.xyz; }
        else d = normalize(u.camFwd.xyz + px.x * u.camRight.xyz + px.y * u.camUp.xyz);
        float3 L = 0.0, T = 1.0;
        float bgw = 0.0;
        bool mirror = false;   // the first bounce took the specular lobe
        bool studio = u.skyTop.w > 0.5;
        float lastPdf = 1e9;   // the chance the ray's direction was picked with (huge: a mirror or glass, no choice)
        f.hit = false; f.n = -d; f.diff = 0.0; f.spec = 0.0; f.rough = 1.0;
        for (int depth = 0; depth < 8; depth++) {
            Hit h = closest(u, accel, vtx, idx, tri, o, d, INFINITY);
            if (depth == 1 && mirror) f.reach = h.hit ? h.t : diag * 100.0;
            if (!h.hit) {
                if (depth == 0) { bgw = 1.0; f.p = o + d * diag * 1e3; }
                else if (studio) { float pl; float3 B = boxes(d, pl); L += T * (sky(u, d) * 0.3 + B * lastPdf / (lastPdf + pl)); }   // a softbox met by chance: weighed against the sample aimed at it
                else L += T * sky(u, d);
                break;
            }
            float3 p = o + d * h.t;
            bool isFloor = !h.cap && h.prim >= u.info.w;
            if (depth == 0 && isFloor) bgw = smoothstep(diag * 1.5, diag * 10.0, h.t);   // the floor melts into the background
            Mat m = mats[h.cap ? (u.info.w > 0 ? tri[u.info.w] + 1 : 0) : h.mat];
            float3 col = m.color.rgb;
            if (!h.cap && m.tex.x >= 0.0) {   // a picture: its colour at the hit, and a screen lights itself
                uint i = h.prim;
                float2 uv = uvs[idx[3 * i]] * (1.0 - h.bc.x - h.bc.y) + uvs[idx[3 * i + 1]] * h.bc.x + uvs[idx[3 * i + 2]] * h.bc.y;
                col = texs[uint(m.tex.x)].sample(pic, uv, level(0)).rgb;
            }
            if (!h.cap) L += T * col * m.tex.y;   // a screen or a lamp's lens lights itself
            float metal = m.prm.x, a = max(m.prm.y * m.prm.y, 0.002), a2 = a * a, trans = m.prm.z;
            float3 v = -d, nt = h.n;   // nt: the normal with the finish's grain in it
            if (!h.cap && m.tex.z > 0.5) grain(m, p, nt, col);
            if (depth == 0) { f.hit = true; f.p = p; f.n = dot(nt, v) > 0.02 ? nt : h.n; f.diff = col * (1.0 - metal); f.spec = mix(float3(0.04), col, metal); f.rough = m.prm.y; }
            if (trans > 0.5) {   // glass: Fresnel-weighted reflect or refract, IOR 1.5
                bool entering = dot(h.ng, d) < 0.0;
                float3 n = entering ? h.n : -h.n;
                float ior = m.prm.w > 1.0 ? m.prm.w : 1.5, eta = entering ? 1.0 / ior : ior, cosi = min(dot(v, n), 1.0);
                float f0 = (ior - 1.0) * (ior - 1.0) / ((ior + 1.0) * (ior + 1.0)), F = f0 + (1.0 - f0) * pow(saturate(1.0 - cosi), 5.0);
                float3 rd = refract(d, n, eta);
                if (all(rd == 0.0) || rnd(seed) < F) { d = reflect(d, n); o = p + n * eps; }
                else { d = rd; o = p - n * eps; T *= col; }
                lastPdf = 1e9;
                continue;
            }
            float3 n = dot(nt, v) > 0.02 ? nt : h.n, ng = dot(h.ng, d) < 0.0 ? h.ng : -h.ng;   // a grain that turned the normal away from the eye is left out
            if (dot(n, ng) < 0.0) n = ng;
            o = p + ng * eps;
            float pSpec = mix(0.25, 1.0, metal);
            if (studio) {   // one shadowed sample aimed at a softbox, weighed against meeting it by chance (above)
                Box b = softbox(min(int(rnd(seed) * 3.0), 2));
                float3 t, bt; boxAxes(b, t, bt);
                float3 sd = normalize(b.c + (rnd(seed) * 2.0 - 1.0) * b.h.x * t + (rnd(seed) * 2.0 - 1.0) * b.h.y * bt);
                float pl; float3 B = boxes(sd, pl);
                if (dot(n, sd) > 0.0 && pl > 0.0)
                    L += T * brdf(n, v, sd, col, metal, a2) * dot(n, sd) * B / (pl + lobePdf(n, v, sd, a2, pSpec)) * shadow(u, accel, vtx, idx, tri, mats, o, sd);
            } else {   // Sun: one shadowed sample inside its disc (soft shadow edge).
                float3 sd = normalize(u.sunDir.xyz + onb(u.sunDir.xyz, float3((rnd(seed) * 2.0 - 1.0), (rnd(seed) * 2.0 - 1.0), 0.0)) * u.sunDir.w);
                if (dot(n, sd) > 0.0)
                    L += T * brdf(n, v, sd, col, metal, a2) * dot(n, sd) * u.sunCol.rgb * shadow(u, accel, vtx, idx, tri, mats, o, sd);
            }
            // Lamps: one shadowed sample each, inverse square in metres (the scene is mm), soft cone edge.
            for (uint li = 0; li < uint(u.scene.w); li++) {
                Lamp lp = lamps[li];
                float3 to = lp.pos.xyz - o; float dist = length(to); float3 ld = to / dist;
                float cone = smoothstep(lp.pos.w, lp.dir.w, dot(-ld, lp.dir.xyz)), nl = dot(n, ld);
                if (cone <= 0.0 || nl <= 0.0) continue;
                L += T * brdf(n, v, ld, col, metal, a2) * nl * lp.col.rgb * cone * 1e6 / (dist * dist) * shadow(u, accel, vtx, idx, tri, mats, o, ld, dist);
            }
            // Next direction: GGX lobe or cosine hemisphere, weighted by their mixture pdf.
            float3 l;
            if (rnd(seed) < pSpec) {
                mirror = depth == 0;
                float r1 = rnd(seed), r2 = rnd(seed);
                float ct = sqrt((1.0 - r1) / (1.0 + (a2 - 1.0) * r1)), st = sqrt(1.0 - ct * ct), ph = 2.0 * M_PI_F * r2;
                float3 hv = onb(n, float3(st * cos(ph), st * sin(ph), ct));
                l = reflect(-v, hv);
            } else {
                float r1 = rnd(seed), r2 = rnd(seed), ph = 2.0 * M_PI_F * r2;
                l = onb(n, float3(sqrt(r1) * cos(ph), sqrt(r1) * sin(ph), sqrt(1.0 - r1)));
            }
            float nl = dot(n, l);
            if (nl <= 0.0 || dot(ng, l) <= 0.0) break;
            float pdf = lobePdf(n, v, l, a2, pSpec);
            T *= brdf(n, v, l, col, metal, a2) * nl / max(pdf, 1e-6);
            lastPdf = pdf;
            d = l;
            if (depth >= 3) { float q = min(max(T.r, max(T.g, T.b)), 0.95); if (rnd(seed) > q) break; T /= q; }
        }
        float lum = dot(L, float3(0.2126, 0.7152, 0.0722));
        if (lum > 20.0) L *= 20.0 / lum;   // firefly clamp
        return float4(L * (1.0 - bgw), bgw);
    }

    kernel void trace(uint2 gid [[thread_position_in_grid]], constant U& u [[buffer(0)]],
                      device const Vtx* vtx [[buffer(1)]], device const uint* idx [[buffer(2)]],
                      device const uint* tri [[buffer(3)]], device const Mat* mats [[buffer(4)]],
                      primitive_acceleration_structure accel [[buffer(5)]], device const float2* uvs [[buffer(6)]], device const Lamp* lamps [[buffer(7)]],
                      texture2d<float, access::read_write> accum [[texture(0)]], texture2d<float, access::write> out [[texture(1)]],
                      array<texture2d<float>, 8> texs [[texture(2)]], texture2d<float> held [[texture(10)]]) {
        uint2 size = uint2(out.get_width(), out.get_height());
        if (gid.x >= size.x || gid.y >= size.y) return;
        uint seed = (gid.x * 1973u + gid.y * 9277u + u.info.x * 26699u) | 1u;
        float4 acc = u.info.x == 0 ? float4(0) : accum.read(gid);   // rgb: weighted radiance; a: background weight
        First f;
        for (uint s = 0; s < u.info.z; s++) {
            float2 px = (float2(gid) + float2(rnd(seed), rnd(seed))) / float2(size) * 2.0 - 1.0;
            acc += path(u, accel, vtx, idx, tri, mats, uvs, lamps, texs, float2(px.x, -px.y), seed, f);
        }
        accum.write(acc, gid);
        float n = float(u.info.x + u.info.z), wHit = n - acc.a;
        float3 c = wHit > 0.0 ? neutral(acc.rgb / wHit) : 0.0;
        c = mix(c, u.bg.rgb, acc.a / n);   // the background is the page's own colour, untouched by tone mapping
        if (u.fx.w < 1.0) c = mix(held.read(gid).rgb, c, u.fx.w);   // the first samples fade in over the upscaled picture
        out.write(float4(srgb(c), 1.0), gid);
    }

    // Where p shows in a camera's picture, 0..1 from the top left.
    static float2 project(float3 pos, float3 fwd, float3 right, float3 up, bool ortho, float3 p) {
        float3 rel = p - pos;
        float z = ortho ? 1.0 : max(dot(rel, fwd), 1e-6);
        float2 ndc = float2(dot(rel, right) / dot(right, right), dot(rel, up) / dot(up, up)) / z;
        return float2(ndc.x, -ndc.y) * 0.5 + 0.5;
    }

    // The half-size pass for MetalFX: noisy light, and what the camera's ray met at each pixel.
    kernel void gbuf(uint2 gid [[thread_position_in_grid]], constant U& u [[buffer(0)]],
                     device const Vtx* vtx [[buffer(1)]], device const uint* idx [[buffer(2)]],
                     device const uint* tri [[buffer(3)]], device const Mat* mats [[buffer(4)]],
                     primitive_acceleration_structure accel [[buffer(5)]], device const float2* uvs [[buffer(6)]], device const Lamp* lamps [[buffer(7)]],
                     array<texture2d<float>, 8> texs [[texture(2)]],
                     texture2d<float, access::write> color [[texture(10)]], texture2d<float, access::write> depth [[texture(11)]],
                     texture2d<float, access::write> motion [[texture(12)]], texture2d<float, access::write> diffuse [[texture(13)]],
                     texture2d<float, access::write> specular [[texture(14)]], texture2d<float, access::write> normal [[texture(15)]],
                     texture2d<float, access::write> rough [[texture(16)]], texture2d<float, access::write> reach [[texture(17)]]) {
        uint2 size = uint2(color.get_width(), color.get_height());
        if (gid.x >= size.x || gid.y >= size.y) return;
        uint seed = (gid.x * 1973u + gid.y * 9277u + u.tick.x * 26699u) | 1u;
        float2 uv = (float2(gid) + 0.5 + u.fx.xy) / float2(size);   // every pixel's ray is off-centre by the frame's jitter
        float2 px = float2(uv.x, 1.0 - uv.y) * 2.0 - 1.0;
        First f; f.reach = 0.0; float4 acc = 0.0;
        for (uint s = 0; s < u.tick.y; s++) acc += path(u, accel, vtx, idx, tri, mats, uvs, lamps, texs, px, seed, f);
        acc /= float(max(u.tick.y, 1u));
        bool ortho = u.info.y == 1;
        float along = dot(f.p - u.camPos.xyz, u.camFwd.xyz);
        float z = !f.hit ? 0.0 : ortho ? saturate(1.0 - (along + u.scene.x * 4.0) / u.fx.z) : saturate(u.fx.z / max(along, 1e-6));
        float2 was = project(u.pPos.xyz, u.pFwd.xyz, u.pRight.xyz, u.pUp.xyz, ortho, f.p);
        // The page's colour shows where the floor fades out and where the ray met nothing, and it is not tone-mapped. So it is mixed
        // in as the eye will see it and the mix taken back to light: the denoiser gets one picture, and resolve's neutral() undoes this.
        float3 L = acc.a < 1.0 ? acc.rgb / (1.0 - acc.a) : float3(0.0);
        float lum = dot(L, float3(0.2126, 0.7152, 0.0722));
        if (lum > 3.0) L *= 3.0 / lum;   // brighter than this (it is white on screen already) and MetalFX hollows a highlight out into a ring
        if (acc.a > 0.0) L = unneutral(mix(neutral(L), u.bg.rgb, acc.a));
        color.write(float4(L, acc.a), gid);
        depth.write(float4(z), gid);
        motion.write(float4(was - uv, 0.0, 0.0), gid);
        diffuse.write(float4(f.diff, 1.0), gid);
        specular.write(float4(f.spec, 1.0), gid);
        normal.write(float4(f.n, 0.0), gid);
        rough.write(float4(f.rough), gid);
        reach.write(float4(f.reach), gid);
    }

    // MetalFX's picture, tone-mapped. Where the half-size pass saw only background the page's own colour goes in untouched.
    kernel void resolve(uint2 gid [[thread_position_in_grid]], constant U& u [[buffer(0)]],
                        texture2d<float> upscaled [[texture(0)]], texture2d<float> low [[texture(1)]],
                        texture2d<float, access::write> held [[texture(2)]], texture2d<float, access::write> out [[texture(3)]]) {
        constexpr sampler lin(filter::linear, address::clamp_to_edge);
        uint2 size = uint2(out.get_width(), out.get_height());
        if (gid.x >= size.x || gid.y >= size.y) return;
        float2 uv = (float2(gid) + 0.5) / float2(size), t = 1.0 / float2(low.get_width(), low.get_height());
        // all background for a pixel and a half around (at half size): the page's colour exactly, which neutral() cannot reach when it is white
        t *= 1.5;
        float w = min(low.sample(lin, uv, level(0)).a, min(min(low.sample(lin, uv + t, level(0)).a, low.sample(lin, uv - t, level(0)).a),
                                                           min(low.sample(lin, uv + float2(t.x, -t.y), level(0)).a, low.sample(lin, uv + float2(-t.x, t.y), level(0)).a)));
        float3 c = mix(neutral(max(upscaled.read(gid).rgb, 0.0)), u.bg.rgb, smoothstep(0.9, 1.0, w));
        held.write(float4(c, 1.0), gid);
        out.write(float4(srgb(c), 1.0), gid);
    }
    """
}
