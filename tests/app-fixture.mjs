import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as midi from '../docs/midi.js';
import { PRESETS, INKS } from '../docs/sound.js';
import * as storageFunctions from '../docs/studio-storage.js';
import * as inkHistory from '../docs/ink-history.js';
import * as edits from '../docs/creative-edits.js';

// This is deliberately a Node DOM simulation, not a browser/layout/audio test.
// Read the actual HTML (missing controls fail initialization), then run app.js
// with only its import declarations replaced. No handler is copied into tests.
const html = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../docs/app.js', import.meta.url), 'utf8');
const imageSource = readFileSync(new URL('../docs/paint2score.js', import.meta.url), 'utf8');
export const storageKey = 'gradient-lab:sketchbook:v1';
export const plain = value => JSON.parse(JSON.stringify(value));

function matches(element, selector) {
  return selector.split(',').some(part => {
    const tokens = part.trim().split(/\s+(?![^[]*\])/), leaf = tokens.pop();
    const simple = (node, expression) => {
      if (!node || !expression) return false;
      const tag = expression.match(/^[\w-]+/), id = expression.match(/#([\w-]+)/);
      if (tag && node.tagName !== tag[0].toUpperCase()) return false;
      if (id && node.id !== id[1]) return false;
      for (const [, name] of expression.matchAll(/\.([\w-]+)/g)) if (!node.classList.contains(name)) return false;
      for (const [, name, op, value] of expression.matchAll(/\[([\w-]+)(?:(\^?=)["']?([^\]"']*)["']?)?\]/g)) {
        const actual = node.getAttribute(name);
        if (actual === null || (op === '=' && actual !== value) || (op === '^=' && !actual.startsWith(value))) return false;
      }
      return true;
    };
    if (!simple(element, leaf)) return false;
    let parent = element.parentNode;
    while (tokens.length) {
      const token = tokens.pop();
      while (parent && !simple(parent, token)) parent = parent.parentNode;
      if (!parent) return false;
      parent = parent.parentNode;
    }
    return true;
  });
}

class Element {
  constructor(tagName, document) {
    this.tagName = tagName.toUpperCase(); this.ownerDocument = document;
    this.parentNode = null; this.children = []; this.attributes = new Map(); this.listeners = new Map();
    this.id = ''; this.className = ''; this.dataset = {}; this.style = { setProperty(name, value) { this[name] = value; } }; this.value = '';
    this.hidden = false; this.disabled = false; this.checked = false; this._text = '';
    this.naturalWidth = 32; this.naturalHeight = 24; this.width = 320; this.height = 240;
    this.classList = {
      contains: name => this.className.split(/\s+/).includes(name),
      add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(' '); },
      remove: (...names) => { this.className = this.className.split(/\s+/).filter(name => !names.includes(name)).join(' '); },
      toggle: (name, force) => {
        const enabled = force ?? !this.classList.contains(name);
        this.classList[enabled ? 'add' : 'remove'](name); return enabled;
      },
    };
  }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  set innerHTML(value) { this.replaceChildren(); parseHTML(String(value), this); }
  setAttribute(name, value) {
    value = String(value); this.attributes.set(name, value);
    if (name === 'class') this.className = value;
    else if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
    else if (['hidden', 'disabled', 'checked', 'open'].includes(name)) this[name] = true;
    else if (name === 'id' || name === 'value') this[name] = value;
  }
  getAttribute(name) {
    if (name === 'class') return this.className || null;
    if (name === 'id') return this.id || null;
    if (name.startsWith('data-')) return this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] ?? null;
    return this.attributes.get(name) ?? null;
  }
  hasAttribute(name) { return this.getAttribute(name) !== null; }
  removeAttribute(name) { this.attributes.delete(name); if (['hidden', 'disabled', 'open'].includes(name)) this[name] = false; }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  append(...children) { children.forEach(child => this.appendChild(child)); }
  prepend(child) { child.parentNode = this; this.children.unshift(child); }
  replaceChildren(...children) {
    this.children.forEach(child => { child.parentNode = null; });
    this.children = []; this._text = ''; this.append(...children);
  }
  querySelectorAll(selector) {
    const found = [];
    const visit = root => root.children.forEach(child => { if (matches(child, selector)) found.push(child); visit(child); });
    visit(this); return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  closest(selector) { return matches(this, selector) ? this : this.parentNode?.closest(selector) ?? null; }
  addEventListener(type, callback, options = false) {
    const listeners = this.listeners.get(type) || [];
    listeners.push({ callback, capture: options === true || options?.capture === true });
    this.listeners.set(type, listeners);
  }
  dispatchEvent(event) {
    event.target ??= this; event.defaultPrevented = false;
    event.preventDefault = () => { event.defaultPrevented = true; };
    event.stopPropagation = () => { event.stopped = true; };
    const path = []; for (let node = this; node; node = node.parentNode) path.push(node);
    const invoke = (node, capture) => {
      event.currentTarget = node;
      for (const listener of node.listeners.get(event.type) || []) {
        if (listener.capture !== capture) continue;
        const result = listener.callback.call(node, event);
        if (result?.catch) result.catch(error => this.ownerDocument.errors.push(error));
      }
    };
    for (const node of [...path].reverse()) { invoke(node, true); if (event.stopped) break; }
    if (!event.stopped) for (const node of path) { invoke(node, false); if (event.stopped || event.bubbles === false) break; }
    return !event.defaultPrevented;
  }
  click() { if (!this.disabled) this.dispatchEvent({ type: 'click' }); }
  focus() { this.ownerDocument.activeElement = this; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 320, height: 240 }; }
  scrollIntoView() {}
  showModal() { this.setAttribute('open', ''); }
  close() { this.removeAttribute('open'); this.dispatchEvent({ type: 'close', bubbles: false }); }
  pause() { this.paused = true; }
  load() {}
  decode() { return Promise.resolve(); }
  setPointerCapture(id) { this.pointerCapture = id; }
  hasPointerCapture(id) { return this.pointerCapture === id; }
  releasePointerCapture() { this.pointerCapture = null; }
  getContext() {
    return this.context ??= {
      setTransform() {}, clearRect() {}, fillRect() {}, drawImage() {}, beginPath() {},
      moveTo() {}, lineTo() {}, arc() {}, stroke() {}, fill() {}, save() {}, restore() {},
      translate() {}, fillText() {}, measureText: text => ({ width: text.length * 8 }),
      createRadialGradient: () => ({ addColorStop() {} }),
      getImageData: () => {
        const data = new Uint8ClampedArray(this.width * this.height * 4);
        for (let i = 0; i < data.length; i += 4) data.set([50 + i % 150, 130, 210, 255], i);
        return { data };
      },
    };
  }
  toDataURL() { return 'data:image/jpeg;base64,YWJj'; }
}

// Only a small HTML/selector subset is needed here. This reads the real static
// control attributes; it does not attempt to emulate browser parsing/layout.
function parseHTML(source, root) {
  const stack = [root], voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  for (const token of source.matchAll(/<!--[\s\S]*?-->|<![^>]*>|<\/?[\w-]+\b[^>]*>|[^<]+/g)) {
    const text = token[0];
    if (/^<!/.test(text)) continue;
    if (/^<\//.test(text)) { if (stack.length > 1) stack.pop(); continue; }
    if (!text.startsWith('<')) { stack.at(-1)._text += text; continue; }
    const [, tag, attributes] = text.match(/^<([\w-]+)\b([^>]*)>/);
    const element = new Element(tag, root.ownerDocument);
    for (const [, name, double, single, bare] of attributes.matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
      element.setAttribute(name, double ?? single ?? bare ?? '');
    }
    stack.at(-1).appendChild(element);
    if (!voidTags.has(tag) && !text.endsWith('/>')) stack.push(element);
  }
}

class Engine {
  constructor() { this.ready = Promise.resolve(); this.playing = false; this.beat = 0; this.inkEvents = []; this.triggers = []; this.plays = []; this.presets = []; this.loads = []; this.inkUpdates = []; this.tracks = { melody: true, chords: true, bass: true, ink: true }; }
  async ensureStarted() { this.limiter = {}; }
  async setPreset(name) { this.presets.push(name); this.presetName = name; this.preset = {}; }
  setVolume(value) { this.volume = Math.max(0, Math.min(1, value)); }
  setMuted(value) { this.muted = Boolean(value); }
  setTrackEnabled(name, enabled) { this.tracks[name] = enabled; }
  load(result, reset = true) { this.result = result; this.loads.push({ result, reset }); if (reset) this.beat = 0; }
  setInks(ink, options) { this.inkEvents = plain(ink); this.inkUpdates.push({ ink: plain(ink), options }); }
  async triggerInk(mark) { this.triggers.push(plain(mark)); }
  stop() { this.playing = false; this.beat = 0; this.onState?.(false); }
  pause() { this.playing = false; this.onState?.(false); }
  play(beat = null) { if (beat !== null) this.beat = beat; this.playing = true; this.plays.push({ beat: this.beat, result: plain(this.result), preset: this.presetName }); this.onState?.(true); }
  toggle() { this.playing ? this.pause() : this.play(); }
}

export async function appFixture({ works = [], hash = '', livingInstaller } = {}) {
  const document = new Element('document'); document.ownerDocument = document; document.errors = [];
  document.createElement = tag => new Element(tag, document);
  document.getElementById = id => document.querySelector(`#${id}`);
  parseHTML(html, document);
  const data = new Map([[storageKey, JSON.stringify(works)]]);
  const storage = { writes: 0, failWrites: false, getItem: key => data.get(key) ?? null,
    setItem(key, value) { if (this.failWrites) throw new Error('QuotaExceededError'); this.writes++; data.set(key, String(value)); } };
  const timers = new Map(), frames = new Map(), actions = [], window = new Element('window', document);
  let now = 10000, timerId = 0, objectId = 0, frameId = 0;
  const location = new URL(`https://gradient-lab.example/${hash}`);
  const sandbox = vm.createContext({
    document, window, localStorage: storage, location,
    history: { replaceState(_state, _title, url) { location.href = new URL(url, location).href; } },
    URL: class extends URL { static createObjectURL() { return `blob:test-${++objectId}`; } static revokeObjectURL() {} },
    URLSearchParams, Blob, btoa, atob, console, performance: { now: () => now },
    setTimeout(callback, delay = 0) { const id = ++timerId; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout: id => timers.delete(id),
    requestAnimationFrame(callback) { const id = ++frameId; frames.set(id, callback); return id; },
    cancelAnimationFrame: id => frames.delete(id),
    Image: class { constructor() { this.naturalWidth = 32; this.naturalHeight = 24; }
      set src(value) { this._src = value; queueMicrotask(() => this.onload?.()); } get src() { return this._src; } },
    navigator: { clipboard: { async writeText() {} } },
  });
  window.devicePixelRatio = 1; window.matchMedia = () => ({ matches: true }); window.scrollTo = () => {};
  // The real analyzer runs against deterministic raster pixels in the simulated
  // canvas, while the real score, MIDI, storage, history and edit helpers run.
  const imageModule = new vm.Script(`(() => {\n${imageSource.replace(/^export /gm, '')}\nreturn { analyzeImage, summon, brightestPoint, SCAN_NAMES };\n})()`, { filename: 'paint2score.js' }).runInContext(sandbox);
  const dependencies = {
    './paint2score.js': imageModule, './midi.js': midi, './sound.js': { Engine, PRESETS, INKS },
    './studio-storage.js': { ...storageFunctions,
      loadWorks: () => storageFunctions.loadWorks(storage),
      saveWork: work => storageFunctions.saveWork(work, storage),
      removeWork: id => storageFunctions.removeWork(id, storage),
      restoreWork: work => storageFunctions.restoreWork(work, storage),
    },
    './ink-history.js': inkHistory, './creative-edits.js': edits,
    // Composer interaction tests deliberately stay in composer mode. The actual
    // live-mode installer is tested separately with the same simulated DOM.
    './living-trio.js': { installLivingTrio: livingInstaller ? api => livingInstaller(api, sandbox)
      : () => ({ active: false, sourceChanged() {}, sourceLoading() {}, notice() {}, setActive() {} }) },
    './creative-studio.js': { installCreativeStudio: () => ({ update() {}, changed() {},
      record(action, metadata) { actions.push({ action, metadata }); } }) },
  };
  sandbox.dependencies = dependencies;
  const executable = appSource.replace(/^import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"];?$/gm, (_line, names, path) => {
    const name = path.split('?')[0];
    assert.ok(dependencies[name], `Provide an explicit test dependency for ${name}`);
    for (const imported of names.split(',').map(value => value.trim())) assert.ok(imported in dependencies[name], `Missing test import ${imported}`);
    return `const {${names}} = dependencies[${JSON.stringify(name)}];`;
  });
  new vm.Script(executable, { filename: 'app.js' }).runInContext(sandbox);
  const get = id => { const element = document.getElementById(id); assert.ok(element, `Missing #${id} in actual index.html`); return element; };
  async function settle(advanceMs = 250) {
    now += advanceMs;
    for (let pass = 0; pass < 20; pass++) {
      await Promise.resolve();
      for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.callback(); }
    }
    if (document.errors.length) throw document.errors.shift();
  }
  await settle();
  assert.ok(window.__gl.state.result, `App failed to initialize: ${get('status').textContent}`);
  return { document, window, sandbox, get, storage, actions, location, settle,
    now: () => now, advance: ms => { now += ms; },
    frame() { const current = [...frames.values()]; frames.clear(); current.forEach(callback => callback(now)); },
    state: window.__gl.state, engine: window.__gl.engine,
    cards: () => get('savedWorks').querySelectorAll('.saved-card'),
    saved: () => plain(storageFunctions.loadWorks(storage)),
    async stroke(kind, points) {
      const swatch = document.querySelector(`[data-ink="${kind}"]`); assert.ok(swatch); swatch.click();
      const overlay = get('overlay');
      points.forEach(([x, y], i) => overlay.dispatchEvent({ type: i ? 'pointermove' : 'pointerdown', pointerId: 1, clientX: x * 320, clientY: y * 240 }));
      overlay.dispatchEvent({ type: 'pointerup', pointerId: 1 }); await settle();
    },
  };
}
