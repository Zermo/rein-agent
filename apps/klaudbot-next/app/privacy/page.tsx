import type { Metadata } from "next";

export const metadata: Metadata = { title: "Privacy · klaʊdbot" };

export default function PrivacyPage() {
  return (
    <main style={{ maxWidth: 640, margin: "0 auto", padding: "32px 20px 64px", color: "#f4ead4", background: "#12100e", minHeight: "100dvh", fontFamily: "ui-monospace, Menlo, monospace", fontSize: 14, lineHeight: 1.55 }}>
      <p style={{ letterSpacing: ".12em", textTransform: "uppercase", fontSize: 11, color: "#c45c3a" }}>klaʊdbot</p>
      <h1 style={{ fontFamily: "Georgia, serif", fontSize: 28 }}>Privacy</h1>
      <p>klaʊdbot is a field console. The iOS app is a signed window onto the console you already host. Zermo does not sell accounts, ads, or conversation data.</p>
      <h2>What the app touches</h2>
      <ul>
        <li>Sign-in goes through your Authelia gate at auth.zermo.org.</li>
        <li>Chat, bots, Path, and Computer traffic stay on your klaʊdbot host (openbot.zermo.org → your Rein/klaud service).</li>
        <li>The optional dictation key uses the microphone and Apple Speech Recognition on device/Apple servers so the keyboard can type. Audio is not stored in the app.</li>
        <li>Local preferences (sound, pane widths) use on-device storage. No tracking domains.</li>
      </ul>
      <h2>What we do not do</h2>
      <ul>
        <li>No advertising identifier, no analytics SDK, no third-party ads.</li>
        <li>No sale of personal information.</li>
        <li>The app does not browse the open web; off-site links leave the shell.</li>
      </ul>
      <p>Questions: use the support page. This notice is for the klaʊdbot iOS client and the public console it loads.</p>
    </main>
  );
}
