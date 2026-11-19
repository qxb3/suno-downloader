// ==UserScript==
// @name         Suno Downloader
// @namespace    https://github.com/qxb3/suno-downloader
// @version      1.3.0
// @description  Replaces Suno's share button with a download button — the userscript port of suno-downloader.
// @author       suno-downloader
// @match        https://suno.com/*
// @match        https://*.suno.com/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @connect      studio-api.prod.suno.com
// @connect      d2lwuy8qc234o3.cloudfront.net
// @connect      cdn1.suno.ai
// @connect      *.suno.ai
// @require      https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.all.js
// @noframes
// ==/UserScript==

/*
 * Browser port of the suno-downloader CLI (src/main.rs). Same steps:
 *
 * 1. Clip metadata from `studio-api.prod.suno.com/api/clip/<id>`. For
 *    anonymous clients `audio_url` is the literal `/api/forbidden` decoy, so
 *    the encrypted stream below is the usual source.
 * 2. The playable audio is `d2lwuy8qc234o3.cloudfront.net/1/clip/<id>.m4a`
 *    (Opus in MP4).
 * 3. `POST studio-api.prod.suno.com/api/mango/rights` returns `key`, `iv` and
 *    `glt` — the guest-token endpoint Suno's player uses.
 * 4. SHA-256 of `glt` is an AES-256-GCM key; `key` and `iv` are AES-GCM
 *    envelopes with a 12-byte nonce prefix and the clip id as AAD.
 * 5. The stream itself is AES-CTR with a 128-bit big-endian counter.
 * 6. Opus → PCM with the browser's decoder, PCM → MP3 with lamejs.
 *
 * The button replaces Suno's share control on each clip:
 *   <button aria-label="Share" class="hxc-btn-base …">
 *     <span aria-hidden="true" class="hxc-btn-tap-target"></span>  ← only a
 *     hit area, and every hxc button has one, so the button is the anchor.
 * The replacement copies that button's classes and internal spans so it keeps
 * the same size, shape and hover treatment as the control it replaces.
 */

(function () {
  'use strict';

  const API_BASE = 'https://studio-api.prod.suno.com/api/clip/';
  const RIGHTS_URL = 'https://studio-api.prod.suno.com/api/mango/rights';
  const ENCRYPTED_AUDIO_BASE = 'https://d2lwuy8qc234o3.cloudfront.net/1/clip/';
  const CDN_BASE = 'https://cdn1.suno.ai/';
  const AES_BLOCK = 16;

  /** MP3 bitrate, the equivalent of the CLI's --bitrate (CLI default ≈ 245). */
  const MP3_BITRATE = 256;

  /** Suno names its share control "Share"; also "Share song"/"Share clip". */
  const SHARE_LABEL = /^share(\s+(song|clip|track))?$/i;

  const HAS_GM = typeof GM_xmlhttpRequest === 'function';

  const ICON = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24"',
    ' fill="currentColor" class="hxc-btn-icon" aria-hidden="true">',
    '<path d="M12 3a1 1 0 0 1 1 1v9.586l3.293-3.293a1 1 0 1 1 1.414 1.414l-5 5a1 1 0 0 1-1.414',
    ' 0l-5-5a1 1 0 0 1 1.414-1.414L11 13.586V4a1 1 0 0 1 1-1ZM5 19a1 1 0 0 1 1-1h12a1 1 0 1',
    '1 0 2H6a1 1 0 0 1-1-1Z"/></svg>',
  ].join('');

  const SPINNER = '<span class="suno-downloader-spinner" aria-hidden="true"></span>';

  const CSS = `
.suno-downloader-btn { cursor: pointer; }
.suno-downloader-btn[data-busy="true"] {
  cursor: progress;
  opacity: 0.7;
  pointer-events: none;
}
.suno-downloader-spinner {
  display: block;
  width: 1em;
  height: 1em;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: suno-downloader-spin 700ms linear infinite;
}
@keyframes suno-downloader-spin { to { transform: rotate(360deg); } }
.suno-downloader-toasts {
  position: fixed;
  right: 20px;
  bottom: 20px;
  z-index: 2147483647;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  pointer-events: none;
}
.suno-downloader-toast {
  max-width: min(380px, calc(100vw - 40px));
  padding: 10px 14px;
  border: 1px solid rgba(127, 127, 127, 0.35);
  border-radius: 10px;
  background: #141414;
  color: #f4f4f4;
  font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.45);
  opacity: 1;
  transition: opacity 200ms ease, transform 200ms ease;
}
.suno-downloader-toast--error { border-color: #b4483d; }
.suno-downloader-toast--leaving { opacity: 0; transform: translateY(4px); }
`;

  /* ------------------------------------------------------------------ *
   * HTTP
   * ------------------------------------------------------------------ */

  /**
   * GM_xmlhttpRequest wrapper: not subject to CORS, so it covers the CDN
   * hosts that do not send CORS headers.
   */
  function gmRequest(url, options) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: options.method || 'GET',
        url,
        headers: options.headers,
        data: options.body,
        responseType: 'arraybuffer',
        timeout: 600000,
        onload: (response) => resolve({ status: response.status, buffer: response.response }),
        onerror: () => reject(new Error(`could not reach ${url}`)),
        ontimeout: () => reject(new Error(`timed out reaching ${url}`)),
        onabort: () => reject(new Error(`request aborted for ${url}`)),
      });
    });
  }

  async function pageRequest(url, options) {
    const response = await fetch(url, {
      method: options.method || 'GET',
      headers: options.headers,
      body: options.body,
      // suno.com's own app calls the studio API with cookies; the CDNs answer
      // with a wildcard CORS header, which a credentialed request would lose.
      credentials: options.credentials || 'include',
      mode: 'cors',
    });
    return { status: response.status, buffer: await response.arrayBuffer() };
  }

  async function request(url, options = {}) {
    try {
      return await pageRequest(url, options);
    } catch (err) {
      if (!HAS_GM) throw err;
      return gmRequest(url, options);
    }
  }

  function parseJson(response) {
    try {
      return JSON.parse(new TextDecoder('utf-8').decode(response.buffer));
    } catch {
      throw new Error('unexpected response from Suno');
    }
  }

  function jsonHeaders() {
    return { Accept: 'application/json', 'Content-Type': 'application/json' };
  }

  /* ------------------------------------------------------------------ *
   * Suno API
   * ------------------------------------------------------------------ */

  const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

  function uuidFrom(text) {
    const match = UUID_RE.exec(text || '');
    return match ? match[0].toLowerCase() : null;
  }

  function usableAudioUrl(url) {
    return typeof url === 'string' && url.startsWith('http') && !url.includes('/api/forbidden');
  }

  function looksLikeMp3(url) {
    return /\.mp3$/i.test(String(url).split('?')[0]);
  }

  function isPlainMedia(media) {
    const contentType = String(media.content_type || '').toLowerCase();
    return (
      !contentType.includes('opus') &&
      (contentType.includes('mpeg') ||
        contentType.includes('mp3') ||
        contentType === 'audio/mp4' ||
        contentType === 'audio/m4a' ||
        String(media.url).toLowerCase().includes('.mp3'))
    );
  }

  async function fetchClip(id) {
    const url = API_BASE + id;
    const response = await request(url, { headers: { Accept: 'application/json' } });
    if (response.status === 404) {
      throw new Error(`song ${id} was not found (it may be private or deleted)`);
    }
    if (!response.status || response.status >= 400) {
      throw new Error(`Suno API returned HTTP ${response.status} for song ${id}`);
    }
    const clip = parseJson(response);
    if (!clip || (!clip.id && !clip.title)) {
      throw new Error(`Suno returned no song data for ${id}`);
    }
    return clip;
  }

  async function fetchRights(id) {
    const response = await request(RIGHTS_URL, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ content_params: { content_id: id, content_type: 'clip' } }),
    });
    if (!response.status || response.status >= 400) {
      throw new Error(`Suno's rights endpoint returned HTTP ${response.status}`);
    }
    const rights = parseJson(response);
    if (!rights || !rights.key || !rights.iv || !rights.glt) {
      throw new Error("Suno's rights response is missing key, IV, or guest token data");
    }
    return rights;
  }

  /* ------------------------------------------------------------------ *
   * Crypto (WebCrypto equivalents of the CLI's aes-gcm + ctr steps)
   * ------------------------------------------------------------------ */

  function base64ToBytes(value) {
    let text = String(value)
      .trim()
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .replace(/\s+/g, '');
    text += '='.repeat((4 - (text.length % 4)) % 4);
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  /**
   * AES-GCM unwrap: 12-byte nonce prefix, then ciphertext + tag, with the clip
   * id as additional authenticated data.
   */
  async function unwrapSecret(gcmKey, wrapped, id, label) {
    const bytes = base64ToBytes(wrapped);
    if (bytes.length < 12 + 16) {
      throw new Error(`Suno's wrapped audio ${label} is incomplete`);
    }
    const nonce = bytes.subarray(0, 12);
    const ciphertext = bytes.subarray(12);
    try {
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: nonce, additionalData: new TextEncoder().encode(id) },
        gcmKey,
        ciphertext,
      );
      return new Uint8Array(plain);
    } catch {
      throw new Error(`could not unwrap the audio ${label}`);
    }
  }

  async function encryptedSource(id) {
    const stream = await request(ENCRYPTED_AUDIO_BASE + id + '.m4a', { credentials: 'omit' });
    if (!stream.status || stream.status >= 400 || !stream.buffer.byteLength) {
      throw new Error('the encrypted audio stream is not available');
    }

    const rights = await fetchRights(id);
    const userKey = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rights.glt));
    const gcmKey = await crypto.subtle.importKey('raw', userKey, { name: 'AES-GCM' }, false, [
      'decrypt',
    ]);

    const key = await unwrapSecret(gcmKey, rights.key, id, 'key');
    const iv = await unwrapSecret(gcmKey, rights.iv, id, 'IV');
    if (iv.length !== AES_BLOCK) throw new Error('the unwrapped audio IV must be 16 bytes');
    if (key.length !== 16 && key.length !== 32) {
      throw new Error(`unsupported audio key length ${key.length}`);
    }

    return { stream, key, iv };
  }

  /** AES-CTR with the full 16-byte IV as counter block (CLI: Ctr128BE). */
  async function decryptStream(buffer, key, iv) {
    const ctrKey = await crypto.subtle.importKey('raw', key, { name: 'AES-CTR' }, false, [
      'decrypt',
    ]);
    try {
      return await crypto.subtle.decrypt(
        // 64 bits of incrementing counter is exact for any real clip: the
        // CLI's Ctr128BE only differs past 2^64 blocks.
        { name: 'AES-CTR', counter: iv, length: 64 },
        ctrKey,
        buffer,
      );
    } catch (err) {
      throw new Error(`could not decrypt Suno's audio stream (${err.message})`);
    }
  }

  /* ------------------------------------------------------------------ *
   * Opus → PCM → MP3 (the CLI's ffmpeg step, in the browser)
   * ------------------------------------------------------------------ */

  const LAME_URL = 'https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.all.js';

  /** Encoders to run at once: one per core, capped so the PCM copies stay bounded. */
  const MAX_ENCODERS = 8;

  /** Shortest slice worth its own worker, in seconds. */
  const MIN_CHUNK_SECONDS = 12;

  async function decodeAudio(data) {
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) throw new Error('this browser has no audio decoder');
    const context = new Context();
    try {
      // decodeAudioData detaches its argument, so hand it a copy.
      return await context.decodeAudioData(data.slice(0));
    } finally {
      try {
        await context.close();
      } catch {
        /* already closed */
      }
    }
  }

  /**
   * One self-contained PCM → MP3 pass. It is stringified into the worker
   * source, so it may only rely on its argument and on the `lamejs` global.
   */
  async function encodePcmPart(part, report) {
    const encoder = new lamejs.Mp3Encoder(part.channels, part.sampleRate, part.bitrate);
    const left = part.left;
    const right = part.right;
    const total = left.length;
    const block = 1152;
    const leftBlock = new Int16Array(block);
    const rightBlock = right ? new Int16Array(block) : null;
    const parts = [];
    let blocks = 0;

    const convert = (source, target, offset, size) => {
      for (let i = 0; i < size; i += 1) {
        const sample = source[offset + i];
        target[i] = sample > 1 ? 32767 : sample < -1 ? -32768 : (sample * 32767) | 0;
      }
    };

    for (let offset = 0; offset < total; offset += block) {
      const size = Math.min(block, total - offset);
      convert(left, leftBlock, offset, size);
      if (right) convert(right, rightBlock, offset, size);
      const encoded = right
        ? encoder.encodeBuffer(leftBlock.subarray(0, size), rightBlock.subarray(0, size))
        : encoder.encodeBuffer(leftBlock.subarray(0, size));
      if (encoded.length) parts.push(new Int8Array(encoded));

      blocks += 1;
      if (blocks >= 24) {
        blocks = 0;
        if (report) report(offset / total);
        // A macrotask, so the page (or worker loop) can breathe between blocks.
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }

    const tail = encoder.flush();
    if (tail.length) parts.push(new Int8Array(tail));
    if (report) report(1);

    const blob = new Blob(parts, { type: 'audio/mpeg' });
    return new Uint8Array(await blob.arrayBuffer());
  }

  function encoderWorkerSource() {
    return [
      `importScripts(${JSON.stringify(LAME_URL)});`,
      encodePcmPart.toString(),
      'self.onmessage = async (event) => {',
      '  const part = event.data;',
      '  try {',
      '    const bytes = await encodePcmPart(part, (fraction) =>',
      '      self.postMessage({ id: part.id, progress: fraction }));',
      '    self.postMessage({ id: part.id, bytes }, [bytes.buffer]);',
      '  } catch (error) {',
      '    self.postMessage({ id: part.id, error: error && error.message ? error.message : String(error) });',
      '  }',
      '};',
    ].join('\n');
  }

  function startWorkerPool(count) {
    let url = null;
    const workers = [];
    const release = () => {
      workers.forEach((worker) => worker.terminate());
      if (url) URL.revokeObjectURL(url);
    };
    try {
      url = URL.createObjectURL(new Blob([encoderWorkerSource()], { type: 'text/javascript' }));
      for (let i = 0; i < count; i += 1) workers.push(new Worker(url));
      return { workers, release };
    } catch (err) {
      // No Worker support, or a CSP that forbids blob workers.
      release();
      return null;
    }
  }

  function runWorker(worker, part, onProgress) {
    return new Promise((resolve, reject) => {
      worker.onmessage = (event) => {
        const message = event.data;
        if (!message || message.id !== part.id) return;
        if (typeof message.progress === 'number') {
          onProgress(message.progress);
          return;
        }
        if (message.error) reject(new Error(message.error));
        else resolve(new Uint8Array(message.bytes));
      };
      worker.onerror = (event) =>
        reject(new Error(event.message || 'the MP3 encoder worker failed'));
      const transfer = [part.left.buffer];
      if (part.right) transfer.push(part.right.buffer);
      worker.postMessage(part, transfer);
    });
  }

  /**
   * Encode the ranged PCM in parallel. MP3 frames are self-contained, so each
   * slice can be encoded independently and the results concatenated.
   */
  async function encodeParts(job, onProgress) {
    const { left, right, channels, sampleRate, ranges } = job;
    const partFor = (range, id) => ({
      id,
      channels,
      sampleRate,
      bitrate: MP3_BITRATE,
      left: left.slice(range[0], range[1]),
      right: right ? right.slice(range[0], range[1]) : null,
    });

    if (ranges.length > 1) {
      const pool = startWorkerPool(ranges.length);
      if (pool) {
        const done = new Array(ranges.length).fill(0);
        const reportPart = (index, fraction) => {
          done[index] = Math.min(1, Math.max(done[index], fraction));
          if (onProgress) onProgress(done.reduce((sum, value) => sum + value, 0) / ranges.length);
        };
        try {
          const parts = await Promise.all(
            ranges.map((range, index) =>
              runWorker(pool.workers[index], partFor(range, index), (fraction) =>
                reportPart(index, fraction),
              ),
            ),
          );
          pool.release();
          return parts;
        } catch (err) {
          console.warn('[suno-downloader] parallel encoding failed; using one encoder:', err);
          pool.release();
        }
      }
    }

    // One encoder on the main thread, yielding between blocks.
    return [
      await encodePcmPart(
        { id: 0, channels, sampleRate, bitrate: MP3_BITRATE, left, right },
        onProgress,
      ),
    ];
  }

  /** MP3 encoding spread over every available core. */
  async function encodeMp3(audio, onProgress) {
    if (typeof lamejs === 'undefined') throw new Error('the MP3 encoder did not load');

    const channels = Math.min(audio.numberOfChannels, 2);
    const sampleRate = audio.sampleRate;
    const frames = audio.length;
    const left = audio.getChannelData(0);
    const right = channels > 1 ? audio.getChannelData(1) : null;

    const cores = Math.max(1, navigator.hardwareConcurrency || 4);
    const enough = Math.floor(frames / (sampleRate * MIN_CHUNK_SECONDS)) || 1;
    const count = Math.max(1, Math.min(MAX_ENCODERS, cores, enough));
    const size = Math.ceil(frames / count);

    const ranges = [];
    for (let start = 0; start < frames; start += size) {
      ranges.push([start, Math.min(frames, start + size)]);
    }

    const parts = await encodeParts({ left, right, channels, sampleRate, ranges }, onProgress);
    if (onProgress) onProgress(1);

    const blob = new Blob(parts, { type: 'audio/mpeg' });
    return new Uint8Array(await blob.arrayBuffer());
  }

  /** Re-encode any downloaded audio to MP3; callers fall back to the original. */
  async function toMp3(data, ext, mime, report) {
    if (ext === 'mp3') return { data, ext, mime };
    report('Decoding audio…');
    const audio = await decodeAudio(data);
    report(`Encoding MP3 (${MP3_BITRATE} kbps)…`);
    const mp3 = await encodeMp3(audio, (fraction) =>
      report(`Encoding MP3 ${Math.round(fraction * 100)}%`),
    );
    return { data: mp3, ext: 'mp3', mime: 'audio/mpeg' };
  }

  /* ------------------------------------------------------------------ *
   * ID3v2.3 tags + cover art (the CLI's ffmpeg -metadata step)
   * ------------------------------------------------------------------ */

  function concatBytes(parts) {
    let total = 0;
    for (const part of parts) total += part.length;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }

  function latin1(value) {
    const bytes = new Uint8Array(value.length);
    for (let i = 0; i < value.length; i += 1) bytes[i] = value.charCodeAt(i) & 0xff;
    return bytes;
  }

  /** ID3v2.3 has no UTF-8: ASCII stays latin1, anything else is UTF-16 with a BOM. */
  function id3Text(value) {
    const plain = String(value);
    if (/^[\x20-\x7e]*$/.test(plain)) {
      return concatBytes([new Uint8Array([0x00]), latin1(plain)]);
    }
    const utf16 = new Uint8Array(2 + plain.length * 2);
    utf16[0] = 0xff;
    utf16[1] = 0xfe;
    for (let i = 0; i < plain.length; i += 1) {
      const code = plain.charCodeAt(i);
      utf16[2 + i * 2] = code & 0xff;
      utf16[3 + i * 2] = code >> 8;
    }
    return concatBytes([new Uint8Array([0x01]), utf16]);
  }

  function id3Frame(id, payload) {
    const header = new Uint8Array(10);
    header.set(latin1(id), 0);
    const size = payload.length;
    // v2.3 frame sizes are plain big-endian, not syncsafe.
    header[4] = (size >>> 24) & 0xff;
    header[5] = (size >>> 16) & 0xff;
    header[6] = (size >>> 8) & 0xff;
    header[7] = size & 0xff;
    return concatBytes([header, payload]);
  }

  function id3Comment(value) {
    return id3Frame(
      'COMM',
      concatBytes([
        new Uint8Array([0x00]), // ISO-8859-1 keeps the empty description simple
        latin1('eng'),
        new Uint8Array([0x00]), // empty description
        latin1(String(value).replace(/[^\x20-\x7e]/g, '-')),
      ]),
    );
  }

  function id3Picture(cover) {
    return id3Frame(
      'APIC',
      concatBytes([
        new Uint8Array([0x00]), // description encoding: ISO-8859-1
        latin1(cover.mime),
        new Uint8Array([0x00]), // MIME terminator
        new Uint8Array([0x03]), // picture type: front cover
        new Uint8Array([0x00]), // empty description
        cover.data,
      ]),
    );
  }

  function buildId3Tag(meta, cover) {
    const frames = [];
    if (meta.title) frames.push(id3Frame('TIT2', id3Text(meta.title)));
    if (meta.artist) frames.push(id3Frame('TPE1', id3Text(meta.artist)));
    if (meta.album) frames.push(id3Frame('TALB', id3Text(meta.album)));
    if (meta.genre) frames.push(id3Frame('TCON', id3Text(meta.genre)));
    if (meta.year) frames.push(id3Frame('TYER', id3Text(meta.year)));
    if (meta.comment) frames.push(id3Comment(meta.comment));
    if (cover) frames.push(id3Picture(cover));

    const body = concatBytes(frames);
    // 1 KiB of padding lets players rewrite the tag in place.
    const size = body.length + 1024;
    return concatBytes([
      latin1('ID3'),
      new Uint8Array([0x03, 0x00, 0x00]), // v2.3.0, no flags
      new Uint8Array([
        (size >>> 21) & 0x7f,
        (size >>> 14) & 0x7f,
        (size >>> 7) & 0x7f,
        size & 0x7f,
      ]),
      body,
      new Uint8Array(1024),
    ]);
  }

  /** Cover art, sniffed rather than trusted from the content type. */
  async function fetchCover(url) {
    if (typeof url !== 'string' || !url.startsWith('http')) return null;
    const response = await request(url, { credentials: 'omit' });
    if (!response.status || response.status >= 400 || !response.buffer.byteLength) return null;
    const bytes = new Uint8Array(response.buffer);
    const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
    const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e;
    if (!jpeg && !png) return null;
    return { data: bytes, mime: jpeg ? 'image/jpeg' : 'image/png' };
  }

  async function attachTags(mp3, meta, report) {
    let cover = null;
    try {
      if (meta.coverUrl) {
        report('Fetching cover art…');
        cover = await fetchCover(meta.coverUrl);
      }
    } catch (err) {
      console.warn('[suno-downloader] cover art skipped:', err);
    }
    return concatBytes([buildId3Tag(meta, cover), mp3]);
  }

  /* ------------------------------------------------------------------ *
   * Download
   * ------------------------------------------------------------------ */

  function tagsString(tags) {
    if (typeof tags === 'string') return tags.trim();
    if (Array.isArray(tags)) {
      return tags.filter((tag) => typeof tag === 'string').join(', ');
    }
    return '';
  }

  function yearOf(createdAt) {
    return typeof createdAt === 'string' && /^\d{4}/.test(createdAt)
      ? createdAt.slice(0, 4)
      : '';
  }

  function sanitizeFileName(name) {
    const cleaned = String(name)
      .replace(/[/\\:*?"<>|]/g, '_')
      .replace(/[\u0000-\u001f]/g, ' ')
      .split(/\s+/)
      .join(' ')
      .replace(/^[. ]+/, '')
      .trim();
    const truncated = Array.from(cleaned).slice(0, 150).join('').trimEnd();
    return truncated || 'suno';
  }

  function firstNonEmpty(...values) {
    for (const value of values) {
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
  }

  function saveBlob(data, fileName, mime) {
    const url = URL.createObjectURL(new Blob([data], { type: mime }));
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.rel = 'noopener';
    link.style.display = 'none';
    document.body.append(link);
    link.click();
    link.remove();
    // Chrome needs the URL alive until the download has started.
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  function directSource(clip) {
    if (usableAudioUrl(clip.audio_url)) {
      return { url: clip.audio_url, mp3: looksLikeMp3(clip.audio_url) };
    }
    const media = (clip.media_urls || []).find(isPlainMedia);
    if (media && media.url) {
      return { url: media.url, mp3: looksLikeMp3(media.url) };
    }
    return null;
  }

  async function downloadSong(id, report) {
    const clip = await fetchClip(id);

    const artist = firstNonEmpty(clip.display_name, clip.handle, 'Suno');
    const title = firstNonEmpty(clip.title, id);
    const base = sanitizeFileName(`${artist} - ${title}`);
    const meta = {
      title,
      artist,
      album: title,
      genre: tagsString(clip.metadata && clip.metadata.tags),
      year: yearOf(clip.created_at),
      comment: `https://suno.com/song/${id}`,
      coverUrl: clip.image_url,
    };

    if (clip.status && clip.status !== 'complete') {
      console.warn(`[suno-downloader] song status is "${clip.status}"; the audio may be incomplete`);
    }

    const attempts = [];

    // Signed audio, when Suno hands the page one (the CLI's first choice).
    const direct = directSource(clip);
    if (direct) {
      attempts.push(async () => {
        const response = await request(direct.url, { credentials: 'omit' });
        if (!response.status || response.status >= 400 || !response.buffer.byteLength) {
          throw new Error(`download failed with HTTP ${response.status}`);
        }
        return {
          data: response.buffer,
          ext: direct.mp3 ? 'mp3' : 'm4a',
          mime: direct.mp3 ? 'audio/mpeg' : 'audio/mp4',
          audio: true,
        };
      });
    }

    // The encrypted progressive stream: what virtually every clip uses now.
    attempts.push(async () => {
      report('Fetching audio…');
      const { stream, key, iv } = await encryptedSource(id);
      report('Decrypting…');
      const data = await decryptStream(stream.buffer, key, iv);
      return { data, ext: 'm4a', mime: 'audio/mp4', audio: true };
    });

    // Last resort: the song's rendered video.
    attempts.push(async () => {
      report('Fetching video…');
      const url = usableAudioUrl(clip.video_url) ? clip.video_url : `${CDN_BASE}${id}.mp4`;
      const response = await request(url, { credentials: 'omit' });
      if (!response.status || response.status >= 400 || !response.buffer.byteLength) {
        throw new Error('the song has no downloadable audio or video');
      }
      return { data: response.buffer, ext: 'mp4', mime: 'video/mp4', audio: false };
    });

    let lastError = null;
    for (const attempt of attempts) {
      try {
        const source = await attempt();
        let output = source;
        let note = '';

        if (source.audio) {
          try {
            output = await toMp3(source.data, source.ext, source.mime, report);
          } catch (err) {
            // No decoder/encoder in this browser: keep the untouched audio.
            console.warn('[suno-downloader] MP3 conversion failed, saving the source audio:', err);
            output = source;
            note = `MP3 conversion unavailable (${err.message}); saved the original audio`;
          }
        }

        // Tags and cover art, like the CLI's ffmpeg pass — never fatal.
        if (output.ext === 'mp3') {
          try {
            output = { ...output, data: await attachTags(output.data, meta, report) };
          } catch (err) {
            console.warn('[suno-downloader] could not write tags:', err);
            note = note || 'tags could not be written';
          }
        }

        const fileName = `${base}.${output.ext}`;
        saveBlob(output.data, fileName, output.mime);
        return { fileName, ext: output.ext, note, artist, title };
      } catch (err) {
        if (!lastError) console.warn('[suno-downloader]', err);
        lastError = err;
      }
    }

    throw new Error(lastError ? lastError.message : `no downloadable audio found for song ${id}`);
  }

  /* ------------------------------------------------------------------ *
   * UI
   * ------------------------------------------------------------------ */

  function injectStyles() {
    if (document.getElementById('suno-downloader-style')) return;
    const style = document.createElement('style');
    style.id = 'suno-downloader-style';
    style.textContent = CSS;
    document.head.append(style);
  }

  function toastHost() {
    let host = document.querySelector('.suno-downloader-toasts');
    if (!host) {
      host = document.createElement('div');
      host.className = 'suno-downloader-toasts';
      document.body.append(host);
    }
    return host;
  }

  /** Toast that stays put while `progress` is true, for live status updates. */
  function toast(message, kind = 'info') {
    const item = document.createElement('div');
    item.className =
      'suno-downloader-toast' + (kind === 'error' ? ' suno-downloader-toast--error' : '');
    item.textContent = message;
    toastHost().append(item);

    const dismiss = (delay) => {
      setTimeout(() => {
        item.classList.add('suno-downloader-toast--leaving');
        setTimeout(() => item.remove(), 250);
      }, delay);
    };

    if (kind !== 'progress') dismiss(kind === 'error' ? 7000 : 4000);

    return {
      update(text) {
        item.textContent = text;
      },
      done(text) {
        item.textContent = text;
        dismiss(4000);
      },
      fail(text) {
        item.textContent = text;
        item.classList.add('suno-downloader-toast--error');
        dismiss(7000);
      },
      dismiss,
    };
  }

  function setBusy(button, busy, status) {
    const content = button.querySelector('.hxc-btn-content') || button;
    button.dataset.busy = busy ? 'true' : 'false';
    button.setAttribute('aria-busy', busy ? 'true' : 'false');
    content.innerHTML = busy ? SPINNER : ICON;
    button.title = busy ? status || 'Downloading…' : 'Download MP3';
  }

  /** Walk up from the control to the card that holds exactly one song link. */
  function findSongId(element) {
    for (let node = element; node && node !== document.body; node = node.parentElement) {
      const ids = new Set();
      if (node.matches && node.matches('a[href*="/song/"]')) {
        const own = uuidFrom(node.href);
        if (own) ids.add(own);
      }
      if (node.querySelectorAll) {
        node.querySelectorAll('a[href*="/song/"]').forEach((link) => {
          const found = uuidFrom(link.href);
          if (found) ids.add(found);
        });
      }
      if (ids.size === 1) return [...ids][0];
      if (ids.size > 1) break;
    }
    return uuidFrom(location.href);
  }

  function createButton(shareButton) {
    const button = document.createElement('button');
    button.type = 'button';
    // Same design-system classes as the control it replaces, so it keeps the
    // exact size, shape and hover treatment; the content spans are rebuilt the
    // way Suno's own buttons are layered.
    button.className = `${shareButton.className} suno-downloader-btn`;
    button.setAttribute('aria-label', 'Download');
    button.title = 'Download MP3';
    button.innerHTML =
      '<span aria-hidden="true" class="hxc-btn-tap-target"></span>' +
      '<span aria-hidden="true" class="hxc-btn-overlay-slot hxc-btn-border"></span>' +
      `<span class="hxc-btn-content">${ICON}</span>`;

    button.addEventListener(
      'click',
      async (event) => {
        // The control usually sits inside a card link.
        event.preventDefault();
        event.stopPropagation();
        if (button.dataset.busy === 'true') return;

        const id = findSongId(button);
        if (!id) {
          toast('Could not find the song on this page.', 'error');
          return;
        }

        const status = toast('Preparing download…', 'progress');
        const report = (text) => {
          setBusy(button, true, text);
          status.update(text);
        };

        setBusy(button, true);
        try {
          const result = await downloadSong(id, report);
          status.done(`Saved ${result.fileName}${result.note ? ` — ${result.note}` : ''}`);
        } catch (err) {
          console.error('[suno-downloader]', err);
          status.fail(`Download failed: ${err.message}`);
        } finally {
          setBusy(button, false);
        }
      },
      true,
    );

    return button;
  }

  function shareLabelOf(element) {
    return firstNonEmpty(
      element.getAttribute('aria-label'),
      element.getAttribute('title'),
      element.textContent,
    );
  }

  function replaceShareControl(shareButton) {
    if (shareButton.classList.contains('suno-downloader-btn')) return false;
    if (shareButton.dataset.sunoDownloader === 'replaced') return false;

    // A re-render can resurrect the share control beside the button already
    // injected for this row; keep the replacement rather than adding a second.
    const parent = shareButton.parentElement;
    if (parent && parent.querySelector(':scope > .suno-downloader-btn')) {
      shareButton.dataset.sunoDownloader = 'replaced';
      shareButton.remove();
      return false;
    }

    // Leave shares that do not belong to a song (page or playlist headers) be.
    if (!findSongId(shareButton)) return false;

    shareButton.dataset.sunoDownloader = 'replaced';
    shareButton.replaceWith(createButton(shareButton));
    return true;
  }

  function scan() {
    injectStyles();

    const controls = document.querySelectorAll(
      'button[aria-label], button[title], [role="button"][aria-label]',
    );
    for (const control of controls) {
      if (!SHARE_LABEL.test(shareLabelOf(control))) continue;
      const host = control.closest('button') || control;
      replaceShareControl(host);
    }
  }

  let scanScheduled = false;

  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    setTimeout(() => {
      scanScheduled = false;
      scan();
    }, 120);
  }

  function start() {
    scan();
    // Suno is a single-page app: cards and modals are mounted all the time.
    new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.addedNodes.length > 0) {
          scheduleScan();
          return;
        }
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
