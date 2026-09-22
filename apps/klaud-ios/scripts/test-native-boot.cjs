const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const swiftPath = path.join(__dirname, '..', 'ReinKlaud', 'ReinKlaudApp.swift');
const swift = fs.readFileSync(swiftPath, 'utf8');
const opening = '        let boot = """';
const start = swift.indexOf(opening) + opening.length;
const end = swift.indexOf('\n        """', start);
assert(start >= opening.length && end > start, 'embedded native bootstrap found');
const boot = swift.slice(start, end)
  .replace('\\(thirdParty ? "true" : "false")', 'false')
  .replace('\\(ready ? "true" : "false")', 'false')
  .replace('\\(seen ? "true" : "false")', 'false');
new vm.Script(boot);

const messages = [];
class Storage {
  constructor() { this.values = new Map(); }
  setItem(key, value) { this.values.set(key, String(value)); }
  getItem(key) { return this.values.get(key) ?? null; }
}
class HTMLTextAreaElement {
  constructor() { this._value = ''; this.events = []; this.form = null; }
  get value() { return this._value; }
  set value(value) { this._value = String(value); }
  closest(selector) { return selector === 'form' ? this.form : null; }
  dispatchEvent(event) { this.events.push(event.type); }
}
class Event { constructor(type) { this.type = type; } }
class InputEvent extends Event {
  constructor(type, options) { super(type); Object.assign(this, options || {}); }
}
class CustomEvent extends Event {
  constructor(type, options) { super(type); this.detail = options?.detail; }
}
class MutationObserver { constructor(callback) { this.callback = callback; } observe() {} }

Object.assign(global, {
  Storage,
  HTMLTextAreaElement,
  Event,
  InputEvent,
  CustomEvent,
  MutationObserver,
});
global.localStorage = new Storage();
global.location = { protocol: 'https:', hostname: 'openbot.zermo.org', port: '' };
global.webkit = {
  messageHandlers: { klaud: { postMessage: (message) => messages.push(message) } },
};
global.getComputedStyle = () => ({ display: 'block', visibility: 'visible' });
global.requestAnimationFrame = (callback) => callback();
global.setInterval = () => 1;
global.setTimeout = (callback) => { callback(); return 1; };
global.window = global;
window.addEventListener = () => {};
window.dispatchEvent = () => true;

const field = new HTMLTextAreaElement();
const form = { submits: 0, requestSubmit() { this.submits += 1; } };
field.form = form;
const stop = { clicks: 0, click() { this.clicks += 1; } };
const ledger = { innerText: 'ledger' };
const scroller = { scrollTop: 0, addEventListener() {} };
const fiber = {
  memoizedProps: { bot: { id: 'bot-stable', sessionId: 'session-one' } },
  return: null,
};
const pane = {
  '__reactFiber$test': fiber,
  getBoundingClientRect: () => ({ width: 320, height: 480 }),
  getClientRects: () => [{ width: 320, height: 480 }],
  getAttribute: () => null,
  contains: (element) => element === form,
  querySelector(selector) {
    if (selector === 'textarea.crt-input') return field;
    if (selector === '.stop-run') return stop;
    if (selector === '.thread') return ledger;
    if (selector === '.chat-scroll') return scroller;
    return null;
  },
};
let panes = [pane];
const listeners = {};
global.document = {
  querySelectorAll(selector) { return selector === '.chat-pane' ? panes : []; },
  addEventListener(type, callback) { listeners[type] = callback; },
  getElementById() { return null; },
  createElement() { return { id: '', textContent: '' }; },
  head: { appendChild() {} },
};

vm.runInThisContext(boot);
const legacy = window.klaudLegacyNativeComposer;
assert(legacy, 'legacy bridge installed');
const scopeOne = 'bot-stable|session-one';
assert.strictEqual(legacy.setDraft('hello', 1, scopeOne), true);
assert.strictEqual(field.value, 'hello');
assert.strictEqual(legacy.submit(scopeOne), true);
assert.strictEqual(form.submits, 1);
assert.strictEqual(legacy.stop(scopeOne), true);
assert.strictEqual(stop.clicks, 1);

fiber.memoizedProps.bot.sessionId = 'session-two';
assert.strictEqual(legacy.setDraft('wrong session', 2, scopeOne), false);
assert.strictEqual(legacy.submit(scopeOne), false);
assert.strictEqual(legacy.stop(scopeOne), false);
assert.strictEqual(field.value, 'hello');

fiber.memoizedProps.bot.sessionId = 'session-one';
panes = [pane, { ...pane }];
assert.strictEqual(legacy.setDraft('ambiguous pane', 3, scopeOne), false);
assert.strictEqual(legacy.submit(scopeOne), false);
assert.strictEqual(legacy.stop(scopeOne), false);
assert.strictEqual(field.value, 'hello');

const state = messages.find((message) => message.action === 'legacyState');
assert(state, 'legacy state emitted');
assert.strictEqual(state.documentNonce, window.klaudNative.documentNonce);
assert(state.documentNonce.length > 0);
assert.strictEqual(state.scope, scopeOne);
assert.strictEqual(state.botId, 'bot-stable');
assert.strictEqual(state.sessionId, 'session-one');
console.log('LEGACY_DOM_GATE=PASS');
