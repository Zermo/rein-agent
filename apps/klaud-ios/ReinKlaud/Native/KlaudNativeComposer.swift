import SwiftUI
import UIKit
import UniformTypeIdentifiers

struct KlaudNativeComposer: View {
    @ObservedObject var bridge: KlaudBridge
    @State private var choosingAttachment = false

    private let glass = Color(red: 0.071, green: 0.063, blue: 0.055)
    private let paper = Color(red: 0.957, green: 0.918, blue: 0.831)
    private let rust = Color(red: 0.769, green: 0.361, blue: 0.227)

    var body: some View {
        VStack(spacing: 0) {
            if bridge.composerDeliveryUncertain {
                HStack(spacing: 8) {
                    Image(systemName: "exclamationmark.triangle.fill")
                    Text("Send status unknown after reconnect.")
                        .lineLimit(2)
                    Spacer(minLength: 4)
                    Button("allow retry") {
                        bridge.keyFeedback("letter")
                        bridge.allowRetryAfterUnknownDelivery()
                    }
                    .fontWeight(.bold)
                }
                .font(.system(size: 12, design: .monospaced))
                .foregroundStyle(paper)
                .padding(.horizontal, 10)
                .padding(.vertical, 7)
                .background(rust.opacity(0.72))
            }

            HStack(alignment: .bottom, spacing: 6) {
                composerButton(symbol: "plus", label: "Add Attachment") {
                    bridge.keyFeedback("letter")
                    choosingAttachment = true
                }
                .disabled(!bridge.composerEnabled || bridge.composerBusy)

                composerButton(symbol: "sparkles", label: "Refine on Device") {
                    bridge.keyFeedback("letter")
                    bridge.refineDraftOnDevice()
                }
                .disabled(
                    !bridge.composerEnabled || bridge.composerBusy ||
                    bridge.localInference.isRunning || bridge.localInference.availability != .ready ||
                    bridge.composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                )

                ZStack(alignment: .topLeading) {
                    if bridge.composerText.isEmpty {
                        Text(bridge.composerEnabled ? "Reply to your field unit…" : "Choose a field unit")
                            .font(.system(size: 15, design: .monospaced))
                            .foregroundStyle(paper.opacity(0.42))
                            .padding(.horizontal, 9)
                            .padding(.vertical, 10)
                            .allowsHitTesting(false)
                    }
                    KlaudComposerTextEditor(bridge: bridge)
                }
                .frame(minHeight: 44, maxHeight: 86)
                .overlay {
                    RoundedRectangle(cornerRadius: 5)
                        .stroke(paper.opacity(0.58), lineWidth: 1)
                }

                composerButton(
                    symbol: bridge.keyboardVisible ? "keyboard.chevron.compact.down" : "keyboard",
                    label: bridge.keyboardVisible ? "Hide Keyboard" : "Show Keyboard"
                ) {
                    bridge.keyFeedback("letter")
                    if bridge.keyboardVisible {
                        bridge.requestKeyboardDismissal()
                    } else {
                        bridge.requestKeyboardPresentation()
                    }
                }

                Button {
                    if bridge.composerBusy {
                        bridge.keyFeedback("delete")
                        bridge.stopRun()
                    } else {
                        bridge.keyFeedback("send")
                        bridge.submitComposer()
                    }
                } label: {
                    Text(bridge.composerBusy ? "stop" : "send")
                        .font(.system(size: 13, weight: .bold, design: .monospaced))
                        .frame(minWidth: 50, minHeight: 44)
                }
                .buttonStyle(KlaudComposerButtonStyle(fill: rust, ink: paper))
                .disabled(
                    !bridge.composerBusy && (
                        !bridge.composerEnabled ||
                        bridge.composerSubmitting ||
                        bridge.composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    )
                )
                .accessibilityLabel(bridge.composerBusy ? "Stop Run" : "Send Reply")
            }
            .padding(.horizontal, 7)
            .padding(.vertical, 7)
        }
        .background(glass)
        .overlay(alignment: .top) {
            Rectangle().fill(paper.opacity(0.48)).frame(height: 1)
        }
        .fileImporter(
            isPresented: $choosingAttachment,
            allowedContentTypes: [.item],
            allowsMultipleSelection: true
        ) { result in
            guard case .success(let urls) = result else { return }
            bridge.appendAttachmentNames(urls)
            bridge.requestKeyboardPresentation()
        }
    }

    private func composerButton(
        symbol: String,
        label: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 16, weight: .semibold))
                .frame(width: 42, height: 44)
        }
        .buttonStyle(KlaudComposerButtonStyle(fill: glass, ink: paper))
        .accessibilityLabel(label)
    }
}

private struct KlaudComposerButtonStyle: ButtonStyle {
    let fill: Color
    let ink: Color

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(configuration.isPressed ? fill : ink)
            .background(configuration.isPressed ? ink : fill)
            .overlay {
                RoundedRectangle(cornerRadius: 5)
                    .stroke(ink.opacity(configuration.isPressed ? 1 : 0.66), lineWidth: 1)
            }
            .clipShape(RoundedRectangle(cornerRadius: 5))
            .offset(y: configuration.isPressed ? 1 : 0)
    }
}

/// A real UITextView gives UIKit trustworthy caret geometry, selection handles,
/// loupe placement, edit menus, undo, paste, and hardware-keyboard behavior.
struct KlaudComposerTextEditor: UIViewRepresentable {
    @ObservedObject var bridge: KlaudBridge

    func makeCoordinator() -> Coordinator {
        Coordinator(bridge: bridge)
    }

    func makeUIView(context: Context) -> KlaudComposerTextView {
        let view = KlaudComposerTextView()
        view.delegate = context.coordinator
        context.coordinator.textView = view
        bridge.composerTextView = view
        view.backgroundColor = .clear
        view.textColor = UIColor(red: 0.957, green: 0.918, blue: 0.831, alpha: 1)
        view.tintColor = UIColor(red: 0.769, green: 0.361, blue: 0.227, alpha: 1)
        view.font = .monospacedSystemFont(ofSize: 15, weight: .regular)
        view.textContainerInset = UIEdgeInsets(top: 9, left: 5, bottom: 8, right: 5)
        view.textContainer.lineFragmentPadding = 0
        view.isScrollEnabled = true
        view.alwaysBounceVertical = false
        view.autocorrectionType = .yes
        view.spellCheckingType = .yes
        view.smartQuotesType = .yes
        view.smartDashesType = .yes
        view.keyboardDismissMode = .interactive
        view.accessibilityLabel = "Reply"
        view.onCommandSend = { [weak coordinator = context.coordinator] in coordinator?.handle(.send) }
        let keyboard = KlaudKeyboardInputView { [weak coordinator = context.coordinator] action in
            coordinator?.handle(action)
        }
        view.installCRTKeyboard(keyboard)
        return view
    }

    func updateUIView(_ view: KlaudComposerTextView, context: Context) {
        context.coordinator.bridge = bridge
        bridge.composerTextView = view
        view.isEditable = bridge.composerEnabled && !bridge.composerBusy
        view.alpha = view.isEditable ? 1 : 0.6
        view.setComposerState(busy: bridge.composerBusy, submitting: bridge.composerSubmitting)

        if view.text != bridge.composerText {
            view.performProgrammaticUpdate {
                let selection = view.selectedRange
                view.text = bridge.composerText
                let length = (bridge.composerText as NSString).length
                let location = min(selection.location, length)
                let rangeLength = min(selection.length, length - location)
                view.selectedRange = NSRange(location: location, length: rangeLength)
            }
        }

        if context.coordinator.lastDismissRequest != bridge.keyboardDismissRequest {
            context.coordinator.lastDismissRequest = bridge.keyboardDismissRequest
            view.resignFirstResponder()
        }
        if context.coordinator.lastShowRequest != bridge.keyboardShowRequest {
            context.coordinator.lastShowRequest = bridge.keyboardShowRequest
            guard view.isEditable else { return }
            view.becomeFirstResponder()
        }
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        var bridge: KlaudBridge
        weak var textView: KlaudComposerTextView?
        var lastDismissRequest = 0
        var lastShowRequest = 0

        init(bridge: KlaudBridge) {
            self.bridge = bridge
        }

        func textViewDidBeginEditing(_ textView: UITextView) {
            bridge.keyboardVisible = true
        }

        func textViewDidEndEditing(_ textView: UITextView) {
            bridge.keyboardVisible = false
        }

        func textViewDidChange(_ textView: UITextView) {
            guard let editor = textView as? KlaudComposerTextView,
                  !editor.isApplyingProgrammaticUpdate else { return }
            bridge.stopDictationForManualEditing()
            bridge.setComposerDraft(textView.text)
        }

        func textViewDidChangeSelection(_ textView: UITextView) {
            guard let editor = textView as? KlaudComposerTextView,
                  !editor.isApplyingProgrammaticUpdate else { return }
            bridge.stopDictationForManualEditing()
        }

        func textView(
            _ textView: UITextView,
            shouldChangeTextIn range: NSRange,
            replacementText text: String
        ) -> Bool {
            if textView.markedTextRange != nil { return true }
            let current = textView.text as NSString
            guard range.location <= current.length, range.location + range.length <= current.length else { return false }
            return current.replacingCharacters(in: range, with: text).utf8.count <= KlaudComposerContract.maximumUTF8Count
        }

        func handle(_ action: KlaudKeyboardAction) {
            guard let textView else { return }
            switch action {
            case .insert(let text):
                bridge.stopDictationForManualEditing()
                bridge.keyFeedback(text == " " ? "space" : "letter")
                textView.insertText(text)
            case .delete:
                bridge.stopDictationForManualEditing()
                bridge.keyFeedback("delete")
                textView.deleteBackward()
            case .returnKey:
                bridge.stopDictationForManualEditing()
                bridge.keyFeedback("return")
                textView.insertText("\n")
            case .send:
                bridge.stopDictationForManualEditing()
                bridge.keyFeedback("send")
                if bridge.composerBusy { bridge.stopRun() } else { bridge.submitComposer() }
            case .dictate:
                bridge.keyFeedback("return")
                bridge.toggleDictation()
            case .systemKeyboard:
                bridge.stopDictationForManualEditing()
                bridge.keyFeedback("letter")
                textView.useSystemKeyboard()
            case .hide:
                bridge.keyFeedback("letter")
                bridge.requestKeyboardDismissal()
            }
        }
    }
}

final class KlaudComposerTextView: UITextView {
    private var crtKeyboard: UIView?
    var onCommandSend: (() -> Void)?
    private(set) var isApplyingProgrammaticUpdate = false

    override var canBecomeFirstResponder: Bool { isEditable }

    override var keyCommands: [UIKeyCommand]? {
        [UIKeyCommand(
            title: "Send Reply",
            action: #selector(sendFromHardwareKeyboard),
            input: "\r",
            modifierFlags: .command
        )]
    }

    func installCRTKeyboard(_ keyboard: UIView) {
        crtKeyboard = keyboard
        inputView = keyboard
        inputAccessoryView = nil
    }

    func setComposerState(busy: Bool, submitting: Bool) {
        (crtKeyboard as? KlaudKeyboardInputView)?.setComposerState(
            busy: busy,
            submitting: submitting
        )
    }

    @discardableResult
    func performProgrammaticUpdate<T>(_ update: () -> T) -> T {
        isApplyingProgrammaticUpdate = true
        defer { isApplyingProgrammaticUpdate = false }
        return update()
    }

    @discardableResult
    func replaceText(in proposedRange: NSRange, with replacement: String) -> NSRange {
        let currentLength = (text as NSString).length
        let location = min(proposedRange.location, currentLength)
        let rangeLength = min(proposedRange.length, currentLength - location)
        textStorage.replaceCharacters(
            in: NSRange(location: location, length: rangeLength),
            with: replacement
        )
        let insertedRange = NSRange(location: location, length: (replacement as NSString).length)
        selectedRange = NSRange(location: NSMaxRange(insertedRange), length: 0)
        return insertedRange
    }

    func useSystemKeyboard() {
        inputView = nil
        inputAccessoryView = KlaudKeyboardAccessory { [weak self] in self?.useCRTKeyboard() }
        reloadInputViews()
    }

    func useCRTKeyboard() {
        inputView = crtKeyboard
        inputAccessoryView = nil
        reloadInputViews()
    }

    @objc private func sendFromHardwareKeyboard() {
        onCommandSend?()
    }
}

enum KlaudKeyboardAction {
    case insert(String)
    case delete
    case returnKey
    case send
    case dictate
    case systemKeyboard
    case hide
}

final class KlaudKeyboardAccessory: UIInputView {
    init(onCRT: @escaping () -> Void) {
        super.init(frame: CGRect(x: 0, y: 0, width: 390, height: 44), inputViewStyle: .keyboard)
        allowsSelfSizing = true
        backgroundColor = UIColor(red: 0.071, green: 0.063, blue: 0.055, alpha: 1)
        let button = UIButton(type: .system)
        button.setTitle("CRT keyboard", for: .normal)
        button.titleLabel?.font = .monospacedSystemFont(ofSize: 14, weight: .semibold)
        button.tintColor = UIColor(red: 0.957, green: 0.918, blue: 0.831, alpha: 1)
        button.accessibilityLabel = "Return to CRT keyboard"
        button.addAction(UIAction { _ in onCRT() }, for: .touchUpInside)
        button.translatesAutoresizingMaskIntoConstraints = false
        addSubview(button)
        NSLayoutConstraint.activate([
            button.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
            button.topAnchor.constraint(equalTo: topAnchor),
            button.bottomAnchor.constraint(equalTo: bottomAnchor),
            button.widthAnchor.constraint(greaterThanOrEqualToConstant: 132)
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    override var intrinsicContentSize: CGSize {
        CGSize(width: UIView.noIntrinsicMetric, height: 44)
    }
}

final class KlaudKeyboardInputView: UIInputView {
    private enum ButtonKind { case key, number, modifier, delete, send }

    private let action: (KlaudKeyboardAction) -> Void
    private let column = UIStackView()
    private var shifted = false
    private var symbols = false
    private var composerBusy = false
    private var composerSubmitting = false

    init(action: @escaping (KlaudKeyboardAction) -> Void) {
        self.action = action
        super.init(frame: CGRect(x: 0, y: 0, width: 390, height: 314), inputViewStyle: .keyboard)
        allowsSelfSizing = true
        autoresizingMask = [.flexibleWidth]
        backgroundColor = UIColor(red: 0.071, green: 0.063, blue: 0.055, alpha: 1)
        configureColumn()
        rebuild()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    override var intrinsicContentSize: CGSize {
        CGSize(width: UIView.noIntrinsicMetric, height: 314)
    }

    func setComposerState(busy: Bool, submitting: Bool) {
        guard busy != composerBusy || submitting != composerSubmitting else { return }
        composerBusy = busy
        composerSubmitting = submitting
        rebuild()
    }

    private func configureColumn() {
        column.axis = .vertical
        column.spacing = 5
        column.distribution = .fillEqually
        column.translatesAutoresizingMaskIntoConstraints = false
        addSubview(column)
        NSLayoutConstraint.activate([
            column.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 5),
            column.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -5),
            column.topAnchor.constraint(equalTo: topAnchor, constant: 6),
            column.bottomAnchor.constraint(equalTo: safeAreaLayoutGuide.bottomAnchor, constant: -6)
        ])
    }

    private func rebuild() {
        column.arrangedSubviews.forEach {
            column.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }

        column.addArrangedSubview(equalRow(Array("1234567890").map(String.init) + ["⌫"], kind: .number) { [weak self] key in
            if key == "⌫" { self?.action(.delete) } else { self?.action(.insert(key)) }
        })

        if symbols {
            column.addArrangedSubview(equalRow(["@", "#", "$", "%", "&", "*", "(", ")", "-", "+"], kind: .key) { [weak self] in self?.action(.insert($0)) })
            column.addArrangedSubview(insetRow(["[", "]", "{", "}", "<", ">", "/", "\\", "|"], inset: 14) { [weak self] in self?.action(.insert($0)) })
            column.addArrangedSubview(equalRow(["_", "=", ":", ";", "!", "?", "~", "`"], kind: .key) { [weak self] in self?.action(.insert($0)) })
        } else {
            column.addArrangedSubview(equalRow(Array("qwertyuiop").map(String.init), kind: .key) { [weak self] key in self?.insertLetter(key) })
            column.addArrangedSubview(insetRow(Array("asdfghjkl").map(String.init), inset: 14) { [weak self] key in self?.insertLetter(key) })
            let shift = keyButton(title: shifted ? "⇧" : "⇧", kind: .modifier, label: "Shift") { [weak self] in
                guard let self else { return }
                shifted.toggle()
                rebuild()
            }
            let letters = Array("zxcvbnm").map(String.init).map { key in
                keyButton(title: shifted ? key.uppercased() : key, kind: .key) { [weak self] in self?.insertLetter(key) }
            }
            column.addArrangedSubview(variableRow([shift] + letters, weights: [1.25] + Array(repeating: 1, count: letters.count)))
        }

        let mode = keyButton(title: symbols ? "abc" : "#+=", kind: .modifier, label: symbols ? "Letters" : "Symbols") { [weak self] in
            guard let self else { return }
            symbols.toggle()
            shifted = false
            rebuild()
        }
        let comma = keyButton(title: ",", kind: .key) { [weak self] in self?.action(.insert(",")) }
        let space = keyButton(title: "space", kind: .key, label: "Space") { [weak self] in self?.action(.insert(" ")) }
        let period = keyButton(title: ".", kind: .key) { [weak self] in self?.action(.insert(".")) }
        let quote = keyButton(title: "'", kind: .key) { [weak self] in self?.action(.insert("'")) }
        column.addArrangedSubview(variableRow([mode, comma, space, period, quote], weights: [1.15, 0.8, 3.3, 0.8, 0.8]))

        let system = keyButton(title: "🌐", kind: .modifier, label: "System Keyboard") { [weak self] in self?.action(.systemKeyboard) }
        let dictate = keyButton(title: "◉", kind: .modifier, label: "Dictate") { [weak self] in self?.action(.dictate) }
        let newline = keyButton(title: "↵", kind: .modifier, label: "New Line") { [weak self] in self?.action(.returnKey) }
        let hide = keyButton(title: "⌄", kind: .modifier, label: "Hide Keyboard") { [weak self] in self?.action(.hide) }
        let send = keyButton(
            title: composerBusy ? "stop" : "send",
            kind: .send,
            label: composerBusy ? "Stop Reply" : "Send Reply"
        ) { [weak self] in self?.action(.send) }
        send.isEnabled = composerBusy || !composerSubmitting
        column.addArrangedSubview(variableRow([system, dictate, newline, hide, send], weights: [1, 1, 1, 1, 2.2]))
    }

    private func insertLetter(_ letter: String) {
        action(.insert(shifted ? letter.uppercased() : letter))
        if shifted {
            shifted = false
            rebuild()
        }
    }

    private func equalRow(
        _ titles: [String],
        kind: ButtonKind,
        onPress: @escaping (String) -> Void
    ) -> UIView {
        let stack = rowStack()
        stack.distribution = .fillEqually
        for title in titles {
            let buttonKind: ButtonKind = title == "⌫" ? .delete : kind
            let label = title == "⌫" ? "Delete" : nil
            stack.addArrangedSubview(keyButton(title: title, kind: buttonKind, label: label) { onPress(title) })
        }
        return stack
    }

    private func insetRow(
        _ titles: [String],
        inset: CGFloat,
        onPress: @escaping (String) -> Void
    ) -> UIView {
        let container = UIView()
        let stack = rowStack()
        stack.distribution = .fillEqually
        stack.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: inset),
            stack.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -inset),
            stack.topAnchor.constraint(equalTo: container.topAnchor),
            stack.bottomAnchor.constraint(equalTo: container.bottomAnchor)
        ])
        for title in titles {
            stack.addArrangedSubview(keyButton(title: title, kind: .key) { onPress(title) })
        }
        return container
    }

    private func variableRow(_ buttons: [UIButton], weights: [CGFloat]) -> UIView {
        let stack = rowStack()
        for button in buttons { stack.addArrangedSubview(button) }
        guard let first = buttons.first, let firstWeight = weights.first else { return stack }
        for (button, weight) in zip(buttons.dropFirst(), weights.dropFirst()) {
            button.widthAnchor.constraint(equalTo: first.widthAnchor, multiplier: weight / firstWeight).isActive = true
        }
        return stack
    }

    private func rowStack() -> UIStackView {
        let stack = UIStackView()
        stack.axis = .horizontal
        stack.spacing = 4
        stack.alignment = .fill
        return stack
    }

    private func keyButton(
        title: String,
        kind: ButtonKind,
        label: String? = nil,
        onPress: @escaping () -> Void
    ) -> UIButton {
        let button = UIButton(type: .custom)
        var config = UIButton.Configuration.plain()
        config.title = title
        config.contentInsets = NSDirectionalEdgeInsets(top: 0, leading: 2, bottom: 0, trailing: 2)
        config.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { incoming in
            var outgoing = incoming
            outgoing.font = .monospacedSystemFont(ofSize: title.count > 2 ? 13 : 17, weight: kind == .send ? .bold : .medium)
            return outgoing
        }
        button.configuration = config
        button.layer.cornerRadius = 5
        button.layer.borderWidth = 1
        button.layer.masksToBounds = true
        button.accessibilityLabel = label ?? title
        button.addAction(UIAction { _ in onPress() }, for: .primaryActionTriggered)
        apply(kind: kind, to: button, pressed: false)
        button.configurationUpdateHandler = { [weak self] button in
            self?.apply(kind: kind, to: button, pressed: button.isHighlighted)
        }
        return button
    }

    private func apply(kind: ButtonKind, to button: UIButton, pressed: Bool) {
        let paper = UIColor(red: 0.957, green: 0.918, blue: 0.831, alpha: 1)
        let rust = UIColor(red: 0.769, green: 0.361, blue: 0.227, alpha: 1)
        let key = UIColor(red: 0.161, green: 0.141, blue: 0.118, alpha: 1)
        let number = UIColor(red: 0.247, green: 0.224, blue: 0.188, alpha: 1)
        let modifier = UIColor(red: 0.118, green: 0.102, blue: 0.086, alpha: 1)
        let normalBackground: UIColor
        switch kind {
        case .number: normalBackground = number
        case .modifier: normalBackground = modifier
        case .delete, .send: normalBackground = rust
        case .key: normalBackground = key
        }
        var config = button.configuration
        config?.baseForegroundColor = pressed ? normalBackground : paper
        config?.background.backgroundColor = pressed ? paper : normalBackground
        button.configuration = config
        button.layer.borderColor = paper.withAlphaComponent(pressed ? 0.95 : 0.34).cgColor
        button.transform = pressed ? CGAffineTransform(translationX: 0, y: 2) : .identity
    }
}
