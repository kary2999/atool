/* ════════════════════════════════════════════════════════════════════
 * tools.js — DevToolbox 通用工具组：二维码 / JSON / 时间日期 / 文本对比
 * 自包含，仅通过 switchLeftTab（panel.js 提供）与主面板联动。
 * 依赖 lib/qrcode.js 暴露的全局 qrcode()。
 * ════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const escHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  function copyToBtn(text, btn) {
    if (text == null) return;
    navigator.clipboard.writeText(text).then(() => {
      const orig = btn.textContent;
      btn.textContent = '已复制 ✓';
      setTimeout(() => { btn.textContent = orig; }, 1500);
    });
  }

  // ════════════════════════════════════════════════════════════════
  // 1) 二维码
  // ════════════════════════════════════════════════════════════════
  let lastQR = { url: '', name: '' };

  function strToUtf8Bytes(str) {
    const bytes = new TextEncoder().encode(str);
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s; // 每个字符即一个 0-255 字节，供 qrcode Byte 模式使用
  }

  function genQR() {
    const text = $('qr-text').value;
    const sta  = $('qr-status');
    if (!text) { sta.className = 'tstatus err'; sta.textContent = '请输入文本'; return; }
    if (typeof qrcode !== 'function') { sta.className = 'tstatus err'; sta.textContent = 'QR 库未加载'; return; }

    const ecc  = $('qr-ecc').value;
    const cell = Math.max(2, Math.min(20, parseInt($('qr-cell').value, 10) || 6));
    const margin = 4;

    try {
      const qr = qrcode(0, ecc);                 // typeNumber 0 = 自动选版本
      qr.addData(strToUtf8Bytes(text), 'Byte');  // UTF-8 字节，支持中文
      qr.make();

      const count = qr.getModuleCount();
      const dim = (count + margin * 2) * cell;
      const cv = document.createElement('canvas');
      cv.width = cv.height = dim;
      const ctx = cv.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, dim, dim);
      ctx.fillStyle = '#000';
      for (let r = 0; r < count; r++) {
        for (let c = 0; c < count; c++) {
          if (qr.isDark(r, c)) ctx.fillRect((c + margin) * cell, (r + margin) * cell, cell, cell);
        }
      }
      const url = cv.toDataURL('image/png');
      lastQR.url = url;
      lastQR.name = 'qrcode-' + dim + 'x' + dim + '.png';

      $('qr-out').innerHTML =
        '<div class="qr-wrap"><img src="' + url + '" width="' + Math.min(dim, 320) + '" height="' + Math.min(dim, 320) + '" alt="QR">' +
        '<div class="qr-size">' + dim + ' × ' + dim + ' px · 纠错 ' + ecc + '</div></div>';
      sta.className = 'tstatus ok';
      sta.textContent = '生成成功 ✓';
    } catch (e) {
      sta.className = 'tstatus err';
      sta.textContent = '生成失败：' + e.message + '（内容过长可降低纠错级别）';
    }
  }

  function downloadQR() {
    if (!lastQR.url) return;
    const a = document.createElement('a');
    a.href = lastQR.url;
    a.download = lastQR.name;
    a.click();
  }

  // ════════════════════════════════════════════════════════════════
  // 2) JSON 工具
  // ════════════════════════════════════════════════════════════════
  // 去除 // 行注释 与 /* */ 块注释（跳过字符串内部）
  function stripJsonComments(src) {
    let out = '', i = 0, inStr = false, ch = '';
    while (i < src.length) {
      const c = src[i], n = src[i + 1];
      if (inStr) {
        out += c;
        if (c === '\\') { out += (n || ''); i += 2; continue; }
        if (c === ch) inStr = false;
        i++; continue;
      }
      if (c === '"' || c === "'") { inStr = true; ch = c; out += c; i++; continue; }
      if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
      if (c === '/' && n === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
      out += c; i++;
    }
    return out;
  }
  // 去掉对象/数组里的尾随逗号
  function stripTrailingCommas(src) {
    return src.replace(/,(\s*[}\]])/g, '$1');
  }

  function sortKeysDeep(obj) {
    if (Array.isArray(obj)) return obj.map(sortKeysDeep);
    if (obj && typeof obj === 'object') {
      const out = {};
      Object.keys(obj).sort().forEach(k => { out[k] = sortKeysDeep(obj[k]); });
      return out;
    }
    return obj;
  }

  function jsonShowResult(text) {
    $('json-out').innerHTML = '<pre>' + escHtml(text) + '</pre>';
    lastJSONResult = text;
  }
  function jsonShowError(msg) {
    $('json-out').innerHTML = '<div class="json-err">✗ ' + escHtml(msg) + '</div>';
    lastJSONResult = '';
  }
  let lastJSONResult = '';

  function jsonAction(act) {
    const raw = $('json-input').value;
    if (!raw.trim()) { jsonShowError('请输入内容'); return; }
    $('json-meta').textContent = '';

    try {
      if (act === 'escape') { jsonShowResult(JSON.stringify(raw)); return; }
      if (act === 'unescape') {
        let s = raw.trim();
        let out;
        try { out = JSON.parse(s); }
        catch (_) { out = JSON.parse('"' + s.replace(/^"|"$/g, '') + '"'); }
        jsonShowResult(typeof out === 'string' ? out : JSON.stringify(out, null, 2));
        return;
      }
      if (act === 'strip') {
        const stripped = stripTrailingCommas(stripJsonComments(raw)).replace(/^\s*\n/gm, '');
        // 尝试解析以校验；失败也照样输出去注释后的文本
        try { JSON.parse(stripped); $('json-meta').textContent = '✓ 合法 JSON'; } catch (_) { $('json-meta').textContent = '⚠ 仅去注释（未校验）'; }
        jsonShowResult(stripped.trim());
        return;
      }
      // format / min / sort 需要先去注释再 parse
      const cleaned = stripTrailingCommas(stripJsonComments(raw));
      let obj = JSON.parse(cleaned);
      if (act === 'sort') obj = sortKeysDeep(obj);
      const out = (act === 'min') ? JSON.stringify(obj) : JSON.stringify(obj, null, 2);
      jsonShowResult(out);
      $('json-meta').textContent = '✓ 合法 JSON';
    } catch (e) {
      jsonShowError('JSON 解析失败：' + e.message);
    }
  }

  // ════════════════════════════════════════════════════════════════
  // 3) 时间日期
  // ════════════════════════════════════════════════════════════════
  const TZ_LIST = [
    'UTC', 'Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Tokyo', 'Asia/Seoul', 'Asia/Singapore',
    'Asia/Kolkata', 'Asia/Bangkok', 'Asia/Dubai', 'Europe/London', 'Europe/Paris',
    'Europe/Moscow', 'America/New_York', 'America/Los_Angeles', 'America/Sao_Paulo', 'Australia/Sydney'
  ];

  function tzOffsetLabel(tz) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(new Date(0));
      const o = parts.find(p => p.type === 'timeZoneName');
      return o ? o.value.replace('GMT', 'UTC') : '';
    } catch (_) { return ''; }
  }

  function initTzSelect() {
    const sel = $('time-tz');
    const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const list = TZ_LIST.slice();
    if (!list.includes(local)) list.unshift(local);
    sel.innerHTML = list.map(tz => {
      const off = tzOffsetLabel(tz);
      return '<option value="' + tz + '"' + (tz === local ? ' selected' : '') + '>' + (off ? off + ' ' : '') + tz + '</option>';
    }).join('');
  }

  function fmtInTz(date, tz, withMs) {
    const opt = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: tz };
    const parts = new Intl.DateTimeFormat('zh-CN', opt).formatToParts(date);
    const m = {};
    parts.forEach(p => { m[p.type] = p.value; });
    let hh = (m.hour === '24') ? '00' : m.hour;
    let s = m.year + '-' + m.month + '-' + m.day + ' ' + hh + ':' + m.minute + ':' + m.second;
    if (withMs) s += '.' + String(date.getMilliseconds()).padStart(3, '0');
    return s;
  }

  function parseTimeInput() {
    const sta = $('time-status');
    const raw = $('time-input').value.trim();
    if (!raw) { sta.className = 'tstatus err'; sta.textContent = '请输入时间戳或日期'; return; }

    let date;
    if (/^\d+$/.test(raw)) {
      const num = parseInt(raw, 10);
      // 10 位=秒，13 位=毫秒，其余按位数推断
      if (raw.length <= 10) date = new Date(num * 1000);
      else if (raw.length <= 13) date = new Date(num);
      else date = new Date(num);                  // 微秒/纳秒不精确，按毫秒近似
    } else {
      const t = Date.parse(raw.replace(/-/g, '/').replace('T', ' '));
      if (isNaN(t)) { sta.className = 'tstatus err'; sta.textContent = '无法识别的日期格式'; return; }
      date = new Date(t);
    }
    if (isNaN(date.getTime())) { sta.className = 'tstatus err'; sta.textContent = '无效时间'; return; }

    renderTime(date);
    sta.className = 'tstatus ok';
    sta.textContent = '解析成功 ✓';
  }

  function loadNow() {
    const d = new Date();
    $('time-input').value = String(Math.floor(d.getTime() / 1000));
    renderTime(d);
    $('time-status').className = 'tstatus ok';
    $('time-status').textContent = '当前时间 ✓';
  }

  function renderTime(date) {
    const tz = $('time-tz').value;
    const sec = Math.floor(date.getTime() / 1000);
    const ms  = date.getTime();
    const rows = [
      ['标准时间（秒）', fmtInTz(date, tz, false), String(sec)],
      ['标准时间（毫秒）', fmtInTz(date, tz, true), String(ms)],
      ['Unix 时间戳（秒）', String(sec), String(sec)],
      ['Unix 时间戳（毫秒）', String(ms), String(ms)],
      ['ISO 8601 (UTC)', date.toISOString(), String(sec)],
      ['星期', new Intl.DateTimeFormat('zh-CN', { weekday: 'long', timeZone: tz }).format(date), String(sec)]
    ];
    $('time-out').innerHTML = '<table class="kvtable">' + rows.map(r =>
      '<tr><td>' + escHtml(r[0]) + '</td><td><span>' + escHtml(r[1]) + '</span>' +
      '<button class="time-load" data-v="' + escHtml(r[2]) + '">加载</button></td></tr>'
    ).join('') + '</table>';
    $('time-out').querySelectorAll('.time-load').forEach(b => {
      b.addEventListener('click', () => { $('time-input').value = b.dataset.v; parseTimeInput(); });
    });
  }

  // ════════════════════════════════════════════════════════════════
  // 4) 文本对比（基于 LCS 的逐行 diff）
  // ════════════════════════════════════════════════════════════════
  function lineDiff(a, b) {
    const A = a.split('\n'), B = b.split('\n');
    const n = A.length, m = B.length;
    // LCS DP
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = (A[i] === B[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const out = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (A[i] === B[j]) { out.push(['same', A[i]]); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push(['del', A[i]]); i++; }
      else { out.push(['add', B[j]]); j++; }
    }
    while (i < n) { out.push(['del', A[i++]]); }
    while (j < m) { out.push(['add', B[j++]]); }
    return out;
  }

  function runDiff() {
    const a = $('diff-a').value, b = $('diff-b').value;
    if (!a && !b) { $('diff-out').innerHTML = '<div class="tout-hint">请粘贴文本</div>'; return; }
    const diff = lineDiff(a, b);
    let adds = 0, dels = 0;
    const html = diff.map(([t, line]) => {
      if (t === 'add') adds++;
      if (t === 'del') dels++;
      const g = t === 'add' ? '+' : t === 'del' ? '-' : '';
      return '<div class="diff-line ' + t + '"><span class="diff-gutter">' + g + '</span><span class="diff-text">' + (escHtml(line) || '&nbsp;') + '</span></div>';
    }).join('');
    $('diff-out').innerHTML = html || '<div class="tout-hint">两段文本完全一致</div>';
    $('diff-meta').textContent = (adds || dels)
      ? '+' + adds + ' 行  −' + dels + ' 行'
      : '完全一致 ✓';
  }

  // ════════════════════════════════════════════════════════════════
  // 初始化
  // ════════════════════════════════════════════════════════════════
  function init() {
    // nav 联动
    ['qr', 'json', 'time', 'diff'].forEach(name => {
      $('ltab-' + name)?.addEventListener('click', () => switchLeftTab(name));
    });

    // 二维码
    $('qr-gen-btn')?.addEventListener('click', genQR);
    $('qr-download-btn')?.addEventListener('click', downloadQR);

    // JSON
    document.querySelectorAll('#tool-json .json-btn').forEach(b => {
      b.addEventListener('click', () => jsonAction(b.dataset.act));
    });
    $('json-copy-btn')?.addEventListener('click', function () { copyToBtn(lastJSONResult, this); });

    // 时间
    initTzSelect();
    $('time-parse-btn')?.addEventListener('click', parseTimeInput);
    $('time-now-btn')?.addEventListener('click', loadNow);
    $('time-tz')?.addEventListener('change', () => { if ($('time-input').value.trim()) parseTimeInput(); });
    $('time-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') parseTimeInput(); });

    // 对比
    $('diff-run-btn')?.addEventListener('click', runDiff);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
