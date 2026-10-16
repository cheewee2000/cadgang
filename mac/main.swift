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
let EXTS = ["step", "stp", "iges", "igs", "brep", "stl", "obj", "ply", "3mf", "gltf", "glb", "fbx", "dxf"]

/// Files dropped ANYWHERE in the window (toolbar, canvas) open like a Finder
/// double-click. Left to WebKit, a file drop outside the page's own drop zone did nothing.
final class DropWebView: WKWebView {
    var onFiles: (([URL]) -> Void)?
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

final class App: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    var window: NSWindow!
    var web: DropWebView!
    var node: Process?
    // Sparkle: checks the appcast in Info.plist (SUFeedURL), verifies with SUPublicEDKey, swaps the app in place.
    let updater = SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: nil, userDriverDelegate: nil)
    var ready = false
    var pending: [String] = []

    func applicationDidFinishLaunching(_ n: Notification) {
        buildMenu()
        let cfg = WKWebViewConfiguration()
        cfg.preferences.setValue(true, forKey: "developerExtrasEnabled")
        // The page learns it is inside the app, and can ask the shell for things only a shell can do.
        cfg.userContentController.addUserScript(WKUserScript(source: "window.cadgangDesktop = true", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        cfg.userContentController.add(self, name: "cadgang")
        web = DropWebView(frame: .zero, configuration: cfg)
        web.onFiles = { [weak self] urls in self?.application(NSApp, open: urls) }
        web.navigationDelegate = self
        web.uiDelegate = self
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1400, height: 900),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "CADgang"
        window.contentView = web
        window.setFrameAutosaveName("cadgang.main")
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        startServer()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { true }
    func applicationWillTerminate(_ n: Notification) { node?.terminate() }

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

    func load() { web.load(URLRequest(url: BASE.appendingPathComponent("view"))) }

    func fail(_ msg: String) {
        let a = NSAlert(); a.messageText = "CADgang"; a.informativeText = msg; a.runModal()
        NSApp.terminate(nil)
    }

    // MARK: files

    func application(_ app: NSApplication, open urls: [URL]) {
        pending += urls.map { $0.path }
        flush()
    }

    func webView(_ w: WKWebView, didFinish nav: WKNavigation!) { ready = true; flush() }

    func flush() {
        guard ready, !pending.isEmpty else { return }
        let paths = pending; pending = []
        let json = String(data: try! JSONSerialization.data(withJSONObject: paths), encoding: .utf8)!
        web.evaluateJavaScript("window.cadgangOpen ? cadgangOpen(\(json)) : (location.href = '/view?open=' + encodeURIComponent(\(json).join('|')))")
    }

    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        guard let body = m.body as? [String: Any], let cmd = body["cmd"] as? String else { return }
        if cmd == "defaultApp" { makeDefaultViewer() }
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
            self.web.evaluateJavaScript("window.cadgangNotify && cadgangNotify(...\(json))")
        }
    }

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
        fileMenu.addItem(withTitle: "Open…", action: #selector(openDocument(_:)), keyEquivalent: "o")
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
