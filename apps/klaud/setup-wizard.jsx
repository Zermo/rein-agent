import React, { useEffect, useRef, useState } from "react";
import { AvatarPicker, BotAvatar } from "./avatars.jsx";

const labels = ["Bring your work", "Connect a model", "Make it yours", "Meet your bot"];
const defaults = { q1: "e", q2: "e", q3: "b", q4: "a", q5: "a", q6: "a", q7: "a" };
const subscriptions = ["codex", "copilot", "grok"];
function usableConfiguration(config) {
  if (!config?.model || typeof config.model !== "string") return false;
  if (config.auth === "cli") return subscriptions.includes(config.provider) && config.baseUrl === `cli://${config.provider}`;
  try { const url = new URL(config.baseUrl); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
}
const describeError = error => String(error?.message || "That step could not finish.").replace(/^Error invoking remote method '[^']+': Error: /, "");

export function SetupWizard({ api, inspection, connection, bots = [], selectedBotId, onPrepared, onFinish, onCancel }) {
  const [step, setStep] = useState(inspection.prepared || inspection.completed ? 1 : 0);
  const [choice, setChoice] = useState(inspection.existing.found ? "migrate" : "fresh");
  const [working, setWorking] = useState(false), [error, setError] = useState("");
  const [setup, setSetup] = useState(null), [accounts, setAccounts] = useState(null);
  const [provider, setProvider] = useState("lmstudio"), [baseUrl, setBaseUrl] = useState("http://127.0.0.1:1234/v1"), [model, setModel] = useState(""), [key, setKey] = useState("");
  const [keepConnection, setKeepConnection] = useState(false), [check, setCheck] = useState(null), [servers, setServers] = useState([]), [network, setNetwork] = useState(false);
  const [login, setLogin] = useState(null);
  const [hardware, setHardware] = useState(null);
  const [answers, setAnswers] = useState(defaults), [keepProfile, setKeepProfile] = useState(false), [enablePack, setEnablePack] = useState(false);
  const [maxTurns, setMaxTurns] = useState(300), [maxIterations, setMaxIterations] = useState(25);
  const [name, setName] = useState("Pip"), [avatar, setAvatar] = useState("aviator"), [existingBot, setExistingBot] = useState(selectedBotId || bots[0]?.id || "");
  const [starter, setStarter] = useState("Help me make one small thing in my day easier.");
  const created = useRef(null), heading = useRef(null), loginRef = useRef(null);
  loginRef.current = login;
  async function run(action) {
    setWorking(true); setError("");
    try { return await action(); } catch (error) { setError(describeError(error)); return undefined; }
    finally { setWorking(false); }
  }
  function acceptAccounts(value) {
    setAccounts(previous => ({ ...previous, ...value }));
    const configured = value?.configured;
    if (usableConfiguration(configured)) {
      setProvider(configured.provider || "custom"); setModel(configured.model);
      setBaseUrl(configured.baseUrl || ""); setKeepConnection(true);
    }
  }
  async function load() {
    const [configuration, accountState] = await Promise.all([api.request("getSetup"), api.request("getAccounts")]);
    setSetup(configuration); acceptAccounts(accountState);
    setMaxTurns(configuration.budgets.maxTurns); setMaxIterations(configuration.budgets.maxIterations);
    if (configuration.profile) { setAnswers(configuration.profile.answers); setKeepProfile(true); }
  }
  useEffect(() => { if (connection) void run(load); }, [connection]);
  useEffect(() => { heading.current?.focus(); }, [step]);
  useEffect(() => { if (!existingBot && bots.length) setExistingBot(bots[0].id); }, [bots]);
  useEffect(() => {
    if (!login || !["starting", "waiting"].includes(login.status)) return;
    let active = true, timer;
    const poll = async () => {
      try { const next = await api.request("getLogin", { id: login.id }); if (active) setLogin(next); }
      catch (error) { if (active) { setError(describeError(error)); setLogin(null); } }
      if (active) timer = setTimeout(poll, 2000);
    };
    timer = setTimeout(poll, 1500);
    return () => { active = false; clearTimeout(timer); };
  }, [login?.id, login?.status]);
  useEffect(() => () => {
    const pending = loginRef.current;
    if (pending && ["starting", "waiting"].includes(pending.status)) void api.request("cancelLogin", { id: pending.id }).catch(() => {});
  }, []);
  async function prepare() {
    await run(async () => { const status = await api.onboardingPrepare({ choice: inspection.choice || choice }); await onPrepared(status); setStep(1); });
  }
  async function saveConnection() {
    if (loginPending) return;
    if (keepConnection) { setStep(2); return; }
    await run(async () => {
      const payload = { provider, model: model.trim(), ...(!subscriptions.includes(provider) ? { baseUrl: baseUrl.trim(), ...(key.trim() ? { apiKey: key.trim() } : {}) } : {}) };
      const result = await api.request("saveProvider", payload);
      acceptAccounts(result); setKey("");
      if (subscriptions.includes(provider)) setCheck({ message: "Subscription connection saved. Check sign-in status, then continue." });
      else setCheck(await api.request("probeModel"));
    });
  }
  async function savePreferences() {
    await run(async () => {
      const focusPacks = { a: "ship", b: "ops", c: "study", d: "studio", e: "everyday", f: "everyday" };
      const result = await api.request("saveSetup", { budgets: { maxTurns: Number(maxTurns), maxIterations: Number(maxIterations) },
        ...(!keepProfile ? { answers, enabledPack: enablePack ? focusPacks[answers.q2] : null, fingerprint: setup.fingerprint } : {}) });
      setSetup(result); setStep(3);
    });
  }
  async function finish() {
    await run(async () => {
      let selected = bots.find(bot => bot.id === existingBot) ?? created.current;
      if (!selected) { selected = await api.request("createBot", { name: name.trim(), avatar }); created.current = selected; }
      await onFinish(selected, inspection.completed ? undefined : starter);
    });
  }
  const selectedBot = bots.find(bot => bot.id === existingBot);
  const loginPending = !!login && ["starting", "waiting"].includes(login.status);
  const modelConfigured = usableConfiguration(accounts?.configured);
  const accountStatus = accounts?.subscriptions?.find(item => item.provider === provider);
  const focusPacks = { a: "ship", b: "ops", c: "study", d: "studio", e: "everyday", f: "everyday" };
  const pack = setup?.packs?.[focusPacks[answers.q2]];
  return <main className="setup-workbench">
    <section className="setup-companion" aria-label="Your bot preview">
      <p className="eyebrow"><span className="phonetic-name">klaʊdbot</span> / first meeting</p>
      <BotAvatar avatar={selectedBot ? selectedBot.avatar : avatar} botId={selectedBot?.id} state="ready" size={220}/>
      <h1>{step < 3 ? "A little help.\nYour way." : selectedBot?.name || name || "Your new bot"}</h1>
      <p>{step === 0 ? "Your work has a past. Your bot can bring it along." : step === 1 ? "Choose where your bot thinks. Your own machine, your network, or a connected cloud account." : step === 2 ? "Small steps or the full picture. Tell your bot what helps you get going." : "A familiar face. Well, almost. Pick the hat that feels right."}</p>
      <ol className="setup-index">{labels.map((label, index) => <li key={label} aria-current={step === index ? "step" : undefined}><span>{index < step ? "✓" : String(index + 1).padStart(2, "0")}</span>{label}</li>)}</ol>
      <p className="setup-footnote">The eyebrows show activity and requests for your attention. They follow what your bot is doing.</p>
    </section>
    <section className="setup-panel" aria-busy={working}>
      <p className="eyebrow">{String(step + 1).padStart(2, "0")} / {labels.length} · Assisted setup</p>
      <h2 ref={heading} tabIndex={-1}>{["Where should we begin?", "Give your bot a connection.", "How do you like to work?", "Meet your first teammate."][step]}</h2>
      {error && <div className="setup-error" role="alert">{error}<button type="button" disabled={working} onClick={() => void run(load)}>Reload setup</button></div>}
      {step === 0 && <>
        {inspection.existing.found && <div className="setup-found" role="status"><strong>We found your Rein installation.</strong><span>{inspection.existing.sessionCount} saved sessions · {inspection.existing.botCount} bots{inspection.existing.profileFound ? " · work-style profile" : ""}{inspection.existing.configured ? " · model configured" : ""}</span></div>}
        <fieldset className="setup-options"><legend>Your starting point</legend>
          {inspection.existing.found && <label className="setup-option"><input type="radio" name="starting-point" checked={choice === "migrate"} onChange={() => setChoice("migrate")}/><span><strong>Bring my Rein with me</strong><small>Copy settings, notes, and saved conversations into klaʊdbot. Your original Rein installation stays available.</small></span></label>}
          <label className="setup-option"><input type="radio" name="starting-point" checked={choice === "fresh"} onChange={() => setChoice("fresh")}/><span><strong>Start fresh</strong><small>A separate bot space with its own model connection and preferences. Your existing work stays where it is.</small></span></label>
        </fieldset>
        <button className="primary" disabled={working} onClick={prepare}>{working ? "Preparing your space…" : choice === "migrate" ? "Bring my work over" : "Create my bot space"}</button>
      </>}
      {step === 1 && <>
        {!connection ? <><p>Your bot space is prepared. Reconnect to continue where you left off.</p><button className="primary" disabled={working} onClick={prepare}>Continue setup</button></> : !setup ? <p role="status">{working ? "Reading your setup…" : "Use Reload setup to try again."}</p> : <>
          {modelConfigured && <label className="setup-option"><input type="checkbox" checked={keepConnection} onChange={event => { setKeepConnection(event.target.checked); setCheck(null); }}/><span><strong>Keep {accounts.configured.model}</strong><small>{accounts.configured.auth === "cli" ? "Existing official CLI subscription connection" : accounts.configured.baseUrl}</small></span></label>}
          {!keepConnection && <div className="setup-fields">
            <label htmlFor="setup-provider">Connection type</label><select id="setup-provider" value={provider} disabled={working} onChange={event => { const id = event.target.value; void run(async () => { if (login && ["starting", "waiting"].includes(login.status)) await api.request("cancelLogin", { id: login.id }); setLogin(null); setProvider(id); setBaseUrl(setup.providers.find(item => item.id === id)?.baseUrl || ""); setModel(""); setKey(""); setCheck(null); }); }}>
              <optgroup label="Your own models">{[["lmstudio", "LM Studio"], ["ollama", "Ollama"], ["llamacpp", "llama.cpp"], ["vllm", "vLLM"], ["custom", "Another OpenAI-compatible server"]].map(([id, label]) => <option key={id} value={id}>{label}</option>)}</optgroup>
              <optgroup label="Cloud API key">{["openai", "gemini", "xai", "openrouter", "deepseek", "groq"].map(id => <option key={id} value={id}>{id}</option>)}</optgroup>
              <optgroup label="Cloud subscription through official CLI">{subscriptions.map(id => <option key={id} value={id}>{id}</option>)}</optgroup>
            </select>
            {!subscriptions.includes(provider) && <><label htmlFor="setup-base">Server URL</label><input id="setup-base" value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder="http://model-host.local:1234/v1" autoComplete="off" spellCheck={false}/><label htmlFor="setup-key">API key <small>optional for servers that do not require one</small></label><input id="setup-key" type="password" value={key} onChange={event => setKey(event.target.value)} autoComplete="off" spellCheck={false}/></>}
            <label htmlFor="setup-model">Model ID</label><input id="setup-model" value={model} onChange={event => setModel(event.target.value)} placeholder={subscriptions.includes(provider) ? "The model supported by your subscription CLI" : "Choose a discovered model, or paste its exact ID"} spellCheck={false}/>
            {!subscriptions.includes(provider) && <details className="setup-help"><summary>Find models already running</summary><p>Start your model server, load a model, and enable its OpenAI-compatible API. On another computer, enable network access and use its LAN or mesh address here.</p><label><input type="checkbox" checked={network} onChange={event => setNetwork(event.target.checked)}/> Include known LAN and mesh peers</label><button disabled={working} onClick={() => void run(async () => { const result = await api.request("discoverModels", { network }); setServers(result.servers); setCheck({ message: result.servers.length ? "Choose a model below." : "No running models found. Start a server or enter its URL above." }); })}>Find running models</button>{servers.map(server => <div className="discovered-model" key={server.baseUrl}><strong>{server.baseUrl}</strong>{server.models.map(id => <button key={id} onClick={() => { if (server.savedConnection) { setKeepConnection(true); setModel(accounts.configured.model); setBaseUrl(accounts.configured.baseUrl); setCheck({ message: "Saved SSH connection found. Its trusted route is retained." }); } else { setProvider(server.provider || "custom"); setBaseUrl(server.baseUrl); setModel(id); } }}>{id}</button>)}</div>)}</details>}
          </div>}
            {subscriptions.includes(provider) && <div className="setup-subscription"><p>The official {provider} CLI handles sign-in on this computer. A compatible subscription and installed CLI are required.</p>{accountStatus && <p role="status">{accountStatus.detail}</p>}<button disabled={working || !!login && ["starting", "waiting"].includes(login.status)} onClick={() => void run(async () => setLogin(await api.request("startLogin", { provider })))}>Connect {provider} account</button>{login && <div role="status"><p>{login.message}</p>{login.userCode && <code className="device-code">{login.userCode}</code>}{login.verificationURL && <button onClick={() => void run(() => api.openAccountAuth(login.verificationURL))}>Open secure sign-in</button>}{["starting", "waiting"].includes(login.status) && <button onClick={() => void run(async () => setLogin(await api.request("cancelLogin", { id: login.id })))}>Cancel sign-in</button>}</div>}</div>}
          {keepConnection && <button disabled={working} onClick={() => void run(async () => setCheck(await api.request("probeModel")))}>Check saved connection</button>}
          {check && <p role="status" className="setup-found">{check.message}</p>}
          <section className="setup-help" aria-label="Hardware and model fit">
            <h3>Hardware and model fit</h3>
            <p>Check available memory and serving software where the model will run.</p>
            <div className="setup-actions">
              <button disabled={working} onClick={() => void run(async () => setHardware(await api.request("inspectHardware", { target: "local" })))}>Inspect this computer</button>
              {modelConfigured && <button disabled={working} onClick={() => void run(async () => setHardware(await api.request("inspectHardware", { target: "model-host" })))}>Inspect saved model host</button>}
            </div>
            {hardware && <div className="hardware-report" role="status">
              <strong>{hardware.target === "model-host" ? "Saved model host" : "This computer"} · {hardware.hardware.os} / {hardware.hardware.arch}</strong>
              <p>{hardware.hardware.gpus.map(gpu => gpu.name).join(", ") || hardware.hardware.cpu.name} · {hardware.hardware.cpu.cores} CPU cores</p>
              <p>{(hardware.hardware.ram.available / 1024 ** 3).toFixed(1)} GiB available / {(hardware.hardware.ram.total / 1024 ** 3).toFixed(1)} GiB total {hardware.hardware.unifiedMemory ? "shared memory" : "RAM"}</p>
              <p>Serving CLIs on PATH: {Object.entries(hardware.tools).filter(([, value]) => value.onPath).map(([name]) => name).join(", ") || "none detected"}. A server may run outside PATH.</p>
              <p>Server processes observed: {Object.entries(hardware.tools).filter(([, value]) => value.running).map(([name]) => name).join(", ") || "none identified"}.</p>
              <p>Estimates at {hardware.contextTokens.toLocaleString()} context tokens, one request. This does not measure the loaded model's speed.</p>
              <div className="hardware-table"><table><thead><tr><th>Model</th><th>Quant.</th><th>Memory</th><th>Fit</th></tr></thead><tbody>{hardware.models.map(item => <tr key={item.id}><td>{item.name}</td><td>{item.quant}</td><td>{(item.footprint / 1024 ** 3).toFixed(1)} GiB</td><td>{item.verdict === "no" ? "Does not fit" : item.verdict === "tight" ? "Tight" : "Fits"}</td></tr>)}</tbody></table></div>
              <p>Checked {new Date(hardware.measuredAt).toLocaleTimeString()}.</p>
            </div>}
          </section>
          <div className="setup-actions"><button className="primary" disabled={working || loginPending || !keepConnection && !model.trim()} onClick={saveConnection}>{keepConnection ? "Continue with this connection" : "Save and check connection"}</button><button disabled={working || loginPending} onClick={() => setStep(2)}>Set up a model later</button></div>
        </>}
      </>}
      {step === 2 && setup && <>
        {setup.profile && <label className="setup-option"><input type="checkbox" checked={keepProfile} onChange={event => setKeepProfile(event.target.checked)}/><span><strong>Keep my existing working preferences</strong><small>Your copied voice, notes, and native skill choices stay in use.</small></span></label>}
        {!keepProfile && <><div className="setup-fields">{setup.items.map(item => <React.Fragment key={item.id}><label htmlFor={`setup-${item.id}`}>{item.prompt.replaceAll("Rein", "your bot")}</label><select id={`setup-${item.id}`} value={answers[item.id]} onChange={event => setAnswers(previous => ({ ...previous, [item.id]: event.target.value }))}>{item.choices.map(choice => <option key={choice.id} value={choice.id}>{choice.label}</option>)}</select></React.Fragment>)}</div>{pack && <label className="setup-option"><input type="checkbox" checked={enablePack} onChange={event => setEnablePack(event.target.checked)}/><span><strong>Add {pack.label.toLowerCase()} skills</strong><small>{pack.description} Optional; you can skip this.</small></span></label>}</>}
        <details className="setup-help" open><summary>Room for longer tasks</summary>{setup.budgetsNeedReview && <p role="status">Your earlier task limits need attention. We have filled in working defaults; review and save them below.</p>}<p>Limits pause a task for review. They do not grant permission for new work. A turn is one model response; an iteration is one autonomy work cycle.</p><div className="setup-budget-fields"><label>Turns per task<input type="number" min="1" max="10000" value={maxTurns} onChange={event => setMaxTurns(event.target.value)}/></label><label>Autonomy iterations<input type="number" min="1" max="1000" value={maxIterations} onChange={event => setMaxIterations(event.target.value)}/></label></div><p className="muted">Autonomy stays off until you enable it. These limits apply when you run it.</p></details>
        <div className="setup-actions"><button disabled={working} onClick={() => setStep(1)}>Back</button><button className="primary" disabled={working} onClick={savePreferences}>Save my preferences</button></div>
      </>}
      {step === 3 && <>
        {bots.length > 0 && <div className="setup-fields"><label htmlFor="setup-existing-bot">Continue a conversation</label><select id="setup-existing-bot" value={existingBot} onChange={event => setExistingBot(event.target.value)}><option value="">Create a new bot</option>{bots.map(bot => <option key={bot.id} value={bot.id}>{bot.name}</option>)}</select></div>}
        {!selectedBot && <><div className="setup-fields"><label htmlFor="setup-bot-name">What should we call your bot?</label><input id="setup-bot-name" maxLength={64} value={name} onChange={event => setName(event.target.value)}/></div><AvatarPicker value={avatar} onChange={setAvatar} disabled={working}/></>}
        {!inspection.completed && <><fieldset className="setup-starters"><legend>Pick a first thing to try</legend>{["Help me make one small thing in my day easier.", "Help me get a project unstuck, one step at a time.", "Help me think through a decision and compare my options."].map(text => <label key={text}><input type="radio" name="starter" checked={starter === text} onChange={() => setStarter(text)}/>{text}</label>)}</fieldset>
        <p className="muted">This fills the message box. You choose when to send it.</p></>}
        <div className="setup-actions"><button disabled={working} onClick={() => setStep(2)}>Back</button><button className="primary" disabled={working || !selectedBot && !name.trim()} onClick={finish}>{working ? "Getting ready…" : "Open my bot"}</button></div>
      </>}
      {onCancel && <button className="setup-cancel" disabled={working} onClick={onCancel}>Return to my bots</button>}
    </section>
  </main>;
}
