// cadgang.app — a WKWebView over the bundled node server.
//
// The whole app is the web UI plus the server that already exists; this shell
// adds what a browser tab cannot: a Finder file association, ⌘O, a Dock icon,
// and a server that starts with the window and dies with it. Port 4477 is
// fixed on purpose: the Claude Code MCP server (.mcp.json) talks to that port,
// so the running app IS the thing Claude authors into. If a dev server already
// owns the port, the app just uses it.

import Cocoa
import WebKit
import UniformTypeIdentifiers
import Sparkle

let PORT = 4477
let BASE = URL(string: "http://127.0.0.1:\(PORT)")!
let EXTS = ["step", "stp", "iges", "igs", "brep", "stl", "obj", "ply", "3mf", "gltf", "glb", "fbx", "dxf", "cadgang"]

/// Files dropped ANYWHERE in the window (toolbar, canvas) open like a Finder
/// double-click. Left to WebKit, a file drop outside the page's own drop zone did nothing.
final class DropWebView: WKWebView {
    var tracer: PathTracer?
    var onFiles: (([URL]) -> Void)?
    /// Trackpad pinch goes to the page as a plain call: since the page sat in PageBox, WebKit's DOM
    /// gesture events stopped arriving. super is not called, so WebKit cannot zoom a second time.
    override func magnify(with e: NSEvent) { evaluateJavaScript("window.cadgangPinch?.(\(e.magnification))") }
    private func files(_ s: NSDraggingInfo) -> [URL] {
        (s.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL]) ?? []
    }
    override func draggingEntered(_ s: NSDraggingInfo) -> NSDragOperation { files(s).isEmpty ? super.draggingEntered(s) : .copy }
    override func draggingUpdated(_ s: NSDraggingInfo) -> NSDragOperation { files(s).isEmpty ? super.draggingUpdated(s) : .copy }
    override func prepareForDragOperation(_ s: NSDraggingInfo) -> Bool { files(s).isEmpty ? super.prepareForDragOperation(s) : true }
    override func performDragOperation(_ s: NSDraggingInfo) -> Bool {
        let urls = files(s)
        if urls.isEmpty { return super.performDragOperation(s) }
        onFiles?(urls); return true
    }
}

/// The window's content: the page over the Metal render view (render.swift). Flipped, so the page's
/// viewport rect (top-left origin) is the render view's frame as is.
final class PageBox: NSView {
    override var isFlipped: Bool { true }
    override func magnify(with e: NSEvent) { webIn(window)?.magnify(with: e) }   // a pinch that landed on the box, not the page
}
func webIn(_ win: NSWindow?) -> DropWebView? { win?.contentView?.subviews.lazy.compactMap { $0 as? DropWebView }.first }

final class App: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    var web: DropWebView!            // the first window's page; files that arrive before it is ready wait for it
    var windows: [NSWindow] = []     // one per open file; each page has its own markups, the server tells them apart
    var titleWatch: [NSKeyValueObservation] = []
    var keyWeb: DropWebView { webIn(NSApp.keyWindow) ?? web }
    var node: Process?
    // Sparkle: checks the appcast in Info.plist (SUFeedURL), verifies with SUPublicEDKey, swaps the app in place.
    let updater = SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: nil, userDriverDelegate: nil)
    var ready = false
    var pending: [String] = []
    var quitting = false             // a quit tears the windows down; that must not look like the user closing them

    func applicationDidFinishLaunching(_ n: Notification) {
        buildMenu()
        let cfg = WKWebViewConfiguration()
        cfg.preferences.setValue(true, forKey: "developerExtrasEnabled")
        // The page learns it is inside the app, and can ask the shell for things only a shell can do.
        cfg.userContentController.addUserScript(WKUserScript(source: "window.cadgangDesktop = true", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        cfg.userContentController.add(self, name: "cadgang")
        cfg.preferences.javaScriptCanOpenWindowsAutomatically = true   // the page opens a second file with window.open
        // A background tab stays awake (WebKit suspends it by default): a Claude session asking for its screen gets an answer.
        if #available(macOS 14.0, *) { cfg.preferences.inactiveSchedulingPolicy = .none }
        web = makeWindow(cfg)
        NSApp.activate(ignoringOtherApps: true)
        startServer()
    }

    /// A window around a page. The page sets its own title; files dropped on it open in it.
    func makeWindow(_ cfg: WKWebViewConfiguration) -> DropWebView {
        let w = DropWebView(frame: .zero, configuration: cfg)
        w.navigationDelegate = self
        w.uiDelegate = self
        let win = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1400, height: 900),
                           styleMask: [.titled, .closable, .miniaturizable, .resizable],
                           backing: .buffered, defer: false)
        win.isReleasedWhenClosed = false
        win.title = "CADgang"
        let box = PageBox()
        win.contentView = box
        w.frame = box.bounds; w.autoresizingMask = [.width, .height]
        w.setValue(false, forKey: "drawsBackground")   // the page paints its own paper; under RENDER its viewport is see-through
        box.addSubview(w)
        w.onFiles = { [weak self, weak w] urls in if let w = w { self?.open(urls.map { $0.path }, in: w) } }
        titleWatch.append(w.observe(\.title, options: [.new]) { [weak win] w, _ in win?.title = (w.title?.isEmpty == false) ? w.title! : "CADgang" })
        titleWatch.append(w.observe(\.url, options: [.new]) { [weak self] _, _ in self?.saveWindows() })
        if let key = NSApp.keyWindow {
            win.cascadeTopLeft(from: NSPoint(x: key.frame.minX + 24, y: key.frame.maxY - 24))
        } else {
            win.setFrameAutosaveName("cadgang.main"); win.center()
        }
        windows.append(win)
        NotificationCenter.default.addObserver(forName: NSWindow.willCloseNotification, object: win, queue: .main) { [weak self] n in
            self?.windows.removeAll { $0 === (n.object as? NSWindow) }
            self?.saveWindows()
        }
        win.makeKeyAndOrderFront(nil)
        return w
    }

    /// The page asked for a window (window.open, target=_blank): give it one, unless it is another site
    /// (a link like vercel.com/account/tokens), which opens in the default browser. WebKit loads the request into the view we return.
    func webView(_ w: WKWebView, createWebViewWith cfg: WKWebViewConfiguration, for nav: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let u = nav.request.url, u.host != BASE.host { NSWorkspace.shared.open(u); return nil }
        return makeWindow(cfg)
    }

    @objc func showCells(_ s: Any?) { web.load(URLRequest(url: BASE.appendingPathComponent("cells"))) }
    @objc func showViewer(_ s: Any?) { web.load(URLRequest(url: BASE.appendingPathComponent("view"))) }
    @objc func newWindow(_ s: Any?) { makeWindow(web.configuration).load(URLRequest(url: BASE.appendingPathComponent("view"))) }

    func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { true }
    func applicationShouldTerminate(_ s: NSApplication) -> NSApplication.TerminateReply { quitting = true; return .terminateNow }
    func applicationWillTerminate(_ n: Notification) { node?.terminate() }

    // MARK: session

    /// The open files, as the windows' addresses (the page keeps ?open= current), kept on every change
    /// so a quit, a crash or a force quit all come back to the same windows.
    static let SESSION = "cadgang.windows"
    func saveWindows() {
        if quitting { return }
        let urls = windows.compactMap { webIn($0)?.url }.filter { $0.query?.contains("open=") == true }
        UserDefaults.standard.set(urls.map { $0.absoluteString }, forKey: Self.SESSION)
    }
    func savedWindows() -> [URL] {
        (UserDefaults.standard.stringArray(forKey: Self.SESSION) ?? []).compactMap { URL(string: $0) }.filter { $0.port == BASE.port }
    }

    // MARK: server

    func startServer() {
        health { up in
            if up { self.load(); return }
            let res = Bundle.main.resourceURL!
            let p = Process()
            p.executableURL = res.appendingPathComponent("node")
            p.arguments = [res.appendingPathComponent("app/src/server/supervise.js").path]
            let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("cadgang")
            try? FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
            var env = ProcessInfo.processInfo.environment
            env["CADGANG_DESKTOP"] = "1"
            env["CADGANG_PORT"] = String(PORT)
            env["CADGANG_DATA"] = support.path   // markups and the last screen
            env["CADGANG_CELLS"] = support.appendingPathComponent("cells.json").path   // the cell stack until a project is set
            p.environment = env
            p.currentDirectoryURL = support
            p.standardOutput = FileHandle.standardOutput
            p.standardError = FileHandle.standardError
            do { try p.run() } catch {
                self.fail("Could not start the bundled server: \(error.localizedDescription)"); return
            }
            self.node = p
            self.waitForServer(tries: 100)
        }
    }

    func waitForServer(tries: Int) {
        health { up in
            if up { self.load() }
            else if tries == 0 { self.fail("The server did not answer on port \(PORT).") }
            else { DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { self.waitForServer(tries: tries - 1) } }
        }
    }

    func health(_ done: @escaping (Bool) -> Void) {
        var req = URLRequest(url: BASE.appendingPathComponent("api/health"), timeoutInterval: 1)
        req.cachePolicy = .reloadIgnoringLocalCacheData
        URLSession.shared.dataTask(with: req) { _, resp, _ in
            DispatchQueue.main.async { done((resp as? HTTPURLResponse)?.statusCode == 200) }
        }.resume()
    }

    func load() {
        let saved = savedWindows()
        web.load(URLRequest(url: saved.first ?? BASE.appendingPathComponent("view")))
        for u in saved.dropFirst() { makeWindow(web.configuration).load(URLRequest(url: u)) }
    }

    func fail(_ msg: String) {
        let a = NSAlert(); a.messageText = "CADgang"; a.informativeText = msg; a.runModal()
        NSApp.terminate(nil)
    }

    // MARK: files

    // Finder, ⌘O and the Dock hand files to the key window's page; it opens them there if it is
    // empty, otherwise in a new window. Before the first page is up they wait.
    func application(_ app: NSApplication, open urls: [URL]) {
        if ready { open(urls.map { $0.path }, in: keyWeb) } else { pending += urls.map { $0.path } }
    }

    func webView(_ w: WKWebView, didFinish nav: WKNavigation!) {
        guard w === web, !ready else { return }
        ready = true
        if !pending.isEmpty { let p = pending; pending = []; open(p, in: web) }
    }

    func open(_ paths: [String], in w: WKWebView) {
        let json = String(data: try! JSONSerialization.data(withJSONObject: paths), encoding: .utf8)!
        w.evaluateJavaScript("window.cadgangOpen ? cadgangOpen(\(json)) : (location.href = '/view?open=' + encodeURIComponent(\(json).join('|')))")
    }

    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        guard let body = m.body as? [String: Any], let cmd = body["cmd"] as? String else { return }
        if cmd == "defaultApp" { makeDefaultViewer() }
        if cmd.hasPrefix("render"), let w = m.webView as? DropWebView { render(cmd, body, in: w) }
        // AirDrop the ?follow link: the sheet lists nearby devices; the iPad opens it in Safari.
        if cmd == "airdrop", let s = body["url"] as? String, let u = URL(string: s) { NSSharingService(named: .sendViaAirDrop)?.perform(withItems: [u]) }
        // The page's clipboard API refuses after an await (the click's activation is spent), so the shell copies.
        // Save project: the Save panel picks the path; the page then sends the bytes to the server, which writes them.
        if cmd == "saveProject", let w = m.webView {
            let panel = NSSavePanel()
            panel.allowedFileTypes = ["cadgang"]
            panel.nameFieldStringValue = body["name"] as? String ?? "project.cadgang"
            if let d = body["dir"] as? String, !d.isEmpty { panel.directoryURL = URL(fileURLWithPath: d) }
            panel.begin { r in
                guard r == .OK, let u = panel.url, let data = try? JSONSerialization.data(withJSONObject: [u.path]), let json = String(data: data, encoding: .utf8) else { return }
                w.evaluateJavaScript("window.cadgangSaveTo?.(\(json)[0])")
            }
        }
        if cmd == "copy", let s = body["text"] as? String { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(s, forType: .string) }
    }

    /// RENDER: the page drives a PathTracer that sits under it (render.swift).
    func render(_ cmd: String, _ body: [String: Any], in w: DropWebView) {
        if cmd == "render" { w.tracer?.stop(); return }
        if w.tracer == nil, let box = w.superview {
            guard let t = PathTracer(frame: .zero) else { w.evaluateJavaScript("window.cadgangNativeRender?.(false)"); return }
            box.addSubview(t.view, positioned: .below, relativeTo: w)
            w.tracer = t
        }
        guard let t = w.tracer else { return }
        if cmd == "renderScene",
           let v = (body["verts"] as? String).flatMap({ Data(base64Encoded: $0) }), let i = (body["idx"] as? String).flatMap({ Data(base64Encoded: $0) }),
           let tr = (body["tri"] as? String).flatMap({ Data(base64Encoded: $0) }), let mats = body["mats"] as? [[Double]] {
            t.setScene(verts: v, idx: i, tri: tr, mats: mats, cap: (body["cap"] as? [Double]) ?? [0.04, 0.04, 0.04], bg: (body["bg"] as? [Double]) ?? [1, 1, 1],
                       uv: (body["uv"] as? String).flatMap { Data(base64Encoded: $0) }, pngs: ((body["pngs"] as? [String]) ?? []).compactMap { Data(base64Encoded: $0) })
        }
        if cmd == "renderCam" { t.setCamera(body) }
    }

    /// Become the Finder's app for every extension the viewer reads. One LaunchServices
    /// call per type; the page gets a one-line verdict.
    func makeDefaultViewer() {
        let group = DispatchGroup(); var failed: [String] = []
        for ext in EXTS {
            // Every type claiming the extension: another app's own 3MF type, the public one, a dynamic one.
            let types = UTType.types(tag: ext, tagClass: .filenameExtension, conformingTo: nil)
            if types.isEmpty { failed.append(ext); continue }
            var ok = 0; let sub = DispatchGroup()
            for t in types {
                sub.enter()
                NSWorkspace.shared.setDefaultApplication(at: Bundle.main.bundleURL, toOpen: t) { err in if err == nil { ok += 1 }; sub.leave() }
            }
            group.enter(); sub.notify(queue: .main) { if ok == 0 { failed.append(ext) }; group.leave() }
        }
        group.notify(queue: .main) {
            let msg = failed.isEmpty ? "CADgang is now the default app for \(EXTS.count) CAD file types"
                                     : "Could not take over: \(failed.joined(separator: ", "))"
            let json = String(data: try! JSONSerialization.data(withJSONObject: [msg, !failed.isEmpty]), encoding: .utf8)!
            self.keyWeb.evaluateJavaScript("window.cadgangNotify && cadgangNotify(...\(json))")
        }
    }

    @objc func saveProject(_ s: Any?) { keyWeb.evaluateJavaScript("window.cadgangSave?.(false)") }
    @objc func saveProjectAs(_ s: Any?) { keyWeb.evaluateJavaScript("window.cadgangSave?.(true)") }

    @objc func openDocument(_ s: Any?) {
        let p = NSOpenPanel()
        p.allowsMultipleSelection = true
        p.allowedFileTypes = EXTS
        if p.runModal() == .OK { application(NSApp, open: p.urls) }
    }


    // The v1 page still asks with confirm(); without these a WKWebView answers silently.
    func webView(_ w: WKWebView, runJavaScriptAlertPanelWithMessage m: String, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = NSAlert(); a.messageText = m; a.runModal(); completionHandler()
    }
    func webView(_ w: WKWebView, runJavaScriptConfirmPanelWithMessage m: String, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = NSAlert(); a.messageText = m; a.addButton(withTitle: "OK"); a.addButton(withTitle: "Cancel")
        completionHandler(a.runModal() == .alertFirstButtonReturn)
    }
    func webView(_ w: WKWebView, runJavaScriptTextInputPanelWithPrompt p: String, defaultText: String?, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let a = NSAlert(); a.messageText = p; a.addButton(withTitle: "OK"); a.addButton(withTitle: "Cancel")
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 300, height: 24)); field.stringValue = defaultText ?? ""
        a.accessoryView = field
        completionHandler(a.runModal() == .alertFirstButtonReturn ? field.stringValue : nil)
    }

    // <input type=file> inside the page
    func webView(_ w: WKWebView, runOpenPanelWith p: WKOpenPanelParameters, initiatedByFrame f: WKFrameInfo,
                 completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = p.allowsMultipleSelection
        panel.begin { completionHandler($0 == .OK ? panel.urls : nil) }
    }

    // MARK: menu

    func buildMenu() {
        let main = NSMenu()
        let app = NSMenuItem(); main.addItem(app)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About CADgang", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        let check = NSMenuItem(title: "Check for Updates…", action: #selector(SPUStandardUpdaterController.checkForUpdates(_:)), keyEquivalent: "")
        check.target = updater
        appMenu.addItem(check)
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit CADgang", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        app.submenu = appMenu

        let file = NSMenuItem(); main.addItem(file)
        let fileMenu = NSMenu(title: "File")
        fileMenu.addItem(withTitle: "New Window", action: #selector(newWindow(_:)), keyEquivalent: "n")
        fileMenu.addItem(withTitle: "Open…", action: #selector(openDocument(_:)), keyEquivalent: "o")
        fileMenu.addItem(withTitle: "Save Project", action: #selector(saveProject(_:)), keyEquivalent: "s")
        fileMenu.addItem(withTitle: "Save Project As…", action: #selector(saveProjectAs(_:)), keyEquivalent: "S")
        fileMenu.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        file.submenu = fileMenu

        let edit = NSMenuItem(); main.addItem(edit)
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        edit.submenu = editMenu

        let view = NSMenuItem(); main.addItem(view)
        let viewMenu = NSMenu(title: "View")
        viewMenu.addItem(withTitle: "Viewer", action: #selector(showViewer(_:)), keyEquivalent: "1").keyEquivalentModifierMask = [.command, .shift]
        viewMenu.addItem(withTitle: "Cells", action: #selector(showCells(_:)), keyEquivalent: "2").keyEquivalentModifierMask = [.command, .shift]
        viewMenu.addItem(withTitle: "Reload", action: #selector(WKWebView.reload(_:)), keyEquivalent: "r")
        view.submenu = viewMenu

        let win = NSMenuItem(); main.addItem(win)
        let winMenu = NSMenu(title: "Window")
        winMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        winMenu.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        win.submenu = winMenu
        NSApp.windowsMenu = winMenu
        NSApp.mainMenu = main
    }
}

let app = NSApplication.shared
let delegate = App()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
