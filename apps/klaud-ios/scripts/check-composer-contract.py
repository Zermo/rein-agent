#!/usr/bin/env python3
"""Execute the production bridge/contract on macOS; no UIKit/device/model claim."""
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
source = (root / "ReinKlaud/ReinKlaudApp.swift").read_text()
bridge = source[source.index("@MainActor\nfinal class KlaudBridge:"):source.index("\nfinal class KlaudKeyFeel")]
editor_source = (root / "ReinKlaud/Native/KlaudNativeComposer.swift").read_text()
update = editor_source[editor_source.index("    func updateUIView("):editor_source.index("    final class Coordinator:")]
did_change = editor_source[editor_source.index("        func textViewDidChange("):editor_source.index("        func textViewDidChangeSelection(")]
should_change = editor_source[editor_source.index("        func textView(\n"):editor_source.index("        func handle(")]
editor_check = """
@MainActor final class EditorCoordinator {
    var bridge: KlaudBridge
    var lastDismissRequest = 0
    var lastShowRequest = 0
    init(_ bridge: KlaudBridge) { self.bridge = bridge }
""" + did_change + should_change + """
}
@MainActor struct Context { let coordinator: EditorCoordinator }
@MainActor struct EditorUpdate { let bridge: KlaudBridge
""" + update + "\n}\n"
prefix = r'''
import Foundation
import Combine
import WebKit
let klaudOrigin = URL(string: "https://openbot.zermo.org/")!
struct ShareItem: Identifiable { let id = UUID(); let url: URL }
final class KlaudKeyFeel { func tap(_ key: String) {} }
final class KlaudDictation {
    var onResult: ((String, Bool, String?) -> Void)?
    func start() {} ; func stop() {}
}
final class ReinSoundEngine { enum Cue { case send, key }; func play(_ cue: Cue) {} }
final class KlaudLocalInference {
    func refreshAvailability() {}
    func markDraftChanged() {}
    var refineCalls = 0
    func refine(_ text: String, completion: @escaping (Result<String, Error>) -> Void) { refineCalls += 1 }
}
class UITextView {
    var text = ""
    var isEditable = true
    var alpha = 1.0
    var selectedRange = NSRange(location: 0, length: 0)
    var markedTextRange: NSRange?
    func unmarkText() { markedTextRange = nil }
    @discardableResult func resignFirstResponder() -> Bool { true }
    @discardableResult func becomeFirstResponder() -> Bool { true }
}
final class KlaudComposerTextView: UITextView {
    var isApplyingProgrammaticUpdate = false
    func setComposerState(busy: Bool, submitting: Bool) {}
    func performProgrammaticUpdate<T>(_ action: () -> T) -> T { action() }
    func replaceText(in range: NSRange, with value: String) -> NSRange {
        text = (text as NSString).replacingCharacters(in: range, with: value)
        return NSRange(location: range.location, length: (value as NSString).length)
    }
}
'''
checks = r'''
@main struct BridgeCheck {
    @MainActor static func main() {
        func check(_ value: Bool, _ name: String) {
            if !value { print("FAIL: " + name); exit(1) }
        }
        let a = "klaud-bot-1234abcd", b = "klaud-bot-5678abcd"
        var nonce = "document-1"
        func message(_ action: String, _ bot: String = "klaud-bot-1234abcd") -> [String: Any] {
            ["protocolVersion": KlaudComposerContract.version, "documentNonce": nonce,
             "action": action, "botId": bot, "sessionId": bot + "-session"]
        }
        func state(_ bot: String, _ text: String, edits: Int = 0) -> [String: Any] {
            var body = message("state", bot)
            body.merge(["visible": true, "enabled": true, "busy": false, "draft": text, "webRevision": edits]) { _, new in new }
            return body
        }
        let bridge = KlaudBridge()
        var commands: [[String: Any]] = []
        bridge.commandSink = { commands.append($0) }
        func hello() {
            var body = message("hello"); body["requestId"] = "hello-1"
            bridge.receiveComposerMessage(body)
            check(commands.last?["action"] as? String == "ready", "hello acknowledges a committed document before activating either editor")
            check(commands.last?["documentNonce"] as? String == nonce, "outbound command is bound to its document")
        }
        hello()
        check(!bridge.composerVisible && bridge.composerText.isEmpty, "hello cannot adopt a draft or expose another editor")
        bridge.receiveComposerMessage(state(a, "first", edits: 1))
        bridge.setComposerDraft("native A")
        bridge.receiveComposerMessage(state(b, "web B", edits: 1))
        check(bridge.composerText == "web B", "each scope receives its own explicitly edited fallback draft")
        bridge.setComposerDraft("native B")
        bridge.receiveComposerMessage(state(a, "stale echo", edits: 1))
        check(bridge.composerText == "native A", "native echoes cannot erase saved native text")
        bridge.resetComposerTransport(); nonce = "document-2"; hello()
        bridge.receiveComposerMessage(state(a, "", edits: 1))
        check(bridge.composerText.isEmpty, "explicit fallback deletion wins over a cached native draft")
        bridge.setComposerDraft("retain until accepted")
        bridge.submitComposer()
        let send = commands.last!
        var pendingState = state(a, "", edits: 1)
        pendingState["busy"] = true; pendingState["enabled"] = false
        bridge.receiveComposerMessage(pendingState)
        check(bridge.composerSubmitting && bridge.composerText == "retain until accepted", "busy is not delivery acceptance")
        var ack = send; ack["action"] = "sendAck"; ack["accepted"] = false
        bridge.receiveComposerMessage(ack)
        check(!bridge.composerSubmitting && bridge.composerText == "retain until accepted", "rejected send retains the draft and releases its latch")
        bridge.receiveComposerMessage(state(a, "", edits: 1))
        bridge.submitComposer()
        let currentSend = commands.last!
        ack = currentSend; ack["action"] = "sendAck"; ack["accepted"] = true
        ack["revision"] = Double(currentSend["revision"] as! Int) + 0.25
        bridge.receiveComposerMessage(ack)
        check(bridge.composerSubmitting, "fractional acknowledgements cannot match an integer revision")
        ack = currentSend; ack["action"] = "sendAck"; ack["accepted"] = 1
        bridge.receiveComposerMessage(ack)
        check(bridge.composerSubmitting, "numeric truthy acknowledgement is not a boolean")
        bridge.setComposerDraft("newer typing")
        ack = currentSend; ack["action"] = "sendAck"; ack["accepted"] = true
        bridge.receiveComposerMessage(ack)
        check(!bridge.composerSubmitting && bridge.composerText == "newer typing", "late acceptance cannot erase newer native typing")
        bridge.setComposerDraft("  accepted draft  ")
        bridge.submitComposer()
        ack = commands.last!; ack["action"] = "sendAck"; ack["accepted"] = true
        bridge.receiveComposerMessage(ack)
        check(bridge.composerText.isEmpty, "accepted original snapshot clears even when wire text was trimmed")
        bridge.setComposerDraft("newer typing")
        for field in ["enabled", "busy", "visible", "webRevision", "protocolVersion", "botId", "sessionId"] {
            var malformed = state(b, "must not replace", edits: 2)
            switch field {
            case "enabled", "busy", "visible": malformed[field] = NSNumber(value: 1)
            case "webRevision": malformed[field] = true
            case "protocolVersion": malformed[field] = Double(KlaudComposerContract.version) + 0.5
            default: malformed[field] = "../other"
            }
            bridge.receiveComposerMessage(malformed)
            check(bridge.composerText == "newer typing", "malformed \(field) mutated the composer")
        }
        var hidden = message("state"); hidden["visible"] = false
        bridge.receiveComposerMessage(hidden)
        check(!bridge.composerVisible, "absent scope hides native")
        bridge.receiveComposerMessage(state(a, "", edits: 1))
        check(bridge.composerVisible && bridge.composerText == "newer typing", "scope removal does not forget document readiness")
        bridge.submitComposer(); bridge.resetComposerTransport(); nonce = "document-3"; hello()
        bridge.receiveComposerMessage(state(a, ""))
        check(bridge.composerSubmitting && bridge.composerDeliveryUncertain, "navigation preserves unknown delivery without automatic replay")
        var gate = KlaudDocumentBridgeGate()
        gate.beginNavigation(); let epoch = gate.epoch
        check(gate.receiveComposer(["documentNonce": "old"], capturedEpoch: epoch) == nil, "precommit messages are not authorized")
        _ = gate.commit(nonce: nonce, capturedEpoch: epoch)
        check(!gate.accepts(["documentNonce": "old"], capturedEpoch: epoch), "outgoing document cannot borrow the new epoch")
        check(gate.accepts(["documentNonce": nonce], capturedEpoch: epoch), "committed document is accepted")
        check(KlaudComposerContract.trusts(scheme: "https", host: "openbot.zermo.org", port: 443, isMainFrame: true), "trusted HTTPS main frame")
        check(!KlaudComposerContract.trusts(scheme: "http", host: "openbot.zermo.org", port: 80, isMainFrame: true), "HTTP denied")
        check(!KlaudComposerContract.trusts(scheme: "https", host: "openbot.zermo.org", port: 443, isMainFrame: false), "subframes denied")
        let editor = KlaudComposerTextView()
        editor.text = "in-progress composition"
        editor.markedTextRange = NSRange(location: 0, length: 3)
        let updater = EditorUpdate(bridge: bridge)
        let context = Context(coordinator: EditorCoordinator(bridge))
        updater.updateUIView(editor, context: context)
        check(editor.text == "in-progress composition", "same-scope external replacement must defer while marked text exists")
        editor.unmarkText()
        updater.updateUIView(editor, context: context)
        check(editor.text == bridge.composerText, "deferred replacement applies after marked text finishes")
        editor.markedTextRange = NSRange(location: 0, length: 3)
        bridge.receiveComposerMessage(state(b, "scope B", edits: 2))
        check(editor.markedTextRange == nil, "scope switch explicitly ends old composition")
        updater.updateUIView(editor, context: context)
        check(editor.text == "scope B", "new scope cannot inherit old composition")
        let imeBridge = KlaudBridge()
        var imeCommands: [[String: Any]] = []
        imeBridge.commandSink = { imeCommands.append($0) }
        var imeHello = message("hello"); imeHello["requestId"] = "hello-ime"
        imeBridge.receiveComposerMessage(imeHello)
        let previous = String(repeating: "a", count: KlaudComposerContract.maximumUTF8Count - 1)
        imeBridge.receiveComposerMessage(state(a, previous, edits: 1))
        let imeView = KlaudComposerTextView()
        imeView.text = previous
        imeBridge.composerTextView = imeView
        let imeDelegate = EditorCoordinator(imeBridge)
        let lastCharacter = NSRange(location: (previous as NSString).length - 1, length: 1)
        check(!imeDelegate.textView(imeView, shouldChangeTextIn: lastCharacter, replacementText: "🙂"), "ordinary oversized input is refused")
        imeView.markedTextRange = lastCharacter
        check(imeDelegate.textView(imeView, shouldChangeTextIn: lastCharacter, replacementText: "🙂"), "IME composition remains editable")
        imeView.text = (previous as NSString).replacingCharacters(in: lastCharacter, with: "🙂")
        let overflow = imeView.text
        imeDelegate.textViewDidChange(imeView)
        imeView.unmarkText()
        imeDelegate.textViewDidChange(imeView)
        imeBridge.submitComposer()
        check(!imeCommands.contains { $0["action"] as? String == "send" }, "committed IME overflow must not send the older draft")
        check(imeBridge.composerText == overflow, "oversized local composition stays synchronized for correction")
        let imeUpdater = EditorUpdate(bridge: imeBridge)
        let imeContext = Context(coordinator: imeDelegate)
        imeUpdater.updateUIView(imeView, context: imeContext)
        check(imeView.text == overflow, "rendering must not erase committed overflow")
        imeBridge.refineDraftOnDevice()
        check(imeBridge.localInference.refineCalls == 0, "invalid editor text cannot start refinement from an older snapshot")
        imeBridge.receiveComposerMessage(state(b, "other", edits: 1))
        imeUpdater.updateUIView(imeView, context: imeContext)
        imeBridge.receiveComposerMessage(state(a, previous, edits: 1))
        imeUpdater.updateUIView(imeView, context: imeContext)
        check(imeView.text == overflow, "scope return preserves the local oversized draft")
        check(imeCommands.allSatisfy { (($0["text"] as? String)?.utf8.count ?? 0) <= KlaudComposerContract.maximumUTF8Count }, "oversized local text never crosses the bridge")
        let firstCharacter = NSRange(location: 0, length: 1)
        while imeView.text.utf8.count > KlaudComposerContract.maximumUTF8Count {
            check(imeDelegate.textView(imeView, shouldChangeTextIn: firstCharacter, replacementText: ""), "over-limit text permits incremental correction")
            imeView.text = (imeView.text as NSString).replacingCharacters(in: firstCharacter, with: "")
            imeDelegate.textViewDidChange(imeView)
        }
        imeView.markedTextRange = firstCharacter
        imeBridge.submitComposer()
        check(!imeCommands.contains { $0["action"] as? String == "send" }, "uncommitted in-limit composition cannot submit")
        imeView.unmarkText()
        imeBridge.submitComposer()
        let imeSend = imeCommands.last { $0["action"] as? String == "send" }
        check(imeSend?["text"] as? String == imeView.text, "corrected committed text sends exactly")
        var imeAck = imeSend!; imeAck["action"] = "sendAck"; imeAck["accepted"] = true
        imeBridge.receiveComposerMessage(imeAck)
        imeBridge.setComposerDraft("previous valid snapshot")
        imeView.text = "new committed text"
        let sendsBefore = imeCommands.filter { $0["action"] as? String == "send" }.count
        imeBridge.submitComposer()
        check(imeCommands.filter { $0["action"] as? String == "send" }.count == sendsBefore, "unsynchronized editor cannot submit the previous snapshot")
        imeDelegate.textViewDidChange(imeView)
        imeBridge.submitComposer()
        check(imeCommands.last?["text"] as? String == "new committed text", "synchronized editor can submit again")
        for (original, replacement) in [("\u{00E9}", "e\u{0301}"), ("\u{AC00}", "\u{1100}\u{1161}"), ("e\u{0301}\u{0323}", "e\u{0323}\u{0301}")] {
            check(original == replacement && !original.utf8.elementsEqual(replacement.utf8), "canonical fixture differs in bytes")
            let unicodeBridge = KlaudBridge()
            var unicodeCommands: [[String: Any]] = []
            unicodeBridge.commandSink = { unicodeCommands.append($0) }
            unicodeBridge.receiveComposerMessage(imeHello)
            let prior = String(repeating: "a", count: KlaudComposerContract.maximumUTF8Count - original.utf8.count) + original
            unicodeBridge.receiveComposerMessage(state(a, prior, edits: 1))
            let view = KlaudComposerTextView()
            view.text = prior
            unicodeBridge.composerTextView = view
            let delegate = EditorCoordinator(unicodeBridge)
            let range = NSRange(location: (prior as NSString).length - (original as NSString).length, length: (original as NSString).length)
            view.markedTextRange = range
            check(delegate.textView(view, shouldChangeTextIn: range, replacementText: replacement), "canonical IME edit remains editable")
            view.text = (prior as NSString).replacingCharacters(in: range, with: replacement)
            let actual = view.text
            view.unmarkText()
            unicodeBridge.submitComposer()
            unicodeBridge.refineDraftOnDevice()
            check(!unicodeCommands.contains { $0["action"] as? String == "send" } && unicodeBridge.localInference.refineCalls == 0, "byte-different canonical editor cannot send/refine stale text before didChange")
            let oldRevision = unicodeBridge.composerRevision
            delegate.textViewDidChange(view)
            check(unicodeBridge.composerText.utf8.elementsEqual(actual.utf8) && unicodeBridge.composerRevision > oldRevision, "canonical edit retains exact bytes and advances revision")
            let exceedsLimit = actual.utf8.count > KlaudComposerContract.maximumUTF8Count
            check(unicodeBridge.composerWithinLimit == !exceedsLimit, "canonical edit reports its actual byte limit")
            if exceedsLimit {
                unicodeBridge.submitComposer(); unicodeBridge.refineDraftOnDevice()
                check(!unicodeCommands.contains { $0["action"] as? String == "send" } && unicodeBridge.localInference.refineCalls == 0, "canonical overflow cannot submit/refine after didChange")
            }
            let updater = EditorUpdate(bridge: unicodeBridge)
            let context = Context(coordinator: delegate)
            updater.updateUIView(view, context: context)
            check(view.text.utf8.elementsEqual(actual.utf8), "rendering preserves canonical edit bytes")
            unicodeBridge.receiveComposerMessage(state(b, "other", edits: 1))
            updater.updateUIView(view, context: context)
            unicodeBridge.receiveComposerMessage(state(a, prior, edits: 1))
            updater.updateUIView(view, context: context)
            check(view.text.utf8.elementsEqual(actual.utf8), "scope return preserves canonical edit bytes")
            check(unicodeCommands.allSatisfy { (($0["text"] as? String)?.utf8.count ?? 0) <= KlaudComposerContract.maximumUTF8Count }, "canonical overflow never crosses the bridge")
            while view.text.utf8.count > KlaudComposerContract.maximumUTF8Count {
                check(delegate.textView(view, shouldChangeTextIn: firstCharacter, replacementText: ""), "canonical overflow allows incremental correction")
                view.text = (view.text as NSString).replacingCharacters(in: firstCharacter, with: "")
                delegate.textViewDidChange(view)
            }
            unicodeBridge.submitComposer()
            check((unicodeCommands.last?["text"] as? String)?.utf8.elementsEqual(view.text.utf8) == true, "corrected canonical text sends byte-exactly")
            var accepted = unicodeCommands.last!; accepted["action"] = "sendAck"; accepted["accepted"] = true
            unicodeBridge.receiveComposerMessage(accepted)
            // External/native updates must also replace canonically equal but byte-different editor text.
            unicodeBridge.setComposerDraft(original)
            updater.updateUIView(view, context: context)
            let snapshot = unicodeBridge.currentDraftSnapshot()
            unicodeBridge.submitComposer()
            var oldAck = unicodeCommands.last!; oldAck["action"] = "sendAck"; oldAck["accepted"] = true
            view.text = replacement
            delegate.textViewDidChange(view)
            unicodeBridge.receiveComposerMessage(oldAck)
            unicodeBridge.applyRefinedDraft("stale result", from: snapshot)
            check(unicodeBridge.composerText.utf8.elementsEqual(replacement.utf8), "late acknowledgement/refinement preserves canonical edits")
            unicodeBridge.setComposerDraft(original)
            updater.updateUIView(view, context: context)
            check(view.text.utf8.elementsEqual(original.utf8), "programmatic synchronization is byte-exact")
            let beforeEcho = unicodeCommands.count
            unicodeBridge.receiveComposerMessage(state(a, replacement, edits: 1))
            check(unicodeCommands.count == beforeEcho + 1 && (unicodeCommands.last?["text"] as? String)?.utf8.elementsEqual(original.utf8) == true, "canonical stale web echo reconciles to native bytes")
        }
        print("PASS: production bridge handoff, acceptance, strict envelopes, document gate, IME overflow and byte-exact Unicode synchronization (not UIKit/device execution)")
    }
}
'''
with tempfile.TemporaryDirectory(prefix="klaud-composer-") as directory:
    directory = Path(directory)
    swift = directory / "BridgeCheck.swift"
    swift.write_text(prefix + bridge + editor_check + checks)
    subprocess.run(["xcrun", "swiftc", "-swift-version", "5", "-parse-as-library", str(swift), str(root / "ReinKlaud/Native/KlaudComposerContract.swift"), "-o", str(directory / "check")], check=True)
    raise SystemExit(subprocess.run([str(directory / "check")]).returncode)
