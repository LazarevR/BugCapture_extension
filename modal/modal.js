/**
 * BugCapture — modal.js
 *
 * Работает внутри iframe, вставленного content script'ом.
 * Получает данные через window.postMessage от родительского контента.
 *
 * Функции:
 * - Воспроизведение записанного видео
 * - Управление ползунками обрезки (trim start/end)
 * - Сохранение обрезанного WebM через временные метки чанков
 * - Конвертация в MP4 через ffmpeg.wasm (lazy load)
 * - Визуализация временной шкалы
 */

'use strict';

// ─── DOM элементы ─────────────────────────────────────────────────────────────

const video = document.getElementById('preview-video');
const btnClose = document.getElementById('btn-close');
const btnPlayPause = document.getElementById('btn-play-pause');
const btnRewind = document.getElementById('btn-rewind');
const btnForward = document.getElementById('btn-forward');
const btnSave = document.getElementById('btn-save');
const btnRestart = document.getElementById('btn-restart');
const iconPlay = document.getElementById('icon-play');
const iconPause = document.getElementById('icon-pause');
const trimStart = document.getElementById('trim-start');
const trimEnd = document.getElementById('trim-end');
const trimStartTime = document.getElementById('trim-start-time');
const trimEndTime = document.getElementById('trim-end-time');
const timeCurrent = document.getElementById('time-current');
const timeTotal = document.getElementById('time-total');
const timelineBar = document.getElementById('timeline-bar');
const timelineRange = document.getElementById('timeline-range');
const timelinePlayhead = document.getElementById('timeline-playhead');
const loadingSpinner = document.getElementById('loading-spinner');
const conversionProgress = document.getElementById('conversion-progress');
const progressBar = document.getElementById('progress-bar');
const progressPercent = document.getElementById('progress-percent');
const formatBadge = document.getElementById('format-badge');
const saveLabel = document.getElementById('save-label');
const selectionDuration = document.getElementById('selection-duration');
const fileSizeEstimate = document.getElementById('file-size-estimate');

// ─── Состояние ────────────────────────────────────────────────────────────────

let videoDuration = 0;
let trimStartSec = 0;
let trimEndSec = Infinity; // Infinity = неизвестная длительность (защита от немедленной паузы)
let isPlaying = false;
let sourceBlob = null;
let sourceUrl = null;
let settings = {
  saveFormat: 'webm',
  bufferSeconds: 15
};
let isConverting = false;
let isMinimized  = false; // модалка скрыта, конвертация идёт в фоне
let currentConversionPct = 0; // последний известный % конвертации
let bufferDuration = null; // кол-во секунд реального буфера (chunks.length из offscreen)

// Обновляем прогресс в модалке и, если она скрыта, отправляем постоянный тост в content.js
function reportProgress(pct, label) {
  currentConversionPct = pct;
  showConversionProgress(true, pct, label);
  if (isMinimized) {
    window.parent.postMessage({ type: 'BUGCAPTURE_CONVERSION_PROGRESS', pct, label }, '*');
  }
}

// ─── Инициализация ────────────────────────────────────────────────────────────

// Nonce из URL-хэша (#n=...) — верифицирует первый postMessage от content script.
// Проверять event.origin нельзя: content script работает в контексте страницы,
// поэтому event.origin = origin страницы (https://...), а не chrome-extension://.
const _nonce = location.hash.replace(/^#n=/, '') || '';

window.addEventListener('message', onParentMessage);
document.addEventListener('keydown', onKeyDown);

// Инициализация ползунков
updateSliderBackground(trimStart);
updateSliderBackground(trimEnd);

// ─── Получение данных от content script ──────────────────────────────────────

function onParentMessage(event) {
  if (!event.data?.type) return;

  // Верифицируем nonce для всех входящих сообщений от content script
  if (!_nonce || event.data.nonce !== _nonce) return;

  // ─── Прогресс/результат конвертации от background (через content script) ──
  if (event.data.type === 'BUGCAPTURE_CONV_PROGRESS') {
    currentConversionPct = event.data.pct;
    showConversionProgress(true, event.data.pct, event.data.label || 'Конвертация в MP4...');
    return;
  }
  if (event.data.type === 'BUGCAPTURE_CONV_ERROR') {
    isConverting = false;
    setBusy(false);
    showConversionProgress(false);
    if (isMinimized) {
      isMinimized = false;
      window.parent.postMessage({ type: 'BUGCAPTURE_CONVERSION_ERROR', message: sanitize(event.data.message) }, '*');
    } else {
      showError('Не удалось конвертировать: ' + sanitize(event.data.message));
    }
    return;
  }

  if (event.data.type !== 'BUGCAPTURE_INIT_MODAL') return;

  const data = event.data;

  // Принимаем Blob напрямую (structured clone из content script)
  console.log('[BugCapture:modal] INIT_MODAL received. blob instanceof Blob:', data.blob instanceof Blob,
    'blob size:', data.blob?.size, 'prevBlob size:', data.prevBlob?.size);
  if (!(data.blob instanceof Blob)) return;

  settings = validateSettings(data.settings);
  bufferDuration = (typeof data.bufferDuration === 'number' && data.bufferDuration > 0)
    ? data.bufferDuration : null;
  formatBadge.textContent = settings.saveFormat.toUpperCase();

  showLoading(true);

  try {
    sourceBlob = data.blob;
    sourceUrl  = URL.createObjectURL(sourceBlob);
    video.src  = sourceUrl;
    video.load();
  } catch (e) {
    showLoading(false);
    showError('Не удалось загрузить видео. Попробуйте записать снова.');
  }
}


function validateSettings(raw) {
  if (!raw || typeof raw !== 'object') {
    return { saveFormat: 'webm', bufferSeconds: 15, audioFromSpeakers: false, audioFromMic: false, hotkey: '' };
  }
  return {
    saveFormat: (raw.saveFormat === 'mp4' || raw.saveFormat === 'webm') ? raw.saveFormat : 'webm',
    bufferSeconds: (typeof raw.bufferSeconds === 'number' && raw.bufferSeconds >= 5 && raw.bufferSeconds <= 40) ? raw.bufferSeconds : 15,
    audioFromSpeakers: typeof raw.audioFromSpeakers === 'boolean' ? raw.audioFromSpeakers : false,
    audioFromMic: typeof raw.audioFromMic === 'boolean' ? raw.audioFromMic : false,
    hotkey: (typeof raw.hotkey === 'string') ? raw.hotkey.replace(/[<>"'`]/g, '').substring(0, 50) : ''
  };
}

// ─── Обработка событий видео ──────────────────────────────────────────────────

video.addEventListener('loadedmetadata', () => {
  videoDuration = video.duration;
  if (!isFinite(videoDuration) || videoDuration <= 0) {
    // WebM из MediaRecorder часто имеет длительность Infinity.
    // Пробуем определить реальную длительность через seek к концу.
    videoDuration = 0;
    video.addEventListener('canplay', () => {
      if (videoDuration === 0) {
        video.currentTime = 1e10; // seek к «бесконечности» — браузер прыгнет к концу
      }
    }, { once: true });
    return; // onVideoReady вызовется из 'seeked'
  }
  onVideoReady();
});

// Определение длительности через seeked (для WebM с Infinity duration)
let _seekingForDuration = false;
video.addEventListener('seeked', () => {
  // ВАЖНО: сначала проверяем флаг, а потом videoDuration
  // (videoDuration уже установлена, когда ждём seeked обратно к 0)
  if (_seekingForDuration) {
    _seekingForDuration = false;
    onVideoReady();
    return;
  }
  if (videoDuration > 0) return; // уже известна, seek был пользовательским
  if (video.currentTime > 0) {
    _seekingForDuration = true;
    videoDuration = video.currentTime;
    video.currentTime = 0; // вернуться к началу
  } else {
    // Seek trick не сработал — запускаем с неизвестной длительностью
    onVideoReady();
  }
});

video.addEventListener('timeupdate', onTimeUpdate);
video.addEventListener('ended', onVideoEnded);
video.addEventListener('error', onVideoError);

video.addEventListener('canplay', () => {
  showLoading(false);
});

let _videoReadyCalled = false;
function onVideoReady() {
  if (_videoReadyCalled) return;
  _videoReadyCalled = true;
  showLoading(false);

  const knownDuration = videoDuration > 0;

  trimEndSec = knownDuration ? videoDuration : Infinity;
  trimEnd.value = 100;
  trimEnd.disabled = !knownDuration;

  // Автоматически выставляем начало обрезки на (total - bufferSeconds),
  // чтобы пользователь сразу видел ровно столько секунд, сколько задано в настройках.
  // bufferDuration учитывает случай когда offscreen отдал prevBlob + текущий blob
  // (например: 5-сек ротация + 3 сек текущей сессии = 8 сек total → trim start = 3 сек).
  if (knownDuration && bufferDuration > 0 && videoDuration > bufferDuration + 0.3) {
    trimStartSec = videoDuration - bufferDuration;
    const startPct = (trimStartSec / videoDuration) * 100;
    trimStart.value = startPct;
    trimStartTime.textContent = formatTime(trimStartSec);
  } else {
    trimStartSec = 0;
    trimStart.value = 0;
    trimStartTime.textContent = formatTime(0);
  }

  trimStart.disabled = !knownDuration;
  updateSliderBackground(trimStart);
  updateSliderBackground(trimEnd);

  timeTotal.textContent = knownDuration ? formatTime(videoDuration) : '?:??';
  trimEndTime.textContent = knownDuration ? formatTime(videoDuration) : '?:??';

  updateTimelineRange();
  updateSelectionInfo();

  // Перематываем к началу активного участка (trim start)
  video.currentTime = trimStartSec;
  video.pause();
  updatePlayButton(false);
}

function onTimeUpdate() {
  const current = video.currentTime;
  timeCurrent.textContent = formatTime(current);

  // Обновляем playhead на timeline
  if (videoDuration > 0) {
    const pct = (current / videoDuration) * 100;
    timelinePlayhead.style.left = pct + '%';
  }

  // Проверяем не вышли ли за конец обрезки (isFinite — защита для Infinity)
  if (isFinite(trimEndSec) && current >= trimEndSec && isPlaying) {
    video.pause();
    video.currentTime = trimEndSec;
    updatePlayButton(false);
  }
}

function onVideoEnded() {
  updatePlayButton(false);
  isPlaying = false;
}

function onVideoError() {
  // Игнорируем ошибки до инициализации (пустой src при загрузке страницы)
  if (!sourceUrl) return;
  showLoading(false);
  const err = video.error;
  console.error('[BugCapture:modal] video error code=', err?.code, 'message=', err?.message, '| blob size=', sourceBlob?.size);
  showError('Ошибка воспроизведения видео. Формат может не поддерживаться.');
}

// ─── Ползунки обрезки ─────────────────────────────────────────────────────────

trimStart.addEventListener('input', () => {
  const endVal = parseFloat(trimEnd.value);
  const startVal = parseFloat(trimStart.value);

  // Не даём начальному ползунку обогнать конечный
  if (startVal >= endVal - 0.5) {
    trimStart.value = endVal - 0.5;
  }

  trimStartSec = (parseFloat(trimStart.value) / 100) * videoDuration;
  trimStartTime.textContent = formatTime(trimStartSec);
  updateSliderBackground(trimStart);
  updateTimelineRange();
  updateSelectionInfo();

  // Перематываем к точке начала
  video.currentTime = trimStartSec;
  if (isPlaying) {
    video.pause();
    updatePlayButton(false);
    isPlaying = false;
  }
});

trimEnd.addEventListener('input', () => {
  const startVal = parseFloat(trimStart.value);
  const endVal = parseFloat(trimEnd.value);

  // Не даём конечному ползунку уйти раньше начального
  if (endVal <= startVal + 0.5) {
    trimEnd.value = startVal + 0.5;
  }

  trimEndSec = (parseFloat(trimEnd.value) / 100) * videoDuration;
  trimEndTime.textContent = formatTime(trimEndSec);
  updateSliderBackground(trimEnd);
  updateTimelineRange();
  updateSelectionInfo();
});

function updateSliderBackground(slider) {
  const val = parseFloat(slider.value);
  slider.style.setProperty('--val', val + '%');
}

function updateTimelineRange() {
  const startPct = parseFloat(trimStart.value);
  const endPct = parseFloat(trimEnd.value);
  timelineRange.style.left = startPct + '%';
  timelineRange.style.width = (endPct - startPct) + '%';
}

function updateSelectionInfo() {
  const duration = trimEndSec - trimStartSec;
  selectionDuration.textContent = isFinite(duration)
    ? `Выделено: ${duration.toFixed(1)} сек`
    : 'Выделено: весь буфер';

  // Примерный размер файла (WebM ~200-400 Кбайт/сек при 2.5 Мбит/с)
  if (sourceBlob) {
    const totalBlobSize = sourceBlob.size;
    const ratio = duration / (videoDuration || 1);
    const estimatedSize = totalBlobSize * ratio;
    fileSizeEstimate.textContent = `Размер: ~${formatBytes(estimatedSize)}`;
  }
}

// ─── Клик по timeline ─────────────────────────────────────────────────────────

timelineBar.addEventListener('click', (e) => {
  if (!videoDuration) return;
  const rect = timelineBar.getBoundingClientRect();
  const pct = (e.clientX - rect.left) / rect.width;
  const targetTime = pct * videoDuration;

  // Перематываем только если в пределах trim
  video.currentTime = Math.max(trimStartSec, Math.min(trimEndSec, targetTime));
});

// ─── Кнопки управления воспроизведением ──────────────────────────────────────

btnPlayPause.addEventListener('click', togglePlayPause);

function togglePlayPause() {
  if (isConverting) return;

  if (video.paused) {
    // Если currentTime вышел за trim — перематываем
    if (video.currentTime < trimStartSec || video.currentTime >= trimEndSec) {
      video.currentTime = trimStartSec;
    }
    video.play().then(() => {
      isPlaying = true;
      updatePlayButton(true);
    }).catch(() => {});
  } else {
    video.pause();
    isPlaying = false;
    updatePlayButton(false);
  }
}

btnRewind.addEventListener('click', () => {
  video.currentTime = trimStartSec;
  timeCurrent.textContent = formatTime(trimStartSec);
});

btnForward.addEventListener('click', () => {
  if (!isFinite(trimEndSec)) return; // guard: не устанавливаем Infinity в currentTime
  video.currentTime = trimEndSec;
  timeCurrent.textContent = formatTime(trimEndSec);
});

function updatePlayButton(playing) {
  if (playing) {
    iconPlay.style.display = 'none';
    iconPause.style.display = '';
    btnPlayPause.setAttribute('aria-label', 'Пауза');
    btnPlayPause.title = 'Пауза (Пробел)';
  } else {
    iconPlay.style.display = '';
    iconPause.style.display = 'none';
    btnPlayPause.setAttribute('aria-label', 'Воспроизвести');
    btnPlayPause.title = 'Воспроизвести (Пробел)';
  }
}

// ─── Закрыть ──────────────────────────────────────────────────────────────────

btnClose.addEventListener('click', () => {
  if (isConverting) {
    // Сохранение/конвертация запущены — скрываем модалку, но НЕ прерываем процесс.
    // Для MP4: ffmpeg работает в offscreen document, переживёт перезагрузку страницы.
    // Для WebM: обрезка в iframe, завершится и снова покажет overlay.
    isMinimized = true;
    const label = settings.saveFormat === 'mp4' ? 'Конвертация в MP4...' : 'Сохранение WebM...';
    window.parent.postMessage({
      type:  'BUGCAPTURE_MINIMIZE_MODAL',
      pct:   currentConversionPct,
      label,
    }, '*');
    return;
  }
  cleanup();
  window.parent.postMessage({ type: 'BUGCAPTURE_CLOSE_MODAL' }, '*');
});

btnRestart.addEventListener('click', () => {
  if (isConverting) return;
  cleanup();
  window.parent.postMessage({ type: 'BUGCAPTURE_RESTART_RECORDING' }, '*');
});

// ─── Сохранение ───────────────────────────────────────────────────────────────

btnSave.addEventListener('click', onSave);

async function onSave() {
  if (isConverting || !sourceBlob) return;
  if (videoDuration === 0) {
    showError('Видео ещё не загружено. Подождите.');
    return;
  }

  const trimDuration = trimEndSec - trimStartSec;
  if (trimDuration < 0.1) {
    showError('Слишком короткий отрезок. Расширьте диапазон обрезки.');
    return;
  }

  video.pause();
  updatePlayButton(false);
  isPlaying = false;

  if (settings.saveFormat === 'mp4') {
    await saveAsMP4();
  } else {
    await saveAsWebM();
  }
}

// ─── Сохранение WebM ─────────────────────────────────────────────────────────

async function saveAsWebM() {
  isConverting = true;
  setBusy(true);
  reportProgress(10, 'Подготовка WebM...');

  try {
    reportProgress(30, 'Обрезка видео...');
    const trimmedBlob = await trimVideoBlob(sourceBlob, trimStartSec, trimEndSec);
    reportProgress(95, 'Файл готов...');

    if (isMinimized) {
      isMinimized = false;
      window.parent.postMessage({ type: 'BUGCAPTURE_SHOW_OVERLAY' }, '*');
    }
    // Передаём blob в content script — он покажет нативный диалог сохранения ОС
    window.parent.postMessage({ type: 'BUGCAPTURE_SAVE_WEBM', blob: trimmedBlob }, '*');
  } catch (e) {
    if (isMinimized) {
      isMinimized = false;
      window.parent.postMessage({ type: 'BUGCAPTURE_CONVERSION_ERROR', message: sanitize(e.message) }, '*');
    } else {
      showError('Не удалось сохранить WebM: ' + sanitize(e.message));
    }
  } finally {
    isConverting = false;
    setBusy(false);
    showConversionProgress(false);
  }
}

/**
 * Обрезка WebM через перезапись с MediaRecorder.
 *
 * ВАЖНО: MediaRecorder WebM не содержит cue table → браузер не умеет
 * делать seek по таким файлам. Поэтому НЕ ждём событие 'seeked' —
 * ждём 'canplay' (всегда срабатывает когда видео готово к воспроизведению).
 * Для startSec > 0 выставляем currentTime после canplay и ждём seeked
 * с fallback-таймером на случай если seek не работает.
 */
async function trimVideoBlob(blob, startSec, endSec) {
  // Нет обрезки → возвращаем исходник без перекодирования
  if (startSec < 0.1 && !isFinite(endSec)) return blob;

  return new Promise((resolve, reject) => {
    const tempVideo = document.createElement('video');
    tempVideo.muted = true;
    tempVideo.style.display = 'none';
    document.body.appendChild(tempVideo);

    const url = URL.createObjectURL(blob);
    let stream = null;
    let recorder = null;
    const chunks = [];
    let captureStarted = false;

    function beginCapture() {
      if (captureStarted) return;
      captureStarted = true;

      try {
        stream = tempVideo.captureStream
          ? tempVideo.captureStream(30)
          : tempVideo.mozCaptureStream(30);
      } catch (e) {
        finish(null, new Error('captureStream не поддерживается'));
        return;
      }

      const mimeType = getSupportedMimeType();
      try {
        recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 2_500_000 });
      } catch (e) {
        finish(null, new Error('MediaRecorder не удалось создать'));
        return;
      }

      recorder.ondataavailable = (e) => {
        if (e.data?.size > 0) chunks.push(e.data);
      };
      recorder.onstop = () => finish(new Blob(chunks, { type: mimeType }), null);
      recorder.onerror = () => finish(null, new Error('Ошибка MediaRecorder при обрезке'));

      recorder.start(100);
      tempVideo.play().catch(() => {});

      if (isFinite(endSec)) {
        const timeoutMs = Math.max(500, (endSec - tempVideo.currentTime) * 1000 + 1000);
        const timer = setTimeout(stop, timeoutMs);
        tempVideo.addEventListener('timeupdate', () => {
          if (tempVideo.currentTime >= endSec - 0.05) { clearTimeout(timer); stop(); }
        });
        tempVideo.addEventListener('ended', () => { clearTimeout(timer); stop(); }, { once: true });
      } else {
        tempVideo.addEventListener('ended', stop, { once: true });
        setTimeout(stop, 300_000); // страховка 5 минут
      }
    }

    function stop() {
      tempVideo.pause();
      if (recorder?.state !== 'inactive') recorder?.stop();
    }

    function finish(result, error) {
      if (stream) stream.getTracks().forEach(t => t.stop());
      URL.revokeObjectURL(url);
      tempVideo.remove();
      if (error) reject(error);
      else resolve(result);
    }

    tempVideo.addEventListener('error', () => {
      finish(null, new Error('Ошибка воспроизведения при обрезке'));
    });

    // canplay срабатывает когда видео готово — в отличие от seeked не зависит
    // от наличия cue table в WebM
    tempVideo.addEventListener('canplay', () => {
      if (startSec >= 0.1) {
        // Ждём завершения перемотки; fallback если WebM не seekable
        const seekFallback = setTimeout(beginCapture, 2000);
        tempVideo.addEventListener('seeked', () => {
          clearTimeout(seekFallback);
          beginCapture();
        }, { once: true });
        tempVideo.currentTime = startSec;
      } else {
        beginCapture();
      }
    }, { once: true });

    tempVideo.src = url;
    tempVideo.load();
  });
}

function getSupportedMimeType() {
  const types = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];
  for (const type of types) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return 'video/webm';
}


// ─── Сохранение MP4 ──────────────────────────────────────────────────────────
//
// Конвертация запускается в offscreen document (background.js → offscreen.js).
// Результат приходит обратно через background → content script → iframe
// как BUGCAPTURE_CONV_DONE / BUGCAPTURE_CONV_PROGRESS / BUGCAPTURE_CONV_ERROR.
// Это позволяет конвертации пережить перезагрузку страницы.

async function saveAsMP4() {
  isConverting = true;
  setBusy(true);
  reportProgress(5, 'Кодирование данных...');

  try {
    // Кодируем blob в base64 для передачи через postMessage → background → offscreen
    const inputData = await sourceBlob.arrayBuffer();
    const bytes     = new Uint8Array(inputData);
    const chunkSize = 8192;
    let binary = '';
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunkSize, bytes.length)));
    }
    const inputBase64 = btoa(binary);

    reportProgress(10, 'Запуск конвертации в offscreen...');

    // Передаём в content script → background → offscreen
    // Результат вернётся как BUGCAPTURE_CONV_DONE/PROGRESS/ERROR в onParentMessage
    window.parent.postMessage({
      type:        'BUGCAPTURE_START_CONVERSION',
      nonce:       _nonce,
      inputBase64,
      inputMime:   sourceBlob.type || 'video/webm',
      trimStart:   trimStartSec,
      trimEnd:     trimEndSec,
    }, '*');

    // isConverting остаётся true — сбросится в обработчиках BUGCAPTURE_CONV_DONE/ERROR

  } catch (e) {
    isConverting = false;
    setBusy(false);
    showConversionProgress(false);
    showError('Не удалось начать конвертацию: ' + sanitize(e.message));
  }
}


function generateFilename(ext) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const dateStr = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;
  const timeStr = `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  return `bugcapture_${dateStr}_${timeStr}.${ext}`;
}

// ─── UI вспомогательные функции ───────────────────────────────────────────────

function showLoading(show) {
  loadingSpinner.style.display = show ? 'flex' : 'none';
}

function showConversionProgress(show, pct = 0, label = '') {
  conversionProgress.style.display = show ? 'flex' : 'none';
  if (show) {
    progressBar.style.width = pct + '%';
    progressPercent.textContent = pct + '%';
    if (label) {
      conversionProgress.querySelector('.progress-label').textContent = label;
    }
  }
}

function setBusy(busy) {
  btnSave.disabled = busy;
  // btnClose намеренно не отключается — закрыть можно всегда (ffmpeg завершится)
  btnRestart.disabled = busy;
  btnPlayPause.disabled = busy;

  if (busy) {
    saveLabel.textContent = settings.saveFormat === 'mp4' ? 'Конвертация...' : 'Сохранение...';
  } else {
    saveLabel.textContent = 'Сохранить';
  }
}

function showError(message) {
  // Создаём overlay с сообщением об ошибке
  const existing = document.getElementById('bugcapture-error-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = 'bugcapture-error-toast';
  Object.assign(toast.style, {
    position: 'fixed',
    bottom: '16px',
    left: '50%',
    transform: 'translateX(-50%)',
    background: '#7f1d1d',
    border: '1px solid #ef4444',
    color: '#fecaca',
    padding: '12px 20px',
    borderRadius: '8px',
    fontSize: '13px',
    zIndex: '9999',
    maxWidth: '420px',
    lineHeight: '1.5',
    whiteSpace: 'pre-line',
    boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
    opacity: '0',
    transition: 'opacity 0.2s ease'
  });

  // textContent безопасен от XSS
  toast.textContent = message;
  document.body.appendChild(toast);

  requestAnimationFrame(() => {
    requestAnimationFrame(() => { toast.style.opacity = '1'; });
  });

  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 6000);
}

function cleanup() {
  if (sourceUrl) {
    URL.revokeObjectURL(sourceUrl);
    sourceUrl = null;
  }
  video.pause();
  video.src = '';
}

// ─── Горячие клавиши в модалке ────────────────────────────────────────────────

function onKeyDown(event) {
  switch (event.key) {
    case ' ':
    case 'k':
      event.preventDefault();
      togglePlayPause();
      break;
    case 'ArrowLeft':
      event.preventDefault();
      video.currentTime = Math.max(trimStartSec, video.currentTime - 2);
      break;
    case 'ArrowRight':
      event.preventDefault();
      video.currentTime = Math.min(trimEndSec, video.currentTime + 2);
      break;
    case 'Escape':
      event.preventDefault();
      if (!isConverting) {
        cleanup();
        window.parent.postMessage({ type: 'BUGCAPTURE_CLOSE_MODAL' }, '*');
      }
      break;
    default:
      break;
  }
}

// ─── Утилиты ─────────────────────────────────────────────────────────────────

function formatTime(seconds) {
  if (!isFinite(seconds) || isNaN(seconds)) return '0:00';
  const s = Math.floor(seconds);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' Б';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' КБ';
  return (bytes / (1024 * 1024)).toFixed(1) + ' МБ';
}

function sanitize(str) {
  if (typeof str !== 'string') return 'Неизвестная ошибка';
  return str
    .replace(/https?:\/\/[^\s]*/g, '[URL]')
    .substring(0, 150);
}
