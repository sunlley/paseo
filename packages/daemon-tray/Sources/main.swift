import SwiftUI
import AppKit

// MARK: - Data

struct DaemonStatus: Codable {
    let pid: Int?
    let listen: String?
    let daemonVersion: String?
    let localDaemon: String?
    let startedAt: String?
    let logPath: String?
}

struct HostRow: Codable, Identifiable, Hashable {
    let registrationId: String
    let serverId: String?
    let label: String?
    let enabled: Bool
    let status: String
    let targetDescription: String
    let lastOnlineAt: String?
    let nextRetryAt: String?
    let error: HostError?
    let source: Source?

    struct HostError: Codable, Hashable {
        let code: String
        let message: String
    }

    struct Source: Codable, Hashable {
        let id: String
        let key: String
    }

    var id: String { registrationId }
    var displayName: String { label ?? serverId ?? "未命名主机" }
}

struct ClientRow: Codable, Identifiable, Hashable {
    let clientId: String
    let clientType: String
    let appVersion: String?

    var id: String { clientId }
    var typeLabel: String {
        switch clientType {
        case "browser": return "桌面/浏览器"
        case "cli": return "CLI"
        case "mobile": return "手机"
        case "mcp": return "MCP"
        case "hub": return "Hub"
        default: return clientType
        }
    }
}

// MARK: - Model

@MainActor
final class DaemonModel: ObservableObject {
    @Published var state = "checking"
    @Published var pid: Int?
    @Published var listen: String?
    @Published var version: String?
    @Published var startedAt: String?
    @Published var logPath: String?
    @Published var passwordSet = false
    @Published var hosts: [HostRow] = []
    @Published var clients: [ClientRow] = []
    @Published var busy = false
    @Published var busyLabel = ""

    let home: String
    let cli: String
    private var pollTask: Task<Void, Never>?

    init() {
        let env = ProcessInfo.processInfo.environment
        let rawHome = env["PASEO_TRAY_HOME"] ?? "~/.paseo"
        home = URL(fileURLWithPath: (rawHome as NSString).expandingTildeInPath).standardized.path
        cli = Self.resolveCli()
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refresh()
                try? await Task.sleep(nanoseconds: 3_000_000_000)
            }
        }
    }

    var running: Bool { state == "running" }
    var known: Bool { state == "running" || state == "stopped" }

    var symbol: String {
        if busy { return "arrow.triangle.2.circlepath" }
        switch state {
        case "running": return "circle.fill"
        case "stopped": return "circle.slash"
        case "checking": return "circle.dotted"
        default: return "exclamationmark.circle.fill"
        }
    }

    var symbolColor: Color {
        switch state {
        case "running": return Color(red: 0.118, green: 0.62, blue: 0.333)
        case "stopped": return Color(nsColor: .systemGray)
        default: return Color(nsColor: .systemRed)
        }
    }

    var statusLine: String {
        if busy { return busyLabel }
        switch state {
        case "running": return "运行中 · \(listen ?? "")"
        case "stopped": return "已停止"
        case "checking": return "检查中…"
        default: return "状态异常"
        }
    }

    var hostCountText: String { hosts.isEmpty ? "还没有保存的主机" : "已保存 \(hosts.count) 台" }

    private static func resolveCli() -> String {
        let fallback = NSString(string: "~/.local/bin/paseo").expandingTildeInPath
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/zsh")
        process.arguments = ["-lc", "command -v paseo"]
        let out = Pipe()
        process.standardOutput = out
        process.standardError = Pipe()
        do { try process.run() } catch { return fallback }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        let path = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        return process.terminationStatus == 0 && !path.isEmpty ? path : fallback
    }

    private func exec(_ args: [String]) async -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: cli)
        process.arguments = args + ["--home", home]
        let out = Pipe()
        let err = Pipe()
        process.standardOutput = out
        process.standardError = err
        do { try process.run() } catch { return "__error__:\(error.localizedDescription)" }
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            DispatchQueue.global().async {
                process.waitUntilExit()
                cont.resume()
            }
        }
        // ponytail: CLI outputs are a few KB, well under the 64KB pipe buffer, so
        // reading both pipes after waitUntilExit cannot deadlock.
        let stdout = String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        let stderr = String(decoding: err.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        let trimmed = stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        if process.terminationStatus != 0 {
            let message = stderr.trimmingCharacters(in: .whitespacesAndNewlines)
            return message.isEmpty ? "__error__:(exit \(process.terminationStatus)) \(trimmed)" : "__error__:\(message)"
        }
        return trimmed
    }

    private func decodeJSON<T: Decodable>(_ raw: String, as type: T.Type) -> T? {
        let decoder = JSONDecoder()
        var candidates: [String] = [raw]
        if let index = raw.firstIndex(where: { $0 == "{" || $0 == "[" }) {
            candidates.append(String(raw[index...]))
        }
        for candidate in candidates {
            if let data = candidate.data(using: .utf8), let value = try? decoder.decode(T.self, from: data) {
                return value
            }
        }
        return nil
    }

    func refresh() async {
        let raw = await exec(["daemon", "status", "--json"])
        if raw.hasPrefix("__error__") {
            state = "errored"
            hosts = []
            clients = []
            return
        }
        if let status = decodeJSON(raw, as: DaemonStatus.self) {
            state = status.localDaemon ?? "errored"
            pid = status.pid
            listen = status.listen
            version = status.daemonVersion
            startedAt = status.startedAt
            logPath = status.logPath
        } else {
            state = "errored"
        }
        refreshPasswordState()
        if running {
            await refreshHosts()
            await refreshClients()
        } else {
            hosts = []
            clients = []
        }
    }

    private func refreshPasswordState() {
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: home + "/config.json")),
              let config = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let daemon = config["daemon"] as? [String: Any],
              let auth = daemon["auth"] as? [String: Any] else {
            passwordSet = false
            return
        }
        passwordSet = !(auth["password"] as? String ?? "").isEmpty
    }

    func refreshHosts() async {
        let raw = await exec(["host", "ls", "--json"])
        if raw.hasPrefix("__error__") {
            hosts = []
            return
        }
        hosts = decodeJSON(raw, as: [HostRow].self) ?? []
    }

    func refreshClients() async {
        let raw = await exec(["daemon", "clients", "--json"])
        if raw.hasPrefix("__error__") {
            clients = []
            return
        }
        // ponytail: hide internal plugin connections; the tray surfaces human clients.
        clients = (decodeJSON(raw, as: [ClientRow].self) ?? []).filter { !$0.clientId.hasPrefix("plugin:") }
    }

    private func runBusy(_ label: String, _ args: [String]) async {
        busy = true
        busyLabel = label
        _ = await exec(args)
        busy = false
        await refresh()
    }

    func start() async { await runBusy("正在启动…", ["daemon", "start", "--timeout", "120"]) }
    func stop() async { await runBusy("正在停止…", ["daemon", "stop"]) }
    func restart() async { await runBusy("正在重启…", ["daemon", "restart"]) }

    func setHostEnabled(_ host: HostRow, _ enabled: Bool) async {
        await runBusy(enabled ? "正在启用…" : "正在禁用…", ["host", enabled ? "enable" : "disable", host.registrationId])
    }

    func removeHost(_ host: HostRow) async {
        await runBusy("正在移除…", ["host", "rm", host.registrationId])
    }

    func renameHost(_ host: HostRow, _ label: String) async -> String? {
        let raw = await exec(["host", "update", host.registrationId, "--label", label])
        await refreshHosts()
        return raw.hasPrefix("__error__") ? String(raw.dropFirst("__error__:".count)) : nil
    }

    func addHost(connection: String, label: String) async -> String? {
        var args = ["host", "add", connection]
        if !label.isEmpty { args += ["--label", label] }
        let raw = await exec(args)
        await refresh()
        return raw.hasPrefix("__error__") ? String(raw.dropFirst("__error__:".count)) : nil
    }

    func setPassword(_ password: String) async {
        await runBusy("正在写入密码…", ["daemon", "set-password", "--password", password])
        if known { await runBusy("正在重启使密码生效…", ["daemon", "restart"]) }
    }
}

// MARK: - Helpers

func relativeTime(_ iso: String?) -> String {
    guard let iso, !iso.isEmpty else { return "—" }
    let parsers: [ISO8601DateFormatter] = {
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let plain = ISO8601DateFormatter()
        return [withFraction, plain]
    }()
    let date = parsers.lazy.compactMap { $0.date(from: iso) }.first
    guard let date else { return "—" }
    return RelativeDateTimeFormatter().localizedString(for: date, relativeTo: Date())
}

func shortTime(_ iso: String?) -> String {
    guard let iso,
          let date = ISO8601DateFormatter().date(from: iso)
              ?? ISO8601DateFormatter().date(from: String(iso.prefix(19)) + "Z") else { return "—" }
    return date.formatted(date: .omitted, time: .shortened)
}

func confirmDialog(title: String, message: String) -> Bool {
    let alert = NSAlert()
    alert.messageText = title
    alert.informativeText = message
    alert.alertStyle = .warning
    alert.addButton(withTitle: "确定")
    alert.addButton(withTitle: "取消")
    return alert.runModal() == .alertFirstButtonReturn
}

// MARK: - App

@main
struct DaemonTrayApp: App {
    @StateObject private var model = DaemonModel()

    var body: some Scene {
        MenuBarExtra {
            TrayMenu(model: model)
        } label: {
            if model.busy {
                Image(systemName: "arrow.triangle.2.circlepath")
            } else {
                Image(systemName: model.symbol)
                    .renderingMode(.original)
                    .foregroundStyle(model.symbolColor)
            }
        }
        .menuBarExtraStyle(.menu)

        Window("Paseo Daemon", id: "panel") {
            PanelRoot(model: model)
                .frame(minWidth: 380, minHeight: 450)
        }
        .windowResizability(.contentMinSize)
        .defaultSize(width: 380, height: 450)
        .restorationBehavior(.disabled)
    }
}

struct TrayMenu: View {
    @ObservedObject var model: DaemonModel
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Text(model.statusLine).font(.headline)
        if model.running {
            Button("重启") { Task { await model.restart() } }.disabled(model.busy)
            Button("停止") { Task { await model.stop() } }.disabled(model.busy)
        } else if model.known && !model.busy {
            Button("启动") { Task { await model.start() } }
        }
        Divider()
        Button("打开面板") {
            NSApp.activate(ignoringOtherApps: true)
            openWindow(id: "panel")
        }
        if let log = model.logPath {
            Button("打开日志") { NSWorkspace.shared.open(URL(fileURLWithPath: log)) }
        }
        Divider()
        Button("退出托盘") { NSApplication.shared.terminate(nil) }
    }
}

// MARK: - Panel

struct PanelRoot: View {
    @ObservedObject var model: DaemonModel
    @State private var tab = 0
    @State private var selectedHost: HostRow?
    @State private var refreshing = false

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Picker("", selection: $tab) {
                    Text("状态").tag(0)
                    Text("连接").tag(1)
                    Text("密码").tag(2)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                Button {
                    refreshing = true
                    Task {
                        await model.refresh()
                        refreshing = false
                    }
                } label: {
                    Image(systemName: "arrow.clockwise")
                        .font(.system(size: 12, weight: .medium))
                        .rotationEffect(.degrees(refreshing ? 360 : 0))
                        .animation(refreshing ? .linear(duration: 0.8).repeatForever(autoreverses: false) : .default, value: refreshing)
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .help("手动刷新")
            }
            .padding(.horizontal, 18)
            .padding(.top, 10)
            .padding(.bottom, 4)

            if let host = selectedHost {
                HostDetail(model: model, host: host, onBack: { selectedHost = nil })
            } else {
                switch tab {
                case 1: HostsTab(model: model, openDetail: { selectedHost = $0 })
                case 2: PasswordTab(model: model)
                default: StatusTab(model: model)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }
}

private func dotFor(_ status: String) -> some View {
    switch status {
    case "online":
        return AnyView(Circle().fill(.green).frame(width: 8, height: 8))
    case "connecting":
        return AnyView(ProgressView().controlSize(.mini))
    case "error":
        return AnyView(Circle().fill(.red).frame(width: 8, height: 8))
    case "disabled":
        return AnyView(Circle().fill(.gray).frame(width: 8, height: 8))
    default:
        return AnyView(Circle().stroke(.gray, lineWidth: 1.5).frame(width: 8, height: 8))
    }
}

private func hostSubline(_ host: HostRow) -> String {
    if let error = host.error { return "错误：\(error.message)" }
    if !host.enabled || host.status == "disabled" { return "已禁用 · 上次在线 \(relativeTime(host.lastOnlineAt))" }
    switch host.status {
    case "connecting":
        return "连接中 · 下次重试 \(relativeTime(host.nextRetryAt))"
    case "online":
        return "\(host.serverId ?? "") · 上次在线 \(relativeTime(host.lastOnlineAt))"
    default:
        return "离线 · 上次在线 \(relativeTime(host.lastOnlineAt))"
    }
}

private struct StatusTab: View {
    @ObservedObject var model: DaemonModel

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top) {
                HStack(spacing: 10) {
                    if model.busy {
                        ProgressView().controlSize(.small)
                    } else {
                        Circle()
                            .fill(runningDot)
                            .frame(width: 12, height: 12)
                    }
                    Text(model.busy ? model.busyLabel : stateText)
                        .font(.system(size: 16, weight: .semibold))
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 2) {
                    Text(model.listen ?? "未监听").font(.system(size: 12)).foregroundStyle(.secondary)
                    if let version = model.version {
                        Text("v\(version)\(model.startedAt.map { " · 启动于 \(shortTime($0))" } ?? "")")
                            .font(.system(size: 12)).foregroundStyle(.secondary)
                    }
                }
            }
            .padding(.vertical, 14)

            kv("PID", model.pid.map(String.init) ?? "—")
            kv("Home", model.home)

            HStack(spacing: 8) {
                Button("启动") { Task { await model.start() } }
                    .buttonStyle(.borderedProminent).tint(runningGreen)
                    .disabled(model.running || model.busy)
                Button("停止") { Task { await model.stop() } }
                    .disabled(!model.running || model.busy)
                Button("重启") { Task { await model.restart() } }
                    .disabled(!model.running || model.busy)
                Spacer()
            }
            .padding(.top, 16)

            Spacer()
            Text("状态每 3 秒自动刷新").font(.system(size: 11)).foregroundStyle(.tertiary)
                .frame(maxWidth: .infinity)
                .padding(.bottom, 12)
        }
        .padding(.horizontal, 18)
    }

    private var runningDot: Color {
        model.running ? runningGreen : Color(nsColor: .systemGray)
    }
    private var runningGreen: Color {
        Color(red: 0.118, green: 0.62, blue: 0.333)
    }
    private var stateText: String {
        switch model.state {
        case "running": return "运行中"
        case "stopped": return "已停止"
        case "checking": return "检查中…"
        default: return "状态异常"
        }
    }
    private func kv(_ key: String, _ value: String) -> some View {
        HStack(alignment: .top) {
            Text(key).font(.system(size: 12.5)).foregroundStyle(.secondary).frame(width: 46, alignment: .leading)
            Text(value).font(.system(size: 12.5)).textSelection(.enabled)
        }
        .padding(.vertical, 5)
    }
}

private struct HostsTab: View {
    @ObservedObject var model: DaemonModel
    let openDetail: (HostRow) -> Void
    @State private var hovered: String?
    @State private var showAdd = false

    var body: some View {
        VStack(spacing: 0) {
            if !model.clients.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text("客户端连接").font(.system(size: 11, weight: .medium)).foregroundStyle(.secondary)
                    ForEach(model.clients) { client in
                        HStack(spacing: 9) {
                            Circle().fill(Color(red: 0.118, green: 0.62, blue: 0.333)).frame(width: 7, height: 7)
                            VStack(alignment: .leading, spacing: 1) {
                                Text("\(client.typeLabel) · v\(client.appVersion ?? "?")")
                                    .font(.system(size: 12.5, weight: .medium))
                                Text(shortClientId(client.clientId))
                                    .font(.system(size: 11)).foregroundStyle(.secondary)
                                    .font(.system(size: 11)).monospaced()
                            }
                            Spacer()
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6)
                        .background(Color(nsColor: .tertiarySystemFill))
                        .cornerRadius(8)
                    }
                }
                .padding(.horizontal, 18)
                .padding(.bottom, 8)
            }
            if !model.running {
                VStack(spacing: 6) {
                    Text("daemon 未运行").font(.system(size: 13, weight: .medium))
                    Text("启动 daemon 后，客户端连接和注册的主机会显示在这里")
                        .font(.system(size: 11)).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 24)
            } else if model.hosts.isEmpty {
                VStack(spacing: 6) {
                    Text(model.clients.isEmpty ? "还没有客户端连接" : "还没有保存的主机").font(.system(size: 13, weight: .medium))
                    Text("其他 Paseo 实例通过「连接主机」注册后显示在这里")
                        .font(.system(size: 11)).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 20)
            } else {
                ScrollView {
                    VStack(spacing: 6) {
                        ForEach(model.hosts) { host in
                            HostRowView(
                                host: host,
                                hovered: hovered == host.id,
                                onHover: { hovered = $0 ? host.id : nil },
                                model: model,
                                openDetail: openDetail,
                                showAdd: $showAdd
                            )
                        }
                    }
                    .padding(.vertical, 6)
                }
            }
            HStack {
                Button("＋ 添加主机") { showAdd = true }
                Spacer()
                if !model.hosts.isEmpty {
                    Text(model.hostCountText).font(.system(size: 11)).foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, 18)
            .padding(.vertical, 10)
        }
        .sheet(isPresented: $showAdd) { AddHostSheet(model: model) }
    }

    private func shortClientId(_ id: String) -> String {
        id.count > 18 ? String(id.prefix(18)) + "…" : id
    }
}

private struct HostRowView: View {
    let host: HostRow
    let hovered: Bool
    let onHover: (Bool) -> Void
    @ObservedObject var model: DaemonModel
    let openDetail: (HostRow) -> Void
    @Binding var showAdd: Bool

    var body: some View {
        HStack(spacing: 9) {
            dotFor(host.status)
            VStack(alignment: .leading, spacing: 1) {
                Text(host.displayName).font(.system(size: 12.5, weight: .medium))
                Text(hostSubline(host)).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 8)
            if hovered && !model.busy {
                Button("详情") { openDetail(host) }.buttonStyle(.link).font(.system(size: 11))
                Button(host.enabled ? "禁用" : "启用") {
                    Task { await model.setHostEnabled(host, !host.enabled) }
                }
                .buttonStyle(.link).font(.system(size: 11))
                Button("移除") {
                    if confirmDialog(title: "移除主机", message: "移除「\(host.displayName)」后，对端需要重新注册才能连回本机。") {
                        Task { await model.removeHost(host) }
                    }
                }
                .buttonStyle(.link).font(.system(size: 11)).foregroundStyle(.red)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .background(hovered ? Color(nsColor: .quaternarySystemFill) : Color(nsColor: .tertiarySystemFill))
        .cornerRadius(8)
        .padding(.horizontal, 18)
        .onHover(perform: onHover)
    }
}

private struct AddHostSheet: View {
    @ObservedObject var model: DaemonModel
    @Environment(\.dismiss) private var dismiss
    @State private var connection = ""
    @State private var label = ""
    @State private var errorText: String?
    @State private var working = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("添加主机").font(.headline)
            VStack(alignment: .leading, spacing: 4) {
                Text("连接串（从对端 Paseo 复制）").font(.system(size: 12, weight: .medium))
                TextField("paseo://… 或 tcp://host:port", text: $connection, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                    .lineLimit(2...3)
            }
            VStack(alignment: .leading, spacing: 4) {
                Text("备注标签（可选）").font(.system(size: 12, weight: .medium))
                TextField("例：办公室 iMac", text: $label)
                    .textFieldStyle(.roundedBorder)
            }
            if let errorText {
                Text(errorText).font(.system(size: 11)).foregroundStyle(.red)
            }
            HStack {
                Spacer()
                Button("取消") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("添加") {
                    working = true
                    Task {
                        errorText = await model.addHost(connection: connection, label: label)
                        working = false
                        if errorText == nil { dismiss() }
                    }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(connection.isEmpty || working)
            }
            Text("添加后由本 daemon 主动建立并维护连接").font(.system(size: 11)).foregroundStyle(.secondary)
        }
        .padding(18)
        .frame(width: 340)
    }
}

private struct HostDetail: View {
    @ObservedObject var model: DaemonModel
    let host: HostRow
    let onBack: () -> Void
    @State private var labelDraft = ""
    @State private var editingLabel = false

    var body: some View {
        let current = model.hosts.first(where: { $0.id == host.id }) ?? host
        return VStack(alignment: .leading, spacing: 0) {
            Button {
                onBack()
            } label: {
                HStack(spacing: 3) {
                    Image(systemName: "chevron.left").font(.system(size: 11, weight: .medium))
                    Text("返回").font(.system(size: 12))
                }
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .padding(.top, 10)
            HStack(alignment: .top) {
                HStack(spacing: 10) {
                    dotFor(current.status)
                    Text(statusText(current)).font(.system(size: 16, weight: .semibold))
                }
                Spacer()
                Text("上次在线 \(relativeTime(current.lastOnlineAt))")
                    .font(.system(size: 12)).foregroundStyle(.secondary)
            }
            .padding(.vertical, 14)

            kv("serverId", current.serverId ?? "—", mono: true)
            kv("目标", current.targetDescription)
            kv("来源", current.source.map { "\($0.id) / \($0.key)" } ?? "—")
            if let error = current.error {
                kv("错误", "\(error.code)：\(error.message)")
            }
            if current.nextRetryAt != nil && current.status == "connecting" {
                kv("重试", "下次重试 \(relativeTime(current.nextRetryAt))")
            }

            HStack {
                Text("标签").font(.system(size: 12.5)).foregroundStyle(.secondary).frame(width: 52, alignment: .leading)
                if editingLabel {
                    TextField("标签", text: $labelDraft)
                        .textFieldStyle(.roundedBorder)
                        .onSubmit { Task { await saveLabel(current) } }
                    Button("保存") { Task { await saveLabel(current) } }.buttonStyle(.link)
                    Button("取消") { editingLabel = false }.buttonStyle(.link)
                } else {
                    Text(current.label ?? "—").font(.system(size: 12.5)).textSelection(.enabled)
                    Button("编辑") {
                        labelDraft = current.label ?? ""
                        editingLabel = true
                    }.buttonStyle(.link)
                }
            }
            .padding(.vertical, 5)

            Spacer()

            HStack(spacing: 8) {
                Button(current.enabled ? "禁用" : "启用") {
                    Task { await model.setHostEnabled(current, !current.enabled) }
                }
                .disabled(model.busy)
                Button("移除主机", role: .destructive) {
                    if confirmDialog(title: "移除主机", message: "移除「\(current.displayName)」后，对端需要重新注册才能连回本机。") {
                        Task { await model.removeHost(current) }
                    }
                }
                .disabled(model.busy)
                Spacer()
            }
            .padding(.bottom, 14)
        }
        .padding(.horizontal, 18)
    }

    private func saveLabel(_ current: HostRow) async {
        if let error = await model.renameHost(current, labelDraft) {
            _ = error
        }
        editingLabel = false
    }

    private func statusText(_ host: HostRow) -> String {
        switch host.status {
        case "online": return "在线"
        case "connecting": return "连接中"
        case "offline": return "离线"
        case "error": return "连接错误"
        default: return "已禁用"
        }
    }

    private func kv(_ key: String, _ value: String, mono: Bool = false) -> some View {
        HStack(alignment: .top) {
            Text(key).font(.system(size: 12.5)).foregroundStyle(.secondary).frame(width: 52, alignment: .leading)
            Text(value).font(mono ? .system(size: 12).monospaced() : .system(size: 12.5)).textSelection(.enabled)
        }
        .padding(.vertical, 5)
    }
}

private struct PasswordTab: View {
    @ObservedObject var model: DaemonModel
    @State private var password = ""
    @State private var confirm = ""
    @State private var message: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Circle()
                    .fill(model.passwordSet ? Color(red: 0.118, green: 0.62, blue: 0.333) : Color(nsColor: .systemGray))
                    .frame(width: 8, height: 8)
                Text(model.passwordSet ? "已设置密码 · 外部客户端连接时需要认证" : "未设置密码 · 本机以外的客户端无法连接")
                    .font(.system(size: 12.5))
            }
            .padding(.vertical, 6)

            VStack(alignment: .leading, spacing: 4) {
                Text(model.passwordSet ? "新密码" : "设置密码").font(.system(size: 12, weight: .medium))
                SecureField("至少 8 位", text: $password)
                    .textFieldStyle(.roundedBorder)
            }
            VStack(alignment: .leading, spacing: 4) {
                Text("确认\(model.passwordSet ? "新" : "")密码").font(.system(size: 12, weight: .medium))
                SecureField("再输入一次", text: $confirm)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit { Task { await submit() } }
            }
            if let message {
                Text(message).font(.system(size: 11)).foregroundStyle(message.hasPrefix("完成") ? .green : .red)
            }
            HStack {
                Button(model.passwordSet ? "修改密码并重启" : "设置密码并重启") {
                    Task { await submit() }
                }
                .buttonStyle(.borderedProminent).tint(Color(red: 0.118, green: 0.62, blue: 0.333))
                .disabled(password.isEmpty || password != confirm || model.busy)
                Spacer()
                if model.busy { ProgressView().controlSize(.small) }
            }
            Spacer()
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: "info.circle").foregroundStyle(Color(red: 0.118, green: 0.62, blue: 0.333))
                Text("密码哈希后写入 config.json，不回显。修改后 daemon 需要重启才生效，已连接的客户端要用新密码重连。")
                    .font(.system(size: 11)).foregroundStyle(.secondary)
            }
            .padding(10)
            .background(Color(nsColor: .quaternarySystemFill))
            .cornerRadius(8)
            .padding(.bottom, 12)
        }
        .padding(.horizontal, 18)
    }

    private func submit() async {
        guard password == confirm else {
            message = "两次输入的密码不一致"
            return
        }
        await model.setPassword(password)
        password = ""
        confirm = ""
        message = "完成：密码已写入，daemon 已重启"
    }
}
