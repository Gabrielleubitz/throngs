// AI Office — a native Mac app for the Success Manager office (built by `sm app`, no Xcode project needed).
// One window with the office inside (WebKit), no browser: it wakes the office server if it is asleep, signs in
// with the private token, keeps its window size, and opens outside links in the default browser.
import AppKit
import WebKit

let officeURL = URL(string: "http://127.0.0.1:\(OfficeConfig.port)/")!

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var status: NSTextField!
    var retryTimer: Timer?
    var starting = false

    func applicationDidFinishLaunching(_ note: Notification) {
        buildMenu()
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default() // keeps the office's saved settings between launches
        config.preferences.javaScriptCanOpenWindowsAutomatically = true
        config.applicationNameForUserAgent = "AIOffice/1.0" // lets the page know it runs in the app (no real pop-ups here)
        web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.allowsBackForwardNavigationGestures = false
        if #available(macOS 13.3, *) { web.isInspectable = true }
        web.underPageBackgroundColor = NSColor(red: 0.118, green: 0.118, blue: 0.180, alpha: 1) // no white flash

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1500, height: 940),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                          backing: .buffered, defer: false)
        window.title = "AI Office"
        window.minSize = NSSize(width: 900, height: 600)
        window.backgroundColor = NSColor(red: 0.118, green: 0.118, blue: 0.180, alpha: 1)
        window.center()
        window.setFrameAutosaveName("AIOfficeMainWindow")
        window.isReleasedWhenClosed = false

        let root = NSView()
        web.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(web)
        status = NSTextField(labelWithString: "Waking the office…")
        status.textColor = NSColor(white: 0.85, alpha: 1)
        status.font = NSFont.monospacedSystemFont(ofSize: 14, weight: .medium)
        status.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(status)
        NSLayoutConstraint.activate([
            web.leadingAnchor.constraint(equalTo: root.leadingAnchor), web.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            web.topAnchor.constraint(equalTo: root.topAnchor), web.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            status.centerXAnchor.constraint(equalTo: root.centerXAnchor), status.centerYAnchor.constraint(equalTo: root.centerYAnchor),
        ])
        window.contentView = root
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        wake()
    }

    // Closing the window keeps the app (and the office) running; the Dock icon brings it back.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
        if !hasVisibleWindows { window.makeKeyAndOrderFront(nil) }
        return true
    }

    // MARK: waking the office

    func wake() {
        status.stringValue = "Waking the office…"
        status.isHidden = false
        isUp { up in
            if up { self.load() } else { self.startServer() }
        }
    }

    func isUp(_ done: @escaping (Bool) -> Void) {
        var req = URLRequest(url: officeURL.appendingPathComponent("api/health"))
        req.timeoutInterval = 2
        URLSession.shared.dataTask(with: req) { _, resp, _ in
            let ok = (resp as? HTTPURLResponse)?.statusCode == 200
            DispatchQueue.main.async { done(ok) }
        }.resume()
    }

    func startServer() {
        if !starting {
            starting = true
            let p = Process()
            p.executableURL = URL(fileURLWithPath: OfficeConfig.node)
            p.arguments = ["bin/sm.js", "office", "--no-open"]
            p.currentDirectoryURL = URL(fileURLWithPath: OfficeConfig.root)
            var env = ProcessInfo.processInfo.environment
            env["PATH"] = OfficeConfig.path
            p.environment = env
            let log = OfficeConfig.root + "/.pixel-office-app.log"
            FileManager.default.createFile(atPath: log, contents: nil)
            if let h = FileHandle(forWritingAtPath: log) { h.seekToEndOfFile(); p.standardOutput = h; p.standardError = h }
            do { try p.run() } catch { status.stringValue = "Could not start the office: \(error.localizedDescription)" }
        }
        var tries = 0
        retryTimer?.invalidate()
        retryTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { t in
            tries += 1
            self.isUp { up in
                if up { t.invalidate(); self.starting = false; self.load() }
                else if tries > 60 { t.invalidate(); self.starting = false; self.status.stringValue = "The office didn't start — see .pixel-office-app.log. ⌘R to try again." }
            }
        }
    }

    func load() {
        let token = (try? String(contentsOfFile: NSHomeDirectory() + "/.pixel-agents/standalone-token", encoding: .utf8))?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        var c = URLComponents(url: officeURL, resolvingAgainstBaseURL: false)!
        if !token.isEmpty { c.queryItems = [URLQueryItem(name: "token", value: token)] }
        web.load(URLRequest(url: c.url!))
    }

    @objc func reload(_ sender: Any?) { if web.url == nil { wake() } else { web.reload() } }

    /// Open a web link in the owner's browser. Chrome needs care: a hidden automation Chrome (e.g. a WhatsApp bot's
    /// headless copy) counts as "Chrome" too, and macOS may hand the link to it, where it vanishes. Starting a new
    /// Chrome process with the link makes Chrome pass it to the owner's real, visible Chrome (its own profile lock).
    func openInBrowser(_ url: URL) {
        guard let browser = NSWorkspace.shared.urlForApplication(toOpen: url) else { NSWorkspace.shared.open(url); return }
        if Bundle(url: browser)?.bundleIdentifier == "com.google.Chrome" {
            let cfg = NSWorkspace.OpenConfiguration()
            cfg.createsNewApplicationInstance = true
            cfg.arguments = ["--profile-directory=\(OfficeConfig.chromeProfile)", url.absoluteString] // the owner's profile, not whichever was used last
            NSWorkspace.shared.openApplication(at: browser, configuration: cfg) { _, err in
                if err != nil { DispatchQueue.main.async { NSWorkspace.shared.open(url) } }
            }
        } else {
            NSWorkspace.shared.open(url)
        }
    }

    // MARK: navigation — the office stays inside; anything else opens in the browser

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = action.request.url, let host = url.host, host != "127.0.0.1", host != "localhost",
           ["http", "https"].contains(url.scheme ?? "") {
            openInBrowser(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { status.isHidden = true }

    // the office restarted under us (a mission rebuilt it): wait for it and come back by itself
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { wakeLater() }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { wakeLater() }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { wakeLater() }
    func wakeLater() {
        status.stringValue = "Reconnecting to the office…"
        status.isHidden = false
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { self.wake() }
    }

    // target=_blank / window.open. The app has no pop-up windows: office links stay here, web links go to the
    // browser, and anything else (a blank `about:blank` pop-up) is dropped — handing it to macOS shows
    // "There is no application set to open the URL about:blank".
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard let url = action.request.url, ["http", "https"].contains(url.scheme ?? "") else { return nil }
        if url.host == "127.0.0.1" || url.host == "localhost" { webView.load(action.request) } else { openInBrowser(url) }
        return nil
    }

    // MARK: dialogs and file pickers the office uses (confirm "Fire …?", attach an image)

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = NSAlert(); a.messageText = message; a.addButton(withTitle: "OK")
        a.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = NSAlert(); a.messageText = message; a.addButton(withTitle: "OK"); a.addButton(withTitle: "Cancel")
        a.beginSheetModal(for: window) { r in completionHandler(r == .alertFirstButtonReturn) }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let a = NSAlert(); a.messageText = prompt; a.addButton(withTitle: "OK"); a.addButton(withTitle: "Cancel")
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24)); field.stringValue = defaultText ?? ""
        a.accessoryView = field
        a.beginSheetModal(for: window) { r in completionHandler(r == .alertFirstButtonReturn ? field.stringValue : nil) }
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.beginSheetModal(for: window) { r in completionHandler(r == .OK ? panel.urls : nil) }
    }

    // MARK: menus (Edit is what makes ⌘C / ⌘V / ⌘A work in text fields)

    func buildMenu() {
        let main = NSMenu()
        let app = NSMenuItem(); main.addItem(app)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About AI Office", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide AI Office", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "Quit AI Office", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        app.submenu = appMenu

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
        viewMenu.addItem(withTitle: "Reload", action: #selector(reload(_:)), keyEquivalent: "r")
        viewMenu.addItem(withTitle: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f").keyEquivalentModifierMask = [.command, .control]
        view.submenu = viewMenu

        let win = NSMenuItem(); main.addItem(win)
        let winMenu = NSMenu(title: "Window")
        winMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        winMenu.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        win.submenu = winMenu
        NSApp.windowsMenu = winMenu
        NSApp.mainMenu = main
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
