// CADgang for iPhone and iPad: a second screen for the Mac app. It shows the Mac's own page
// (http://<mac>:4477/view?follow, see web/view.js), which opens what the Mac has open, follows when
// that changes, and shares its markups. All this file adds is finding the Mac, and find.html lists
// what was found.
//
// Finding it: the Mac app does not announce itself (macOS asks every Mac user for the local network
// permission before an app may, and an older Mac app would not be found at all). Every Mac already
// announces itself over Bonjour, though, so the Macs on the network are looked up by that and each
// is asked on CADgang's port whether CADgang is open there.
import SwiftUI
import WebKit

@main struct CadgangApp: App {
    var body: some Scene { WindowGroup { Shell().ignoresSafeArea() } }
}
struct Shell: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> Viewer { Viewer() }
    func updateUIViewController(_ v: Viewer, context: Context) {}
}

// ponytail: NetService is deprecated but still the short way to an IPv4 address; NWBrowser when it goes.
final class Viewer: UIViewController, WKNavigationDelegate, NetServiceBrowserDelegate, NetServiceDelegate {
    static let ADDR = "cadgang.mac", NAME = "cadgang.mac.name"   // the Mac last shown: host:port, and its Bonjour name
    var web: WKWebView!
    static let PORT = 4477             // the Mac app's, fixed (mac/main.swift)
    // ponytail: what a Mac announces by itself (Handoff, AirPlay receiving). A Mac with both switched off is typed in by address.
    static let TYPES = ["_companion-link._tcp.", "_airplay._tcp."]   // each is in NSBonjourServices (project.yml)
    let browsers = TYPES.map { _ in NetServiceBrowser() }
    var resolving: [NetService] = []
    var hosts: [String: String] = [:]  // every machine found: Bonjour name → IPv4
    var macs: [String: String] = [:]   // the ones with CADgang open: name → host:port
    var finding = false                // find.html is up, or on its way
    var loaded = false                 // ...and has loaded: nothing else is opened before that, or the two loads race and the list can win, deaf
    var picking = false                // ...because the person asked for it: nothing opens by itself
    var failed: String?                // the address that just did not answer, not tried again unasked
    var note = ""

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .white
        let config = WKWebViewConfiguration()
        // The page's footer gets a way back to the list of Macs.
        config.userContentController.addUserScript(WKUserScript(source: """
            if (location.pathname === '/view') { const b = Object.assign(document.createElement('button'), { className: 'ghost', textContent: 'Mac', title: 'Show another Mac' });
              b.onclick = () => { location.href = 'cadgang://macs'; }; document.querySelector('footer .foot-tools')?.append(b); }
            """, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.scrollView.bounces = false
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(web)
        let safe = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([web.topAnchor.constraint(equalTo: safe.topAnchor), web.bottomAnchor.constraint(equalTo: safe.bottomAnchor),
                                     web.leadingAnchor.constraint(equalTo: safe.leadingAnchor), web.trailingAnchor.constraint(equalTo: safe.trailingAnchor)])
        for (b, type) in zip(browsers, Self.TYPES) { b.delegate = self; b.searchForServices(ofType: type, inDomain: "") }
        Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in   // CADgang opened on a Mac already found
            guard let self, self.finding else { return }
            for name in self.hosts.keys { self.ask(name) }
        }
        if let last = UserDefaults.standard.string(forKey: Self.ADDR) { open(last) } else { find() }
        NotificationCenter.default.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { [weak self] _ in
            self?.failed = nil; self?.auto()   // back from the pocket: the Mac may be awake again
        }
    }

    func open(_ addr: String) {
        guard let url = URL(string: "http://\(addr)/view?follow") else { return }
        finding = false; picking = false
        web.load(URLRequest(url: url, timeoutInterval: 6))
    }
    func find(_ why: String = "") {
        note = why
        if finding { tell(); return }
        finding = true; loaded = false
        let page = Bundle.main.url(forResource: "find", withExtension: "html")!
        web.loadFileURL(page, allowingReadAccessTo: page.deletingLastPathComponent())
    }
    /// find.html's list, as it stands.
    func tell() {
        guard finding, loaded, let json = try? JSONSerialization.data(withJSONObject: ["macs": macs.sorted { $0.key < $1.key }.map { ["name": $0.key, "addr": $0.value] }, "note": note]) else { return }
        web.evaluateJavaScript("window.macs?.(\(String(decoding: json, as: UTF8.self)))")
    }
    /// From the list, unasked: the Mac last shown if it is here, else the only one there is.
    func auto() {
        guard finding, loaded, !picking else { return }
        let last = UserDefaults.standard.string(forKey: Self.NAME).flatMap { macs[$0] }
        if let addr = last ?? (macs.count == 1 ? macs.values.first : nil), addr != failed { open(addr) }
    }

    func webView(_ w: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if action.request.url?.scheme == "cadgang" { picking = true; find(); decisionHandler(.cancel) } else { decisionHandler(.allow) }
    }
    func webView(_ w: WKWebView, didFinish navigation: WKNavigation!) {
        if finding { loaded = true; tell(); auto(); return }
        guard let url = w.url, url.path == "/view", let host = url.host else { return }
        let addr = "\(host):\(url.port ?? 80)"
        UserDefaults.standard.set(addr, forKey: Self.ADDR)
        UserDefaults.standard.set(macs.first { $0.value == addr }?.key, forKey: Self.NAME)
    }
    func webView(_ w: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        guard (error as NSError).code != NSURLErrorCancelled, !finding else { return }
        failed = ((error as NSError).userInfo[NSURLErrorFailingURLErrorKey] as? URL).flatMap { u in u.host.map { "\($0):\(u.port ?? 80)" } }
        find("No answer from \(failed ?? "that address"). Is CADgang open on the Mac, and on this network?")
    }
    func webViewWebContentProcessDidTerminate(_ w: WKWebView) { w.reload() }

    func netServiceBrowser(_ b: NetServiceBrowser, didFind s: NetService, moreComing: Bool) { resolving.append(s); s.delegate = self; s.resolve(withTimeout: 5) }
    func netServiceBrowser(_ b: NetServiceBrowser, didRemove s: NetService, moreComing: Bool) { hosts[s.name] = nil; macs[s.name] = nil; tell() }
    /// Is CADgang open on that machine? Its server says so at /api/health.
    func ask(_ name: String) {
        guard let host = hosts[name], let url = URL(string: "http://\(host):\(Self.PORT)/api/health") else { return }
        URLSession.shared.dataTask(with: URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 2)) { data, _, _ in
            let up = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }?["cells"] != nil   // cadgang's own answer, not any server on that port
            DispatchQueue.main.async {
                let addr = up && self.hosts[name] == host ? "\(host):\(Self.PORT)" : nil
                if self.macs[name] != addr { self.macs[name] = addr; self.tell(); self.auto() }
            }
        }.resume()
    }
    func netServiceDidResolveAddress(_ s: NetService) {
        resolving.removeAll { $0 === s }
        for data in s.addresses ?? [] {   // the first IPv4 one: a link-local IPv6 address needs a scope a URL cannot carry
            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            let ok = data.withUnsafeBytes { raw -> Bool in
                let sa = raw.baseAddress!.assumingMemoryBound(to: sockaddr.self)
                return sa.pointee.sa_family == sa_family_t(AF_INET) && getnameinfo(sa, socklen_t(data.count), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0
            }
            if ok { hosts[s.name] = String(cString: host); ask(s.name); return }
        }
    }
    func netService(_ s: NetService, didNotResolve errorDict: [String: NSNumber]) { resolving.removeAll { $0 === s } }
}
