#!/usr/bin/env node
/**
 * Генератор иконок BugCapture — красный глаз
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

function createPNG(size) {
  const pixels = new Uint8Array(size * size * 4);

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const idx = (py * size + px) * 4;

      // Нормализация в [-0.5, 0.5]
      const fx = px / (size - 1) - 0.5;
      const fy = py / (size - 1) - 0.5;
      const dist = Math.sqrt(fx * fx + fy * fy);

      // Прозрачно за пределами круглой иконки
      if (dist > 0.5) { pixels[idx + 3] = 0; continue; }

      // Фон — почти чёрный с лёгким пурпурным оттенком
      let r = 12, g = 8, b = 18, a = 255;

      // Форма глаза — миндалевидный эллипс
      const eyeW   = 0.40;  // половина ширины
      const eyeMaxH = 0.19; // максимальная полувысота

      if (Math.abs(fx) < eyeW) {
        const xNorm = fx / eyeW;                                       // -1 .. 1
        const eyeH  = eyeMaxH * Math.pow(1 - xNorm * xNorm, 0.55);    // форма миндаля
        const yNorm = fy / eyeH;                                       // -1 .. 1 внутри глаза

        if (Math.abs(fy) < eyeH) {
          // Склера (белок)
          r = 245; g = 238; b = 232; a = 255;

          // Ирис — красный круг
          const irisR   = eyeMaxH * 0.88;
          const irisDist = Math.sqrt(fx * fx + fy * fy);

          if (irisDist < irisR) {
            const t = irisDist / irisR;              // 0 = центр, 1 = край ириса
            r = Math.round(215 + t * 20);            // 215→235 от центра к краю
            g = Math.round(20  - t * 10);
            b = Math.round(20  - t * 10);
            a = 255;

            // Зрачок
            const pupilR = irisR * 0.42;
            if (irisDist < pupilR) {
              const pt = irisDist / pupilR;
              r = Math.round(8  + pt * 30);
              g = Math.round(2  + pt * 10);
              b = Math.round(5  + pt * 15);
              a = 255;
            }

            // Блик (только для размеров ≥ 32)
            if (size >= 32) {
              const hlX  = fx - irisR * 0.28;
              const hlY  = fy + irisR * 0.28;
              const hlR  = irisR * 0.28;
              const hlDist = Math.sqrt(hlX * hlX + hlY * hlY);
              if (hlDist < hlR) {
                const ht = 1 - hlDist / hlR;
                r = Math.round(r + (255 - r) * ht * 0.7);
                g = Math.round(g + (180 - g) * ht * 0.5);
                b = Math.round(b + (180 - b) * ht * 0.5);
              }
            }
          }

          // Тёмный контур век (верх и низ)
          const edgeFraction = 1 - Math.abs(yNorm); // 1 = центр, 0 = край
          if (edgeFraction < 0.18 && size >= 32) {
            const blend = edgeFraction / 0.18;
            r = Math.round(r * blend + 20 * (1 - blend));
            g = Math.round(g * blend + 10 * (1 - blend));
            b = Math.round(b * blend + 15 * (1 - blend));
          }
        }
      }

      // Плавное сглаживание краёв иконки
      const fade = dist > 0.46 ? Math.max(0, 1 - (dist - 0.46) / 0.04) : 1;

      pixels[idx]     = r;
      pixels[idx + 1] = g;
      pixels[idx + 2] = b;
      pixels[idx + 3] = Math.round(a * fade);
    }
  }

  return encodePNG(size, size, pixels);
}

function encodePNG(width, height, pixels) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width,  0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8]  = 8; // bit depth
  ihdrData[9]  = 6; // color type: RGBA
  ihdrData[10] = 0;
  ihdrData[11] = 0;
  ihdrData[12] = 0;
  const ihdr = makeChunk('IHDR', ihdrData);

  const rowSize = width * 4;
  const rawData = Buffer.alloc(height * (rowSize + 1));
  for (let y = 0; y < height; y++) {
    rawData[y * (rowSize + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 4;
      const dst = y * (rowSize + 1) + 1 + x * 4;
      rawData[dst]     = pixels[src];
      rawData[dst + 1] = pixels[src + 1];
      rawData[dst + 2] = pixels[src + 2];
      rawData[dst + 3] = pixels[src + 3];
    }
  }

  const compressed = zlib.deflateSync(rawData, { level: 9 });
  const idat = makeChunk('IDAT', compressed);
  const iend = makeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([sig, ihdr, idat, iend]);
}

function makeChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crcValue   = crc32(Buffer.concat([typeBuffer, data]));
  const crcBuffer  = Buffer.alloc(4);
  crcBuffer.writeUInt32BE(crcValue >>> 0, 0);
  return Buffer.concat([length, typeBuffer, data, crcBuffer]);
}

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xFF];
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

const iconsDir = path.join(__dirname, 'icons');
if (!fs.existsSync(iconsDir)) fs.mkdirSync(iconsDir, { recursive: true });

for (const size of [16, 48, 128]) {
  const png      = createPNG(size);
  const filepath = path.join(iconsDir, `icon${size}.png`);
  fs.writeFileSync(filepath, png);
  console.log(`✓ ${size}x${size}: ${filepath} (${png.length} байт)`);
}
console.log('\nИконки созданы!');
