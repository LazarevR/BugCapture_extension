/**
 * BugCapture — content script
 *
 * Запись идёт в offscreen document. Здесь только:
 * - Показ модального окна с превью и скачиванием
 * - Toast-уведомления об ошибках
 * - Горячие клавиши
 */

'use strict';

(function () {
  if (window.__bugCaptureLoaded) return;
  window.__bugCaptureLoaded = true;

  // ─── Состояние ─────────────────────────────────────────────────────────────

  let isModalOpen      = false;
  let currentHotkey    = '';
  let currentSettings  = null;
  let modalOverlay     = null;
  let modalIframe      = null;
  let modalNonce       = null; // nonce текущей открытой модалки (для пересылки сообщений в iframe)

  // ─── Инициализация ─────────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener(onMessage);
  document.addEventListener('keydown', onKeyDown, true);

  // Загружаем горячую клавишу
  chrome.runtime.sendMessage({ type: 'BUGCAPTURE_GET_SETTINGS' }, response => {
    if (chrome.runtime.lastError) return;
    if (response?.settings) {
      currentHotkey   = response.settings.hotkey || '';
      currentSettings = response.settings;
    }
  });

  // Проверяем: не идёт ли конвертация MP4 в фоне (пережила перезагрузку страницы)
  chrome.runtime.sendMessage({ type: 'BUGCAPTURE_GET_CONV_STATE' }, response => {
    if (chrome.runtime.lastError) return;
    if (response?.status === 'converting') {
      showConversionToast(response.pct || 0, response.label || 'Конвертация в MP4...');
    } else if (response?.status === 'done' && response.base64Mp4) {
      showConversionCompletePrompt(response.base64Mp4, response.mimeType || 'video/mp4');
      chrome.runtime.sendMessage({ type: 'BUGCAPTURE_CONV_RESULT_TAKEN' }).catch(() => {});
    }
  });

  // ─── Обработчик сообщений ──────────────────────────────────────────────────

  function onMessage(message, _sender, sendResponse) {
    if (!message?.type) return false;

    switch (message.type) {

      case 'BUGCAPTURE_PING':
        sendResponse({ pong: true });
        break;

      case 'BUGCAPTURE_SHOW_MODAL': {
        // chrome.tabs.sendMessage — JSON-only, ArrayBuffer → {}.
        // Данные передаются как base64-строка и декодируются здесь.
        console.log('[BugCapture:content] SHOW_MODAL received. base64Data length=', message.base64Data?.length,
          'prevBase64Data length=', message.prevBase64Data?.length, 'mimeType=', message.mimeType);

        function decodeBase64Blob(b64, mimeType) {
          const binary = atob(b64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          return new Blob([bytes], { type: mimeType });
        }

        let blob;
        try {
          blob = decodeBase64Blob(message.base64Data, message.mimeType);
          console.log('[BugCapture:content] blob created size=', blob.size, 'type=', blob.type);
        } catch (e) {
          console.error('[BugCapture:content] blob decode error:', e);
          showError('capture_failed', 'Не удалось декодировать видеоданные');
          break;
        }

        let prevBlob = null;
        if (message.prevBase64Data) {
          try {
            prevBlob = decodeBase64Blob(message.prevBase64Data, message.prevMimeType || message.mimeType);
            console.log('[BugCapture:content] prevBlob created size=', prevBlob.size);
          } catch (e) {
            console.warn('[BugCapture:content] prevBlob decode error (ignored):', e);
          }
        }

        openModal(blob, message.mimeType, message.settings || currentSettings || {}, message.bufferDuration ?? null, prevBlob);
        sendResponse({ ok: true });
        break;
      }

      case 'BUGCAPTURE_ERROR':
        showError(message.error, message.message);
        break;

      case 'BUGCAPTURE_SETTINGS_UPDATED':
        currentHotkey = message.hotkey || '';
        break;

      // ─── Прогресс/результат конвертации MP4 от background ──────────────────

      case 'BUGCAPTURE_CONV_PROGRESS':
        if (isModalOpen && modalIframe && modalOverlay?.style.display !== 'none') {
          // Модалка видима — пересылаем прогресс в iframe (там свой progress bar)
          modalIframe.contentWindow?.postMessage({
            type: 'BUGCAPTURE_CONV_PROGRESS', nonce: modalNonce,
            pct: message.pct, label: message.label,
          }, '*');
        } else {
          // Модалка скрыта или закрыта — показываем/обновляем тост
          showConversionToast(message.pct || 0, message.label || 'Конвертация в MP4...');
        }
        break;

      case 'BUGCAPTURE_CONV_DONE':
        removeConversionToast();
        if (isModalOpen) closeModal();
        showConversionCompletePrompt(message.base64Mp4, message.mimeType || 'video/mp4');
        chrome.runtime.sendMessage({ type: 'BUGCAPTURE_CONV_RESULT_TAKEN' }).catch(() => {});
        setTimeout(() => chrome.runtime.sendMessage({ type: 'BUGCAPTURE_AUTO_START' }), 500);
        break;

      case 'BUGCAPTURE_CONV_ERROR':
        removeConversionToast();
        showToast('❌ Ошибка конвертации: ' + (message.message || ''), 'error', 6000);
        if (isModalOpen) closeModal();
        setTimeout(() => chrome.runtime.sendMessage({ type: 'BUGCAPTURE_AUTO_START' }), 300);
        break;
    }

    return false;
  }

  // ─── Горячие клавиши ───────────────────────────────────────────────────────

  function onKeyDown(event) {
    if (!currentHotkey || isModalOpen) return;
    if (buildCombo(event) === currentHotkey) {
      event.preventDefault();
      event.stopPropagation();
      chrome.runtime.sendMessage({ type: 'BUGCAPTURE_TRIGGER' });
    }
  }

  function buildCombo(event) {
    const parts = [];
    if (event.ctrlKey)  parts.push('Ctrl');
    if (event.altKey)   parts.push('Alt');
    if (event.shiftKey) parts.push('Shift');
    if (event.metaKey)  parts.push('Meta');

    const ignore = new Set([
      'Control','Alt','Shift','Meta','CapsLock','Tab','Escape',
      'Enter','Backspace','Delete','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'
    ]);
    if (!ignore.has(event.key)) parts.push(event.key.toUpperCase());
    return parts.join('+');
  }

  // ─── Модальное окно ────────────────────────────────────────────────────────

  function openModal(videoBlob, mime, settings, bufferDuration, prevBlob = null) {
    if (isModalOpen) return;
    isModalOpen = true;

    // Overlay
    modalOverlay = document.createElement('div');
    Object.assign(modalOverlay.style, {
      position:       'fixed',
      top:            '0',
      left:           '0',
      width:          '100%',
      height:         '100%',
      background:     'rgba(0,0,0,0.78)',
      zIndex:         '2147483647',
      display:        'flex',
      alignItems:     'center',
      justifyContent: 'center'
    });

    const container = document.createElement('div');
    Object.assign(container.style, {
      position:     'relative',
      width:        '90%',
      maxWidth:     '900px',
      maxHeight:    '90vh',
      background:   '#1a1a2e',
      borderRadius: '12px',
      overflow:     'hidden',
      boxShadow:    '0 25px 60px rgba(0,0,0,0.55)'
    });

    // Nonce для верификации postMessage (сохраняем в modalNonce для пересылки прогресса)
    const nonce = crypto.randomUUID ? crypto.randomUUID() :
      Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    modalNonce = nonce;

    modalIframe = document.createElement('iframe');
    modalIframe.src = chrome.runtime.getURL('modal/modal.html') + '#n=' + nonce;
    modalIframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-downloads');
    Object.assign(modalIframe.style, {
      width:  '100%',
      height: '80vh',
      border: 'none'
    });

    modalIframe.onload = () => {
      // Передаём Blob напрямую (structured clone)
      modalIframe.contentWindow.postMessage({
        type:          'BUGCAPTURE_INIT_MODAL',
        nonce,
        blob:          videoBlob,
        prevBlob,      // Blob из записи до перезагрузки (null если не было)
        mimeType:      mime,
        settings,
        bufferDuration // сколько секунд реального буфера в конце видео
      }, '*');
    };

    container.appendChild(modalIframe);
    modalOverlay.appendChild(container);
    document.documentElement.appendChild(modalOverlay);

    modalOverlay.addEventListener('click', e => {
      if (e.target === modalOverlay) closeModal();
    });
    document.addEventListener('keydown', onEscKey, true);
    window.addEventListener('message', onIframeMessage);
  }

  function onEscKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      // Не закрываем если оверлей скрыт (конвертация в фоне)
      if (modalOverlay && modalOverlay.style.display === 'none') return;
      closeModal();
    }
  }

  function onIframeMessage(event) {
    const extOrigin = chrome.runtime.getURL('').replace(/\/$/, '');
    if (event.origin !== extOrigin) return;
    if (!event.data?.type) return;

    switch (event.data.type) {
      case 'BUGCAPTURE_CLOSE_MODAL':
        closeModal();
        // Перезапускаем буфер после закрытия модалки
        setTimeout(() => {
          chrome.runtime.sendMessage({ type: 'BUGCAPTURE_AUTO_START' });
        }, 300);
        break;

      case 'BUGCAPTURE_MINIMIZE_MODAL':
        // Конвертация продолжается в фоне — скрываем оверлей, iframe остаётся живым
        if (modalOverlay) modalOverlay.style.display = 'none';
        showConversionToast(event.data.pct || 0, event.data.label || 'Конвертация в MP4...');
        break;

      case 'BUGCAPTURE_CONVERSION_PROGRESS':
        showConversionToast(event.data.pct || 0, event.data.label || 'Конвертация в MP4...');
        break;

      case 'BUGCAPTURE_SHOW_OVERLAY':
        // Конвертация завершена — убираем прогресс-тост и возвращаем оверлей
        removeConversionToast();
        if (modalOverlay) modalOverlay.style.display = '';
        break;

      case 'BUGCAPTURE_CONVERSION_ERROR':
        showToast('❌ Ошибка конвертации: ' + (event.data.message || ''), 'error', 6000);
        closeModal();
        setTimeout(() => chrome.runtime.sendMessage({ type: 'BUGCAPTURE_AUTO_START' }), 300);
        break;

      case 'BUGCAPTURE_RESTART_RECORDING':
        closeModal();
        // AUTO_START перезапускает запись без показа модалки (в отличие от TRIGGER)
        setTimeout(() => chrome.runtime.sendMessage({ type: 'BUGCAPTURE_AUTO_START' }), 300);
        break;

      // Модалка запрашивает старт конвертации → relay в background → offscreen
      case 'BUGCAPTURE_START_CONVERSION':
        chrome.runtime.sendMessage({
          type:        'BUGCAPTURE_START_CONVERSION',
          inputBase64: event.data.inputBase64,
          inputMime:   event.data.inputMime,
          trimStart:   event.data.trimStart,
          trimEnd:     event.data.trimEnd,
        }).catch(() => {});
        break;

      // Модалка обрезала WebM — просим показать нативный диалог сохранения
      case 'BUGCAPTURE_SAVE_WEBM': {
        const blob = event.data.blob;
        if (!(blob instanceof Blob)) break;
        closeModal();
        showSaveFilePrompt(blob, 'webm', 'video/webm');
        setTimeout(() => chrome.runtime.sendMessage({ type: 'BUGCAPTURE_AUTO_START' }), 300);
        break;
      }
    }
  }

  function closeModal() {
    if (!isModalOpen) return;
    isModalOpen = false;
    modalNonce  = null;
    modalOverlay?.remove();
    modalOverlay = null;
    modalIframe  = null;
    document.removeEventListener('keydown', onEscKey, true);
    window.removeEventListener('message', onIframeMessage);
  }

  // ─── Ошибки ────────────────────────────────────────────────────────────────

  function showError(code, message) {
    if (code === 'restricted_url') {
      showToast('🚫 ' + (message || 'Недоступно на этой странице'), 'error', 5000);
      return;
    }
    if (code === 'capture_failed') {
      showPermissionModal(message);
      return;
    }
    showToast('❌ ' + (message || 'Неизвестная ошибка'), 'error', 4000);
  }

  function showPermissionModal(msg) {
    if (isModalOpen) return;
    isModalOpen = true;

    modalOverlay = document.createElement('div');
    Object.assign(modalOverlay.style, {
      position:       'fixed',
      top:            '0',
      left:           '0',
      width:          '100%',
      height:         '100%',
      background:     'rgba(0,0,0,0.78)',
      zIndex:         '2147483647',
      display:        'flex',
      alignItems:     'center',
      justifyContent: 'center',
      fontFamily:     'system-ui, -apple-system, sans-serif'
    });

    const box = document.createElement('div');
    Object.assign(box.style, {
      background:   '#1a1a2e',
      color:        '#e0e0e0',
      borderRadius: '12px',
      padding:      '32px',
      maxWidth:     '500px',
      width:        '90%',
      boxShadow:    '0 25px 60px rgba(0,0,0,0.5)',
      lineHeight:   '1.6'
    });

    const title = document.createElement('h2');
    title.textContent = '🚫 Не удалось начать запись';
    Object.assign(title.style, { margin: '0 0 16px 0', fontSize: '20px', color: '#e74c3c' });

    const info = document.createElement('pre');
    info.textContent =
      'Ошибка: ' + (msg || 'неизвестно') +
      '\n\nВозможные причины:\n' +
      '• Страница открыта по http:// (не https://) — попробуйте https\n' +
      '• Вкладка была закрыта во время захвата\n' +
      '• Обновите страницу (F5) и попробуйте снова';
    Object.assign(info.style, {
      background:  '#0f0f23',
      padding:     '16px',
      borderRadius:'8px',
      fontSize:    '13px',
      whiteSpace:  'pre-wrap',
      wordBreak:   'break-word',
      color:       '#a8b2d8',
      margin:      '0 0 20px 0'
    });

    const btn = document.createElement('button');
    btn.textContent = 'Закрыть';
    Object.assign(btn.style, {
      background:   '#e74c3c',
      color:        'white',
      border:       'none',
      borderRadius: '8px',
      padding:      '10px 24px',
      cursor:       'pointer',
      fontSize:     '14px',
      fontWeight:   '600'
    });
    btn.addEventListener('click', closeModal);

    box.appendChild(title);
    box.appendChild(info);
    box.appendChild(btn);
    modalOverlay.appendChild(box);
    document.documentElement.appendChild(modalOverlay);

    modalOverlay.addEventListener('click', e => { if (e.target === modalOverlay) closeModal(); });
    document.addEventListener('keydown', onEscKey, true);
  }

  // ─── Постоянный тост прогресса конвертации ─────────────────────────────────

  const CONV_TOAST_ID = 'bugcapture-conv-toast';

  function showConversionToast(pct, label) {
    let toast = document.getElementById(CONV_TOAST_ID);

    if (!toast) {
      toast = document.createElement('div');
      toast.id = CONV_TOAST_ID;
      Object.assign(toast.style, {
        position:   'fixed',
        bottom:     '24px',
        right:      '24px',
        background: '#1e2a4a',
        color:      '#e8eaf6',
        padding:    '14px 18px',
        borderRadius: '10px',
        fontSize:   '13px',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        fontWeight: '500',
        boxShadow:  '0 4px 20px rgba(0,0,0,0.5)',
        zIndex:     '2147483646',
        minWidth:   '240px',
        border:     '1px solid rgba(79,142,247,0.35)',
        opacity:    '0',
        transition: 'opacity 0.25s ease'
      });

      // Верхняя строка: иконка + текст + процент
      const topRow = document.createElement('div');
      Object.assign(topRow.style, {
        display: 'flex', alignItems: 'center',
        justifyContent: 'space-between', marginBottom: '10px'
      });

      const labelEl = document.createElement('span');
      labelEl.id = CONV_TOAST_ID + '-label';
      Object.assign(labelEl.style, { display: 'flex', alignItems: 'center', gap: '7px' });

      const spinner = document.createElement('span');
      spinner.textContent = '⚙️';
      spinner.style.fontSize = '15px';

      const labelText = document.createElement('span');
      labelText.id = CONV_TOAST_ID + '-text';

      labelEl.appendChild(spinner);
      labelEl.appendChild(labelText);

      const pctEl = document.createElement('span');
      pctEl.id = CONV_TOAST_ID + '-pct';
      Object.assign(pctEl.style, { color: '#4f8ef7', fontWeight: '700', fontSize: '14px' });

      topRow.appendChild(labelEl);
      topRow.appendChild(pctEl);

      // Прогресс-бар
      const barWrap = document.createElement('div');
      Object.assign(barWrap.style, {
        height: '5px', background: 'rgba(255,255,255,0.1)',
        borderRadius: '3px', overflow: 'hidden'
      });

      const bar = document.createElement('div');
      bar.id = CONV_TOAST_ID + '-bar';
      Object.assign(bar.style, {
        height: '100%', width: '0%',
        background: '#4f8ef7', borderRadius: '3px',
        transition: 'width 0.45s ease'
      });

      barWrap.appendChild(bar);
      toast.appendChild(topRow);
      toast.appendChild(barWrap);
      document.documentElement.appendChild(toast);

      requestAnimationFrame(() =>
        requestAnimationFrame(() => { toast.style.opacity = '1'; })
      );
    }

    document.getElementById(CONV_TOAST_ID + '-text').textContent = label;
    document.getElementById(CONV_TOAST_ID + '-pct').textContent  = pct + '%';
    document.getElementById(CONV_TOAST_ID + '-bar').style.width  = pct + '%';
  }

  function removeConversionToast() {
    document.getElementById(CONV_TOAST_ID)?.remove();
  }

  // ─── Диалог сохранения файла через нативный диалог ОС ─────────────────────

  // Вызывается после конвертации MP4 (base64 → blob) или перезагрузки страницы
  function showConversionCompletePrompt(base64, mimeType) {
    let blob;
    try {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      blob = new Blob([bytes], { type: mimeType || 'video/mp4' });
    } catch { return; }
    const ext = (mimeType || 'video/mp4').includes('mp4') ? 'mp4' : 'webm';
    showSaveFilePrompt(blob, ext, mimeType || 'video/mp4');
  }

  // Показывает кнопку "Сохранить файл" → вызывает showSaveFilePicker (нативный диалог ОС)
  function showSaveFilePrompt(blob, ext, mimeType) {
    const SAVE_ID = 'bugcapture-save-prompt';
    document.getElementById(SAVE_ID)?.remove();

    const overlay = document.createElement('div');
    overlay.id = SAVE_ID;
    Object.assign(overlay.style, {
      position: 'fixed', inset: '0',
      background: 'rgba(0,0,0,0.65)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: '2147483647',
      fontFamily: 'system-ui, -apple-system, sans-serif'
    });

    const dialog = document.createElement('div');
    Object.assign(dialog.style, {
      background: '#16213e', border: '1px solid rgba(255,255,255,0.1)',
      borderRadius: '12px', padding: '32px 36px',
      maxWidth: 'calc(100% - 48px)', boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
      textAlign: 'center', color: '#e8eaf6'
    });

    const icon = document.createElement('div');
    icon.textContent = '✅';
    icon.style.cssText = 'font-size:40px;margin-bottom:14px';

    const title = document.createElement('h3');
    title.textContent = ext === 'mp4' ? 'Видео готово' : 'Файл готов';
    title.style.cssText = 'margin:0 0 8px;font-size:18px;font-weight:700';

    const desc = document.createElement('p');
    desc.textContent = 'Нажмите кнопку, чтобы выбрать папку и имя файла.';
    desc.style.cssText = 'margin:0 0 24px;font-size:13px;color:#8892b0;line-height:1.5';

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:10px;justify-content:center';

    const btnCancel = document.createElement('button');
    btnCancel.textContent = 'Отмена';
    btnCancel.style.cssText = 'background:transparent;border:1px solid rgba(255,255,255,0.12);border-radius:8px;color:#8892b0;padding:10px 22px;cursor:pointer;font-size:14px;font-weight:500';

    const btnSave = document.createElement('button');
    btnSave.textContent = '💾 Сохранить файл...';
    btnSave.style.cssText = 'background:#22c55e;border:none;border-radius:8px;color:white;padding:10px 24px;cursor:pointer;font-size:15px;font-weight:600';

    btnRow.appendChild(btnCancel);
    btnRow.appendChild(btnSave);
    dialog.appendChild(icon);
    dialog.appendChild(title);
    dialog.appendChild(desc);
    dialog.appendChild(btnRow);
    overlay.appendChild(dialog);
    document.documentElement.appendChild(overlay);

    btnCancel.addEventListener('click', () => overlay.remove());
    btnSave.addEventListener('click', async () => {
      btnSave.disabled = true;
      btnSave.textContent = 'Сохранение...';
      overlay.remove();
      await saveWithPicker(blob, ext, mimeType);
    });
  }

  async function saveWithPicker(blob, ext, mimeType) {
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const name = `bugcapture_${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}.${ext}`;

    if (typeof window.showSaveFilePicker === 'function') {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: name,
          types: [{ description: ext.toUpperCase() + ' Video', accept: { [mimeType]: ['.' + ext] } }]
        });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        return;
      } catch (e) {
        if (e.name === 'AbortError') return;
      }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.documentElement.appendChild(a);
    a.click();
    document.documentElement.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  // ─── Toast ─────────────────────────────────────────────────────────────────

  function showToast(text, type = 'info', duration = 3000) {
    document.getElementById('bugcapture-toast')?.remove();

    const colors = {
      info:    '#2563eb',
      warning: '#d97706',
      error:   '#dc2626',
      success: '#059669'
    };

    const toast = document.createElement('div');
    toast.id = 'bugcapture-toast';
    toast.setAttribute('role', 'alert');
    Object.assign(toast.style, {
      position:     'fixed',
      bottom:       '24px',
      right:        '24px',
      background:   colors[type] || colors.info,
      color:        'white',
      padding:      '12px 20px',
      borderRadius: '8px',
      fontSize:     '14px',
      fontFamily:   'system-ui, -apple-system, sans-serif',
      fontWeight:   '500',
      boxShadow:    '0 4px 16px rgba(0,0,0,0.3)',
      zIndex:       '2147483646',
      maxWidth:     '400px',
      lineHeight:   '1.5',
      transition:   'opacity 0.3s ease',
      opacity:      '0'
    });

    toast.textContent = text;
    document.documentElement.appendChild(toast);

    requestAnimationFrame(() =>
      requestAnimationFrame(() => { toast.style.opacity = '1'; })
    );
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

})();
