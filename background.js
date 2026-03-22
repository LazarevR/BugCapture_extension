/**
 * BugCapture — background service worker (Manifest V3)
 *
 * Отвечает за:
 * - Создание offscreen document (запись идёт там через getUserMedia)
 * - Получение streamId через chrome.tabCapture.getMediaStreamId() БЕЗ consumerTabId
 * - Передачу streamId в offscreen document (НЕ в content script)
 * - Переключение между «идёт запись» / «показать модалку»
 * - Управление бейджем иконки
 * - Хранение настроек
 *
 * КЛЮЧЕВОЕ: ensureOffscreen() вызывается ДО getMediaStreamId().
 * Это гарантирует, что когда offscreen получит streamId и вызовет getUserMedia,
 * streamId ещё не протух (Chrome даёт ограниченное время на использование).
 */

'use strict';

const DEFAULT_SETTINGS = {
  bufferSeconds: 15,
  saveFormat: 'mp4',
  hotkey: ''
};

const RESTRICTED_URL = /^(chrome|chrome-extension|devtools|edge|brave|about|data|javascript|blob):/;
const OFFSCREEN_URL  = chrome.runtime.getURL('offscreen.html');

// Состояние конвертации MP4 (in-memory, выживает при перезагрузке вкладки).
// offscreen document выполняет ffmpeg, progress идёт через здесь → content script.
const convState = {
  status:    'idle', // 'idle' | 'converting' | 'done' | 'error'
  tabId:     null,
  pct:       0,
  label:     '',
  base64Mp4: null,
  mimeType:  null,
};

// ─── Инициализация ────────────────────────────────────────────────────────────

// Прогреваем offscreen сразу при старте service worker (до первого события).
// Когда onTabUpdated сработает, offscreen уже будет готов и getMediaStreamId
// будет использован практически мгновенно — streamId не успеет протухнуть.
ensureOffscreen().catch(() => {});

chrome.runtime.onInstalled.addListener(onInstalled);
chrome.runtime.onStartup.addListener(onStartup);
chrome.action.onClicked.addListener(onActionClicked);
chrome.runtime.onMessage.addListener(onMessage);
chrome.tabs.onRemoved.addListener(onTabRemoved);
chrome.tabs.onUpdated.addListener(onTabUpdated);
chrome.tabs.onUpdated.addListener(onTabUpdatedAutoStart);

chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId)
    .then(tab => { if (isCapturableTab(tab)) startCapture(tabId, true); })
    .catch(() => {});
});

function onInstalled(details) {
  if (details.reason === 'install') {
    chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
  }
  ensureOffscreen().catch(() => {});
  tryStartCaptureOnActiveTab();
}

function onStartup() {
  ensureOffscreen().catch(() => {});
  tryStartCaptureOnActiveTab();
}

async function tryStartCaptureOnActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && isCapturableTab(tab)) startCapture(tab.id, true);
  } catch {}
}

// ─── Проверка вкладки ─────────────────────────────────────────────────────────

function isCapturableTab(tab) {
  if (!tab?.url) return false;
  return !RESTRICTED_URL.test(tab.url);
}

// ─── Offscreen document ───────────────────────────────────────────────────────

async function ensureOffscreen() {
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [OFFSCREEN_URL]
    });
    if (contexts.length > 0) return; // уже существует
  }

  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['USER_MEDIA'],
      justification: 'Запись вкладки через tabCapture getUserMedia'
    });
  } catch (e) {
    // Игнорируем ошибку "only one offscreen document" — значит уже создан
    const msg = e?.message || '';
    if (!msg.includes('only one') && !msg.includes('Only a single')) throw e;
  }
}

async function sendToOffscreen(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch {
    return null;
  }
}

async function getOffscreenStatus() {
  return await sendToOffscreen({ type: 'OFFSCREEN_STATUS' });
}

// ─── Клик по иконке ──────────────────────────────────────────────────────────
//
// КЛЮЧЕВОЕ: getMediaStreamId вызывается СИНХРОННО в теле onActionClicked,
// до любых await. Chrome проверяет право на захват в момент вызова API.
// После await контекст пользовательского жеста может быть потерян.

function onActionClicked(tab) {
  if (!tab?.id) return;
  const tabId = tab.id;

  if (!isCapturableTab(tab)) {
    notifyTab(tabId, {
      type: 'BUGCAPTURE_ERROR',
      error: 'restricted_url',
      message: 'Расширение не работает на системных страницах браузера.\nОткройте обычный сайт.'
    });
    return;
  }

  // Запрашиваем streamId сразу — до await, пока есть контекст жеста
  chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, async (freshStreamId) => {
    const streamErr = chrome.runtime.lastError?.message;

    // Проверяем статус уже после получения streamId
    const status = await getOffscreenStatus();

    if (status?.isCapturing && status?.tabId === tabId) {
      // Запись идёт — открываем модалку (freshStreamId истечёт сам)
      await triggerSaveModal(tabId);
      return;
    }

    // Запись не идёт — запускаем с полученным streamId
    if (streamErr || !freshStreamId) {
      await notifyTab(tabId, {
        type: 'BUGCAPTURE_ERROR',
        error: 'capture_failed',
        message: sanitize(streamErr || 'нет streamId')
      });
      return;
    }

    try {
      await ensureOffscreen();
    } catch (e) {
      await notifyTab(tabId, { type: 'BUGCAPTURE_ERROR', error: 'capture_failed', message: sanitize(e?.message) });
      return;
    }

    const settings = await getSettings();
    const resp = await sendToOffscreen({ type: 'OFFSCREEN_START', streamId: freshStreamId, settings, tabId });

    if (resp?.ok) {
      updateBadge(tabId, true);
    } else {
      await notifyTab(tabId, {
        type: 'BUGCAPTURE_ERROR',
        error: 'capture_failed',
        message: sanitize(resp?.error || 'getUserMedia failed')
      });
    }
  });
}

// ─── Запуск захвата ───────────────────────────────────────────────────────────
//
// КЛЮЧЕВОЕ: getMediaStreamId вызывается ПЕРВЫМ — до await ensureOffscreen.
// Chrome проверяет право захвата в момент вызова API.
// Если до этого был await — Chrome может считать вызов вне контекста жеста
// и отказать в захвате даже при наличии host_permissions.
//
// silent = true → не показывать ошибки пользователю (авто-старт)

function startCapture(tabId, silent = false, retries = 5) {
  // Вызываем getMediaStreamId СРАЗУ — до любых await
  chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, async (streamId) => {
    const errMsg = chrome.runtime.lastError?.message;

    if (errMsg || !streamId) {
      console.warn('[BugCapture] getMediaStreamId failed:', errMsg, { tabId, retries, silent });

      if (!silent) {
        await notifyTab(tabId, {
          type: 'BUGCAPTURE_ERROR',
          error: 'capture_failed',
          message: sanitize(errMsg || 'нет streamId')
        });
        return;
      }

      // Тихий режим — повторяем
      if (retries > 0) {
        setTimeout(async () => {
          try {
            const tab = await chrome.tabs.get(tabId);
            if (tab?.active && isCapturableTab(tab)) startCapture(tabId, true, retries - 1);
          } catch {}
        }, 2000);
      }
      return;
    }

    // streamId получен — теперь проверяем не запущена ли уже запись
    try {
      const status = await getOffscreenStatus();
      if (status?.isCapturing && status?.tabId === tabId) return;
    } catch {}

    // Убеждаемся что offscreen запущен (быстро если уже существует)
    try {
      await ensureOffscreen();
    } catch (e) {
      const msg = sanitize(e?.message || 'Ошибка offscreen');
      console.error('[BugCapture] ensureOffscreen failed:', msg);
      if (!silent) await notifyTab(tabId, { type: 'BUGCAPTURE_ERROR', error: 'capture_failed', message: msg });
      return;
    }

    const settings = await getSettings();

    const resp = await sendToOffscreen({
      type: 'OFFSCREEN_START',
      streamId,
      settings,
      tabId
    });

    if (resp?.ok) {
      updateBadge(tabId, true);
    } else {
      const startErr = resp?.error || 'getUserMedia failed';
      console.warn('[BugCapture] OFFSCREEN_START failed:', startErr, { tabId, retries, silent });

      if (!silent) {
        await notifyTab(tabId, {
          type: 'BUGCAPTURE_ERROR',
          error: 'capture_failed',
          message: sanitize(startErr)
        });
      } else if (retries > 0) {
        setTimeout(async () => {
          try {
            const tab = await chrome.tabs.get(tabId);
            if (tab?.active && isCapturableTab(tab)) startCapture(tabId, true, retries - 1);
          } catch {}
        }, 2000);
      }
    }
  });
}

// ─── Сохранение записи (клик по иконке во время записи) ──────────────────────

async function triggerSaveModal(tabId) {
  // Не убираем бейдж заранее: если данных нет (запись только стартовала),
  // getBlobAsync вернёт ошибку без остановки рекордера — бейдж должен остаться.
  const blobResult = await sendToOffscreen({ type: 'OFFSCREEN_GET_BLOB' });

  console.log('[BugCapture:bg] triggerSaveModal: blobResult ok=', blobResult?.ok, 'base64Data length=', blobResult?.base64Data?.length, 'error=', blobResult?.error);

  if (!blobResult?.ok || !blobResult.base64Data) {
    const errMsg = blobResult?.error || 'Нет данных для сохранения';
    // Проверяем, продолжает ли запись идти (ошибка «нет данных» не останавливает запись)
    const status = await getOffscreenStatus();
    if (!status?.isCapturing || status?.tabId !== tabId) {
      updateBadge(tabId, false);
    }
    await notifyTab(tabId, {
      type: 'BUGCAPTURE_ERROR',
      error: 'capture_failed',
      message: sanitize(errMsg)
    });
    return;
  }

  // Запись успешно остановлена — снимаем бейдж
  updateBadge(tabId, false);

  // base64Data уже готова (закодирована в offscreen до передачи через IPC)
  const base64Data = blobResult.base64Data;

  const settings = await getSettings();
  await ensureContentScript(tabId);
  await sendToTab(tabId, {
    type:          'BUGCAPTURE_SHOW_MODAL',
    base64Data,
    mimeType:      blobResult.mimeType,
    bufferDuration: blobResult.bufferDuration ?? null,
    settings,
    // Запись до перезагрузки страницы (если есть)
    prevBase64Data: blobResult.prevBase64Data || null,
    prevMimeType:   blobResult.prevMimeType   || null
  });
}

// ─── Очистка при закрытии/навигации вкладки ──────────────────────────────────

function onTabRemoved(tabId) {
  updateBadge(tabId, false);
  getOffscreenStatus().then(status => {
    if (status?.tabId === tabId) sendToOffscreen({ type: 'OFFSCREEN_STOP' });
  }).catch(() => {});
}

function onTabUpdated(tabId, changeInfo) {
  if (changeInfo.status === 'loading') {
    // Сбрасываем бейдж — запись прервётся естественно, когда Chrome завершит поток.
    // Не посылаем OFFSCREEN_STOP: это уничтожает буфер ДО перезагрузки.
    // Вместо этого offscreen.js сохранит данные через videoTrack.onended → saveCurrentDataAsPrev.
    updateBadge(tabId, false);
  }
}

function onTabUpdatedAutoStart(tabId, changeInfo, tab) {
  if (changeInfo.status !== 'complete') return;
  if (!tab?.active) return;
  if (!isCapturableTab(tab)) return;
  startCapture(tabId, true);
}

// ─── Сообщения ────────────────────────────────────────────────────────────────

function onMessage(message, sender, sendResponse) {
  if (!message?.type) return false;

  const tabId = sender.tab?.id;

  switch (message.type) {

    case 'BUGCAPTURE_GET_SETTINGS':
      getSettings().then(s => sendResponse({ settings: s }));
      return true;

    case 'BUGCAPTURE_SAVE_SETTINGS':
      if (message.settings && typeof message.settings === 'object') {
        const validated = validateSettings(message.settings);
        chrome.storage.local.set({ settings: validated }, () => {
          sendResponse({ ok: true });
        });
        if (tabId) {
          chrome.tabs.sendMessage(tabId, {
            type: 'BUGCAPTURE_SETTINGS_UPDATED',
            hotkey: validated.hotkey
          }).catch(() => {});
        }
        return true;
      }
      break;

    case 'BUGCAPTURE_AUTO_START':
      // Content script просит перезапустить буфер (после закрытия модалки)
      if (tabId) {
        chrome.tabs.get(tabId)
          .then(tab => { if (isCapturableTab(tab)) startCapture(tabId, true); })
          .catch(() => {});
      }
      break;

    case 'BUGCAPTURE_RECORDING_STOPPED':
      if (tabId) updateBadge(tabId, false);
      break;

    case 'BUGCAPTURE_TRIGGER':
      if (tabId) {
        chrome.tabs.get(tabId).then(tab => onActionClicked(tab)).catch(() => {});
      }
      break;

    case 'OFFSCREEN_RECORDING_ENDED':
      if (message.tabId) {
        updateBadge(message.tabId, false);
        // Поток прервался (навигация/перезагрузка) — перезапускаем буфер
        const endedTabId = message.tabId;
        chrome.tabs.get(endedTabId).then(tab => {
          if (tab?.active && isCapturableTab(tab)) startCapture(endedTabId, true);
        }).catch(() => {});
      }
      break;

    // ─── Конвертация MP4 ──────────────────────────────────────────────────────

    case 'BUGCAPTURE_START_CONVERSION': {
      const cTabId = sender.tab?.id ?? null;
      convState.status    = 'converting';
      convState.tabId     = cTabId;
      convState.pct       = 0;
      convState.label     = '';
      convState.base64Mp4 = null;
      convState.mimeType  = null;
      sendToOffscreen({
        type:        'OFFSCREEN_CONV_START',
        inputBase64: message.inputBase64,
        inputMime:   message.inputMime,
        trimStart:   message.trimStart,
        trimEnd:     message.trimEnd,
      }).catch(() => {});
      sendResponse({ ok: true });
      return true;
    }

    case 'BUGCAPTURE_GET_CONV_STATE':
      sendResponse({
        status:    convState.status,
        pct:       convState.pct,
        label:     convState.label,
        base64Mp4: convState.status === 'done' ? convState.base64Mp4 : null,
        mimeType:  convState.mimeType,
      });
      break;

    case 'BUGCAPTURE_CONV_RESULT_TAKEN':
      if (convState.status === 'done') {
        convState.status    = 'idle';
        convState.base64Mp4 = null;
      }
      sendResponse({ ok: true });
      break;

    // Прогресс/результат от offscreen → перенаправляем в вкладку

    case 'OFFSCREEN_CONV_PROGRESS':
      convState.pct   = message.pct;
      convState.label = message.label || '';
      if (convState.tabId != null) {
        sendToTab(convState.tabId, {
          type:  'BUGCAPTURE_CONV_PROGRESS',
          pct:   message.pct,
          label: message.label,
        });
      }
      break;

    case 'OFFSCREEN_CONV_DONE':
      convState.status    = 'done';
      convState.base64Mp4 = message.base64Mp4;
      convState.mimeType  = message.mimeType || 'video/mp4';
      if (convState.tabId != null) {
        (async () => {
          await ensureContentScript(convState.tabId);
          await sendToTab(convState.tabId, {
            type:      'BUGCAPTURE_CONV_DONE',
            base64Mp4: message.base64Mp4,
            mimeType:  message.mimeType,
          });
        })().catch(() => {});
      }
      break;

    case 'OFFSCREEN_CONV_ERROR':
      convState.status = 'error';
      if (convState.tabId != null) {
        sendToTab(convState.tabId, {
          type:    'BUGCAPTURE_CONV_ERROR',
          message: message.message,
        });
      }
      break;

  }

  return false;
}

// ─── Утилиты ─────────────────────────────────────────────────────────────────

async function sendToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    return null;
  }
}

async function notifyTab(tabId, message) {
  await ensureContentScript(tabId);
  await sendToTab(tabId, message);
}

async function ensureContentScript(tabId) {
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { type: 'BUGCAPTURE_PING' });
    if (pong?.pong) return;
  } catch {}
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    await new Promise(r => setTimeout(r, 250));
  } catch {}
}

function updateBadge(tabId, isRecording) {
  if (isRecording) {
    chrome.action.setBadgeText({ text: '●', tabId }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ color: '#e74c3c', tabId }).catch(() => {});
    chrome.action.setTitle({ title: 'BugCapture — идёт запись (нажми для сохранения)', tabId }).catch(() => {});
  } else {
    chrome.action.setBadgeText({ text: '', tabId }).catch(() => {});
    chrome.action.setTitle({ title: 'BugCapture — нажми для записи', tabId }).catch(() => {});
  }
}

async function getSettings() {
  return new Promise(resolve => {
    chrome.storage.local.get('settings', result => {
      resolve(validateSettings(result.settings || {}));
    });
  });
}

function validateSettings(raw) {
  if (!raw || typeof raw !== 'object') raw = {};
  const bufSec = parseInt(raw.bufferSeconds, 10);
  return {
    bufferSeconds: (!isNaN(bufSec) && bufSec >= 5 && bufSec <= 40) ? bufSec : 15,
    saveFormat: (raw.saveFormat === 'mp4' || raw.saveFormat === 'webm') ? raw.saveFormat : 'mp4',
    hotkey: (typeof raw.hotkey === 'string' && raw.hotkey.length <= 50)
      ? raw.hotkey.replace(/[<>"'`]/g, '')
      : ''
  };
}

function sanitize(msg) {
  if (typeof msg !== 'string') return 'Неизвестная ошибка';
  return msg.replace(/https?:\/\/[^\s]*/g, '[URL]').substring(0, 200);
}

