// The matching hosted bridge owns its DOM; unsupported pages remain web-only.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert/strict');
const swift = fs.readFileSync(path.join(__dirname, '..', 'ReinKlaud', 'ReinKlaudApp.swift'), 'utf8');
const opening = '        let boot = """';
const start = swift.indexOf(opening) + opening.length;
const end = swift.indexOf('\n        """', start);
assert(start >= opening.length && end > start);
const boot = swift.slice(start, end)
  .replace('\\(thirdParty ? "true" : "false")', 'false')
  .replace('\\(ready ? "true" : "false")', 'false')
  .replace('\\(seen ? "true" : "false")', 'false');
new vm.Script(boot);
function load(url, secureNonce = true) {
  const messages = [], events = [];
  class Storage {
    constructor() { this.values = new Map(); }
    setItem(key, value) { this.values.set(key, String(value)); }
    getItem(key) { return this.values.get(key) ?? null; }
  }
  class CustomEvent { constructor(type, options) { this.type = type; this.detail = options?.detail; } }
  const noLegacy = () => { throw new Error('bootstrap must not poll, inspect or hide the web editor'); };
  const context = {
    Storage, CustomEvent, location: new URL(url), localStorage: new Storage(),
    crypto: secureNonce ? { randomUUID: () => 'fixture-document' } : {},
    webkit: { messageHandlers: { klaud: { postMessage: message => messages.push(message) } } },
    document: new Proxy({}, { get: noLegacy }), setTimeout: noLegacy, setInterval: noLegacy,
    dispatchEvent: event => { events.push(event); return true; },
  };
  context.window = context;
  vm.runInNewContext(boot, context);
  return { context, messages, events };
}
for (const url of ['https://openbot.zermo.org/', 'https://reinklaud.zermo.org/']) {
  const { context, messages, events } = load(url);
  assert.equal(context.klaudNative.protocolVersion, 2);
  assert(context.klaudNative.capabilities.includes('composer.v2'));
  assert.equal(context.klaudNative.documentNonce, 'fixture-document');
  assert.equal(context.klaudLegacyNativeComposer, undefined);
  assert(events.some(event => event.type === 'klaud-native-ready'));
  context.klaudNative.feel('send');
  assert.equal(messages.at(-1).documentNonce, 'fixture-document');
}
for (const url of ['http://openbot.zermo.org/', 'https://openbot.zermo.org:444/', 'https://auth.zermo.org/', 'https://openbot.zermo.org.attacker.invalid/']) {
  assert.equal(load(url).context.klaudNative, undefined);
}
assert.equal(load('https://openbot.zermo.org/', false).context.klaudNative, undefined);
console.log('PASS: exact embedded v2 bootstrap; secure nonce and HTTPS allowlist; no DOM inspection, hiding or polling');
