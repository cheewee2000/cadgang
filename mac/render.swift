// RENDER in the app: a Metal path tracer (hardware ray tracing on M3 and newer) drawn in an MTKView
// UNDER the page. The page goes transparent over its viewport while it is on, so every HTML control
// stays on top and nothing is copied back. The page sends the visible triangles once per change
// (renderScene) and the camera + section plane + viewport rect whenever they move (renderCam).
// Samples accumulate while the view holds still; any change starts them over.

import MetalKit

struct RenderUniforms {
    var camPos = SIMD4<Float>(), camFwd = SIMD4<Float>(), camRight = SIMD4<Float>(), camUp = SIMD4<Float>()
    var sunDir = SIMD4<Float>(), sunCol = SIMD4<Float>(), skyTop = SIMD4<Float>(), skyBot = SIMD4<Float>()
    var bg = SIMD4<Float>(), clip = SIMD4<Float>()   // clip: keep where dot(xyz, p) + w >= 0; xyz = 0 is off
    var scene = SIMD4<Float>()                       // x: scene diagonal, y: ray offset, z: floor height
    var info = SIMD4<UInt32>()                       // x: samples so far, y: ortho, z: samples this frame, w: floor's first triangle
}

final class PathTracer: NSObject, MTKViewDelegate {
    let view: MTKView
    private let queue: MTLCommandQueue
    private let pipe: MTLComputePipelineState
    private var accel: MTLAccelerationStructure?
    private var vtx: MTLBuffer?, idx: MTLBuffer?, tri: MTLBuffer?, mats: MTLBuffer?
    private var accum: MTLTexture?
    private var u = RenderUniforms()
    private var cam: [String: Any] = [:]
    static let maxSamples: UInt32 = 4096

    init?(frame: NSRect) {
        guard let dev = MTLCreateSystemDefaultDevice(), dev.supportsRaytracing, let q = dev.makeCommandQueue() else { return nil }
        do {
            let lib = try dev.makeLibrary(source: PathTracer.shader, options: nil)
            pipe = try dev.makeComputePipelineState(function: lib.makeFunction(name: "trace")!)
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
    }

    func stop() { view.isHidden = true; view.isPaused = true; accel = nil; vtx = nil; idx = nil; tri = nil; mats = nil }

    /// verts: [x y z nx ny nz] per vertex, world space. idx: 3 per triangle. tri: material per triangle.
    /// mats: [r g b metalness roughness transmission ior] (linear colour).
    func setScene(verts: Data, idx idxData: Data, tri triData: Data, mats matList: [[Double]], cap: [Double], bg: [Double]) {
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
        m.append([0.92, 0.91, 0.89, 0, 0.9, 0, 1.5])                          // floor
        m.append(cap.map(Float.init) + [0, 0.7, 0, 1.5])                       // section cap
        tm += [UInt32(m.count - 2), UInt32(m.count - 2)]
        let mats8: [Float] = m.flatMap { [$0[0], $0[1], $0[2], 0, $0[3], $0[4], $0[5], $0.count > 6 ? $0[6] : 1.5] }   // two float4 per material
        vtx = dev.makeBuffer(bytes: v, length: v.count * 4, options: .storageModeShared)
        idx = dev.makeBuffer(bytes: ix, length: ix.count * 4, options: .storageModeShared)
        tri = dev.makeBuffer(bytes: tm, length: tm.count * 4, options: .storageModeShared)
        mats = dev.makeBuffer(bytes: mats8, length: mats8.count * 4, options: .storageModeShared)
        u.bg = SIMD4(Float(bg[0]), Float(bg[1]), Float(bg[2]), 1)
        u.scene = SIMD4(diag, diag * 2e-5, z, 0)
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
    /// clip: the section plane [nx ny nz c] or nil; rect: the viewport in the page's points, top-left origin.
    func setCamera(_ c: [String: Any]) {
        cam = c
        if let r = c["rect"] as? [Double], r.count == 4 {
            let f = NSRect(x: r[0], y: r[1], width: r[2], height: r[3])
            if view.frame != f { view.frame = f }
        }
        let p = (c["clip"] as? [Double]) ?? [0, 0, 0, 0]
        u.clip = SIMD4(Float(p[0]), Float(p[1]), Float(p[2]), Float(p[3]))
        view.isHidden = false
        restart()
    }

    private func restart() { u.info.x = 0; view.isPaused = accel == nil }

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
        guard let drawable = v.currentDrawable, let cb = queue.makeCommandBuffer(), encode(into: drawable.texture, cb) else { return }
        cb.present(drawable); cb.commit()
        if u.info.x >= Self.maxSamples { v.isPaused = true }   // converged: stop spending the GPU
    }

    /// One frame of samples into accum, tone-mapped into out.
    func encode(into out: MTLTexture, _ cb: MTLCommandBuffer) -> Bool {
        guard let accel = accel, let enc = cb.makeComputeCommandEncoder() else { return false }
        if accum?.width != out.width || accum?.height != out.height {
            let td = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .rgba32Float, width: out.width, height: out.height, mipmapped: false)
            td.usage = [.shaderRead, .shaderWrite]; td.storageMode = .private
            accum = view.device!.makeTexture(descriptor: td); u.info.x = 0
        }
        basis(aspect: Float(out.width) / Float(max(out.height, 1)))
        u.info.z = u.info.x < 4 ? 1 : 4   // one sample a frame while moving, four once it holds still
        enc.setComputePipelineState(pipe)
        enc.setBytes(&u, length: MemoryLayout<RenderUniforms>.stride, index: 0)
        enc.setBuffer(vtx, offset: 0, index: 1); enc.setBuffer(idx, offset: 0, index: 2)
        enc.setBuffer(tri, offset: 0, index: 3); enc.setBuffer(mats, offset: 0, index: 4)
        enc.setAccelerationStructure(accel, bufferIndex: 5)
        enc.setTexture(accum, index: 0); enc.setTexture(out, index: 1)
        enc.dispatchThreadgroups(MTLSize(width: (out.width + 7) / 8, height: (out.height + 7) / 8, depth: 1), threadsPerThreadgroup: MTLSize(width: 8, height: 8, depth: 1))
        enc.endEncoding()
        u.info.x += u.info.z
        return true
    }

    static let shader = """
    #include <metal_stdlib>
    #include <metal_raytracing>
    using namespace metal;
    using namespace raytracing;

    struct U { float4 camPos, camFwd, camRight, camUp, sunDir, sunCol, skyTop, skyBot, bg, clip, scene; uint4 info; };
    struct Vtx { packed_float3 p; packed_float3 n; };
    struct Mat { float4 color; float4 prm; };   // prm: metalness, roughness, transmission, ior

    static uint pcg(thread uint& s) { s = s * 747796405u + 2891336453u; uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u; return (w >> 22u) ^ w; }
    static float rnd(thread uint& s) { return float(pcg(s)) * (1.0 / 4294967296.0); }
    static float3 onb(float3 n, float3 v) {   // v in n's tangent frame → world
        float3 t = abs(n.z) < 0.999 ? normalize(cross(float3(0, 0, 1), n)) : float3(1, 0, 0);
        return v.x * t + v.y * cross(n, t) + v.z * n;
    }
    static float3 sky(constant U& u, float3 d) { return mix(u.skyBot.rgb, u.skyTop.rgb, smoothstep(-0.3, 0.8, d.z)); }

    struct Hit { bool hit; float t; float3 ng; float3 n; uint mat; bool cap; uint prim; };

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
            if (isFloor && u.camPos.z < u.scene.z) { tmin = x.distance + u.scene.y; continue; }   // looking up from under it: no floor
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
            h.hit = true; h.t = x.distance; h.ng = ng; h.n = dot(n, ng) < 0.0 ? -n : n; h.mat = tri[i]; h.prim = i;
            return h;
        }
        return h;
    }

    // How much sun gets through from o along d: clear bodies let it through tinted, anything else stops it.
    static float3 shadow(constant U& u, primitive_acceleration_structure accel, device const Vtx* vtx, device const uint* idx,
                         device const uint* tri, device const Mat* mats, float3 o, float3 d) {
        float3 t = 1.0;
        for (int k = 0; k < 8; k++) {
            Hit h = closest(u, accel, vtx, idx, tri, o, d, INFINITY);
            if (!h.hit) return t;
            if (h.cap || mats[h.mat].prm.z < 0.5) return 0.0;
            t *= mats[h.mat].color.rgb;
            o += d * (h.t + u.scene.y);
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

    static float3 neutral(float3 c) {   // Khronos PBR Neutral tone mapping
        float x = min(c.r, min(c.g, c.b)), off = x < 0.08 ? x - 6.25 * x * x : 0.04;
        c -= off;
        float peak = max(c.r, max(c.g, c.b));
        if (peak < 0.76) return c;
        float np = 1.0 - 0.0576 / (peak + 0.24 - 0.76);
        c *= np / peak;
        return mix(c, float3(np), 1.0 - 1.0 / (0.15 * (peak - np) + 1.0));
    }
    static float3 srgb(float3 c) { c = saturate(c); return select(1.055 * pow(c, 1.0 / 2.4) - 0.055, 12.92 * c, c <= 0.0031308); }

    kernel void trace(uint2 gid [[thread_position_in_grid]], constant U& u [[buffer(0)]],
                      device const Vtx* vtx [[buffer(1)]], device const uint* idx [[buffer(2)]],
                      device const uint* tri [[buffer(3)]], device const Mat* mats [[buffer(4)]],
                      primitive_acceleration_structure accel [[buffer(5)]],
                      texture2d<float, access::read_write> accum [[texture(0)]], texture2d<float, access::write> out [[texture(1)]]) {
        uint2 size = uint2(out.get_width(), out.get_height());
        if (gid.x >= size.x || gid.y >= size.y) return;
        uint seed = (gid.x * 1973u + gid.y * 9277u + u.info.x * 26699u) | 1u;
        float4 acc = u.info.x == 0 ? float4(0) : accum.read(gid);   // rgb: weighted radiance; a: background weight
        float diag = u.scene.x, eps = u.scene.y;
        for (uint s = 0; s < u.info.z; s++) {
            float2 px = (float2(gid) + float2(rnd(seed), rnd(seed))) / float2(size) * 2.0 - 1.0;
            px.y = -px.y;
            float3 o = u.camPos.xyz, d;
            if (u.info.y == 1) { o += px.x * u.camRight.xyz + px.y * u.camUp.xyz - u.camFwd.xyz * diag * 4.0; d = u.camFwd.xyz; }
            else d = normalize(u.camFwd.xyz + px.x * u.camRight.xyz + px.y * u.camUp.xyz);
            float3 L = 0.0, T = 1.0;
            float bgw = 0.0;
            for (int depth = 0; depth < 8; depth++) {
                Hit h = closest(u, accel, vtx, idx, tri, o, d, INFINITY);
                if (!h.hit) { if (depth == 0) bgw = 1.0; else L += T * sky(u, d); break; }
                float3 p = o + d * h.t;
                bool isFloor = !h.cap && h.prim >= u.info.w;
                if (depth == 0 && isFloor) bgw = smoothstep(diag * 1.5, diag * 10.0, h.t);   // the floor melts into the background
                Mat m = mats[h.cap ? (u.info.w > 0 ? tri[u.info.w] + 1 : 0) : h.mat];
                float3 col = m.color.rgb;
                float metal = m.prm.x, a = max(m.prm.y * m.prm.y, 0.002), a2 = a * a, trans = m.prm.z;
                float3 v = -d;
                if (trans > 0.5) {   // glass: Fresnel-weighted reflect or refract, IOR 1.5
                    bool entering = dot(h.ng, d) < 0.0;
                    float3 n = entering ? h.n : -h.n;
                    float ior = m.prm.w > 1.0 ? m.prm.w : 1.5, eta = entering ? 1.0 / ior : ior, cosi = min(dot(v, n), 1.0);
                    float f0 = (ior - 1.0) * (ior - 1.0) / ((ior + 1.0) * (ior + 1.0)), F = f0 + (1.0 - f0) * pow(saturate(1.0 - cosi), 5.0);
                    float3 rd = refract(d, n, eta);
                    if (all(rd == 0.0) || rnd(seed) < F) { d = reflect(d, n); o = p + n * eps; }
                    else { d = rd; o = p - n * eps; T *= col; }
                    continue;
                }
                float3 n = h.n, ng = dot(h.ng, d) < 0.0 ? h.ng : -h.ng;
                if (dot(n, ng) < 0.0) n = ng;
                o = p + ng * eps;
                // Sun: one shadowed sample inside its disc (soft shadow edge).
                float3 sd = normalize(u.sunDir.xyz + onb(u.sunDir.xyz, float3((rnd(seed) * 2.0 - 1.0), (rnd(seed) * 2.0 - 1.0), 0.0)) * u.sunDir.w);
                if (dot(n, sd) > 0.0)
                    L += T * brdf(n, v, sd, col, metal, a2) * dot(n, sd) * u.sunCol.rgb * shadow(u, accel, vtx, idx, tri, mats, o, sd);
                // Next direction: GGX lobe or cosine hemisphere, weighted by their mixture pdf.
                float pSpec = mix(0.25, 1.0, metal);
                float3 l;
                if (rnd(seed) < pSpec) {
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
                float3 hv = normalize(v + l);
                float nh = max(dot(n, hv), 0.0), vh = max(dot(v, hv), 1e-4);
                float pdf = pSpec * ggxD(nh, a2) * nh / (4.0 * vh) + (1.0 - pSpec) * nl / M_PI_F;
                T *= brdf(n, v, l, col, metal, a2) * nl / max(pdf, 1e-6);
                d = l;
                if (depth >= 3) { float q = min(max(T.r, max(T.g, T.b)), 0.95); if (rnd(seed) > q) break; T /= q; }
            }
            float lum = dot(L, float3(0.2126, 0.7152, 0.0722));
            if (lum > 20.0) L *= 20.0 / lum;   // firefly clamp
            acc += float4(L * (1.0 - bgw), bgw);
        }
        accum.write(acc, gid);
        float n = float(u.info.x + u.info.z), wHit = n - acc.a;
        float3 c = wHit > 0.0 ? neutral(acc.rgb / wHit) : 0.0;
        c = mix(c, u.bg.rgb, acc.a / n);   // the background is the page's own colour, untouched by tone mapping
        out.write(float4(srgb(c), 1.0), gid);
    }
    """
}
