import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { build } from "esbuild";
import { AVATAR_STATES, AVATAR_STYLES, avatarForBot } from "../avatar-catalog.mjs";

const reactPath = pathToFileURL(createRequire(import.meta.url).resolve("react")).href;
const compiled = await build({ entryPoints: [new URL("../avatars.jsx", import.meta.url).pathname], bundle: true, platform: "node", format: "esm", write: false,
  plugins: [{ name: "shared-react", setup(builder) { builder.onResolve({ filter: /^react$/ }, () => ({ path: reactPath, external: true })); } }],
});
const { BotAvatar, AvatarPicker } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`);

test("saved avatars override stable ID defaults and unknown saved styles have a safe fallback", () => {
  for (const style of AVATAR_STYLES) assert.equal(avatarForBot("example-bot", style.id), style.id);
  assert.equal(avatarForBot("example-bot"), avatarForBot("example-bot", "invalid-style"));
  for (const id of [null, undefined, "", "operator-🛠", "<script>", "a".repeat(10000)]) {
    assert.ok(AVATAR_STYLES.some(style => style.id === avatarForBot(id)));
    assert.equal(avatarForBot(id), avatarForBot(id));
  }
  assert.ok(new Set(Array.from({ length: 24 }, (_, i) => avatarForBot(`bot-${i}`))).size >= 4);
});

test("every avatar exposes a distinct silhouette and two brows for every supported phase", () => {
  const portraits = new Set();
  for (const style of AVATAR_STYLES) {
    for (const state of Object.keys(AVATAR_STATES)) {
      const svg = renderToStaticMarkup(React.createElement(BotAvatar, { avatar: style.id, state, size: 160 }));
      assert.match(svg, new RegExp(`data-avatar="${style.id}"`));
      assert.match(svg, new RegExp(`data-state="${state}"`));
      assert.match(svg, /role="img"/);
      assert.match(svg, /class="bot-avatar-brow-left"/);
      assert.match(svg, /class="bot-avatar-brow-right"/);
      assert.match(svg, /width="160" height="160"/);
      assert.doesNotMatch(svg, /<foreignObject|<image|<script|<animate|<filter/);
      if (state === "ready") portraits.add(svg.replace(/data-avatar="[^"]*"|aria-label="[^"]*"/g, ""));
    }
  }
  assert.equal(portraits.size, 6);
});

test("decorative portraits do not duplicate identity and unknown phases cannot imply work", () => {
  const svg = renderToStaticMarkup(React.createElement(BotAvatar, { botId: "sample", state: "invented", decorative: true, paused: true, size: Infinity }));
  assert.match(svg, /aria-hidden="true"/);
  assert.match(svg, /data-state="ready"/);
  assert.match(svg, /data-paused="true"/);
  assert.match(svg, /width="48" height="48"/);
  assert.doesNotMatch(svg, /role="img"|aria-label=/);
});

test("picker uses labelled native controls with a single persisted selection", () => {
  const markup = renderToStaticMarkup(React.createElement(AvatarPicker, { value: "builder", disabled: true }));
  assert.equal((markup.match(/<button /g) || []).length, 6);
  assert.equal((markup.match(/aria-pressed="true"/g) || []).length, 1);
  assert.equal((markup.match(/ disabled=""/g) || []).length, 6);
  assert.equal((markup.match(/aria-label="[^"]+: /g) || []).length, 6);
  assert.doesNotMatch(markup, /tabindex=/);
  let selected;
  const element = AvatarPicker({ value: "builder", onChange: value => { selected = value; } });
  element.props.children.find(child => child.key === "explorer").props.onClick();
  assert.equal(selected, "explorer");
});

test("motion has one procedural driver and reduced motion overrides portrait transforms", async () => {
  const css = await readFile(new URL("../avatars.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /data-state="(?:ready|approval|error)"/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /transform: none !important/);
  assert.doesNotMatch(css, /@keyframes|animation:/);
  assert.match(css, /data-animated="true"/);
  assert.match(css, /transform-origin: 64px 64px/);
});
