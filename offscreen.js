'use strict';

/**
 * BugCapture — offscreen document
 *
 * Пишет видео СЕССИЯМИ по bufferSeconds секунд.
 * После завершения сессии сохраняет blob и немедленно начинает новую.
 * При запросе OFFSCREEN_GET_BLOB — останавливает текущую сессию
 * и возвращает последний готовый blob (или текущий, если в нём уже
 * есть данные).
 *
 * Каждая сессия использует НОВЫЙ MediaRecorder → временные метки
 * WebM всегда начинаются с 0 → файл всегда корректно воспроизводится.
 *
 * Протокол (chrome.runtime.onMessage от background.js):
 *   OFFSCREEN_STATUS    {}                             → { isCapturing, tabId }
 *   OFFSCREEN_START     { streamId, settings, tabId } → { ok } / { ok, error }
 *   OFFSCREEN_STOP      {}                             → { ok }
 *   OFFSCREEN_GET_BLOB  {}                             → { ok, arrayBuffer, mimeType, bufferDuration }
 */

let stream      = null;
let mimeType    = 'video/webm';
let isCapturing = false;
let activeTabId = null;
let bufferSeconds = 15;

// Данные текущей сессии
let recorder    = null;
let chunks      = [];

// Последний завершённый сессионный blob (резерв, если текущая сессия пуста)
let latestBlob  = null;

// Blob из ПРЕДЫДУЩЕГО потока (до перезагрузки страницы).
// Сохраняется когда поток обрывается естественно (навигация),
// чтобы объединить с новой записью при сохранении.
let prevBlob     = null;
let prevBlobMime = null;

// Таймер автоматической ротации сессии
let sessionTimer = null;

// Ожидающий resolve/reject от getBlobAsync
let pendingResolve = null;
let pendingReject  = null;

// ─── Конвертация MP4 (ffmpeg.wasm, работает в offscreen → выживает при перезагрузке страницы) ──
let convFFmpeg   = null;
let isConverting = false;

// Момент начала текущей сессии (для определения короткой сессии при остановке)
let sessionStartTime = 0;

// ─── Обработчик сообщений ────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message?.type) return false;

  switch (message.type) {

    case 'OFFSCREEN_STATUS':
      sendResponse({ isCapturing, tabId: activeTabId });
      break;

    case 'OFFSCREEN_START':
      startCapture(message.streamId, message.settings, message.tabId)
        .then(() => sendResponse({ ok: true }))
        .catch(e => sendResponse({ ok: false, error: e.message }));
      return true; // async

    case 'OFFSCREEN_STOP':
      cleanup();
      sendResponse({ ok: true });
      break;

    case 'OFFSCREEN_CONV_START':
      if (isConverting) {
        sendResponse({ ok: false, error: 'Конвертация уже идёт' });
        break;
      }
      startConversion(message).catch(e =>
        chrome.runtime.sendMessage({ type: 'OFFSCREEN_CONV_ERROR', message: e.message }).catch(() => {})
      );
      sendResponse({ ok: true });
      break;

    case 'OFFSCREEN_CONV_CANCEL':
      if (convFFmpeg) {
        try { convFFmpeg.terminate(); } catch {}
        convFFmpeg = null;
      }
      isConverting = false;
      sendResponse({ ok: true });
      break;

    case 'OFFSCREEN_GET_BLOB':
      getBlobAsync()
        .then(result => sendResponse(result))
        .catch(e => sendResponse({ ok: false, error: e.message }));
      return true; // async
  }

  return false;
});

// ─── Запуск захвата ───────────────────────────────────────────────────────────

async function startCapture(streamId, settings, tabId) {
  if (isCapturing) {
    if (activeTabId === tabId) return; // уже пишем эту вкладку
    // Другая вкладка — сбрасываем предыдущий буфер (не относится к этой вкладке)
    prevBlob = null;
    prevBlobMime = null;
    cleanup();
  }

  bufferSeconds = Math.max(5, Math.min(40, settings?.bufferSeconds || 15));
  activeTabId   = tabId;

  const constraints = {
    video: {
      mandatory: {
        chromeMediaSource:   'tab',
        chromeMediaSourceId: streamId
      }
    },
    audio: false
  };

  stream = await navigator.mediaDevices.getUserMedia(constraints);

  const hasAudio = stream.getAudioTracks().length > 0;
  mimeType   = getSupportedMimeType(hasAudio);
  chunks     = [];
  latestBlob = null;
  isCapturing = true;

  beginSession();
}

// ─── Сохранение текущих данных как prevBlob (при естественном обрыве потока) ──

function saveCurrentDataAsPrev() {
  // Берём текущие накопленные чанки или последний готовый blob
  const currentData = chunks.length > 0
    ? new Blob(chunks, { type: mimeType })
    : latestBlob;

  if (currentData) {
    prevBlob     = currentData;
    prevBlobMime = mimeType;
    console.log('[BugCapture:offscreen] saveCurrentDataAsPrev: saved', currentData.size, 'bytes as prevBlob');
  }
}

// ─── Начало новой сессии ──────────────────────────────────────────────────────

function beginSession() {
  chunks = [];

  try {
    // Новый MediaRecorder на каждую сессию → временные метки WebM начинаются с 0
    recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: 2_500_000
    });
  } catch (e) {
    cleanup();
    return;
  }

  recorder.ondataavailable = e => {
    if (e.data?.size > 0) {
      chunks.push(e.data);
      console.log('[BugCapture:offscreen] chunk #' + chunks.length + ' size=' + e.data.size + ' totalChunks=' + chunks.length);
    }
  };

  recorder.onstop = handleSessionStop;

  recorder.onerror = () => {
    const tabId = activeTabId;
    saveCurrentDataAsPrev();
    cleanup();
    chrome.runtime.sendMessage({ type: 'OFFSCREEN_RECORDING_ENDED', tabId }).catch(() => {});
  };

  // Следим за окончанием потока (навигация / закрытие вкладки)
  const videoTrack = stream?.getVideoTracks()[0];
  if (videoTrack) {
    videoTrack.onended = () => {
      const tabId = activeTabId;
      saveCurrentDataAsPrev();
      cleanup();
      chrome.runtime.sendMessage({ type: 'OFFSCREEN_RECORDING_ENDED', tabId }).catch(() => {});
    };
  }

  sessionStartTime = Date.now();
  recorder.start(1000); // чанк раз в секунду
  console.log('[BugCapture:offscreen] beginSession: recorder started, mimeType=' + mimeType + ' bufferSeconds=' + bufferSeconds);

  // Автоматическая ротация по истечении bufferSeconds
  sessionTimer = setTimeout(rotateSession, bufferSeconds * 1000);
}

// ─── Ротация по таймеру ───────────────────────────────────────────────────────

function rotateSession() {
  if (recorder && recorder.state === 'recording') {
    recorder.stop(); // → handleSessionStop (pendingResolve === null → beginSession)
  }
}

// ─── Обработчик onstop ────────────────────────────────────────────────────────

function handleSessionStop() {
  clearTimeout(sessionTimer);
  sessionTimer = null;

  if (chunks.length > 0) {
    const currentBlob = new Blob(chunks, { type: mimeType });
    chunks = [];

    if (pendingResolve && latestBlob && (Date.now() - sessionStartTime) < bufferSeconds * 750) {
      // Пользователь кликнул вскоре после ротации (текущая сессия < 75% bufferSeconds).
      // Сохраняем latestBlob — он содержит полную предыдущую ротацию (bufferSeconds).
      // currentBlob (короткий отрезок) отбрасываем.
      console.log('[BugCapture:offscreen] handleSessionStop: short session, keeping latestBlob');
    } else {
      latestBlob = currentBlob;
    }
  }

  if (pendingResolve) {
    // Запрос от пользователя (кликнул иконку) — отдаём данные
    deliverBlob();
  } else if (isCapturing) {
    // Плановая ротация — запускаем новую сессию
    beginSession();
  }
}

// ─── Отдать blob вызывающей стороне ──────────────────────────────────────────

function deliverBlob() {
  const resolve = pendingResolve;
  const reject  = pendingReject;
  pendingResolve = null;
  pendingReject  = null;

  const blobToSend     = latestBlob;
  const savedMime      = mimeType;
  const savedBufferSec = bufferSeconds;

  console.log('[BugCapture:offscreen] deliverBlob called. blobToSend:', blobToSend ? `Blob ${blobToSend.size} bytes` : 'null');

  // Очищаем состояние до await (чтобы не было двойного вызова)
  if (stream) {
    stream.getTracks().forEach(t => t.stop());
    stream = null;
  }
  recorder     = null;
  chunks       = [];
  latestBlob   = null;
  prevBlob     = null;
  prevBlobMime = null;
  isCapturing  = false;
  activeTabId  = null;

  if (!blobToSend) {
    reject(new Error('Нет данных — подождите несколько секунд после начала записи'));
    return;
  }

  // ArrayBuffer теряется при передаче через sendResponse (Chrome сериализует как {}).
  // Конвертируем в base64 здесь, в offscreen, до отправки через IPC.
  blobToSend.arrayBuffer().then(ab => {
    const bytes = new Uint8Array(ab);
    const chunkSize = 8192;
    let binary = '';
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunkSize, bytes.length)));
    }
    const base64Data = btoa(binary);
    console.log('[BugCapture:offscreen] deliverBlob: base64Data length=', base64Data.length);
    resolve({ ok: true, base64Data, mimeType: savedMime, bufferDuration: savedBufferSec });
  }).catch(e => reject(new Error('Не удалось конвертировать blob: ' + e.message)));
}

// ─── Получить blob и остановить запись ───────────────────────────────────────

function getBlobAsync() {
  return new Promise((resolve, reject) => {
    // Нечего отдавать
    if (!isCapturing && !latestBlob) {
      return reject(new Error('Не идёт запись'));
    }

    pendingResolve = resolve;
    pendingReject  = reject;

    // Рекордер уже остановлен (ротация только что завершилась)
    if (!recorder || recorder.state === 'inactive') {
      deliverBlob();
      return;
    }

    // Отменяем плановую ротацию и останавливаем рекордер вручную
    clearTimeout(sessionTimer);
    sessionTimer = null;

    try {
      recorder.stop(); // → handleSessionStop → deliverBlob
    } catch (e) {
      pendingResolve = null;
      pendingReject  = null;
      reject(e);
    }
  });
}

// ─── Очистка ─────────────────────────────────────────────────────────────────

function cleanup() {
  clearTimeout(sessionTimer);
  sessionTimer  = null;
  pendingResolve = null;
  pendingReject  = null;

  if (recorder && recorder.state !== 'inactive') {
    try { recorder.stop(); } catch {}
  }
  if (stream) {
    stream.getTracks().forEach(t => t.stop());
    stream = null;
  }
  recorder    = null;
  chunks      = [];
  latestBlob  = null;
  isCapturing = false;
  activeTabId = null;
  // prevBlob намеренно НЕ сбрасывается здесь:
  // он управляется через saveCurrentDataAsPrev() и deliverBlob().
}

// ─── Утилиты ─────────────────────────────────────────────────────────────────

function getSupportedMimeType(hasAudio = false) {
  // Без аудио-треков не указываем аудио-кодек: несоответствие mimeType
  // и реального содержимого WebM вызывает ошибку воспроизведения.
  const types = hasAudio
    ? ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
    : ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  return types.find(t => MediaRecorder.isTypeSupported(t)) || 'video/webm';
}

// ─── MP4 конвертация через ffmpeg.wasm ───────────────────────────────────────

function encodeUint8Array(bytes) {
  const chunkSize = 8192;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunkSize, bytes.length)));
  }
  return btoa(binary);
}

function decodeBase64(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function ensureConvFFmpeg(sendProg) {
  if (convFFmpeg) return convFFmpeg;

  // ffmpeg.min.js загружен в offscreen.html — window.FFmpegWASM уже доступен
  if (!window.FFmpegWASM) {
    throw new Error('FFmpegWASM не загружен (проверьте libs/ffmpeg/ffmpeg.js в offscreen.html)');
  }

  sendProg(2, 'Загрузка ffmpeg.wasm (~31 МБ)...');

  const { FFmpeg } = window.FFmpegWASM;
  const ff = new FFmpeg();
  const coreURL = chrome.runtime.getURL('libs/ffmpeg/ffmpeg-core.js');
  const wasmURL = chrome.runtime.getURL('libs/ffmpeg/ffmpeg-core.wasm');
  await ff.load({ coreURL, wasmURL });

  convFFmpeg = ff;
  return ff;
}

async function startConversion({ inputBase64, inputMime, trimStart, trimEnd }) {
  isConverting = true;

  const sendProg = (pct, label) => {
    chrome.runtime.sendMessage({ type: 'OFFSCREEN_CONV_PROGRESS', pct, label }).catch(() => {});
  };

  let fakeTimer = null;
  let fakePct   = 20;

  function startFake() {
    fakeTimer = setInterval(() => {
      fakePct = Math.min(93, fakePct + Math.max(0.2, (93 - fakePct) * 0.012));
      sendProg(Math.round(fakePct), 'Конвертация в MP4...');
    }, 500);
  }

  function stopFake() {
    clearInterval(fakeTimer);
    fakeTimer = null;
  }

  let progressHandler = null;

  try {
    const ffmpeg = await ensureConvFFmpeg(sendProg);

    sendProg(5, 'Передача данных в ffmpeg...');
    await ffmpeg.writeFile('input.webm', decodeBase64(inputBase64));

    sendProg(20, 'Конвертация в MP4...');

    progressHandler = ({ progress }) => {
      if (!isFinite(progress) || progress < 0) return;
      stopFake();
      const pct = Math.max(21, Math.min(97, Math.round(20 + progress * 77)));
      sendProg(pct, 'Конвертация в MP4...');
    };
    ffmpeg.on('progress', progressHandler);

    const args = ['-fflags', '+genpts'];
    const ts = parseFloat(trimStart);
    const te = parseFloat(trimEnd);
    if (isFinite(ts) && ts >= 0.1) args.push('-ss', ts.toFixed(3));
    args.push('-i', 'input.webm');
    if (isFinite(te)) {
      const dur = te - Math.max(0, isFinite(ts) && ts >= 0.1 ? ts : 0);
      args.push('-t', dur.toFixed(3));
    }
    args.push(
      '-map', '0:v:0', '-map', '0:a:0?',
      '-vf', 'scale=-2:min(ih\\,1080)',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-crf', '23',
      '-c:a', 'aac', '-b:a', '128k', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
      'output.mp4'
    );

    startFake();
    await ffmpeg.exec(args);
    stopFake();

    sendProg(99, 'Подготовка файла...');
    const outputData = await ffmpeg.readFile('output.mp4');
    await ffmpeg.deleteFile('input.webm').catch(() => {});
    await ffmpeg.deleteFile('output.mp4').catch(() => {});

    const base64Mp4 = encodeUint8Array(new Uint8Array(outputData.buffer));
    chrome.runtime.sendMessage({ type: 'OFFSCREEN_CONV_DONE', base64Mp4, mimeType: 'video/mp4' }).catch(() => {});

  } catch (e) {
    stopFake();
    chrome.runtime.sendMessage({ type: 'OFFSCREEN_CONV_ERROR', message: e.message }).catch(() => {});
  } finally {
    if (progressHandler && convFFmpeg) {
      try { convFFmpeg.off('progress', progressHandler); } catch {}
    }
    progressHandler = null;
    isConverting = false;
  }
}
