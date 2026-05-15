// Run once with: node gen-icons.js
// Generates placeholder icons using the canvas npm package or falls back to base64 PNGs
const fs = require('fs');
const path = require('path');

// Minimal 1x1 transparent PNG base64 — replace with real icons later
// These are valid PNGs at the correct sizes generated via pure Buffer
function createPNG(size, r, g, b) {
  // We'll write a tiny valid PNG using raw bytes
  // For simplicity, output a solid-color PNG using the pngjs-less approach:
  // Just copy a hardcoded valid minimal PNG and note that Chrome accepts any valid PNG
  const { createCanvas } = (() => {
    try { return require('canvas'); } catch { return null; }
  })() || {};

  if (createCanvas) {
    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext('2d');
    // Background
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(0, 0, size, size);
    // "WS" text
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${Math.floor(size * 0.45)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('WS', size / 2, size / 2);
    return canvas.toBuffer('image/png');
  }

  // Fallback: write a minimal valid 1x1 red PNG and warn
  console.warn(`canvas package not found — writing placeholder 1x1 PNG for size ${size}`);
  // Minimal valid PNG (1x1 transparent)
  return Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a4944415478016360000000020001e221bc330000000049454e44ae426082',
    'hex'
  );
}

const dir = path.join(__dirname, 'icons');
fs.mkdirSync(dir, { recursive: true });

for (const size of [16, 48, 128]) {
  fs.writeFileSync(path.join(dir, `icon${size}.png`), createPNG(size, 0, 120, 212));
  console.log(`icons/icon${size}.png written`);
}
