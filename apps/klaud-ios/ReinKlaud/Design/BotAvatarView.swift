import SwiftUI

/// Shared IDs and geometry with the desktop avatar catalog. No face or body is drawn.
enum BotAvatarStyle: String, CaseIterable, Identifiable, Sendable {
    case aviator, motorcycle, builder, baseball, medic, explorer
    var id: String { rawValue }
    var label: String {
        switch self { case .aviator: "Aviator"; case .motorcycle: "Rider"; case .builder: "Builder"; case .baseball: "Slugger"; case .medic: "Medic"; case .explorer: "Explorer" }
    }
    static func resolve(_ explicit: String?, botID: String) -> Self {
        if let explicit, let style = Self(rawValue: explicit) { return style }
        return allCases[Int(AvatarMotion.seed(for: botID) % UInt32(allCases.count))]
    }
}

enum BotAvatarPhase: String, CaseIterable, Sendable {
    case ready, working, thinking, responding, tool, journaling, autonomy, approval, error
    var label: String {
        switch self {
        case .ready: "Ready"
        case .working: "Working"
        case .thinking: "Thinking"
        case .responding: "Replying"
        case .tool: "Running a tool"
        case .journaling: "Writing notes"
        case .autonomy: "Autonomy work"
        case .approval: "Waiting for approval"
        case .error: "Needs attention"
        }
    }
    var moves: Bool { ![.ready, .approval, .error].contains(self) }

    /// Only public gateway activity selects these expressions; no model thoughts are read.
    static func reported(by event: GatewayEvent) -> Self? {
        switch event.type {
        case "RUN_STARTED", "TOOL_CALL_END": return .working
        case "TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT": return .responding
        case "TOOL_CALL_START": return .tool
        case "RUN_ERROR": return .error
        case "RUN_FINISHED": return .ready
        case "CUSTOM":
            guard event.name == "klaud.progress", let value = event.value?.objectValue,
                  let name = value["phase"]?.stringValue, let phase = Self(rawValue: name), phase.moves,
                  case .number(let turn) = value["turn"], turn.isFinite,
                  turn >= 1, turn <= 9007199254740991, turn.rounded() == turn else { return nil }
            return phase
        default: return nil
        }
    }
}

enum AvatarMotion {
    static func seed(for botID: String) -> UInt32 {
        // FNV matches avatar-motion.mjs, including code points within its UTF-16 limit.
        let units = Array(botID.utf16.prefix(4096))
        var hash: UInt32 = 2166136261
        var index = 0
        while index < units.count {
            var scalar = UInt32(units[index])
            if (0xD800...0xDBFF).contains(scalar), index + 1 < units.count,
               (0xDC00...0xDFFF).contains(units[index + 1]) {
                scalar = (scalar - 0xD800) * 0x400 + UInt32(units[index + 1]) - 0xDC00 + 0x10000
                index += 1
            }
            hash = (hash ^ scalar) &* 16777619
            index += 1
        }
        return hash
    }

    static func pose(seconds: Double, phase: BotAvatarPhase, seed: UInt32) -> AvatarPose {
        // Coefficients and equations match the desktop avatar-motion.mjs sampler.
        let c: [Double]
        switch phase {
        case .working: c = [1, 1.2, 1.1, 1.8, 0.010, 0.9, 0.45]
        case .thinking: c = [0.72, 1.6, 0.7, 2.1, 0.008, 1.5, 0.5]
        case .responding: c = [1.2, 1.25, 1.6, 1.7, 0.016, 1.4, 0.7]
        case .tool: c = [1.45, 0.85, 1.1, 1.25, 0.012, 0.75, 0.6]
        case .journaling: c = [0.88, 1.1, 0.85, 1.5, 0.009, 1, 0.4]
        case .autonomy: c = [0.63, 1.75, 1.3, 2.2, 0.012, 1.1, 0.55]
        default: return .neutral
        }
        let v = Double(seed) / 4294967296, p = v * .pi * 2
        let u = (seconds.isFinite ? seconds : 0) * 1.8 * c[0] * (0.94 + 0.12 * v)
        let breath = sin(u * 1.67 + p)
        return AvatarPose(
            x: c[1] * (0.72 * sin(u * 1.37 + p) + 0.28 * sin(u * 0.53 + p * 1.7)),
            y: c[2] * (0.70 * sin(u * 1.91 + p * 0.83) + 0.30 * sin(u * 0.71 + p)),
            rotate: c[3] * (0.78 * sin(u * 1.13 + p + 0.45) + 0.22 * sin(u * 0.43 + p * 0.6)),
            scaleX: 1 + c[4] * (0.7 * breath + 0.3 * sin(u * 0.67 + p)),
            scaleY: 1 - c[4] * (0.6 * breath + 0.2 * sin(u * 0.67 + p)),
            glassesX: c[6] * 0.5 * sin(u * 1.37 + p - 0.35),
            glassesY: c[6] * 0.6 * sin(u * 1.91 + p * 0.83 - 0.45),
            glassesRotate: c[6] * 0.7 * sin(u * 1.13 + p + 0.05),
            leftBrowY: -c[5] * (0.6 * sin(u * 2.13 + p) + 0.4 * sin(u * 0.79 + p * 0.7)),
            leftBrowRotate: c[5] * 1.3 * sin(u * 1.41 + p - 0.3),
            rightBrowY: -c[5] * (0.55 * sin(u * 1.87 + p + 0.9) + 0.45 * sin(u * 0.67 + p)),
            rightBrowRotate: -c[5] * 1.3 * sin(u * 1.53 + p + 0.4))
    }

    static func damp(_ current: AvatarPose, toward target: AvatarPose, delta: Double) -> AvatarPose {
        let weight = -expm1(-12 * boundedDelta(delta))
        var result = current
        for key in AvatarPose.fields { result[keyPath: key] += (target[keyPath: key] - current[keyPath: key]) * weight }
        return result
    }
    static func boundedDelta(_ delta: Double) -> Double { delta.isFinite ? max(0, min(0.05, delta)) : 0 }
}

struct AvatarPose: Equatable {
    var x = 0.0, y = 0.0, rotate = 0.0, scaleX = 1.0, scaleY = 1.0
    var glassesX = 0.0, glassesY = 0.0, glassesRotate = 0.0
    var leftBrowY = 0.0, leftBrowRotate = 0.0, rightBrowY = 0.0, rightBrowRotate = 0.0
    static let neutral = AvatarPose()
    static let fields: [WritableKeyPath<AvatarPose, Double>] = [\Self.x, \Self.y, \Self.rotate, \Self.scaleX, \Self.scaleY,
        \Self.glassesX, \Self.glassesY, \Self.glassesRotate, \Self.leftBrowY, \Self.leftBrowRotate, \Self.rightBrowY, \Self.rightBrowRotate]
    var isNeutral: Bool { Self.fields.allSatisfy { abs(self[keyPath: $0] - Self.neutral[keyPath: $0]) < 0.001 } }
}

struct AvatarMotionState {
    private(set) var pose = AvatarPose.neutral
    private(set) var elapsed = 0.0
    private var previous: TimeInterval?
    func shouldTick(phase: BotAvatarPhase, visible: Bool, sceneActive: Bool, reduceMotion: Bool) -> Bool {
        visible && sceneActive && !reduceMotion && (phase.moves || !pose.isNeutral)
    }
    mutating func advance(at time: TimeInterval, phase: BotAvatarPhase, seed: UInt32) {
        let delta = previous.map { AvatarMotion.boundedDelta(time - $0) } ?? 0
        previous = time
        elapsed += delta
        pose = AvatarMotion.damp(pose, toward: AvatarMotion.pose(seconds: elapsed, phase: phase, seed: seed), delta: delta)
        if !phase.moves && pose.isNeutral { pose = .neutral; previous = nil }
    }
    mutating func suspend(reset: Bool = false) {
        previous = nil
        if reset { pose = .neutral }
    }
}

struct BotAvatarView: View {
    let style: BotAvatarStyle
    var phase: BotAvatarPhase = .ready
    var botID = ""
    @Environment(\.reinTheme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @State private var appeared = false
    @State private var inViewport = true
    @State private var motion = AvatarMotionState()

    private var ticking: Bool {
        motion.shouldTick(phase: phase, visible: appeared && inViewport, sceneActive: scenePhase == .active, reduceMotion: reduceMotion)
    }

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 60, paused: !ticking)) { timeline in
            portrait(pose: reduceMotion ? .neutral : motion.pose)
                .onChange(of: timeline.date, initial: true) { _, date in
                    guard ticking else { return }
                    motion.advance(at: date.timeIntervalSinceReferenceDate, phase: phase, seed: AvatarMotion.seed(for: botID))
                }
        }
        // Geometry only changes the visibility flag; it never drives a motion value.
        .onGeometryChange(for: Bool.self) { geometry in
            guard let viewport = geometry.bounds(of: .scrollView) else { return true }
            return CGRect(origin: .zero, size: geometry.size).intersects(viewport)
        } action: { inViewport = $0 }
        .onAppear { appeared = true }
        .onDisappear { appeared = false; motion.suspend() }
        .onChange(of: inViewport) { _, visible in if !visible { motion.suspend() } }
        .onChange(of: scenePhase) { _, scene in if scene != .active { motion.suspend() } }
        .onChange(of: reduceMotion) { _, reduced in if reduced { motion.suspend(reset: true) } }
        .onChange(of: botID) { _, _ in motion = AvatarMotionState() }
        .accessibilityLabel("\(style.label) avatar. \(phase.label).")
    }

    private func portrait(pose: AvatarPose) -> some View {
        Canvas { context, size in
            let scale = min(size.width, size.height) / 128
            context.translateBy(x: (size.width - 128 * scale) / 2, y: (size.height - 128 * scale) / 2)
            context.scaleBy(x: scale, y: scale)
            context = transformed(context, x: pose.x, y: pose.y, rotate: pose.rotate, center: CGPoint(x: 64, y: 64), scaleX: pose.scaleX, scaleY: pose.scaleY)
            drawHeadwear(in: context, pose: pose)
            drawBrows(in: context, pose: pose)
        }
    }

    private func transformed(_ source: GraphicsContext, x: Double = 0, y: Double = 0, rotate: Double = 0,
                             center: CGPoint, scaleX: Double = 1, scaleY: Double = 1) -> GraphicsContext {
        var context = source
        context.translateBy(x: center.x + x, y: center.y + y)
        context.rotate(by: .degrees(rotate))
        context.scaleBy(x: scaleX, y: scaleY)
        context.translateBy(x: -center.x, y: -center.y)
        return context
    }

    private var ink: Color { theme.ink }
    private var rust: Color { Color(hex: theme.dark ? 0xF29070 : 0xB54229) }
    private var paper: Color { theme.paper }
    private var gold: Color { theme.gold }

    private func drawHeadwear(in source: GraphicsContext, pose: AvatarPose) {
        var context = source
        let eyewear = transformed(source, x: pose.glassesX, y: pose.glassesY, rotate: pose.glassesRotate, center: CGPoint(x: 64, y: 80))
        switch style {
        case .aviator:
            do {
                let path = Path { p in p.move(to: .init(x: 26, y: 60)); p.addCurve(to: .init(x: 65, y: 18), control1: .init(x: 24, y: 32), control2: .init(x: 41, y: 17)); p.addCurve(to: .init(x: 103, y: 62), control1: .init(x: 91, y: 18), control2: .init(x: 105, y: 35)); p.addLine(to: .init(x: 99, y: 89)); p.addLine(to: .init(x: 87, y: 95)); p.addLine(to: .init(x: 85, y: 54)); p.addQuadCurve(to: .init(x: 43, y: 54), control: .init(x: 64, y: 44)); p.addLine(to: .init(x: 40, y: 95)); p.addLine(to: .init(x: 27, y: 90)); p.closeSubpath() }
                context.fill(path, with: .color(rust), style: FillStyle(eoFill: false))
                context.stroke(path, with: .color(ink), style: StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round))
            }
            do {
                let path = Path { p in p.move(to: .init(x: 39, y: 28)); p.addQuadCurve(to: .init(x: 36, y: 61), control: .init(x: 32, y: 46)); p.move(to: .init(x: 86, y: 27)); p.addQuadCurve(to: .init(x: 96, y: 58), control: .init(x: 97, y: 39)); p.move(to: .init(x: 60, y: 21)); p.addQuadCurve(to: .init(x: 58, y: 45), control: .init(x: 56, y: 32)) }
                context.stroke(path, with: .color(gold), style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round, dash: [3, 3]))
            }
            do {
                let path = Path { p in p.move(to: .init(x: 43, y: 51)); p.addQuadCurve(to: .init(x: 85, y: 51), control: .init(x: 64, y: 43)); p.addLine(to: .init(x: 87, y: 58)); p.addQuadCurve(to: .init(x: 41, y: 58), control: .init(x: 64, y: 51)); p.closeSubpath() }
                context.fill(path, with: .color(paper), style: FillStyle(eoFill: false))
                context.stroke(path, with: .color(ink), style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
            }
            do {
                let path = Path(ellipseIn: CGRect(x: 31, y: 80, width: 6, height: 6))
                context.fill(path, with: .color(gold), style: FillStyle(eoFill: false))
            }
            do {
                let path = Path(ellipseIn: CGRect(x: 90, y: 80, width: 6, height: 6))
                context.fill(path, with: .color(gold), style: FillStyle(eoFill: false))
            }
            do {
                let path = Path { p in p.move(to: .init(x: 24, y: 76)); p.addLine(to: .init(x: 103, y: 76)) }
                context.stroke(path, with: .color(rust), style: StrokeStyle(lineWidth: 8, lineCap: .round, lineJoin: .round))
            }
            context = eyewear
            do {
                let path = Path(ellipseIn: CGRect(x: 31, y: 69, width: 26, height: 22))
                context.stroke(path, with: .color(ink), style: StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round))
            }
            do {
                let path = Path(ellipseIn: CGRect(x: 71, y: 69, width: 26, height: 22))
                context.stroke(path, with: .color(ink), style: StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round))
            }
            do {
                let path = Path { p in p.move(to: .init(x: 57, y: 77)); p.addQuadCurve(to: .init(x: 71, y: 77), control: .init(x: 64, y: 73)); p.move(to: .init(x: 25, y: 74)); p.addLine(to: .init(x: 31, y: 77)); p.move(to: .init(x: 97, y: 77)); p.addLine(to: .init(x: 103, y: 74)) }
                context.stroke(path, with: .color(ink), style: StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round))
            }
            do {
                let path = Path { p in p.move(to: .init(x: 38, y: 76)); p.addLine(to: .init(x: 44, y: 72)); p.move(to: .init(x: 78, y: 76)); p.addLine(to: .init(x: 84, y: 72)) }
                context.stroke(path, with: .color(gold), style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
            }
            context = source
            do {
                let path = Path { p in p.move(to: .init(x: 41, y: 101)); p.addLine(to: .init(x: 56, y: 98)); p.addLine(to: .init(x: 70, y: 103)); p.addLine(to: .init(x: 83, y: 101)); p.addLine(to: .init(x: 79, y: 111)); p.addLine(to: .init(x: 63, y: 108)); p.addLine(to: .init(x: 47, y: 111)); p.closeSubpath() }
                context.fill(path, with: .color(rust), style: FillStyle(eoFill: false))
                context.stroke(path, with: .color(ink), style: StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round))
            }
        case .motorcycle:
            do {
                let path = Path { p in p.move(to: .init(x: 27, y: 66)); p.addCurve(to: .init(x: 64, y: 17), control1: .init(x: 23, y: 37), control2: .init(x: 40, y: 17)); p.addCurve(to: .init(x: 104, y: 65), control1: .init(x: 90, y: 17), control2: .init(x: 106, y: 35)); p.addLine(to: .init(x: 98, y: 95)); p.addLine(to: .init(x: 83, y: 108)); p.addLine(to: .init(x: 43, y: 108)); p.addLine(to: .init(x: 28, y: 89)); p.closeSubpath(); p.move(to: .init(x: 34, y: 56)); p.addLine(to: .init(x: 34, y: 83)); p.addQuadCurve(to: .init(x: 96, y: 83), control: .init(x: 64, y: 97)); p.addLine(to: .init(x: 96, y: 56)); p.closeSubpath() }
                context.fill(path, with: .color(rust), style: FillStyle(eoFill: true))
                context.stroke(path, with: .color(ink), style: StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round))
            }
            do {
                let path = Path { p in p.move(to: .init(x: 35, y: 52)); p.addQuadCurve(to: .init(x: 99, y: 52), control: .init(x: 66, y: 43)); p.move(to: .init(x: 44, y: 97)); p.addLine(to: .init(x: 82, y: 97)); p.move(to: .init(x: 51, y: 103)); p.addLine(to: .init(x: 75, y: 103)) }
                context.stroke(path, with: .color(ink), style: StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round))
            }
            do {
                let path = Path { p in p.move(to: .init(x: 52, y: 21)); p.addQuadCurve(to: .init(x: 43, y: 45), control: .init(x: 43, y: 31)); p.addLine(to: .init(x: 50, y: 45)); p.addQuadCurve(to: .init(x: 58, y: 21), control: .init(x: 49, y: 33)); p.closeSubpath() }
                context.fill(path, with: .color(paper), style: FillStyle(eoFill: false))
            }
            do {
                let path = Path { p in p.move(to: .init(x: 35, y: 84)); p.addQuadCurve(to: .init(x: 95, y: 84), control: .init(x: 64, y: 94)) }
                context.stroke(path, with: .color(gold), style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
            }
            do {
                let path = Path(ellipseIn: CGRect(x: 25, y: 57, width: 8, height: 8))
                context.fill(path, with: .color(paper), style: FillStyle(eoFill: false))
                context.stroke(path, with: .color(ink), style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
            }
            do {
                let path = Path(ellipseIn: CGRect(x: 97, y: 57, width: 8, height: 8))
                context.fill(path, with: .color(paper), style: FillStyle(eoFill: false))
                context.stroke(path, with: .color(ink), style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
            }
            context = eyewear
            do {
                let path = Path { p in p.move(to: .init(x: 40, y: 79)); p.addLine(to: .init(x: 54, y: 79)); p.move(to: .init(x: 74, y: 79)); p.addLine(to: .init(x: 88, y: 79)) }
                context.stroke(path, with: .color(ink), style: StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round))
            }
            context = source
        case .builder:
            do {
                let path = Path { p in p.move(to: .init(x: 27, y: 56)); p.addLine(to: .init(x: 27, y: 49)); p.addCurve(to: .init(x: 64, y: 23), control1: .init(x: 27, y: 31), control2: .init(x: 43, y: 23)); p.addCurve(to: .init(x: 101, y: 49), control1: .init(x: 85, y: 23), control2: .init(x: 101, y: 32)); p.addLine(to: .init(x: 101, y: 56)); p.closeSubpath() }
                context.fill(path, with: .color(rust), style: FillStyle(eoFill: false))
                context.stroke(path, with: .color(ink), style: StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round))
            }
            do {
                let path = Path { p in p.move(to: .init(x: 58, y: 24)); p.addLine(to: .init(x: 58, y: 15)); p.addLine(to: .init(x: 70, y: 15)); p.addLine(to: .init(x: 70, y: 56)); p.addLine(to: .init(x: 58, y: 56)); p.closeSubpath() }
                context.fill(path, with: .color(gold), style: FillStyle(eoFill: false))
                context.stroke(path, with: .color(ink), style: StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round))
            }
            do {
                let path = Path { p in p.move(to: .init(x: 40, y: 32)); p.addLine(to: .init(x: 36, y: 52)); p.move(to: .init(x: 87, y: 32)); p.addLine(to: .init(x: 92, y: 52)) }
                context.stroke(path, with: .color(ink), style: StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round))
            }
            do {
                let path = Path { p in p.move(to: .init(x: 18, y: 54)); p.addLine(to: .init(x: 110, y: 54)); p.addLine(to: .init(x: 110, y: 61)); p.addLine(to: .init(x: 18, y: 61)); p.closeSubpath() }
                context.fill(path, with: .color(rust), style: FillStyle(eoFill: false))
                context.stroke(path, with: .color(ink), style: StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round))
            }
            context = eyewear
            do {
                let path = Path { p in p.move(to: .init(x: 31, y: 73)); p.addLine(to: .init(x: 57, y: 73)); p.addLine(to: .init(x: 57, y: 86)); p.addQuadCurve(to: .init(x: 34, y: 85), control: .init(x: 44, y: 92)); p.closeSubpath() }
                context.stroke(path, with: .color(ink), style: StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round))
            }
            do {
                let path = Path { p in p.move(to: .init(x: 71, y: 73)); p.addLine(to: .init(x: 97, y: 73)); p.addLine(to: .init(x: 94, y: 85)); p.addQuadCurve(to: .init(x: 71, y: 86), control: .init(x: 82, y: 92)); p.closeSubpath() }
                context.stroke(path, with: .color(ink), style: StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round))
            }
            do {
                let path = Path { p in p.move(to: .init(x: 57, y: 77)); p.addQuadCurve(to: .init(x: 71, y: 77), control: .init(x: 64, y: 73)); p.move(to: .init(x: 25, y: 74)); p.addLine(to: .init(x: 31, y: 77)); p.move(to: .init(x: 97, y: 77)); p.addLine(to: .init(x: 103, y: 74)) }
                context.stroke(path, with: .color(ink), style: StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round))
            }
            do {
                let path = Path { p in p.move(to: .init(x: 38, y: 76)); p.addLine(to: .init(x: 44, y: 72)); p.move(to: .init(x: 78, y: 76)); p.addLine(to: .init(x: 84, y: 72)) }
                context.stroke(path, with: .color(gold), style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
            }
            context = source
        case .baseball:
            do {
                let path = Path { p in p.move(to: .init(x: 28, y: 51)); p.addCurve(to: .init(x: 65, y: 22), control1: .init(x: 29, y: 30), control2: .init(x: 45, y: 20)); p.addCurve(to: .init(x: 97, y: 52), control1: .init(x: 86, y: 24), control2: .init(x: 97, y: 35)); p.addLine(to: .init(x: 75, y: 55)); p.addLine(to: .init(x: 43, y: 52)); p.closeSubpath() }
                context.fill(path, with: .color(rust), style: FillStyle(eoFill: false))
                context.stroke(path, with: .color(ink), style: StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round))
            }
            do {
                let path = Path { p in p.move(to: .init(x: 27, y: 49)); p.addLine(to: .init(x: 79, y: 48)); p.addQuadCurve(to: .init(x: 115, y: 61), control: .init(x: 101, y: 47)); p.addQuadCurve(to: .init(x: 69, y: 56), control: .init(x: 91, y: 66)); p.addLine(to: .init(x: 28, y: 56)); p.closeSubpath() }
                context.fill(path, with: .color(rust), style: FillStyle(eoFill: false))
                context.stroke(path, with: .color(ink), style: StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round))
            }
            do {
                let path = Path { p in p.move(to: .init(x: 62, y: 24)); p.addQuadCurve(to: .init(x: 45, y: 49), control: .init(x: 47, y: 34)); p.move(to: .init(x: 73, y: 25)); p.addQuadCurve(to: .init(x: 88, y: 47), control: .init(x: 86, y: 33)) }
                context.stroke(path, with: .color(ink), style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
            }
            do {
                let path = Path { p in p.move(to: .init(x: 29, y: 57)); p.addLine(to: .init(x: 29, y: 77)); p.addLine(to: .init(x: 23, y: 85)); p.addLine(to: .init(x: 23, y: 55)); p.closeSubpath() }
                context.fill(path, with: .color(rust), style: FillStyle(eoFill: false))
                context.stroke(path, with: .color(ink), style: StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round))
            }
            do {
                let path = Path { p in p.move(to: .init(x: 53, y: 32)); p.addLine(to: .init(x: 61, y: 32)); p.addLine(to: .init(x: 61, y: 39)); p.addLine(to: .init(x: 53, y: 39)); p.closeSubpath() }
                context.fill(path, with: .color(paper), style: FillStyle(eoFill: false))
            }
            do {
                let path = Path(ellipseIn: CGRect(x: 60, y: 18, width: 6, height: 6))
                context.fill(path, with: .color(ink), style: FillStyle(eoFill: false))
            }
            context = eyewear
            do {
                let path = Path { p in p.move(to: .init(x: 31, y: 73)); p.addLine(to: .init(x: 57, y: 73)); p.addLine(to: .init(x: 57, y: 86)); p.addQuadCurve(to: .init(x: 34, y: 85), control: .init(x: 44, y: 92)); p.closeSubpath() }
                context.stroke(path, with: .color(ink), style: StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round))
            }
            do {
                let path = Path { p in p.move(to: .init(x: 71, y: 73)); p.addLine(to: .init(x: 97, y: 73)); p.addLine(to: .init(x: 94, y: 85)); p.addQuadCurve(to: .init(x: 71, y: 86), control: .init(x: 82, y: 92)); p.closeSubpath() }
                context.stroke(path, with: .color(ink), style: StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round))
            }
            do {
                let path = Path { p in p.move(to: .init(x: 57, y: 77)); p.addQuadCurve(to: .init(x: 71, y: 77), control: .init(x: 64, y: 73)); p.move(to: .init(x: 25, y: 74)); p.addLine(to: .init(x: 31, y: 77)); p.move(to: .init(x: 97, y: 77)); p.addLine(to: .init(x: 103, y: 74)) }
                context.stroke(path, with: .color(ink), style: StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round))
            }
            do {
                let path = Path { p in p.move(to: .init(x: 38, y: 76)); p.addLine(to: .init(x: 44, y: 72)); p.move(to: .init(x: 78, y: 76)); p.addLine(to: .init(x: 84, y: 72)) }
                context.stroke(path, with: .color(gold), style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
            }
            context = source
        case .medic:
            do {
                let path = Path { p in p.move(to: .init(x: 29, y: 52)); p.addLine(to: .init(x: 26, y: 36)); p.addQuadCurve(to: .init(x: 43, y: 28), control: .init(x: 29, y: 27)); p.addQuadCurve(to: .init(x: 64, y: 23), control: .init(x: 53, y: 18)); p.addQuadCurve(to: .init(x: 87, y: 29), control: .init(x: 80, y: 20)); p.addQuadCurve(to: .init(x: 103, y: 40), control: .init(x: 101, y: 30)); p.addLine(to: .init(x: 99, y: 53)); p.closeSubpath() }
                context.fill(path, with: .color(rust), style: FillStyle(eoFill: false))
                context.stroke(path, with: .color(ink), style: StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round))
            }
            do {
                let path = Path { p in p.move(to: .init(x: 29, y: 48)); p.addLine(to: .init(x: 99, y: 48)); p.addLine(to: .init(x: 99, y: 55)); p.addLine(to: .init(x: 29, y: 55)); p.closeSubpath() }
                context.fill(path, with: .color(paper), style: FillStyle(eoFill: false))
                context.stroke(path, with: .color(ink), style: StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round))
            }
            do {
                let path = Path { p in p.move(to: .init(x: 46, y: 32)); p.addLine(to: .init(x: 45, y: 43)); p.move(to: .init(x: 77, y: 29)); p.addLine(to: .init(x: 82, y: 43)) }
                context.stroke(path, with: .color(ink), style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
            }
            context = eyewear
            do {
                let path = Path(ellipseIn: CGRect(x: 31, y: 69, width: 26, height: 22))
                context.stroke(path, with: .color(ink), style: StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round))
            }
            do {
                let path = Path(ellipseIn: CGRect(x: 71, y: 69, width: 26, height: 22))
                context.stroke(path, with: .color(ink), style: StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round))
            }
            do {
                let path = Path { p in p.move(to: .init(x: 57, y: 77)); p.addQuadCurve(to: .init(x: 71, y: 77), control: .init(x: 64, y: 73)); p.move(to: .init(x: 25, y: 74)); p.addLine(to: .init(x: 31, y: 77)); p.move(to: .init(x: 97, y: 77)); p.addLine(to: .init(x: 103, y: 74)) }
                context.stroke(path, with: .color(ink), style: StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round))
            }
            do {
                let path = Path { p in p.move(to: .init(x: 38, y: 76)); p.addLine(to: .init(x: 44, y: 72)); p.move(to: .init(x: 78, y: 76)); p.addLine(to: .init(x: 84, y: 72)) }
                context.stroke(path, with: .color(gold), style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
            }
            context = source
            do {
                let path = Path { p in p.move(to: .init(x: 38, y: 87)); p.addLine(to: .init(x: 30, y: 86)); p.move(to: .init(x: 90, y: 87)); p.addLine(to: .init(x: 98, y: 86)) }
                context.stroke(path, with: .color(ink), style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
            }
            do {
                let path = Path { p in p.move(to: .init(x: 39, y: 83)); p.addQuadCurve(to: .init(x: 89, y: 83), control: .init(x: 64, y: 87)); p.addLine(to: .init(x: 85, y: 99)); p.addQuadCurve(to: .init(x: 43, y: 99), control: .init(x: 64, y: 111)); p.closeSubpath() }
                context.fill(path, with: .color(rust), style: FillStyle(eoFill: false))
                context.stroke(path, with: .color(ink), style: StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round))
            }
            do {
                let path = Path { p in p.move(to: .init(x: 47, y: 91)); p.addLine(to: .init(x: 81, y: 91)); p.move(to: .init(x: 48, y: 97)); p.addLine(to: .init(x: 80, y: 97)) }
                context.stroke(path, with: .color(paper), style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
            }
            do {
                let path = Path { p in p.move(to: .init(x: 33, y: 98)); p.addLine(to: .init(x: 33, y: 105)); p.addQuadCurve(to: .init(x: 46, y: 118), control: .init(x: 33, y: 118)); p.addQuadCurve(to: .init(x: 59, y: 107), control: .init(x: 59, y: 118)); p.move(to: .init(x: 38, y: 102)); p.addLine(to: .init(x: 38, y: 107)); p.move(to: .init(x: 54, y: 106)); p.addLine(to: .init(x: 54, y: 109)); p.move(to: .init(x: 59, y: 108)); p.addQuadCurve(to: .init(x: 94, y: 112), control: .init(x: 79, y: 131)); p.addLine(to: .init(x: 94, y: 106)) }
                context.stroke(path, with: .color(ink), style: StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round))
            }
            do {
                let path = Path(ellipseIn: CGRect(x: 88, y: 97, width: 12, height: 12))
                context.fill(path, with: .color(gold), style: FillStyle(eoFill: false))
                context.stroke(path, with: .color(ink), style: StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round))
            }
        case .explorer:
            do {
                let path = Path { p in p.move(to: .init(x: 36, y: 53)); p.addLine(to: .init(x: 42, y: 24)); p.addLine(to: .init(x: 55, y: 29)); p.addLine(to: .init(x: 68, y: 23)); p.addLine(to: .init(x: 86, y: 29)); p.addLine(to: .init(x: 94, y: 55)); p.closeSubpath() }
                context.fill(path, with: .color(rust), style: FillStyle(eoFill: false))
                context.stroke(path, with: .color(ink), style: StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round))
            }
            do {
                let path = Path { p in p.move(to: .init(x: 39, y: 43)); p.addQuadCurve(to: .init(x: 90, y: 44), control: .init(x: 63, y: 50)); p.addLine(to: .init(x: 93, y: 54)); p.addLine(to: .init(x: 36, y: 54)); p.closeSubpath() }
                context.fill(path, with: .color(ink), style: FillStyle(eoFill: false))
            }
            do {
                let path = Path { p in p.move(to: .init(x: 12, y: 53)); p.addQuadCurve(to: .init(x: 38, y: 51), control: .init(x: 26, y: 47)); p.addQuadCurve(to: .init(x: 94, y: 51), control: .init(x: 64, y: 59)); p.addQuadCurve(to: .init(x: 116, y: 53), control: .init(x: 105, y: 46)); p.addQuadCurve(to: .init(x: 92, y: 64), control: .init(x: 110, y: 63)); p.addLine(to: .init(x: 29, y: 61)); p.closeSubpath() }
                context.fill(path, with: .color(rust), style: FillStyle(eoFill: false))
                context.stroke(path, with: .color(ink), style: StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round))
            }
            do {
                let path = Path { p in p.move(to: .init(x: 60, y: 48)); p.addLine(to: .init(x: 68, y: 48)); p.addLine(to: .init(x: 68, y: 54)); p.addLine(to: .init(x: 60, y: 54)); p.closeSubpath() }
                context.fill(path, with: .color(gold), style: FillStyle(eoFill: false))
            }
            context = eyewear
            do {
                let path = Path(ellipseIn: CGRect(x: 31, y: 69, width: 26, height: 22))
                context.stroke(path, with: .color(ink), style: StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round))
            }
            do {
                let path = Path(ellipseIn: CGRect(x: 71, y: 69, width: 26, height: 22))
                context.stroke(path, with: .color(ink), style: StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round))
            }
            do {
                let path = Path { p in p.move(to: .init(x: 57, y: 77)); p.addQuadCurve(to: .init(x: 71, y: 77), control: .init(x: 64, y: 73)); p.move(to: .init(x: 25, y: 74)); p.addLine(to: .init(x: 31, y: 77)); p.move(to: .init(x: 97, y: 77)); p.addLine(to: .init(x: 103, y: 74)) }
                context.stroke(path, with: .color(ink), style: StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round))
            }
            do {
                let path = Path { p in p.move(to: .init(x: 38, y: 76)); p.addLine(to: .init(x: 44, y: 72)); p.move(to: .init(x: 78, y: 76)); p.addLine(to: .init(x: 84, y: 72)) }
                context.stroke(path, with: .color(gold), style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
            }
            context = source
        }
    }

    private func drawBrows(in context: GraphicsContext, pose: AvatarPose) {
        let points: [(Double, Double, Double, Double, Double, Double)]
        switch phase {
        case .ready: points = [(39, 64, 47, 60, 56, 63), (72, 63, 81, 60, 89, 64)]
        case .working, .tool: points = [(39, 62, 47.5, 63.5, 56, 65), (72, 65, 80.5, 63.5, 89, 62)]
        case .thinking: points = [(39, 64, 47.5, 64.5, 56, 65), (72, 59, 81, 55, 89, 58)]
        case .responding: points = [(39, 61, 47, 57, 56, 61), (72, 61, 81, 57, 89, 61)]
        case .journaling: points = [(39, 65, 47.5, 65.5, 56, 66), (72, 66, 80.5, 65.5, 89, 65)]
        case .autonomy: points = [(39, 62, 47, 59, 56, 62), (72, 62, 81, 59, 89, 62)]
        case .approval: points = [(39, 59, 47, 55, 56, 59), (72, 65, 80.5, 64, 89, 63)]
        case .error: points = [(39, 64, 47.5, 61.5, 56, 59), (72, 59, 80.5, 61.5, 89, 64)]
        }
        for (index, p) in points.enumerated() {
            let brow = Path { path in
                path.move(to: .init(x: p.0, y: p.1))
                path.addQuadCurve(to: .init(x: p.4, y: p.5), control: .init(x: p.2, y: p.3))
            }
            let part = transformed(context, y: index == 0 ? pose.leftBrowY : pose.rightBrowY,
                rotate: index == 0 ? pose.leftBrowRotate : pose.rightBrowRotate,
                center: CGPoint(x: index == 0 ? 48 : 80, y: 63))
            part.stroke(brow, with: .color(ink), style: StrokeStyle(lineWidth: 4, lineCap: .round))
        }
    }

}

struct BotAvatarPicker: View {
    @Binding var selection: BotAvatarStyle
    @Environment(\.reinTheme) private var theme
    @EnvironmentObject private var sounds: ReinSoundEngine
    var body: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 88), spacing: 10)], spacing: 10) {
            ForEach(BotAvatarStyle.allCases) { style in
                Button { selection = style; sounds.play(.click) } label: {
                    VStack(spacing: 2) {
                        BotAvatarView(style: style).frame(width: 72, height: 76).accessibilityHidden(true)
                        Text(style.label).font(.reinMono(.caption))
                        Text(selection == style ? "SELECTED" : "CHOOSE").font(.reinMono(.caption2)).foregroundStyle(theme.muted)
                    }.padding(8).frame(maxWidth: .infinity).foregroundStyle(theme.ink)
                        .background(selection == style ? theme.paperSecondary : theme.raised)
                        .overlay(Rectangle().stroke(selection == style ? theme.accent : theme.rule, lineWidth: selection == style ? 2 : 1))
                }.buttonStyle(.plain).accessibilityLabel("\(style.label) avatar").accessibilityAddTraits(selection == style ? .isSelected : [])
            }
        }.accessibilityElement(children: .contain).accessibilityLabel("Choose a bot avatar")
    }
}
