'use strict';
// Talking to Claude (Linux): the Copilot key (or the microphone button in the Claude panel) records from the
// microphone and turns the words into text on this computer with whisper.cpp; the text goes to the Claude button's
// conversation like anything typed there. Nothing is sent anywhere for the recognition: whisper.cpp runs here through
// whisper-helper.py (Fedora's python3-pywhispercpp; the whisper-cpp package is the library alone), on a model file
// Leafdeck downloads once into its profile. The helper keeps the model loaded between passes and for a few minutes
// after, so the words show up quickly.
// While you talk, the audio so far is transcribed every second or so, so the panel shows what's being heard; letting
// go of the key, pressing it again, or a pause after speaking ends the recording and the final pass is what gets sent.
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

// deps: { dir: the folder for models and scratch files, readConfig, writeConfig, send(channel, payload) }
let deps = null;

const MODELS = {
  'base.en': { label: 'Base (fast)', size: '142 MB', bytes: 147_951_465, file: 'ggml-base.en.bin' },
  'small.en': { label: 'Small (more accurate)', size: '466 MB', bytes: 487_601_967, file: 'ggml-small.en.bin' },
};
const MODEL_URL = (m) => `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODELS[m].file}`;
const RATE = 16000; // whisper's sample rate; pw-record resamples the microphone to it
const MAX_SECONDS = 90;
const PARTIAL_EVERY_MS = 1200;
// A pause ends the recording: this long under the speech level, once there has been speech.
const SILENCE_MS = 1700;
const MIN_SPEECH_MS = 250;
const HP_A = 0.94; // the high-pass filter's coefficient at 16 kHz (see start())

const settings = () => {
  const v = deps.readConfig().voice || {};
  return { key: v.key !== false, model: Object.hasOwn(MODELS, v.model) ? v.model : 'base.en' };
};
const modelFile = (m) => path.join(deps.dir, MODELS[m].file);
const modelReady = (m) => fs.existsSync(modelFile(m));

const HELPER = path.join(__dirname, 'whisper-helper.py');
const INSTALL = 'sudo dnf install python3-pywhispercpp';
// Whether the bindings are there: asked of Python at most every few seconds (Settings asks on every redraw).
let installedAt = 0;
let installedWas = false;
function installed() {
  if (Date.now() - installedAt < 5000) return installedWas;
  installedAt = Date.now();
  try {
    execFileSync('python3', ['-c', 'import pywhispercpp.model'], { stdio: 'ignore', timeout: 5000 });
    installedWas = true;
  } catch {
    installedWas = false;
  }
  return installedWas;
}

const emit = (ev) => deps.send('voice:event', ev);

let rec = null; // the recording in progress
let downloads = new Map(); // model -> pct

function status() {
  const s = settings();
  return {
    supported: process.platform === 'linux',
    installed: installed(),
    install: INSTALL,
    key: s.key,
    model: s.model,
    models: Object.fromEntries(Object.entries(MODELS).map(([k, m]) => [k, { label: m.label, size: m.size, ready: modelReady(k), downloading: downloads.has(k) ? downloads.get(k) : null }])),
    ready: installed() && modelReady(s.model),
    listening: !!rec,
    phase: rec ? rec.phase : 'idle',
    microphone: microphone(),
  };
}

function set(patch) {
  const cur = settings();
  const p = patch && typeof patch === 'object' ? patch : {};
  deps.writeConfig({ voice: { key: 'key' in p ? !!p.key : cur.key, model: 'model' in p && Object.hasOwn(MODELS, p.model) ? p.model : cur.model } });
  return status();
}

/* ---------------- the model ---------------- */

async function download(model) {
  if (!Object.hasOwn(MODELS, model)) throw new Error('No such model');
  if (modelReady(model)) return status();
  if (downloads.has(model)) return status();
  fs.mkdirSync(deps.dir, { recursive: true });
  const part = modelFile(model) + '.part';
  downloads.set(model, 0);
  emit({ t: 'download', model, pct: 0 });
  try {
    const res = await fetch(MODEL_URL(model), { redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error(`The download failed (${res.status})`);
    const total = Number(res.headers.get('content-length')) || MODELS[model].bytes;
    const out = fs.createWriteStream(part);
    let got = 0;
    let lastPct = -1;
    for await (const chunk of res.body) {
      got += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      const pct = Math.min(99, Math.floor((got / total) * 100));
      if (pct !== lastPct) {
        lastPct = pct;
        downloads.set(model, pct);
        emit({ t: 'download', model, pct });
      }
    }
    await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
    if (got < MODELS[model].bytes * 0.9) throw new Error('The download ended early');
    fs.renameSync(part, modelFile(model));
    emit({ t: 'download', model, pct: 100 });
  } catch (err) {
    fs.rm(part, { force: true }, () => {});
    emit({ t: 'error', text: `Couldn’t download the ${MODELS[model].label} model: ${err.message}` });
    throw err;
  } finally {
    downloads.delete(model);
    emit({ t: 'status', ...status() });
  }
  return status();
}

function removeModel(model) {
  if (!Object.hasOwn(MODELS, model)) throw new Error('No such model');
  if (helper?.model === model) stopHelper();
  fs.rmSync(modelFile(model), { force: true });
  return status();
}

/* ---------------- recording and recognition ---------------- */

/** The microphone to record from: the first real capture source. Not the default source: on a computer with a
 * software sink for the speakers (an equalizer), the default can be that sink's monitor, which records the speakers,
 * not the room. A name with "mic" in it wins; else the first source that isn't a monitor. */
function microphone() {
  let list = '';
  try {
    list = execFileSync('pactl', ['list', 'short', 'sources'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).toString();
  } catch {
    return null;
  }
  const names = list
    .split('\n')
    .map((l) => l.split('\t')[1])
    .filter((n) => n && !n.endsWith('.monitor'));
  return names.find((n) => /mic/i.test(n)) || names[0] || null;
}

function wavHeader(dataBytes) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(RATE, 24);
  h.writeUInt32LE(RATE * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

// What whisper writes for silence or noise, which isn't anything the user said.
const NOISE = /^\s*[\[(*]([^\])*]*)[\])*]\s*$/;
function cleanText(raw) {
  const lines = String(raw || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !NOISE.test(l));
  return lines
    .join(' ')
    .replace(/\s*\[(BLANK_AUDIO|inaudible|music|silence)[^\]]*\]\s*/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* The helper: one Python process with the model loaded, started on the first pass, stopped after a while unused
   (the model takes a few hundred megabytes) or when the model changes. */
const HELPER_IDLE_MS = 5 * 60_000;
let helper = null; // { child, model, buf, waiting: Map(id -> {resolve, reject}), ready: Promise, idle, seq }
function helperFor(model) {
  if (helper && helper.model === model && helper.child.exitCode == null) return helper;
  stopHelper();
  const threads = String(Math.max(2, Math.min(8, require('node:os').availableParallelism?.() || 4)));
  const child = spawn('python3', ['-I', HELPER, modelFile(model), threads], { stdio: ['pipe', 'pipe', 'pipe'] });
  const h = { child, model, buf: '', waiting: new Map(), idle: 0, seq: 0, stderr: '' };
  let onReady;
  let onFail;
  h.ready = new Promise((res, rej) => {
    onReady = res;
    onFail = rej;
  });
  h.ready.catch(() => {});
  const fail = (err) => {
    onFail(err);
    for (const w of h.waiting.values()) w.reject(err);
    h.waiting.clear();
  };
  child.stdout.on('data', (d) => {
    h.buf += d;
    let i;
    while ((i = h.buf.indexOf('\n')) >= 0) {
      const line = h.buf.slice(0, i).trim();
      h.buf = h.buf.slice(i + 1);
      if (!line) continue;
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      if (m.ready) onReady();
      else if (m.id == null && m.error) fail(new Error(m.error));
      else if (h.waiting.has(m.id)) {
        const w = h.waiting.get(m.id);
        h.waiting.delete(m.id);
        m.error ? w.reject(new Error(m.error)) : w.resolve(cleanText(m.text));
      }
    }
  });
  child.stderr.on('data', (d) => (h.stderr = (h.stderr + d).slice(-1500)));
  child.on('error', (err) => fail(new Error(`Couldn’t start the speech helper: ${err.message}`)));
  child.on('exit', (code) => {
    fail(new Error(h.stderr.trim().split('\n').pop() || `The speech helper stopped (${code})`));
    if (helper === h) helper = null;
  });
  helper = h;
  return h;
}
function stopHelper() {
  if (!helper) return;
  clearTimeout(helper.idle);
  try {
    helper.child.stdin.end();
  } catch {}
  const c = helper.child;
  setTimeout(() => c.exitCode == null && c.kill(), 1000).unref();
  helper = null;
}
function bumpHelperIdle(h) {
  clearTimeout(h.idle);
  h.idle = setTimeout(() => helper === h && !h.waiting.size && stopHelper(), HELPER_IDLE_MS);
  h.idle.unref();
}

/** Run whisper on the audio recorded so far. Resolves to the text. */
async function transcribe(pcm, { final } = {}) {
  const wav = path.join(deps.dir, final ? 'final.wav' : 'live.wav');
  fs.writeFileSync(wav, Buffer.concat([wavHeader(pcm.length), pcm]));
  const h = helperFor(settings().model);
  await h.ready;
  const id = ++h.seq;
  const text = await new Promise((resolve, reject) => {
    h.waiting.set(id, { resolve, reject });
    try {
      h.child.stdin.write(JSON.stringify({ id, file: wav }) + '\n');
    } catch (err) {
      h.waiting.delete(id);
      reject(err);
    }
  });
  bumpHelperIdle(h);
  return text;
}

/** Loading the model takes a moment: start the helper as soon as listening starts, so the first words show quickly. */
function warm() {
  try {
    const h = helperFor(settings().model);
    bumpHelperIdle(h);
  } catch {}
}

function start() {
  if (process.platform !== 'linux') throw new Error('Talking to Claude needs Leafdeck on Linux');
  if (rec) return status();
  if (!installed()) throw new Error('Speech recognition isn’t installed. Settings → Claude → Voice shows how.');
  const m = settings().model;
  if (!modelReady(m)) throw new Error(`The ${MODELS[m].label} speech model isn’t downloaded yet. Settings → Claude → Voice.`);
  fs.mkdirSync(deps.dir, { recursive: true });
  warm();
  const target = microphone();
  if (!target) throw new Error('No microphone was found.');
  const child = spawn('pw-record', ['--target', target, '--rate', String(RATE), '--channels', '1', '--format', 's16', '--latency', '30ms', '--media-role', 'Communication', '--raw', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const r = { child, chunks: [], bytes: 0, phase: 'listening', lastLevelAt: 0, transcribing: false, lastTranscribed: 0, text: '', speechMs: 0, quietMs: 0, win: [], winMs: 0, heardMs: 0, floor: 1, hpX: 0, hpY: 0, stopped: false, stderr: '' };
  rec = r;
  child.stderr.on('data', (d) => (r.stderr = (r.stderr + d).slice(-800)));
  child.stdout.on('data', (chunk) => {
    if (r.stopped) return;
    r.chunks.push(chunk);
    r.bytes += chunk.length;
    // The level, for the ring and for telling speech from the room: RMS of this chunk as a fraction of full scale,
    // after a high-pass (about 160 Hz) that takes out fan hum and handling rumble, which a laptop's microphones pick
    // up loudly but which aren't speech. Lifted so speech fills the ring.
    let sum = 0;
    const n = chunk.length >> 1;
    for (let i = 0; i < n; i++) {
      const x = chunk.readInt16LE(i * 2) / 32768;
      const y = HP_A * (r.hpY + x - r.hpX);
      r.hpX = x;
      r.hpY = y;
      sum += y * y;
    }
    const rms = n ? Math.sqrt(sum / n) : 0;
    const ms = (n / RATE) * 1000;
    const now = Date.now();
    if (now - r.lastLevelAt > 45) {
      r.lastLevelAt = now;
      emit({ t: 'level', v: Math.min(1, rms * 6) });
    }
    // The room's own noise: the quietest 200 ms heard so far (so it's right even when you start talking at once, as
    // soon as there's a gap between words). Speech is well above it.
    r.heardMs += ms;
    r.win.push(rms);
    r.winMs += ms;
    if (r.winMs >= 200 && r.heardMs < 400) {
      r.win = []; // the first moments ramp up from nothing: not the room
      r.winMs = 0;
    } else if (r.winMs >= 200) {
      r.floor = Math.min(r.floor, r.win.reduce((a, b) => a + b, 0) / r.win.length);
      r.win = [];
      r.winMs = 0;
    }
    const thr = Math.min(0.3, Math.max(0.012, r.floor * 2.5 + 0.004));
    if (rms > thr) {
      r.speechMs += ms;
      r.quietMs = 0;
    } else if (r.speechMs >= MIN_SPEECH_MS) r.quietMs += ms;
    if (r.speechMs >= MIN_SPEECH_MS && r.quietMs >= SILENCE_MS) return stop();
    if (r.bytes >= RATE * 2 * MAX_SECONDS) return stop();
    // What's been heard so far, when the last pass is done and there's at least a second of sound.
    if (!r.transcribing && now - r.lastTranscribed >= PARTIAL_EVERY_MS && r.bytes >= RATE * 2) {
      r.transcribing = true;
      const pcm = Buffer.concat(r.chunks);
      transcribe(pcm)
        .then((text) => {
          if (rec !== r || r.stopped) return;
          if (text && text !== r.text) {
            r.text = text;
            emit({ t: 'partial', text });
          }
        })
        .catch(() => {})
        .finally(() => {
          r.transcribing = false;
          r.lastTranscribed = Date.now();
        });
    }
  });
  child.on('error', (err) => {
    if (rec !== r) return;
    rec = null;
    emit({ t: 'error', text: `Couldn’t open the microphone: ${err.message}` });
    emit({ t: 'state', ...status() });
  });
  child.on('exit', (code) => {
    if (rec !== r || r.stopped) return;
    rec = null;
    emit({ t: 'error', text: `The microphone stopped${code ? ` (${r.stderr.trim().split('\n').pop() || code})` : ''}` });
    emit({ t: 'state', ...status() });
  });
  emit({ t: 'state', ...status() });
  return status();
}

/** End the recording; the whole of it is transcribed once more and sent as 'final'. */
async function stop() {
  const r = rec;
  if (!r || r.stopped) return status();
  r.stopped = true;
  r.phase = 'transcribing';
  try {
    r.child.kill();
  } catch {}
  emit({ t: 'state', ...status() });
  const pcm = Buffer.concat(r.chunks);
  let text = '';
  try {
    if (pcm.length >= RATE) text = await transcribe(pcm, { final: true }); // half a second or more; silence comes back as ''
  } catch (err) {
    if (rec === r) {
      rec = null;
      emit({ t: 'error', text: `Couldn’t make out the words: ${err.message}` });
      emit({ t: 'state', ...status() });
    }
    return status();
  }
  if (rec !== r) return status(); // cancelled meanwhile
  rec = null;
  emit({ t: 'final', text });
  emit({ t: 'state', ...status() });
  return status();
}

/** Drop the recording without sending anything. */
function cancel() {
  const r = rec;
  if (!r) return status();
  rec = null;
  r.stopped = true;
  try {
    r.child.kill();
  } catch {}
  emit({ t: 'cancelled' });
  emit({ t: 'state', ...status() });
  return status();
}

function init(d) {
  deps = d;
}

module.exports = { init, status, set, download, removeModel, start, stop, cancel, stopHelper, MODELS };
