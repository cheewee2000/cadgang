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

let PORT = 4477
let BASE = URL(string: "http://127.0.0.1:\(PORT)")!

final class App: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var node: Process?
    var ready = false
    var pending: [String] = []

    func applicationDidFinishLaunching(_ n: Notification) {
        buildMenu()
        let cfg = WKWebViewConfiguration()
        cfg.preferences.setValue(true, forKey: "developerExtrasEnabled")
        web = WKWebView(frame: .zero, configuration: cfg)
        web.navigationDelegate = self
        web.uiDelegate = self
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1400, height: 900),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "cadgang"
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
            p.arguments = [res.appendingPathComponent("app/src/server/index.js").path]
            let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("cadgang")
            try? FileManager.default.createDirectory(at: support.appendingPathComponent("exports"), withIntermediateDirectories: true)
            var env = ProcessInfo.processInfo.environment
            env["CADGANG_DESKTOP"] = "1"
            env["CADGANG_PORT"] = String(PORT)
            env["CADGANG_DOC"] = support.appendingPathComponent("document.json").path
            env["CADGANG_CELLS"] = support.appendingPathComponent("cells.json").path
            env["CADGANG_EXPORTS"] = support.appendingPathComponent("exports").path
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
        let a = NSAlert(); a.messageText = "cadgang"; a.informativeText = msg; a.runModal()
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
        web.evaluateJavaScript("window.cadgangOpen ? cadgangOpen(\(json)) : (window.cadgangPending = \(json))")
    }

    @objc func openDocument(_ s: Any?) {
        let p = NSOpenPanel()
        p.allowsMultipleSelection = true
        p.allowedFileTypes = ["step", "stp", "iges", "igs", "brep", "stl", "obj", "ply", "3mf", "gltf", "glb", "fbx"]
        if p.runModal() == .OK { application(NSApp, open: p.urls) }
    }

    @objc func showCells(_ s: Any?) { web.load(URLRequest(url: BASE.appendingPathComponent("cells"))) }
    @objc func showViewer(_ s: Any?) { load() }

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
        appMenu.addItem(withTitle: "About cadgang", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit cadgang", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
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
