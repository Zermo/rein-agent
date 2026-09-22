import type { Metadata } from "next";

export const metadata: Metadata = { title: "Support · klaʊdbot" };

export default function SupportPage() {
  return (
    <main style={{ maxWidth: 640, margin: "0 auto", padding: "32px 20px 64px", color: "#f4ead4", background: "#12100e", minHeight: "100dvh", fontFamily: "ui-monospace, Menlo, monospace", fontSize: 14, lineHeight: 1.55 }}>
      <p style={{ letterSpacing: ".12em", textTransform: "uppercase", fontSize: 11, color: "#c45c3a" }}>klaʊdbot</p>
      <h1 style={{ fontFamily: "Georgia, serif", fontSize: 28 }}>Support</h1>
      <p>klaʊdbot is one product: a field console for agents you host. The iPhone/iPad app opens the live console. It is not a separate chatbot.</p>
      <h2>Sign in</h2>
      <p>First run: request a zermo.org account in the console, sign in at auth.zermo.org, then wait until the Authelia permit is minted onto reinklaud.zermo.org. Existing house users can skip the request and sign in.</p>
      <h2>If something is stuck</h2>
      <ul>
        <li>Force-quit and reopen the app to reload the live console.</li>
        <li>Install the current TestFlight build if native keys (mic, haptics) misbehave.</li>
        <li>Confirm the host is up: public /health should remain the klaud health JSON.</li>
      </ul>
      <p>
        Issues: <a href="https://github.com/tullman17-coder/klaudbot/issues" style={{ color: "#c45c3a" }}>github.com/tullman17-coder/klaudbot</a>
      </p>
      <p>
        Console: <a href="https://reinklaud.zermo.org/" style={{ color: "#c45c3a" }}>reinklaud.zermo.org</a>
      </p>
    </main>
  );
}
