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
        // FNV matches avatar-catalog.mjs, including code points within its UTF-16 limit.
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
        return allCases[Int(hash % UInt32(allCases.count))]
    }
}

enum BotAvatarPhase: String, Sendable {
    case ready, working, responding, tool, approval, error
    var label: String {
        switch self { case .ready: "Ready"; case .working: "Working"; case .responding: "Replying"; case .tool: "Running a tool"; case .approval: "Waiting for approval"; case .error: "Needs attention" }
    }
}

struct BotAvatarView: View {
    let style: BotAvatarStyle
    var phase: BotAvatarPhase = .ready
    @Environment(\.reinTheme) private var theme

    var body: some View {
        Canvas { context, size in
            let scale = min(size.width, size.height) / 128
            context.translateBy(x: (size.width - 128 * scale) / 2, y: (size.height - 128 * scale) / 2)
            context.scaleBy(x: scale, y: scale)
            drawHeadwear(in: context)
            // Expressions change only with reported runtime activity. No idle loop.
            drawBrows(in: context)
        }
        .accessibilityLabel("\(style.label) avatar. \(phase.label).")
    }

    private var ink: Color { theme.ink }
    private var rust: Color { Color(hex: theme.dark ? 0xF29070 : 0xB54229) }
    private var paper: Color { theme.paper }
    private var gold: Color { theme.gold }

    private func drawHeadwear(in context: GraphicsContext) {
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
            do {
                let path = Path { p in p.move(to: .init(x: 40, y: 79)); p.addLine(to: .init(x: 54, y: 79)); p.move(to: .init(x: 74, y: 79)); p.addLine(to: .init(x: 88, y: 79)) }
                context.stroke(path, with: .color(ink), style: StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round))
            }
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
        }
    }

    private func drawBrows(in context: GraphicsContext) {
        let brows: Path
        switch phase {
        case .ready: brows = Path { p in p.move(to: .init(x: 39, y: 64)); p.addQuadCurve(to: .init(x: 56, y: 63), control: .init(x: 47, y: 60)); p.move(to: .init(x: 72, y: 63)); p.addQuadCurve(to: .init(x: 89, y: 64), control: .init(x: 81, y: 60)) }
        case .working, .tool: brows = Path { p in p.move(to: .init(x: 39, y: 62)); p.addLine(to: .init(x: 56, y: 65)); p.move(to: .init(x: 72, y: 65)); p.addLine(to: .init(x: 89, y: 62)) }
        case .responding: brows = Path { p in p.move(to: .init(x: 39, y: 61)); p.addQuadCurve(to: .init(x: 56, y: 61), control: .init(x: 47, y: 57)); p.move(to: .init(x: 72, y: 61)); p.addQuadCurve(to: .init(x: 89, y: 61), control: .init(x: 81, y: 57)) }
        case .approval: brows = Path { p in p.move(to: .init(x: 39, y: 59)); p.addQuadCurve(to: .init(x: 56, y: 59), control: .init(x: 47, y: 55)); p.move(to: .init(x: 72, y: 65)); p.addLine(to: .init(x: 89, y: 63)) }
        case .error: brows = Path { p in p.move(to: .init(x: 39, y: 64)); p.addLine(to: .init(x: 56, y: 59)); p.move(to: .init(x: 72, y: 59)); p.addLine(to: .init(x: 89, y: 64)) }
        }
        context.stroke(brows, with: .color(ink), style: StrokeStyle(lineWidth: 4, lineCap: .round))
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
