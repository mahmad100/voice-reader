// Wren service worker: injects the reader into tabs and owns the chrome.tts engine.
// Speech runs here (not in the page) so it needs no page click to start and isn't
// affected by the site's own scripts or security policy.

importScripts('wren-mark.js');

const MENU_PAGE = 'vr-read-page';
const MENU_SELECTION = 'vr-read-selection';
const MENU_SELECTION_ONLY = 'vr-read-selection-only';

// Natural voices generated on this computer by the Kokoro model (see offscreen/offscreen.js).
const AI_VOICES = [
  ['af_heart', 'Heart (US, female)', 'en-US'],
  ['af_bella', 'Bella (US, female)', 'en-US'],
  ['af_nicole', 'Nicole (US, female, soft)', 'en-US'],
  ['af_aoede', 'Aoede (US, female)', 'en-US'],
  ['am_michael', 'Michael (US, male)', 'en-US'],
  ['am_fenrir', 'Fenrir (US, male)', 'en-US'],
  ['am_puck', 'Puck (US, male)', 'en-US'],
  ['bf_emma', 'Emma (UK, female)', 'en-GB'],
  ['bm_george', 'George (UK, male)', 'en-GB'],
  ['bm_fable', 'Fable (UK, male)', 'en-GB'],
].map(([id, name, lang]) => ({ voiceName: `AI: ${name}`, aiVoice: id, lang, engine: 'ai', remote: false, eventTypes: null }));

let speakingTab = null;
let aiTarget = null; // { tabId, frameId } that AI voice events go to
let creatingOffscreen = null;

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  creatingOffscreen ??= chrome.offscreen.createDocument({
    url: 'offscreen/offscreen.html',
    reasons: ['AUDIO_PLAYBACK', 'WORKERS'],
    justification: 'Generates and plays speech with the on-device AI voice.',
  }).finally(() => { creatingOffscreen = null; });
  await creatingOffscreen;
}

// The toolbar icon shows the logo and color chosen on the player bar, and sways while its tab
// is reading.
let look = { logo: 'soundtail', color: 'ember' };
let iconAnim = null; // { tabId, timer }
const iconCanvases = [[16, 0], [32, 1]].map(([size, pad]) => [size, pad, new OffscreenCanvas(size, size).getContext('2d')]);

function iconImages(levels) {
  const imageData = {};
  for (const [size, pad, ctx] of iconCanvases) {
    WREN_MARK.draw(ctx, size, { shape: look.logo, color: look.color, levels, pad });
    imageData[size] = ctx.getImageData(0, 0, size, size);
  }
  return imageData;
}

function setToolbarIcon() {
  chrome.action.setIcon({ imageData: iconImages() }).catch(() => {});
}

chrome.storage.sync.get(look).then((stored) => {
  look = stored;
  setToolbarIcon();
}).catch(() => {});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync' || !(changes.logo || changes.color)) return;
  look = { logo: changes.logo?.newValue ?? look.logo, color: changes.color?.newValue ?? look.color };
  setToolbarIcon();
});

function startIconAnim(tabId) {
  if (iconAnim?.tabId === tabId) return;
  stopIconAnim();
  const t0 = performance.now();
  const timer = setInterval(() => {
    const imageData = iconImages(WREN_MARK.levels((performance.now() - t0) / 1000));
    chrome.action.setIcon({ tabId, imageData }).catch(() => stopIconAnim());
  }, 100);
  iconAnim = { tabId, timer };
}

function stopIconAnim(tabId = iconAnim?.tabId) {
  if (!iconAnim || iconAnim.tabId !== tabId) return;
  clearInterval(iconAnim.timer);
  iconAnim = null;
  chrome.action.setIcon({ tabId, imageData: iconImages() }).catch(() => {});
}

async function stopAll() {
  chrome.tts.stop();
  if (await hasOffscreen()) chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop' }).catch(() => {});
}

// Wake at browser start, so the toolbar icon is set from the chosen logo (above).
chrome.runtime.onStartup.addListener(() => {});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: MENU_PAGE, title: 'Read this page aloud', contexts: ['page'] });
  chrome.contextMenus.create({ id: MENU_SELECTION_ONLY, title: 'Read selected text', contexts: ['selection'] });
  chrome.contextMenus.create({ id: MENU_SELECTION, title: 'Read aloud from here', contexts: ['selection'] });
});

chrome.action.onClicked.addListener((tab) => sendToTab(tab, { type: 'toggle' }));

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'toggle-reading') sendToTab(tab, { type: 'toggle' });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const type = { [MENU_SELECTION]: 'readSelection', [MENU_SELECTION_ONLY]: 'readSelectionOnly' }[info.menuItemId] || 'readPage';
  sendToTab(tab, { type });
});

// Deliver a command to the tab's reader, injecting it first if it isn't there yet.
async function sendToTab(tab, msg) {
  if (!tab?.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, msg);
    return;
  } catch {
    // No reader in this tab yet.
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['wren-mark.js', 'math-speech.js', 'content.js'] });
    await chrome.tabs.sendMessage(tab.id, msg);
  } catch (err) {
    // chrome:// pages, the Web Store and Chrome's PDF viewer can't be scripted.
    console.warn('[Wren] cannot read this tab:', err?.message);
    chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: '#d93025' });
    chrome.action.setBadgeText({ tabId: tab.id, text: '!' });
    chrome.action.setTitle({ tabId: tab.id, title: "Wren can't read this page" });
    setTimeout(() => chrome.action.setBadgeText({ tabId: tab.id, text: '' }).catch(() => {}), 4000);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target === 'offscreen') return; // meant for the AI voice page, not us
  switch (msg.type) {
    case 'getVoices':
      chrome.tts.getVoices((voices) => {
        sendResponse([...AI_VOICES, ...voices.map((v) => ({
          voiceName: v.voiceName,
          lang: v.lang || '',
          engine: 'chrome',
          remote: !!v.remote,
          eventTypes: v.eventTypes || null,
        }))]);
      });
      return true;

    case 'speak': {
      const tabId = sender.tab?.id;
      const frameId = sender.frameId;
      // Reading started in another tab: tell the old tab it has been paused.
      if (speakingTab != null && speakingTab !== tabId) {
        chrome.tabs.sendMessage(speakingTab, { type: 'externalStop' }).catch(() => {});
      }
      speakingTab = tabId;
      const ai =AI_VOICES.find((v) => v.voiceName === msg.voiceName);
      if (ai) {
        chrome.tts.stop();
        aiTarget = { tabId, frameId };
        ensureOffscreen().then(() => chrome.runtime.sendMessage({
          target: 'offscreen', type: 'speak', id: msg.id, text: msg.text, voice: ai.aiVoice,
          rate: msg.rate, upcoming: msg.upcoming || [],
        })).catch((err) => {
          chrome.tabs.sendMessage(tabId, { type: 'ttsEvent', id: msg.id, ev: { type: 'error', errorMessage: err.message } }, { frameId })
            .catch(() => {});
        });
        sendResponse({ ok: true });
        return;
      }
      hasOffscreen().then((has) => {
        if (has) chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop' }).catch(() => {});
      });
      const options = {
        rate: msg.rate,
        enqueue: false,
        onEvent: (ev) => {
          chrome.tabs.sendMessage(tabId, {
            type: 'ttsEvent',
            id: msg.id,
            ev: { type: ev.type, charIndex: ev.charIndex, length: ev.length, errorMessage: ev.errorMessage },
          }, { frameId }).catch(() => {});
        },
      };
      if (msg.voiceName) options.voiceName = msg.voiceName;
      if (msg.lang) options.lang = msg.lang;
      chrome.tts.speak(msg.text, options);
      sendResponse({ ok: true });
      return;
    }

    case 'stop':
      // Only the tab that is speaking may stop speech, so a paused tab can't cut off another.
      // (null means this worker restarted and lost track, so allow it.)
      if (speakingTab == null || sender.tab?.id === speakingTab) {
        stopAll();
        speakingTab = null;
      }
      sendResponse({ ok: true });
      return;

    case 'iconState':
      if (msg.playing) startIconAnim(sender.tab?.id);
      else stopIconAnim(sender.tab?.id);
      return;

    case 'aiEvent':
      // From the AI voice page: pass playback progress on to the tab that's reading.
      if (aiTarget) {
        chrome.tabs.sendMessage(aiTarget.tabId, { type: 'ttsEvent', id: msg.id, ev: msg.ev }, { frameId: aiTarget.frameId })
          .catch(() => {});
      }
      return;

    case 'aiIdle':
      chrome.offscreen.closeDocument().catch(() => {});
      return;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (iconAnim?.tabId === tabId) {
    clearInterval(iconAnim.timer);
    iconAnim = null;
  }
  if (tabId === speakingTab) {
    stopAll();
    speakingTab = null;
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') stopIconAnim(tabId);
  if (tabId === speakingTab && changeInfo.status === 'loading') {
    stopAll();
    speakingTab = null;
  }
});
