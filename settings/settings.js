/**
 * BugCapture — settings.js
 *
 * Управляет страницей настроек:
 * - Загружает текущие настройки из chrome.storage
 * - Обрабатывает ввод горячей клавиши
 * - Сохраняет настройки и уведомляет content script
 */

'use strict';

// ─── DOM элементы ─────────────────────────────────────────────────────────────

const bufferSlider = document.getElementById('buffer-slider');
const bufferValue = document.getElementById('buffer-value');
const sliderValueUnit = document.querySelector('.slider-value-unit');
const hotkeyInput = document.getElementById('hotkey-input');
const btnClearHotkey = document.getElementById('btn-clear-hotkey');
const hotkeyHint = document.getElementById('hotkey-hint');
const settingsForm = document.getElementById('settings-form');
const btnSaveSettings = document.getElementById('btn-save-settings');
const btnReset = document.getElementById('btn-reset');
const saveStatus = document.getElementById('save-status');
const statusDot = document.querySelector('.status-dot');
const statusText = document.getElementById('status-text');

// ─── Состояние ────────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
  bufferSeconds: 15,
  saveFormat: 'mp4',
  hotkey: ''
};

let currentHotkey = '';
let isRecordingHotkey = false;

// ─── Утилиты ──────────────────────────────────────────────────────────────────

function pluralSeconds(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'секунда';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'секунды';
  return 'секунд';
}

// ─── Инициализация ────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', init);

async function init() {
  await loadSettings();
  setupSlider();
  setupHotkeyInput();
  setupFormHandlers();
  updateRecordingStatus();
}

// ─── Загрузка настроек ────────────────────────────────────────────────────────

async function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get('settings', (result) => {
      const settings = validateSettings(result.settings || {});
      applySettingsToUI(settings);
      resolve(settings);
    });
  });
}

function applySettingsToUI(settings) {
  bufferSlider.value = settings.bufferSeconds;
  bufferValue.textContent = settings.bufferSeconds;
  sliderValueUnit.textContent = pluralSeconds(settings.bufferSeconds);
  updateSliderBackground(bufferSlider);

  // Радиокнопки формата
  const formatRadios = document.querySelectorAll('input[name="save-format"]');
  formatRadios.forEach(r => {
    r.checked = r.value === settings.saveFormat;
  });

  currentHotkey = settings.hotkey || '';
  if (currentHotkey) {
    hotkeyInput.value = currentHotkey;
    hotkeyHint.textContent = `Текущая комбинация: ${currentHotkey}`;
  } else {
    hotkeyInput.value = '';
    hotkeyHint.textContent = 'Горячая клавиша не задана';
  }
}

function validateSettings(raw) {
  const validated = {};

  const bufSec = parseInt(raw.bufferSeconds, 10);
  validated.bufferSeconds = (!isNaN(bufSec) && bufSec >= 5 && bufSec <= 40)
    ? bufSec : DEFAULT_SETTINGS.bufferSeconds;

  validated.saveFormat = (raw.saveFormat === 'mp4' || raw.saveFormat === 'webm')
    ? raw.saveFormat : DEFAULT_SETTINGS.saveFormat;

  validated.hotkey = (typeof raw.hotkey === 'string' && raw.hotkey.length <= 50)
    ? raw.hotkey.replace(/[<>"'`]/g, '') : DEFAULT_SETTINGS.hotkey;

  return validated;
}

// ─── Слайдер буфера ───────────────────────────────────────────────────────────

function setupSlider() {
  updateSliderBackground(bufferSlider);

  bufferSlider.addEventListener('input', () => {
    const val = parseInt(bufferSlider.value, 10);
    bufferValue.textContent = val;
    sliderValueUnit.textContent = pluralSeconds(val);
    bufferSlider.setAttribute('aria-valuenow', val);
    updateSliderBackground(bufferSlider);
  });
}

function updateSliderBackground(slider) {
  const min = parseInt(slider.min, 10) || 0;
  const max = parseInt(slider.max, 10) || 100;
  const val = parseInt(slider.value, 10) || 0;
  const pct = ((val - min) / (max - min)) * 100;
  slider.style.setProperty('--val', pct + '%');
}

// ─── Горячая клавиша ──────────────────────────────────────────────────────────

function setupHotkeyInput() {
  hotkeyInput.addEventListener('focus', () => {
    isRecordingHotkey = true;
    hotkeyInput.classList.add('recording');
    hotkeyInput.value = '';
    hotkeyHint.textContent = '⌨️ Нажмите нужную комбинацию клавиш...';
  });

  hotkeyInput.addEventListener('blur', () => {
    isRecordingHotkey = false;
    hotkeyInput.classList.remove('recording');
    if (!currentHotkey) {
      hotkeyInput.value = '';
      hotkeyHint.textContent = 'Горячая клавиша не задана';
    } else {
      hotkeyInput.value = currentHotkey;
      hotkeyHint.textContent = `Текущая комбинация: ${currentHotkey}`;
    }
  });

  hotkeyInput.addEventListener('keydown', onHotkeyKeydown);

  btnClearHotkey.addEventListener('click', () => {
    currentHotkey = '';
    hotkeyInput.value = '';
    hotkeyHint.textContent = 'Горячая клавиша не задана';
    hotkeyInput.blur();
  });
}

function onHotkeyKeydown(event) {
  if (!isRecordingHotkey) return;

  event.preventDefault();
  event.stopPropagation();

  const specialKeys = new Set([
    'Control', 'Alt', 'Shift', 'Meta',
    'CapsLock', 'NumLock', 'ScrollLock',
    'ContextMenu', 'OS'
  ]);

  // Esc — отменяем запись
  if (event.key === 'Escape') {
    isRecordingHotkey = false;
    hotkeyInput.classList.remove('recording');
    hotkeyInput.blur();
    return;
  }

  // Backspace / Delete — очищаем
  if (event.key === 'Backspace' || event.key === 'Delete') {
    currentHotkey = '';
    hotkeyInput.value = '';
    hotkeyHint.textContent = 'Горячая клавиша очищена';
    isRecordingHotkey = false;
    hotkeyInput.classList.remove('recording');
    hotkeyInput.blur();
    return;
  }

  // Игнорируем только-модификаторные нажатия
  if (specialKeys.has(event.key)) return;

  const combo = buildKeyCombo(event);

  // Требуем хотя бы один модификатор для предотвращения конфликтов
  const hasModifier = event.ctrlKey || event.altKey || event.metaKey || event.shiftKey;
  if (!hasModifier) {
    hotkeyHint.textContent = '⚠️ Добавьте модификатор: Ctrl, Alt, Shift или Meta';
    return;
  }

  currentHotkey = combo;
  hotkeyInput.value = combo;
  hotkeyHint.textContent = `✓ Задана комбинация: ${combo}`;

  isRecordingHotkey = false;
  hotkeyInput.classList.remove('recording');
  // Небольшая задержка перед blur чтобы пользователь увидел результат
  setTimeout(() => hotkeyInput.blur(), 150);
}

function buildKeyCombo(event) {
  const parts = [];
  if (event.ctrlKey) parts.push('Ctrl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  if (event.metaKey) parts.push('Meta');

  const key = event.key;
  const specialKeys = new Set([
    'Control', 'Alt', 'Shift', 'Meta',
    'CapsLock', 'Tab', 'Escape', 'Enter',
    'Backspace', 'Delete', 'Insert',
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
    'Home', 'End', 'PageUp', 'PageDown'
  ]);

  if (!specialKeys.has(key)) {
    // Для буквенных клавиш — uppercase
    if (key.length === 1) {
      parts.push(key.toUpperCase());
    } else {
      parts.push(key);
    }
  }

  return parts.join('+');
}

// ─── Форма ────────────────────────────────────────────────────────────────────

function setupFormHandlers() {
  settingsForm.addEventListener('submit', (e) => {
    e.preventDefault();
    saveSettings();
  });

  btnReset.addEventListener('click', resetSettings);
}

async function saveSettings() {
  const formatRadio = document.querySelector('input[name="save-format"]:checked');
  const saveFormat = formatRadio ? formatRadio.value : 'webm';

  const settings = {
    bufferSeconds: parseInt(bufferSlider.value, 10),
    saveFormat: saveFormat,
    hotkey: currentHotkey
  };

  // Валидируем перед сохранением
  const validated = validateSettings(settings);

  return new Promise((resolve) => {
    chrome.storage.local.set({ settings: validated }, () => {
      if (chrome.runtime.lastError) {
        showSaveStatus('Ошибка сохранения', false);
        resolve(false);
        return;
      }

      showSaveStatus('✓ Настройки сохранены', true);

      // Уведомляем все активные вкладки об обновлении горячей клавиши
      notifyTabsHotkeyUpdate(validated.hotkey);

      resolve(true);
    });
  });
}

async function resetSettings() {
  if (!confirm('Сбросить все настройки по умолчанию?')) return;

  chrome.storage.local.set({ settings: DEFAULT_SETTINGS }, () => {
    applySettingsToUI(DEFAULT_SETTINGS);
    currentHotkey = '';
    showSaveStatus('✓ Настройки сброшены', true);
    notifyTabsHotkeyUpdate('');
  });
}

function notifyTabsHotkeyUpdate(hotkey) {
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      if (tab.id && tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('edge://')) {
        chrome.tabs.sendMessage(tab.id, {
          type: 'BUGCAPTURE_SETTINGS_UPDATED',
          hotkey: hotkey
        }).catch(() => {});
      }
    }
  });
}

// ─── Статус сохранения ────────────────────────────────────────────────────────

let saveStatusTimeout = null;

function showSaveStatus(message, success) {
  clearTimeout(saveStatusTimeout);

  saveStatus.textContent = message;
  saveStatus.className = 'save-status visible ' + (success ? 'success' : 'error');

  saveStatusTimeout = setTimeout(() => {
    saveStatus.className = 'save-status';
  }, 3000);
}

// ─── Статус записи ────────────────────────────────────────────────────────────

function updateRecordingStatus() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs || tabs.length === 0) {
      setStatusUI('idle', 'Нет активной вкладки');
      return;
    }

    const tab = tabs[0];
    if (!tab.id) {
      setStatusUI('idle', 'Нет активной вкладки');
      return;
    }

    // Спрашиваем background о статусе вкладки
    chrome.runtime.sendMessage(
      { type: 'BUGCAPTURE_GET_STATUS', tabId: tab.id },
      (response) => {
        if (chrome.runtime.lastError) {
          setStatusUI('idle', 'Готово к записи');
          return;
        }

        if (response && response.isCapturing) {
          const chunks = response.chunksCount || 0;
          setStatusUI('recording', `Идёт запись (${chunks} сек в буфере)`);
        } else {
          setStatusUI('idle', 'Готово к записи — нажмите иконку в панели');
        }
      }
    );
  });
}

function setStatusUI(state, text) {
  statusDot.className = 'status-dot ' + state;
  statusText.textContent = text;
}
