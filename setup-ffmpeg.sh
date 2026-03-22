#!/bin/bash
# setup-ffmpeg.sh — скачивает файлы ffmpeg.wasm в libs/ffmpeg/
# Запускать один раз перед установкой расширения.
#
# Использование:
#   chmod +x setup-ffmpeg.sh
#   ./setup-ffmpeg.sh

set -e

LIBS_DIR="$(dirname "$0")/libs/ffmpeg"
mkdir -p "$LIBS_DIR"

FFMPEG_VERSION="0.12.10"
CORE_VERSION="0.12.6"
BASE_URL="https://unpkg.com"

echo "Скачиваю ffmpeg.wasm в $LIBS_DIR ..."

# UMD-сборка основного пакета (определяет publicPath по src скрипта)
curl -L --progress-bar \
  "${BASE_URL}/@ffmpeg/ffmpeg@${FFMPEG_VERSION}/dist/umd/ffmpeg.js" \
  -o "${LIBS_DIR}/ffmpeg.js"

# Worker-чанк (загружается рядом с ffmpeg.js)
curl -L --progress-bar \
  "${BASE_URL}/@ffmpeg/ffmpeg@${FFMPEG_VERSION}/dist/umd/814.ffmpeg.js" \
  -o "${LIBS_DIR}/814.ffmpeg.js"

# Core — UMD-сборка с поддержкой importScripts в worker
curl -L --progress-bar \
  "${BASE_URL}/@ffmpeg/core@${CORE_VERSION}/dist/umd/ffmpeg-core.js" \
  -o "${LIBS_DIR}/ffmpeg-core.js"

curl -L --progress-bar \
  "${BASE_URL}/@ffmpeg/core@${CORE_VERSION}/dist/umd/ffmpeg-core.wasm" \
  -o "${LIBS_DIR}/ffmpeg-core.wasm"

echo ""
echo "Готово! Файлы скачаны в libs/ffmpeg/"
echo "Теперь можно загружать расширение в браузер."
