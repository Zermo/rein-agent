import SwiftUI

struct ReinTheme: Equatable {
    let dark: Bool
    let accentName: String
    let density: String

    var paper: Color { Color(hex: dark ? 0x181C18 : 0xF5EDDC) }
    var paperSecondary: Color { Color(hex: dark ? 0x1D211D : 0xF0E5D0) }
    var raised: Color { Color(hex: dark ? 0x2E332D : 0xFFFAF0) }
    var ink: Color { Color(hex: dark ? 0xF5EDDC : 0x252A25) }
    var muted: Color { Color(hex: dark ? 0xB8B0A0 : 0x555D50) }
    var rule: Color { Color(hex: dark ? 0x475045 : 0xC6BAA3) }
    var strongRule: Color { Color(hex: dark ? 0x938B7C : 0x8D8575) }
    var gold: Color { Color(hex: 0xEBBC5C) }
    var green: Color { Color(hex: dark ? 0x88C8AA : 0x284D3D) }
    var greenInk: Color { Color(hex: dark ? 0x181C18 : 0xFFFAF0) }
    var error: Color { Color(hex: dark ? 0xF5EDDC : 0x932C25) }
    var errorPaper: Color { Color(hex: dark ? 0x592721 : 0xFAD4CC) }
    var accent: Color {
        switch accentName {
        case "slate": Color(hex: dark ? 0xB8B0A0 : 0x555D50)
        case "storm": green
        default: Color(hex: dark ? 0xF29070 : 0xB54229)
        }
    }
    var accentInk: Color { dark ? Color(hex: 0x181C18) : Color(hex: 0xFFFAF0) }
    var spacing: CGFloat { density == "compact" ? 8 : density == "roomy" ? 24 : 12 }

    static let preview = ReinTheme(dark: false, accentName: "rain", density: "regular")
}

private struct ReinThemeKey: EnvironmentKey { static let defaultValue = ReinTheme.preview }
extension EnvironmentValues {
    var reinTheme: ReinTheme { get { self[ReinThemeKey.self] } set { self[ReinThemeKey.self] = newValue } }
}

extension Color {
    init(hex: UInt, alpha: Double = 1) {
        self.init(.sRGB, red: Double((hex >> 16) & 0xff) / 255, green: Double((hex >> 8) & 0xff) / 255, blue: Double(hex & 0xff) / 255, opacity: alpha)
    }
}

extension Font {
    static func reinDisplay(_ style: TextStyle = .title) -> Font { .custom("Impact", size: style == .largeTitle ? 48 : style == .title ? 34 : 24, relativeTo: style) }
    static func reinBody(_ style: TextStyle = .body, weight: Weight = .regular) -> Font { .custom("Avenir Next", size: style == .body ? 17 : 15, relativeTo: style).weight(weight) }
    static func reinMono(_ style: TextStyle = .caption, weight: Weight = .bold) -> Font { .system(style, design: .monospaced, weight: weight) }
}

struct ReinPrimaryButtonStyle: ButtonStyle {
    @Environment(\.reinTheme) private var theme
    @EnvironmentObject private var sounds: ReinSoundEngine
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.reinMono(.callout, weight: .bold)).textCase(.uppercase)
            .frame(minHeight: 44).padding(.horizontal, 16)
            .foregroundStyle(theme.accentInk).background(theme.accent.opacity(configuration.isPressed ? 0.78 : 1))
            .overlay(Rectangle().stroke(theme.ink, lineWidth: 1))
            .contentShape(Rectangle())
            .onChange(of: configuration.isPressed) { _, pressed in if pressed { sounds.play(.click) } }
            .onHover { inside in if inside { sounds.play(.hover) } }
    }
}

struct ReinSecondaryButtonStyle: ButtonStyle {
    @Environment(\.reinTheme) private var theme
    @EnvironmentObject private var sounds: ReinSoundEngine
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.reinMono(.callout, weight: .bold)).textCase(.uppercase)
            .frame(minHeight: 44).padding(.horizontal, 14)
            .foregroundStyle(theme.ink).background(configuration.isPressed ? theme.paperSecondary : theme.raised)
            .overlay(Rectangle().stroke(theme.strongRule, lineWidth: 1))
            .contentShape(Rectangle())
            .onChange(of: configuration.isPressed) { _, pressed in if pressed { sounds.play(.click) } }
            .onHover { inside in if inside { sounds.play(.hover) } }
    }
}

struct ReinFieldModifier: ViewModifier {
    @Environment(\.reinTheme) private var theme
    func body(content: Content) -> some View {
        content.padding(12).frame(minHeight: 44).background(theme.raised)
            .overlay(Rectangle().stroke(theme.strongRule, lineWidth: 1)).foregroundStyle(theme.ink)
    }
}

extension View { func reinField() -> some View { modifier(ReinFieldModifier()) } }

struct FieldLabel: View {
    let title: String
    let folio: String?
    init(_ title: String, folio: String? = nil) { self.title = title; self.folio = folio }
    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title.uppercased())
            Spacer(minLength: 8)
            if let folio { Text(folio) }
        }.font(.reinMono(.caption, weight: .bold)).tracking(1.1)
    }
}
