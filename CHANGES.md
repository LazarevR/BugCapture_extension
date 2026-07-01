# BugCapture — история изменений

---

## v1.10.6 — 2026-07-02

### Изменено поведение запуска записи

**Запись теперь стартует только по явному действию пользователя** (клик на иконку или горячая клавиша).

Ранее расширение работало в режиме "записывать всегда": запись автоматически стартовала при открытии браузера, при переключении вкладок и при навигации на любой сайт. Это приводило к тому, что после нажатия "Остановить запись" запись возобновлялась при переходе на другую страницу.

**Удалено:**
- Авто-старт при запуске браузера (`onInstalled`, `onStartup`)
- Авто-старт при переключении вкладок (`chrome.tabs.onActivated`)
- Авто-старт при загрузке страницы (`onTabUpdatedAutoStart`)

**Добавлено:**
- `recordingTabId` в `chrome.storage.local` — персистентный флаг активной записи, переживает рестарты service worker
- При перезагрузке страницы во время записи — поток автоматически переподключается (поведение сохранено)
- `onTabUpdated` теперь только восстанавливает бейдж если Chrome сбросил его при навигации, но поток выжил

---

## v1.10.5 — 2026-06-30

### Новые функции

**Контекстное меню иконки расширения**
- Правый клик на иконке BugCapture открывает меню с двумя пунктами:
  - Статус (disabled): `● Идёт запись` или `○ Остановлено`
  - Кнопка: `Остановить запись` / `Начать запись` — работает идентично клику по иконке
- Меню пересоздаётся при каждом старте service worker (не пропадает после принудительного перезапуска)
- Добавлено разрешение `"contextMenus"` в manifest.json

### Исправления

**Индикатор записи при обновлении страницы**
- Бейдж (красная точка) больше не пропадает с иконки при `Ctrl+R` / `F5`, пока запись продолжается
- Ранее: `onTabUpdated(loading)` немедленно сбрасывал бейдж, а перезапуск потока занимал 1-3 сек
- Теперь: бейдж сохраняется, так как offscreen поток ещё жив; при реальном обрыве потока (`OFFSCREEN_RECORDING_ENDED`) происходит перезапуск без промежуточного сброса бейджа
- Если все попытки перезапуска исчерпаны или вкладка стала недоступной — бейдж корректно сбрасывается

---

## v1.10.4 — 2026-06-30

### Исправления багов

**B1** — Добавлен обработчик `BUGCAPTURE_GET_STATUS` в `background.js`
- Страница настроек теперь корректно показывает статус записи активной вкладки

**B3** — Устранена утечка таймера в `trimVideoBlob` (`modal.js`)
- 5-минутный страховой таймер теперь сохраняется и очищается в `finish()` при нормальном завершении

**B4** — `BUGCAPTURE_SAVE_SETTINGS` с невалидным payload теперь вызывает `sendResponse` (`background.js`)
- Канал сообщений больше не зависает при некорректных данных

**B5** — Устранены повторные вызовы `stop()` через `timeupdate` в `trimVideoBlob` (`modal.js`)
- Добавлен флаг `stopped` — обрезка WebM останавливается ровно один раз при достижении конечной точки

**B6** — `cleanup()` теперь делает `reject` для зависшего Promise (`offscreen.js`)
- При аварийном обрыве записи (ошибка рекордера, закрытие вкладки) `getBlobAsync()` больше не зависает — возвращает ошибку и UI корректно сбрасывается

---

## v1.10.3 — 2026-03-23

### 1. Новая цветовая схема (`modal/modal.css`, `settings/settings.css`)

**Изменение:**
- Тёмный фон: `#0f0f1a` / `#1a1a2e` заменены на `#111111` / `#191919`
- Акцентный цвет: синий `#4f8ef7` заменён на красный `#bf0000`, ховер `#a30000`
- Зелёный цвет (`#22c55e`) убран — все акценты теперь единого красного тона
- Кнопка «Сохранить настройки»: была зелёной → стала красной
- `.about-privacy`: зелёный бордер/фон → красный тон с нейтральным текстом

---

### 2. Склонение слова «секунда» (`settings/settings.js`)

**Проблема:** Слайдер буфера всегда показывал «секунд» независимо от числа: «1 секунд», «2 секунд».

**Решение:**
- Добавлена функция `pluralSeconds(n)` с правилами русского языка:
  - `1`, `21`, `31` → «секунда»
  - `2–4`, `22–24` → «секунды»
  - `5–20`, `25–30`, `40` → «секунд»
- Единица обновляется при загрузке настроек и при перетаскивании ползунка

---

### 3. Дефолтный формат сохранения MP4 (`background.js`, `settings/settings.js`, `settings/settings.html`)

**Проблема:** По умолчанию был выбран WebM, хотя MP4 предпочтительнее для совместимости.

**Решение:**
- `DEFAULT_SETTINGS.saveFormat` изменён с `'webm'` на `'mp4'` в `background.js` и `settings/settings.js`
- Атрибут `checked` в `settings.html` перенесён с radio-кнопки WebM на MP4
- Фоллбэк в `validateSettings()` в `background.js` также изменён на `'mp4'`

> ⚠️ Для существующих установок: настройка применится только после **полного удаления и повторной установки** расширения — `chrome.storage.local` не очищается при перезагрузке.

---

### 4. README и документация

- Создан `README.md` с подробными инструкциями по установке в Chrome, Edge, Яндекс Браузер, Opera и Firefox
- Добавлены разделы: использование, горячие клавиши, таблица настроек, требования, приватность

---

Chrome MV3 расширение — непрерывная запись экрана вкладки с кольцевым буфером.
Конвертация WebM → MP4 через ffmpeg.wasm в offscreen document.

---

## v1.10.1 — 2026-03-23

### Ограничение разрешения MP4 до 1080p (`offscreen.js`)

**Задача:** Ускорить конвертацию на экранах с высоким DPI (Retina, 4K).

**Решение:**
- ffmpeg-аргумент изменён с `scale=trunc(iw/2)*2:trunc(ih/2)*2` на `scale=-2:min(ih\,1080)`
- Если высота источника ≤ 1080 — без изменений. Если больше — масштабируется с сохранением пропорций
- `h=-2` гарантирует чётную высоту (требование H.264)
- Ускорение на MacBook Pro Retina (2880×1800 → 1728×1080): ~2.8×
- Ускорение на 4K (3840×2160 → 1920×1080): ~4×

---

## v1.10.0 — 2026-03-23

### 1. Иконка приложения (`modal/modal.html`, `modal/modal.css`, `settings/settings.html`, `settings/settings.css`, `manifest.json`)

**Изменения:**
- Эмодзи `🐛` заменён на `icons/icon.png` (256×256 PNG) в модалке и странице настроек
- Модалка: размер 20×20 px (`object-fit: contain`)
- Настройки: размер 36×36 px (`object-fit: contain`)
- `icons/icon.png` добавлен в `web_accessible_resources` манифеста (требуется для iframe)

---

### 2. Версия v1.10.0 (`manifest.json`, `settings/settings.html`)

- Версия обновлена с `1.0.0` до `1.10.0`

---

### 3. Конвертация MP4 перенесена в offscreen document (`offscreen.js`, `background.js`, `content.js`, `modal.js`)

**Проблема:** ffmpeg работал в iframe модалки — перезагрузка страницы уничтожала iframe и обрывала конвертацию.

**Решение:**
- `offscreen.js` — добавлены `convFFmpeg`, `isConverting`, функции `ensureConvFFmpeg()`, `startConversion()`, `encodeUint8Array()`, `decodeBase64()`
- `offscreen.html` — добавлена статическая загрузка `libs/ffmpeg/ffmpeg.js` (динамическая блокируется CSP)
- `background.js` — добавлен объект `convState` (`status/tabId/pct/label/base64Mp4/mimeType`), обработчики: `BUGCAPTURE_START_CONVERSION`, `BUGCAPTURE_GET_CONV_STATE`, `BUGCAPTURE_CONV_RESULT_TAKEN`, `OFFSCREEN_CONV_PROGRESS`, `OFFSCREEN_CONV_DONE`, `OFFSCREEN_CONV_ERROR`
- `content.js` — при инициализации запрашивает `BUGCAPTURE_GET_CONV_STATE`: если конвертация идёт → тост, если готово → диалог сохранения
- `modal.js` — `saveAsMP4()` делегирует в offscreen через postMessage цепочку (modal → content → background → offscreen)

**Поток сообщений:**
```
modal.js → BUGCAPTURE_START_CONVERSION → content.js → background.js
         → OFFSCREEN_CONV_START → offscreen.js → startConversion()
         → OFFSCREEN_CONV_PROGRESS/DONE/ERROR → background.js
         → BUGCAPTURE_CONV_PROGRESS/DONE/ERROR → content.js → toast / modal
```

---

### 4. Тост прогресса для WebM (`modal.js`, `content.js`)

**Проблема:** Тост отображался только при конвертации в MP4, для WebM — нет.

**Решение:**
- `saveAsWebM()` теперь устанавливает `isConverting = true` и вызывает `reportProgress()`
- Кнопка закрытия при `isConverting` — скрывает модалку (minimize), не прерывает обрезку
- При завершении WebM-обрезки: `BUGCAPTURE_SHOW_OVERLAY` возвращает оверлей

---

### 5. Исправлен баг: сохранялось 2 секунды вместо 5 (`offscreen.js`)

**Проблема:** Пользователь ставит буфер 5 сек. Ротация завершилась на 5-й секунде. Клик на 7-й секунде → `handleSessionStop` перезаписывал `latestBlob` (5 сек) коротким `currentBlob` (2 сек).

**Решение:**
- Добавлен `sessionStartTime = Date.now()` в `beginSession()`
- В `handleSessionStop()`: если `pendingResolve` установлен И сессия шла < 75% от `bufferSeconds` → `latestBlob` сохраняется (короткий `currentBlob` отбрасывается)

---

### 6. Исправлен баг: сохранялось 18 секунд вместо 5 (`offscreen.js`, `modal.js`)

**Проблема:** Механизм `prevBlob` склеивал запись до перезагрузки (13 сек) с текущей (5 сек) → 18 секунд в модалке.

**Решение:**
- Удалена логика `prevBlob = latestBlob` в `handleSessionStop()` (ранее введённая для fix п.5)
- `deliverBlob()` упрощён: отдаёт только `latestBlob`, без `prevBase64Data`
- `modal.js` — удалены `mergeWithPrev()`, `loadFFmpeg()`, `ffmpegInstance`
- `BUGCAPTURE_INIT_MODAL` — убрана ветка с `prevBlob`
- Исправление п.5 полностью решается через `sessionStartTime` без склейки блобов

---

### 7. Исправлен баг: двойная модалка при "Записать заново" (`content.js`)

**Проблема:** `BUGCAPTURE_RESTART_RECORDING` отправлял `BUGCAPTURE_TRIGGER` → `onActionClicked()` → если offscreen успел перезапустить запись → `isCapturing = true` → открывалась вторая модалка.

**Решение:**
- Заменён `BUGCAPTURE_TRIGGER` на `BUGCAPTURE_AUTO_START` (с задержкой 300 мс)
- `BUGCAPTURE_AUTO_START` запускает запись тихо, без открытия модалки

---

### 8. Нативный диалог сохранения ОС (`content.js`, `modal.js`)

**Проблема:** `showSaveFilePicker()` вызывался из sandboxed iframe → падал молча → файл уходил в Downloads без выбора имени.

**Решение:**
- MP4: `BUGCAPTURE_CONV_DONE` в `content.js` закрывает модалку и вызывает `showSaveFilePrompt()` в контексте страницы
- WebM: после обрезки `modal.js` отправляет `BUGCAPTURE_SAVE_WEBM` с blob → `content.js` закрывает модалку и вызывает `showSaveFilePrompt()`
- `showSaveFilePicker()` работает корректно в основном контексте страницы
- Fallback на `<a download>` если API недоступен
- Из `modal.js` удалены `showFilenameDialog()` и `saveWithPicker()`

---

### 9. Удалена опция "Запись с динамиков" (`offscreen.js`, `background.js`, `settings/settings.html`, `settings/settings.js`)

**Причина:** Звук с вкладки фактически не записывался — опция создавала ложное ожидание.

**Изменения:**
- Удалена секция "Аудио" из `settings.html`
- Удалены `toggleSpeakers`, `audioFromSpeakers` из `settings.js` и `DEFAULT_SETTINGS`
- Удалён `audioFromSpeakers` из `background.js` (`DEFAULT_SETTINGS`, `validateSettings`)
- `offscreen.js` — аудио-constraint жёстко `audio: false`

---

### 10. Исправлено имя файла ffmpeg (`offscreen.html`)

**Проблема:** В `offscreen.html` был `ffmpeg.min.js` — файл не существует, загрузка ffmpeg падала.

**Решение:** Исправлено на `ffmpeg.js` (реальное имя файла).

---

### 11. Авто-подрезка видео в модалке (`modal.js`)

**Проблема:** После исправления буфера в модалке мог показываться видеоролик длиннее `bufferSeconds`.

**Решение:**
- В `onVideoReady()`: если `videoDuration > bufferDuration + 0.3` → `trimStartSec = videoDuration - bufferDuration`
- Ползунок начала автоматически выставляется на нужную позицию

---

### 12. `.gitignore` и версионирование

- Создан `.gitignore`: macOS (`.DS_Store`), IDE (`.vscode/`, `.idea/`), упакованные расширения (`*.crx`, `*.pem`), Node артефакты
- Файлы `libs/ffmpeg/` включены в репозиторий (не игнорируются)

---

## v1.0.0 — начальная версия

### 1. Запись через перезагрузку страницы (`offscreen.js`, `background.js`, `content.js`, `modal.js`)

**Задача:** Не терять данные при перезагрузке/навигации вкладки.

**Решение:**
- `offscreen.js` — `saveCurrentDataAsPrev()` вызывается из `videoTrack.onended` и `recorder.onerror`; сохраняет текущие чанки или `latestBlob` в `prevBlob`
- `background.js` → `onTabUpdated(loading)`: убран вызов `OFFSCREEN_STOP` (ранее уничтожал буфер ДО перезагрузки)
- `deliverBlob()` возвращал `prevBase64Data` + `prevMimeType` вместе с основными данными
- `modal.js` → `mergeWithPrev()`: ffmpeg concat `-c copy` объединял два WebM без перекодирования *(удалено в v1.10.0 из-за конфликта с другими исправлениями)*

---

### 2. Удаление микрофона (`background.js`, `settings/settings.html`, `settings/settings.js`)

**Причина:** Микрофон вызывал ошибку "Permission dismissed" и не использовался.

**Изменения:**
- Удалены все упоминания `audioFromMic` из настроек и кода
- Удалены `toggleMic`, `openMicGrant()`, файлы `mic-grant.html` и `mic-grant.js`
- Убраны обработчики `OFFSCREEN_MIC_DENIED` и `MIC_GRANTED`

---

### 3. Иконка расширения (`create-icons.js`, `icons/`)

**Решение:**
- `create-icons.js` — генерирует PNG через Node.js без внешних зависимостей
- Генерирует `icon16.png`, `icon48.png`, `icon128.png`

---

### 4. Исправления конвертации MP4 (`modal.js`)

- **Зависание на фиксированном %**: WebM из MediaRecorder не содержит длительности → ffmpeg progress не срабатывает. Добавлен fake-прогресс с экспоненциальным замедлением
- **Нечётные размеры**: libx264 требует чётные. Добавлен `-vf scale=trunc(iw/2)*2:trunc(ih/2)*2` *(заменён на `scale=-2:min(ih\,1080)` в v1.10.1)*
- **Нет аудио-потока**: `-c:a aac` падает без аудио. Добавлен `-map 0:a:0?`
- **Медленный seek**: `-ss` перенесён перед `-i` (input seek — не декодирует лишние кадры)
- **Утечка слушателей**: `ffmpeg.on('progress')` накапливался. Добавлен `ffmpeg.off()` в `finally`

---

### 5. Сессионная ротация буфера (`offscreen.js`)

**Задача:** WebM из MediaRecorder без ротации имеет некорректные временные метки при длинных записях.

**Решение:**
- Каждые `bufferSeconds` секунд создаётся новый `MediaRecorder` → временные метки WebM всегда начинаются с 0
- `latestBlob` хранит последнюю завершённую сессию
- При клике пользователя: текущая сессия останавливается, `latestBlob` отдаётся через `deliverBlob()`

---

### 6. Minimize-iframe паттерн (`modal.js`, `content.js`)

**Задача:** Закрытие модалки во время конвертации не должно прерывать ffmpeg.

**Решение:**
- Кнопка X при `isConverting = true` → `BUGCAPTURE_MINIMIZE_MODAL`, overlay скрывается (`display: none`), iframe остаётся живым
- `content.js` показывает постоянный тост с прогрессом
- При завершении: `BUGCAPTURE_SHOW_OVERLAY` → тост убирается, overlay возвращается
- Esc-guard: не закрывает при скрытом overlay

---

## Архитектура

```
Пользователь кликает иконку
  → background.js: tabCapture.getMediaStreamId()
  → offscreen.js: getUserMedia(tabCapture) → MediaRecorder (сессии по N сек)
  → при клике снова: OFFSCREEN_GET_BLOB → deliverBlob() → base64
  → background.js → content.js: BUGCAPTURE_SHOW_MODAL
  → content.js: создаёт iframe (modal/modal.html) + postMessage(blob)
  → modal.js: превью, обрезка ползунками
  → "Сохранить":
      WebM → trimVideoBlob() → BUGCAPTURE_SAVE_WEBM → content.js → showSaveFilePrompt()
      MP4  → BUGCAPTURE_START_CONVERSION → background → offscreen → ffmpeg.wasm
           → BUGCAPTURE_CONV_DONE → content.js → showSaveFilePrompt()
           → showSaveFilePicker() [нативный диалог ОС]
```

---

## Файлы проекта

| Файл | Назначение |
|------|-----------|
| `manifest.json` | MV3 манифест, версия, разрешения |
| `background.js` | Service worker: захват вкладки, настройки, маршрутизация сообщений, convState |
| `offscreen.js` | Offscreen document: MediaRecorder, кольцевой буфер, ffmpeg.wasm конвертация |
| `offscreen.html` | HTML для offscreen document (статическая загрузка ffmpeg.js) |
| `content.js` | Content script: модалка, тосты, горячие клавиши, диалог сохранения |
| `modal/modal.html` | HTML модального окна (sandboxed iframe) |
| `modal/modal.js` | Превью видео, обрезка trim, управление конвертацией |
| `modal/modal.css` | Стили модалки |
| `settings/settings.html` | Страница настроек расширения |
| `settings/settings.js` | Логика настроек: буфер, формат, горячая клавиша |
| `settings/settings.css` | Стили настроек |
| `libs/ffmpeg/` | ffmpeg.wasm библиотеки (ffmpeg.js, 814.ffmpeg.js, ffmpeg-core.js, ffmpeg-core.wasm) |
| `icons/` | PNG иконки (icon.png 256×256, icon16/48/128.png) |
| `create-icons.js` | Генератор иконок (Node.js, без зависимостей) |
| `setup-ffmpeg.sh` | Скрипт загрузки ffmpeg.wasm из unpkg.com |
| `.gitignore` | Исключения для git |
