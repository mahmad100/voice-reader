// Wren AI voice engine. Runs in an offscreen document (a hidden extension page) because
// the Kokoro model needs WebGPU and audio playback, which the service worker doesn't have.
// It turns sentences into audio on this computer, plays them, and reads ahead a few sentences
// so playback doesn't stall.
import { KokoroTTS, env } from './kokoro.bundle.js';

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const CACHE_LIMIT = 40;

env.allowLocalModels = false;
env.backends.onnx.wasm.wasmPaths = new URL('./ort/', import.meta.url).href;

let ttsPromise = null;
let current = null;     // id of the sentence that should be playing
let player = null;      // the <audio> element for it
const clips = new Map(); // `${voice}|${text}` -> { promise, started, cancelled, url }
// The model makes one clip at a time. What the reader is waiting to hear goes to the front of
// the line, ahead of read-ahead work, so jumping somewhere doesn't wait behind sentences that
// were being prepared for where it used to be.
const waiting = [];
let generating = false;

function emit(id, ev) {
  chrome.runtime.sendMessage({ type: 'aiEvent', id, ev }).catch(() => {});
}

function loadModel(id) {
  if (!ttsPromise) {
    ttsPromise = (async () => {
      const adapter = navigator.gpu && (await navigator.gpu.requestAdapter().catch(() => null));
      if (!adapter) throw new Error('AI voices need WebGPU, which this computer or browser does not support.');
      let lastPct = -1;
      const tts = await KokoroTTS.from_pretrained(MODEL_ID, {
        dtype: 'fp32',
        device: 'webgpu',
        progress_callback: (p) => {
          if (p.status !== 'progress' || !p.file?.endsWith('.onnx')) return;
          const pct = Math.floor(p.progress);
          if (pct === lastPct || (pct < 100 && pct - lastPct < 2)) return;
          lastPct = pct;
          // Also fires when reading from the local cache, so say "loading", not "downloading".
          emit(current ?? id, { type: 'progress', message: `Loading AI voice ${pct}%` });
        },
      });
      emit(current ?? id, { type: 'progress', message: 'Warming up AI voice…' });
      await tts.generate('Ready.', { voice: 'af_heart' }); // compiles the GPU shaders once
      return tts;
    })();
    ttsPromise.catch(() => { ttsPromise = null; });
  }
  return ttsPromise;
}

function cancel(entry) {
  entry.cancelled = true;
  const i = waiting.indexOf(entry);
  if (i >= 0) waiting.splice(i, 1);
  if (!entry.started) entry.reject(new Error('cancelled'));
}

function getClip(text, voice, id, urgent = false) {
  const key = `${voice}|${text}`;
  const hit = clips.get(key);
  if (hit && !hit.cancelled) {
    clips.delete(key); // re-insert to mark it recently used
    clips.set(key, hit);
    const i = waiting.indexOf(hit);
    if (urgent && i > 0) waiting.unshift(...waiting.splice(i, 1));
    return hit.promise;
  }
  const entry = { key, text, voice, id, started: false, cancelled: false, url: null };
  entry.promise = new Promise((resolve, reject) => Object.assign(entry, { resolve, reject }));
  entry.promise.catch(() => { if (clips.get(key) === entry) clips.delete(key); });
  clips.set(key, entry);
  if (urgent) waiting.unshift(entry);
  else waiting.push(entry);
  while (clips.size > CACHE_LIMIT) {
    const [oldKey, old] = clips.entries().next().value;
    if (old.url) URL.revokeObjectURL(old.url);
    clips.delete(oldKey);
    cancel(old);
  }
  generateNext();
  return entry.promise;
}

async function generateNext() {
  if (generating) return;
  generating = true;
  while (waiting.length) {
    const entry = waiting.shift();
    entry.started = true;
    try {
      const tts = await loadModel(entry.id);
      const audio = await tts.generate(entry.text, { voice: entry.voice });
      entry.url = URL.createObjectURL(audio.toBlob());
      entry.resolve({ url: entry.url, duration: audio.audio.length / audio.sampling_rate });
    } catch (err) {
      entry.reject(err);
    }
  }
  generating = false;
}

function stopAudio() {
  if (player) {
    player.onended = player.onerror = null;
    player.pause();
    player = null;
  }
}

async function speak({ id, text, voice, rate, upcoming = [] }) {
  stopAudio();
  current = id;
  // Drop read-ahead work that's no longer needed (e.g. the reader jumped elsewhere).
  const wanted = new Set([text, ...upcoming].map((t) => `${voice}|${t}`));
  for (const [key, entry] of clips) {
    if (!entry.started && !wanted.has(key)) {
      clips.delete(key);
      cancel(entry);
    }
  }
  let clip;
  try {
    clip = await getClip(text, voice, id, true);
  } catch (err) {
    if (current === id && err.message !== 'cancelled') emit(id, { type: 'error', errorMessage: err.message });
    return;
  }
  for (const t of upcoming) getClip(t, voice, id).catch(() => {});
  if (current !== id) return;

  const audio = new Audio(clip.url);
  audio.preservesPitch = true;
  audio.playbackRate = rate;
  audio.onended = () => { if (current === id) emit(id, { type: 'end' }); };
  audio.onerror = () => { if (current === id) emit(id, { type: 'error', errorMessage: 'Audio playback failed' }); };
  player = audio;
  try {
    await audio.play();
  } catch (err) {
    if (current === id) emit(id, { type: 'error', errorMessage: err.message });
    return;
  }
  if (current === id) emit(id, { type: 'start', duration: clip.duration / rate });
}

// Free the model's memory when the AI voice hasn't been used for a while.
const IDLE_MS = 10 * 60 * 1000;
let idleTimer = null;
function touch() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => chrome.runtime.sendMessage({ type: 'aiIdle' }).catch(() => {}), IDLE_MS);
}
touch();

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== 'offscreen') return;
  touch();
  if (msg.type === 'speak') speak(msg);
  else if (msg.type === 'stop') {
    current = null;
    stopAudio();
  }
});
