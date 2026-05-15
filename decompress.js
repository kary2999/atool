// Auto-detect and decompress binary WebSocket payloads

const FORMATS = ['gzip', 'deflate', 'deflate-raw'];

// Magic byte signatures
function detectFormat(bytes) {
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) return 'gzip';
  // zlib header: first byte 0x78, second byte 0x9c / 0x01 / 0xda / 0x5e
  if (bytes[0] === 0x78 && (bytes[1] === 0x9c || bytes[1] === 0x01 || bytes[1] === 0xda || bytes[1] === 0x5e)) {
    return 'deflate';
  }
  return null;
}

async function decompressWith(bytes, format) {
  const ds = new DecompressionStream(format);
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();

  writer.write(new Uint8Array(bytes));
  writer.close();

  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return new TextDecoder().decode(out);
}

// Returns { format, text } or null if not compressed / can't decompress
async function autoDecompress(bytes) {
  const hint = detectFormat(bytes);
  const order = hint ? [hint, ...FORMATS.filter(f => f !== hint)] : FORMATS;

  for (const fmt of order) {
    try {
      const text = await decompressWith(bytes, fmt);
      return { format: fmt, text };
    } catch {}
  }
  return null;
}

// Best-effort JSON pretty print
function tryJSON(text) {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}
