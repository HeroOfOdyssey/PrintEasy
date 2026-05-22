/*
 * MQTT Printer Server
 *
 * This service exposes a small HTTP API for creating print jobs.  It accepts either
 * plain text/markdown or a JSON payload with a list of tasks, converts it to
 * Epson ESC/POS commands using the `receiptline` library, and publishes the
 * resulting bytes to an MQTT topic.  A microcontroller listening on that
 * topic can then forward the data to a thermal printer via Bluetooth or serial.
 */

require('dotenv').config();

process.env.XDG_CACHE_HOME = process.env.XDG_CACHE_HOME || '/tmp';

const fs = require('fs');
const express = require('express');
const mqtt = require('mqtt');
const receiptline = require('receiptline');
const sharp = require('sharp');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const SERVER_NAME = 'printeasy-mqtt-printer';
const SERVER_VERSION = '1.0.0';
const MCP_PROTOCOL_VERSION = '2025-11-25';

// Environment variables
const API_TOKEN = process.env.API_TOKEN || '';
const MQTT_URL = process.env.MQTT_URL || 'mqtt://localhost:1883';
const MQTT_USER = process.env.MQTT_USER || undefined;
const MQTT_PASS = process.env.MQTT_PASS || undefined;
const MQTT_CA_CERT = process.env.MQTT_CA_CERT || undefined;
const MQTT_TOPIC = process.env.MQTT_TOPIC || 'receipt/print';
const MQTT_PUBLISH_CHUNK_BYTES = parseInt(process.env.MQTT_PUBLISH_CHUNK_BYTES || '1800', 10);
const PRINTER_CPL = parseInt(process.env.PRINTER_CPL || '42', 10);
const PRINTER_COMMAND = process.env.PRINTER_COMMAND || 'epson';
const PRINTER_ENCODING = process.env.PRINTER_ENCODING || 'multilingual';
const PRINTER_DOTS = parseInt(process.env.PRINTER_DOTS || '420', 10);
const IMAGE_RENDERER = (process.env.IMAGE_RENDERER || 'receiptline').toLowerCase();
const RASTER_BAND_HEIGHT = parseInt(process.env.RASTER_BAND_HEIGHT || '192', 10);
const RASTER_THRESHOLD = parseInt(process.env.RASTER_THRESHOLD || '160', 10);
const RASTER_MARKDOWN = (process.env.RASTER_MARKDOWN || 'true').toLowerCase() !== 'false';
const RASTER_FONT_FAMILY = process.env.RASTER_FONT_FAMILY || 'DejaVu Sans Mono, monospace';
const RASTER_FONT_SIZE = parseInt(process.env.RASTER_FONT_SIZE || '22', 10);
const RASTER_LINE_HEIGHT = parseInt(process.env.RASTER_LINE_HEIGHT || '28', 10);
const RASTER_MARGIN_X = parseInt(process.env.RASTER_MARGIN_X || '0', 10);
const ALLOW_TOPIC_OVERRIDE = (process.env.ALLOW_TOPIC_OVERRIDE || 'false').toLowerCase() === 'true';
const PRINT_QUEUE_MAX_JOBS = parseInt(process.env.PRINT_QUEUE_MAX_JOBS || '100', 10);
const PRINT_QUEUE_RETRY_MS = parseInt(process.env.PRINT_QUEUE_RETRY_MS || '5000', 10);
const PRINT_QUEUE_HISTORY_LIMIT = parseInt(process.env.PRINT_QUEUE_HISTORY_LIMIT || '50', 10);
const MCP_ALLOWED_ORIGINS = (process.env.MCP_ALLOWED_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

// Configure Express to parse text and JSON bodies
app.use(express.text({ type: ['text/*', 'application/octet-stream'], limit: '64kb' }));
app.use(express.json({ limit: '64kb' }));

// Helper: enforce API token
function requireApiToken(req, res, next) {
  const auth = req.get('authorization') || '';
  let token;
  if (auth.startsWith('Bearer ')) {
    token = auth.slice(7);
  } else {
    token = req.get('x-api-token') || (req.query && req.query.token);
  }
  if (!API_TOKEN || token !== API_TOKEN) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  next();
}

function buildTaskMarkdown(tasks) {
  const lines = [];
  lines.push('^^^TASK LIST');
  lines.push('');
  const now = new Date();
  lines.push(now.toLocaleDateString('en-US', { timeZone: process.env.TZ || 'UTC' }));
  lines.push('');
  tasks.forEach((task) => {
    lines.push('- ' + String(task));
  });
  lines.push('');
  return lines.join('\n');
}

// Connect to MQTT broker
const mqttOptions = {};
if (MQTT_USER) mqttOptions.username = MQTT_USER;
if (MQTT_PASS) mqttOptions.password = MQTT_PASS;
if (MQTT_CA_CERT) mqttOptions.ca = fs.readFileSync(MQTT_CA_CERT);
const mqttClient = mqtt.connect(MQTT_URL, mqttOptions);

let mqttConnected = false;

mqttClient.on('connect', () => {
  mqttConnected = true;
  console.log('[MQTT] connected');
  scheduleQueueTimer();
});

mqttClient.on('reconnect', () => {
  console.log('[MQTT] reconnecting…');
});

mqttClient.on('close', () => {
  mqttConnected = false;
  console.log('[MQTT] connection closed');
});

mqttClient.on('error', (err) => {
  console.error('[MQTT] error:', err.message);
});

const printQueue = [];
const printQueueHistory = [];
let queueTimer = null;
let queueProcessing = false;
let queueSequence = 0;

function createQueueId() {
  queueSequence += 1;
  return `job_${Date.now().toString(36)}_${queueSequence.toString(36)}`;
}

function parseScheduleOptions(source = {}) {
  const scheduleAt = source.scheduleAt || source.printAt || source.runAt;
  const delayMsRaw = source.delayMs === undefined ? source.delay : source.delayMs;
  let runAtMs = Date.now();

  if (scheduleAt !== undefined && scheduleAt !== null && scheduleAt !== '') {
    const parsed = Date.parse(String(scheduleAt));
    if (Number.isNaN(parsed)) {
      throw new Error('scheduleAt must be an ISO 8601 date/time string.');
    }
    runAtMs = parsed;
  }

  if (delayMsRaw !== undefined && delayMsRaw !== null && delayMsRaw !== '') {
    const delayMs = Number(delayMsRaw);
    if (!Number.isFinite(delayMs) || delayMs < 0) {
      throw new Error('delayMs must be a non-negative number of milliseconds.');
    }
    runAtMs = Math.max(runAtMs, Date.now() + Math.floor(delayMs));
  }

  return {
    runAtMs,
    scheduled: runAtMs > Date.now() + 10,
  };
}

function publicQueueJob(job) {
  return {
    id: job.id,
    topic: job.topic,
    bytes: job.bytes,
    status: job.status,
    createdAt: job.createdAt,
    runAt: job.runAt,
    completedAt: job.completedAt || null,
    attempts: job.attempts,
    lastError: job.lastError || null,
    source: job.source,
  };
}

function queueSnapshot() {
  return {
    pending: printQueue.map(publicQueueJob),
    history: printQueueHistory.map(publicQueueJob),
    limits: {
      maxJobs: PRINT_QUEUE_MAX_JOBS,
      historyLimit: PRINT_QUEUE_HISTORY_LIMIT,
      retryMs: PRINT_QUEUE_RETRY_MS,
    },
  };
}

function addHistory(job, status, error) {
  printQueueHistory.unshift({
    ...job,
    status,
    completedAt: new Date().toISOString(),
    lastError: error ? String(error.message || error) : job.lastError || null,
    escpos: undefined,
  });
  while (printQueueHistory.length > PRINT_QUEUE_HISTORY_LIMIT) {
    printQueueHistory.pop();
  }
}

function enqueuePrintJob(escpos, topic, options = {}) {
  if (printQueue.length >= PRINT_QUEUE_MAX_JOBS) {
    throw new Error(`Print queue is full. Max pending jobs: ${PRINT_QUEUE_MAX_JOBS}.`);
  }
  const runAtMs = options.runAtMs || Date.now();
  const job = {
    id: createQueueId(),
    escpos,
    topic,
    bytes: escpos.length,
    status: 'queued',
    createdAt: new Date().toISOString(),
    runAt: new Date(runAtMs).toISOString(),
    runAtMs,
    attempts: 0,
    lastError: null,
    source: options.source || 'api',
  };
  printQueue.push(job);
  printQueue.sort((a, b) => a.runAtMs - b.runAtMs || a.id.localeCompare(b.id));
  scheduleQueueTimer();
  return job;
}

function scheduleQueueTimer() {
  if (queueTimer) {
    clearTimeout(queueTimer);
    queueTimer = null;
  }
  if (!printQueue.length) {
    return;
  }
  const first = printQueue[0];
  const delay = mqttConnected ? Math.max(0, first.runAtMs - Date.now()) : PRINT_QUEUE_RETRY_MS;
  queueTimer = setTimeout(() => {
    queueTimer = null;
    processPrintQueue().catch((err) => {
      console.error('[QUEUE] processing error:', err.message);
      scheduleQueueTimer();
    });
  }, Math.min(delay, 2147483647));
}

async function processPrintQueue() {
  if (queueProcessing) {
    return;
  }
  queueProcessing = true;
  try {
    while (printQueue.length) {
      const job = printQueue[0];
      if (job.runAtMs > Date.now()) {
        break;
      }
      if (!mqttConnected) {
        job.status = 'waiting_for_mqtt';
        job.lastError = 'MQTT broker not connected';
        break;
      }

      job.status = 'publishing';
      job.attempts += 1;
      try {
        await publishEscPos(job.escpos, job.topic);
        printQueue.shift();
        addHistory(job, 'published');
        console.log(`[QUEUE] published ${job.id} (${job.bytes} bytes) to ${job.topic}`);
      } catch (err) {
        job.status = 'retrying';
        job.lastError = err.message || String(err);
        console.error(`[QUEUE] publish failed for ${job.id}: ${job.lastError}`);
        break;
      }
    }
  } finally {
    queueProcessing = false;
    scheduleQueueTimer();
  }
}

function cancelQueuedJob(id) {
  const index = printQueue.findIndex(job => job.id === id);
  if (index === -1) {
    return null;
  }
  const [job] = printQueue.splice(index, 1);
  job.status = 'cancelled';
  addHistory(job, 'cancelled');
  scheduleQueueTimer();
  return job;
}

async function publishOrQueueEscPos(escpos, topic, options = {}) {
  const schedule = parseScheduleOptions(options);
  if (schedule.scheduled || options.queue === true) {
    const job = enqueuePrintJob(escpos, topic, {
      runAtMs: schedule.runAtMs,
      source: options.source,
    });
    return {
      ok: true,
      queued: true,
      job: publicQueueJob(job),
    };
  }

  const publishResult = await publishEscPos(escpos, topic);
  return {
    ok: true,
    queued: false,
    chunks: publishResult.chunks,
    chunkBytes: publishResult.chunkBytes,
  };
}

// Normalise request body into a markdown string
function normalisePayload(req) {
  // If the body is text, return as‑is
  if (typeof req.body === 'string') {
    return req.body;
  }
  // If the body has a markdown property
  if (req.body && typeof req.body.markdown === 'string') {
    return req.body.markdown;
  }
  // If the body has a text property
  if (req.body && typeof req.body.text === 'string') {
    return req.body.text;
  }
  // If the body contains a list of tasks
  if (req.body && Array.isArray(req.body.tasks)) {
    return buildTaskMarkdown(req.body.tasks);
  }
  // If no tasks or markdown but QR or image fields exist, return an empty string
  if (req.body && (typeof req.body.qr === 'string' || typeof req.body.image === 'string')) {
    return '';
  }
  throw new Error('Unsupported request body');
}

function scheduleOptionsFromRequest(req, source) {
  const body = req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) ? req.body : {};
  return {
    scheduleAt: body.scheduleAt || body.printAt || body.runAt || (req.query && (req.query.scheduleAt || req.query.printAt || req.query.runAt)),
    delayMs: body.delayMs !== undefined ? body.delayMs : (body.delay !== undefined ? body.delay : req.query && (req.query.delayMs || req.query.delay)),
    queue: body.queue === true || body.queue === 'true' || (req.query && req.query.queue === 'true'),
    source,
  };
}

// Convert markdown to ESC/POS bytes
function receiptlineOptions(overrides = {}) {
  return {
    cpl: PRINTER_CPL,
    encoding: PRINTER_ENCODING,
    command: PRINTER_COMMAND,
    threshold: RASTER_THRESHOLD,
    gradient: false,
    ...overrides,
  };
}

function toEscPos(markdown) {
  const binaryString = receiptline.transform(markdown, receiptlineOptions());
  return Buffer.from(binaryString, 'binary');
}

// -----------------------------------------------------------------------------
// Image and QR Code Helpers
//
// Epson printers understand a family of ESC/POS commands for printing QR codes
// and raster images.  Rather than linking in an external QR generator, we use
// the printer’s built‑in functionality.  The commands below follow the
// specification documented for QR Code printing: first select the model and
// module size, set the error correction level, store the payload into the
// symbol storage area, then print it.  For
// images, we rasterise a base64‑encoded picture into a 1‑bit bitmap and wrap
// it in the GS v 0 command.

/**
 * Generate ESC/POS commands to render a QR code.  Uses the GS ( k functions
 * defined in the ESC/POS spec.  See the LR1100 Programming Manual for
 * parameter ranges and defaults.
 *
 * @param {string} data - The text to encode into a QR code.
 * @param {Object} opts - Optional settings: model (1 or 2), size (1–16), error (48–51).
 * @returns {Buffer} ESC/POS command sequence.
 */
function qrToEscPos(data, opts = {}) {
  const model = opts.model || 50; // model 2
  const size = opts.size || 8;    // module size 8 dots
  const error = opts.error || 49; // error correction level M (15%)
  const dataBuf = Buffer.from(data, 'utf8');
  const storeLength = dataBuf.length + 3;
  const pL = storeLength & 0xff;
  const pH = (storeLength >> 8) & 0xff;
  const chunks = [];
  // Select QR Code model
  // GS ( k 4 0 49 65 n1 n2
  chunks.push(Buffer.from([0x1D, 0x28, 0x6B, 0x04, 0x00, 0x31, 0x41, model, 0x00]));
  // Set module size
  // GS ( k 3 0 49 67 n
  chunks.push(Buffer.from([0x1D, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x43, size]));
  // Set error correction level
  // GS ( k 3 0 49 69 n
  chunks.push(Buffer.from([0x1D, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x45, error]));
  // Store data in symbol storage area
  // GS ( k pL pH 49 80 48 <data>
  chunks.push(Buffer.from([0x1D, 0x28, 0x6B, pL, pH, 0x31, 0x50, 0x30]));
  chunks.push(dataBuf);
  // Print the QR code
  // GS ( k 3 0 49 81 48
  chunks.push(Buffer.from([0x1D, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x51, 0x30]));
  return Buffer.concat(chunks);
}

/**
 * Convert a base64‑encoded image into ESC/POS raster image commands.  The
 * printer expects 1‑bit monochrome data.  We resize the image to a
 * printer-width canvas (default 420 dots for 2-1/4 inch / 58 mm TM-P60II paper), convert it to grayscale,
 * threshold to black and white, then pack each row into bytes and wrap it in
 * the GS v 0 command.
 *
 * @param {string} base64 - Base64 string, optionally prefixed with data URL.
 * @param {Object} options - Optional settings: maxWidth, threshold.
 * @returns {Promise<Buffer>} Buffer containing ESC/POS commands for printing the image.
 */
async function imageToEscPos(base64, options = {}) {
  const maxWidth = options.maxWidth || PRINTER_DOTS;
  const threshold = options.threshold || RASTER_THRESHOLD;
  // Remove data URL prefix if present
  const commaIndex = base64.indexOf(',');
  const clean = commaIndex >= 0 ? base64.slice(commaIndex + 1) : base64;
  const imgBuffer = Buffer.from(clean, 'base64');
  if (IMAGE_RENDERER === 'gs_v_0') {
    return imageBufferToEscPos(imgBuffer, { maxWidth, threshold });
  }
  return imageBufferToReceiptlineEscPos(imgBuffer, { maxWidth });
}

async function imageBufferToReceiptlineEscPos(imgBuffer, options = {}) {
  const maxWidth = options.maxWidth || PRINTER_DOTS;
  const image = sharp(imgBuffer);
  const meta = await image.metadata();
  const targetWidth = Math.min(meta.width || maxWidth, maxWidth);
  const png = await image
    .resize({ width: targetWidth, withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .png()
    .toBuffer();
  const document = `{image:${png.toString('base64')}}`;
  const binaryString = receiptline.transform(document, receiptlineOptions());
  return Buffer.from(binaryString, 'binary');
}

/**
 * Convert an image buffer to ESC/POS raster image bands. Bands are safer over
 * Bluetooth than one very tall raster image and reduce printer-buffer pressure.
 */
async function imageBufferToEscPos(imgBuffer, options = {}) {
  const maxWidth = options.maxWidth || PRINTER_DOTS;
  const threshold = options.threshold || RASTER_THRESHOLD;
  const bandHeight = options.bandHeight || RASTER_BAND_HEIGHT;
  const image = sharp(imgBuffer);
  const meta = await image.metadata();
  const targetWidth = Math.min(meta.width || maxWidth, maxWidth);
  const { data: raw, info } = await image
    .resize({ width: targetWidth, withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const outWidth = info.width;
  const outHeight = info.height;
  const bytesPerLine = Math.ceil(outWidth / 8);
  const chunks = [];
  for (let y0 = 0; y0 < outHeight; y0 += bandHeight) {
    const h = Math.min(bandHeight, outHeight - y0);
    const raster = Buffer.alloc(bytesPerLine * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < outWidth; x++) {
        const pixelIndex = (y0 + y) * outWidth + x;
        const pixel = raw[pixelIndex];
        const byteIndex = y * bytesPerLine + (x >> 3);
        const bit = 7 - (x & 7);
        if (pixel < threshold) {
          raster[byteIndex] |= 1 << bit;
        }
      }
    }
    const xL = bytesPerLine & 0xff;
    const xH = (bytesPerLine >> 8) & 0xff;
    const yL = h & 0xff;
    const yH = (h >> 8) & 0xff;
    const header = Buffer.from([0x1D, 0x76, 0x30, 0x00, xL, xH, yL, yH]);
    chunks.push(header, raster);
  }
  return Buffer.concat(chunks);
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function stripInlineMarkdown(s) {
  return String(s)
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 <$2>');
}

function wrapText(text, maxChars) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    if (!line) {
      line = word;
    } else if ((line + ' ' + word).length <= maxChars) {
      line += ' ' + word;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

function tableToLines(rows, maxChars) {
  if (!rows.length) return [];
  const split = rows.map(r => r.trim().replace(/^\||\|$/g, '').split('|').map(c => stripInlineMarkdown(c.trim())));
  const data = split.filter(cols => !cols.every(c => /^:?-{3,}:?$/.test(c)));
  if (!data.length) return [];
  const colCount = Math.max(...data.map(r => r.length));
  const widths = Array(colCount).fill(3);
  for (const row of data) {
    for (let i = 0; i < colCount; i++) widths[i] = Math.max(widths[i], (row[i] || '').length);
  }
  let total = widths.reduce((a, b) => a + b, 0) + (colCount - 1) * 3;
  while (total > maxChars && Math.max(...widths) > 6) {
    const i = widths.indexOf(Math.max(...widths));
    widths[i]--;
    total--;
  }
  return data.map(row => row.map((c, i) => (c || '').slice(0, widths[i]).padEnd(widths[i])).join(' | ').trimEnd());
}

function markdownToTextLines(markdown) {
  const maxChars = Math.max(20, Math.floor((PRINTER_DOTS - RASTER_MARGIN_X * 2) / (RASTER_FONT_SIZE * 0.6)));
  const lines = [];
  const src = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < src.length; i++) {
    let line = src[i];
    if (!line.trim()) { lines.push(''); continue; }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const table = [];
      while (i < src.length && /^\s*\|.*\|\s*$/.test(src[i])) table.push(src[i++]);
      i--;
      lines.push(...tableToLines(table, maxChars), '');
      continue;
    }
    const hr = /^\s*(-{3,}|_{3,}|\*{3,})\s*$/.test(line);
    if (hr) { lines.push('─'.repeat(Math.min(maxChars, 48))); continue; }
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+)$/);
    if (heading) {
      lines.push(stripInlineMarkdown(heading[2]).toUpperCase());
      lines.push('');
      continue;
    }
    const checkbox = line.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.+)$/);
    if (checkbox) {
      const mark = checkbox[1].toLowerCase() === 'x' ? '☑' : '☐';
      const wrapped = wrapText(stripInlineMarkdown(checkbox[2]), maxChars - 2);
      lines.push(`${mark} ${wrapped[0]}`);
      wrapped.slice(1).forEach(w => lines.push(`  ${w}`));
      continue;
    }
    const bullet = line.match(/^\s*[-*+]\s+(.+)$/);
    if (bullet) {
      const wrapped = wrapText(stripInlineMarkdown(bullet[1]), maxChars - 2);
      lines.push(`• ${wrapped[0]}`);
      wrapped.slice(1).forEach(w => lines.push(`  ${w}`));
      continue;
    }
    const numbered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (numbered) {
      const prefix = '• ';
      const wrapped = wrapText(stripInlineMarkdown(numbered[1]), maxChars - 2);
      lines.push(prefix + wrapped[0]);
      wrapped.slice(1).forEach(w => lines.push('  ' + w));
      continue;
    }
    wrapText(stripInlineMarkdown(line), maxChars).forEach(l => lines.push(l));
  }
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

async function markdownToRasterEscPos(markdown) {
  const lines = markdownToTextLines(markdown);
  if (!lines.length) return Buffer.alloc(0);
  const width = PRINTER_DOTS;
  const height = Math.max(RASTER_LINE_HEIGHT, 12 + lines.length * RASTER_LINE_HEIGHT);
  const x = RASTER_MARGIN_X;
  const text = lines.map((line, idx) => {
    const y = 8 + (idx + 1) * RASTER_LINE_HEIGHT - Math.floor((RASTER_LINE_HEIGHT - RASTER_FONT_SIZE) / 2);
    return `<text x="${x}" y="${y}">${esc(line)}</text>`;
  }).join('\n');
  const svg = Buffer.from(`
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="white"/>
      <g font-family="${esc(RASTER_FONT_FAMILY)}" font-size="${RASTER_FONT_SIZE}" fill="black">${text}</g>
    </svg>
  `);
  return imageBufferToEscPos(svg, { maxWidth: width, threshold: RASTER_THRESHOLD, bandHeight: RASTER_BAND_HEIGHT });
}

function parseMarkdownParts(markdown) {
  const parts = [];
  const re = /```(qr|image)\s*\n([\s\S]*?)```/gi;
  let last = 0;
  let match;
  while ((match = re.exec(markdown)) !== null) {
    const before = markdown.slice(last, match.index);
    if (before.trim()) parts.push({ type: 'markdown', value: before });
    parts.push({ type: match[1].toLowerCase(), value: match[2].trim() });
    last = re.lastIndex;
  }
  const tail = markdown.slice(last);
  if (tail.trim()) parts.push({ type: 'markdown', value: tail });
  return parts;
}

async function composePrintJob({ markdown = '', qr, image }) {
  const buffers = [];
  const parts = parseMarkdownParts(markdown);
  for (const part of parts) {
    if (part.type === 'markdown') {
      buffers.push(RASTER_MARKDOWN ? await markdownToRasterEscPos(part.value) : toEscPos(part.value));
    } else if (part.type === 'qr') {
      buffers.push(Buffer.from([0x1B, 0x61, 0x01]), qrToEscPos(part.value), Buffer.from([0x0A, 0x1B, 0x61, 0x00]));
    } else if (part.type === 'image') {
      buffers.push(await imageToEscPos(part.value, { maxWidth: PRINTER_DOTS }));
    }
  }
  if (!parts.length && markdown) {
    buffers.push(RASTER_MARKDOWN ? await markdownToRasterEscPos(markdown) : toEscPos(markdown));
  }
  if (typeof qr === 'string' && qr.trim()) {
    buffers.push(Buffer.from([0x1B, 0x61, 0x01]), qrToEscPos(qr.trim()), Buffer.from([0x0A, 0x1B, 0x61, 0x00]));
  }
  if (typeof image === 'string' && image.trim()) {
    buffers.push(await imageToEscPos(image.trim(), { maxWidth: PRINTER_DOTS }));
  }
  return Buffer.concat(buffers.filter(b => b && b.length));
}

function resolvePublishTopic(args = {}) {
  if (typeof args.topic !== 'string' || !args.topic.trim()) {
    return MQTT_TOPIC;
  }
  if (!ALLOW_TOPIC_OVERRIDE) {
    throw new Error('Topic override is disabled. Set ALLOW_TOPIC_OVERRIDE=true to allow per-request topics.');
  }
  return args.topic.trim();
}

function publishEscPos(escpos, topic = MQTT_TOPIC) {
  if (!mqttConnected) {
    throw new Error('MQTT broker not connected');
  }

  const chunkSize = Number.isFinite(MQTT_PUBLISH_CHUNK_BYTES) && MQTT_PUBLISH_CHUNK_BYTES > 0
    ? MQTT_PUBLISH_CHUNK_BYTES
    : escpos.length;
  const chunks = Math.max(1, Math.ceil(escpos.length / chunkSize));

  return new Promise((resolve, reject) => {
    let offset = 0;

    function publishNext() {
      if (offset >= escpos.length) {
        resolve({ chunks, chunkBytes: chunkSize });
        return;
      }

      const nextOffset = Math.min(offset + chunkSize, escpos.length);
      const chunk = escpos.subarray(offset, nextOffset);
      offset = nextOffset;

      mqttClient.publish(topic, chunk, { qos: 1 }, (err) => {
        if (err) {
          reject(err);
          return;
        }
        publishNext();
      });
    }

    publishNext();
  });
}

function markdownFromToolArgs(args = {}) {
  if (Array.isArray(args.tasks)) {
    return buildTaskMarkdown(args.tasks);
  }
  if (typeof args.markdown === 'string') {
    return args.markdown;
  }
  if (typeof args.text === 'string') {
    return args.text;
  }
  if (typeof args.qr === 'string' || typeof args.image === 'string') {
    return '';
  }
  throw new Error('Provide tasks, markdown, text, qr, or image.');
}

function toolText(text) {
  return [{ type: 'text', text }];
}

function mcpToolResult(text, structuredContent = {}, isError = false) {
  return {
    content: toolText(text),
    structuredContent,
    isError,
  };
}

function encodePreview(escpos, args = {}) {
  const maxBytes = Math.max(0, Math.min(parseInt(args.maxBytes || '4096', 10), escpos.length));
  const preview = escpos.subarray(0, maxBytes);
  const result = {
    bytes: escpos.length,
    returnedBytes: preview.length,
    truncated: preview.length < escpos.length,
    mode: RASTER_MARKDOWN ? 'raster' : 'receiptline',
    widthDots: PRINTER_DOTS,
  };
  if (args.includeHex) {
    result.hex = preview.toString('hex');
  }
  if (args.includeBase64) {
    result.base64 = preview.toString('base64');
  }
  return result;
}

function schedulingSchemaProperties() {
  return {
    scheduleAt: {
      type: 'string',
      description: 'Optional ISO 8601 date/time to publish the job later, e.g. 2026-05-17T19:30:00Z.',
    },
    delayMs: {
      type: 'integer',
      minimum: 0,
      description: 'Optional delay in milliseconds before publishing. If scheduleAt is also supplied, the later time wins.',
    },
    queue: {
      type: 'boolean',
      description: 'When true, enqueue the job even if it is due immediately.',
    },
  };
}

function decodeRawEscPos(args = {}) {
  if (typeof args.data !== 'string' || !args.data.trim()) {
    throw new Error('Raw ESC/POS data is required.');
  }
  const encoding = args.encoding || 'base64';
  if (encoding === 'base64') {
    return Buffer.from(args.data, 'base64');
  }
  if (encoding === 'hex') {
    return Buffer.from(args.data.replace(/\s+/g, ''), 'hex');
  }
  throw new Error('encoding must be "base64" or "hex".');
}

// -----------------------------------------------------------------------------
// MCP Streamable HTTP support
//
// The Model Context Protocol (MCP) allows AI assistants to discover and call
// external tools. This server implements the stateless Streamable HTTP transport:
// clients POST one JSON-RPC message at a time to `/mcp`. The server returns one
// JSON response for requests and 202 Accepted for notifications/responses.

// Define the tool metadata for MCP.  Tools are objects with a name,
// description and JSON Schema describing the accepted arguments.  Clients
// discover tools via the `tools/list` method.
const mcpTools = [
  {
    name: 'printReceipt',
    title: 'Print Receipt',
    description: 'Render tasks, text/markdown, QR codes, or images as ESC/POS and publish the job to MQTT.',
    inputSchema: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          description: 'Strings to print as a dated task list.',
          items: { type: 'string' },
        },
        text: {
          type: 'string',
          description: 'Plain text to print. Treated as markdown by the renderer.',
        },
        markdown: {
          type: 'string',
          description: 'Markdown text to print. Supports headings, lists, checkboxes, simple tables, and qr/image fenced blocks.',
        },
        qr: {
          type: 'string',
          description: 'Data to encode as a native ESC/POS QR code.',
        },
        image: {
          type: 'string',
          description: 'Base64-encoded PNG/JPEG, optionally as a data URL, to rasterize and print.',
        },
        topic: {
          type: 'string',
          description: 'Optional MQTT topic override. Requires ALLOW_TOPIC_OVERRIDE=true.',
        },
        ...schedulingSchemaProperties(),
      },
      anyOf: [
        { required: ['tasks'] },
        { required: ['text'] },
        { required: ['markdown'] },
        { required: ['qr'] },
        { required: ['image'] },
      ],
    },
    annotations: {
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: 'previewReceipt',
    title: 'Preview Receipt',
    description: 'Render a receipt job and return metadata plus optional ESC/POS hex/base64 without publishing to MQTT.',
    inputSchema: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          description: 'Strings to render as a dated task list.',
          items: { type: 'string' },
        },
        text: { type: 'string', description: 'Plain text to render.' },
        markdown: { type: 'string', description: 'Markdown text to render.' },
        qr: { type: 'string', description: 'Data to encode as a QR code.' },
        image: { type: 'string', description: 'Base64-encoded PNG/JPEG, optionally as a data URL.' },
        includeHex: { type: 'boolean', description: 'Include a hex preview of the rendered bytes.' },
        includeBase64: { type: 'boolean', description: 'Include a base64 preview of the rendered bytes.' },
        maxBytes: {
          type: 'integer',
          minimum: 0,
          maximum: 65536,
          description: 'Maximum number of rendered bytes to include in hex/base64 previews.',
        },
      },
      anyOf: [
        { required: ['tasks'] },
        { required: ['text'] },
        { required: ['markdown'] },
        { required: ['qr'] },
        { required: ['image'] },
      ],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'publishEscPos',
    title: 'Publish Raw ESC/POS',
    description: 'Publish prebuilt ESC/POS bytes to the configured MQTT print topic.',
    inputSchema: {
      type: 'object',
      properties: {
        data: {
          type: 'string',
          description: 'Raw ESC/POS bytes encoded as base64 or hex.',
        },
        encoding: {
          type: 'string',
          enum: ['base64', 'hex'],
          default: 'base64',
        },
        topic: {
          type: 'string',
          description: 'Optional MQTT topic override. Requires ALLOW_TOPIC_OVERRIDE=true.',
        },
        ...schedulingSchemaProperties(),
      },
      required: ['data'],
    },
    annotations: {
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: 'listPrintQueue',
    title: 'List Print Queue',
    description: 'Return pending scheduled print jobs and recent queue history.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'cancelQueuedPrint',
    title: 'Cancel Queued Print',
    description: 'Cancel a pending scheduled print job by id.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Queued print job id returned by printReceipt or publishEscPos.',
        },
      },
      required: ['id'],
    },
    annotations: {
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: 'getPrinterStatus',
    title: 'Get Printer Status',
    description: 'Return server, MQTT, topic, and renderer configuration status.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
];

function jsonRpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function isJsonRpcRequest(message) {
  return message && typeof message === 'object' && typeof message.method === 'string' && message.id !== undefined;
}

function isJsonRpcNotification(message) {
  return message && typeof message === 'object' && typeof message.method === 'string' && message.id === undefined;
}

function isJsonRpcResponse(message) {
  return message && typeof message === 'object' && typeof message.method !== 'string' && message.id !== undefined
    && (Object.prototype.hasOwnProperty.call(message, 'result') || Object.prototype.hasOwnProperty.call(message, 'error'));
}

function accepts(req, contentType) {
  const accept = req.get('accept') || '';
  return accept.split(',').some((entry) => entry.split(';')[0].trim().toLowerCase() === contentType);
}

function validMcpProtocolVersion(req) {
  const version = req.get('mcp-protocol-version');
  return !version || version === MCP_PROTOCOL_VERSION || version === '2025-06-18' || version === '2025-03-26';
}

function validateMcpOrigin(req, res, next) {
  const origin = req.get('origin');
  if (!origin) {
    return next();
  }

  let parsedOrigin;
  try {
    parsedOrigin = new URL(origin);
  } catch (err) {
    return res.status(403).json(jsonRpcError(null, -32000, 'Forbidden origin'));
  }

  const host = req.get('host');
  const sameHost = host && parsedOrigin.host.toLowerCase() === host.toLowerCase();
  const explicitlyAllowed = MCP_ALLOWED_ORIGINS.includes(origin);
  if (!sameHost && !explicitlyAllowed) {
    return res.status(403).json(jsonRpcError(null, -32000, 'Forbidden origin'));
  }

  return next();
}

function printerStatus() {
  return {
    ok: true,
    mqtt: mqttConnected,
    topic: MQTT_TOPIC,
    publishChunkBytes: MQTT_PUBLISH_CHUNK_BYTES,
    topicOverrideAllowed: ALLOW_TOPIC_OVERRIDE,
    queue: {
      pending: printQueue.length,
      history: printQueueHistory.length,
      maxJobs: PRINT_QUEUE_MAX_JOBS,
      retryMs: PRINT_QUEUE_RETRY_MS,
    },
    renderer: {
      mode: RASTER_MARKDOWN ? 'raster' : 'receiptline',
      command: PRINTER_COMMAND,
      imageRenderer: IMAGE_RENDERER,
      widthDots: PRINTER_DOTS,
      bandHeight: RASTER_BAND_HEIGHT,
      threshold: RASTER_THRESHOLD,
      fontFamily: RASTER_FONT_FAMILY,
      fontSize: RASTER_FONT_SIZE,
      lineHeight: RASTER_LINE_HEIGHT,
      marginX: RASTER_MARGIN_X,
    },
  };
}

async function callMcpTool(name, args = {}) {
  if (name === 'printReceipt') {
    const markdown = markdownFromToolArgs(args);
    const escpos = await composePrintJob({ markdown, qr: args.qr, image: args.image });
    const topic = resolvePublishTopic(args);
    const publishResult = await publishOrQueueEscPos(escpos, topic, { ...args, source: 'mcp:printReceipt' });
    const structuredContent = {
      ok: true,
      bytes: escpos.length,
      topic,
      chunks: publishResult.chunks,
      chunkBytes: publishResult.chunkBytes,
      queued: publishResult.queued,
      job: publishResult.job,
      mode: RASTER_MARKDOWN ? 'raster' : 'receiptline',
      widthDots: PRINTER_DOTS,
    };
    if (publishResult.queued) {
      return mcpToolResult(`Queued ${escpos.length} ESC/POS bytes for MQTT topic "${topic}" at ${publishResult.job.runAt}.`, structuredContent);
    }
    return mcpToolResult(`Published ${escpos.length} ESC/POS bytes to MQTT topic "${topic}".`, structuredContent);
  }

  if (name === 'previewReceipt') {
    const markdown = markdownFromToolArgs(args);
    const escpos = await composePrintJob({ markdown, qr: args.qr, image: args.image });
    const structuredContent = encodePreview(escpos, args);
    const suffix = structuredContent.truncated ? ` Preview truncated to ${structuredContent.returnedBytes} bytes.` : '';
    return mcpToolResult(`Rendered ${escpos.length} ESC/POS bytes without publishing.${suffix}`, structuredContent);
  }

  if (name === 'publishEscPos') {
    const escpos = decodeRawEscPos(args);
    if (!escpos.length) {
      throw new Error('Decoded ESC/POS payload is empty.');
    }
    const topic = resolvePublishTopic(args);
    const publishResult = await publishOrQueueEscPos(escpos, topic, { ...args, source: 'mcp:publishEscPos' });
    if (publishResult.queued) {
      return mcpToolResult(`Queued ${escpos.length} raw ESC/POS bytes for MQTT topic "${topic}" at ${publishResult.job.runAt}.`, {
        ok: true,
        queued: true,
        bytes: escpos.length,
        topic,
        job: publishResult.job,
      });
    }
    return mcpToolResult(`Published ${escpos.length} raw ESC/POS bytes to MQTT topic "${topic}".`, {
      ok: true,
      queued: false,
      bytes: escpos.length,
      topic,
      chunks: publishResult.chunks,
      chunkBytes: publishResult.chunkBytes,
    });
  }

  if (name === 'listPrintQueue') {
    const snapshot = queueSnapshot();
    return mcpToolResult(`Pending queue jobs: ${snapshot.pending.length}. Recent history entries: ${snapshot.history.length}.`, {
      ok: true,
      ...snapshot,
    });
  }

  if (name === 'cancelQueuedPrint') {
    if (!args || typeof args.id !== 'string' || !args.id.trim()) {
      throw new Error('Queued job id is required.');
    }
    const job = cancelQueuedJob(args.id.trim());
    if (!job) {
      throw new Error(`Queued job not found: ${args.id}`);
    }
    return mcpToolResult(`Cancelled queued print job ${job.id}.`, {
      ok: true,
      cancelled: publicQueueJob(job),
    });
  }

  if (name === 'getPrinterStatus') {
    const status = printerStatus();
    return mcpToolResult(`MQTT connected: ${status.mqtt}. Default topic: ${status.topic}.`, status);
  }

  throw new Error(`Tool not found: ${name}`);
}

async function handleMcpRequest(message) {
  const { jsonrpc, id, method, params } = message || {};
  if (jsonrpc !== '2.0' || typeof method !== 'string') {
    return jsonRpcError(id === undefined ? null : id, -32600, 'Invalid Request');
  }
  if (id === undefined && method.startsWith('notifications/')) {
    return null;
  }

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: (params && params.protocolVersion) || MCP_PROTOCOL_VERSION,
        capabilities: {
          tools: {
            listChanged: false,
          },
        },
        serverInfo: {
          name: SERVER_NAME,
          version: SERVER_VERSION,
        },
        instructions: 'Use printReceipt for normal print jobs, previewReceipt to inspect generated ESC/POS, publishEscPos for trusted raw ESC/POS bytes, and getPrinterStatus for health/configuration.',
      },
    };
  }

  if (method === 'ping') {
    return { jsonrpc: '2.0', id, result: {} };
  }

  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: mcpTools } };
  }

  if (method === 'tools/call') {
    try {
      const { name, arguments: args } = params || {};
      if (typeof name !== 'string') {
        return jsonRpcError(id, -32602, 'Tool name is required.');
      }
      const result = await callMcpTool(name, args || {});
      return { jsonrpc: '2.0', id, result };
    } catch (error) {
      return {
        jsonrpc: '2.0',
        id,
        result: mcpToolResult(error.message || 'Tool call failed.', { ok: false, error: error.message || 'Tool call failed.' }, true),
      };
    }
  }

  return jsonRpcError(id, -32601, 'Method not found');
}

// MCP Streamable HTTP endpoint. Handles discovery (`tools/list`) and invocation
// (`tools/call`). The request body must be one JSON-RPC request, notification,
// or response. This implementation is stateless and returns application/json
// responses rather than streaming SSE responses.
app.get('/mcp', validateMcpOrigin, requireApiToken, (req, res) => {
  res.setHeader('MCP-Protocol-Version', MCP_PROTOCOL_VERSION);
  if (!validMcpProtocolVersion(req)) {
    return res.status(400).json(jsonRpcError(null, -32000, 'Unsupported MCP-Protocol-Version'));
  }
  if (!accepts(req, 'text/event-stream')) {
    return res.status(406).json(jsonRpcError(null, -32000, 'Accept must include text/event-stream'));
  }
  return res.status(405).set('Allow', 'POST').json(jsonRpcError(null, -32000, 'Server-initiated MCP streams are not supported'));
});

app.delete('/mcp', validateMcpOrigin, requireApiToken, (req, res) => {
  res.setHeader('MCP-Protocol-Version', MCP_PROTOCOL_VERSION);
  if (!validMcpProtocolVersion(req)) {
    return res.status(400).json(jsonRpcError(null, -32000, 'Unsupported MCP-Protocol-Version'));
  }
  return res.status(405).set('Allow', 'POST').json(jsonRpcError(null, -32000, 'MCP sessions are stateless and cannot be deleted'));
});

app.post('/mcp', validateMcpOrigin, requireApiToken, async (req, res) => {
  res.setHeader('MCP-Protocol-Version', MCP_PROTOCOL_VERSION);

  if (!validMcpProtocolVersion(req)) {
    return res.status(400).json(jsonRpcError(null, -32000, 'Unsupported MCP-Protocol-Version'));
  }
  if (!accepts(req, 'application/json') || !accepts(req, 'text/event-stream')) {
    return res.status(406).json(jsonRpcError(null, -32000, 'Accept must include application/json and text/event-stream'));
  }

  const payload = req.body;
  if (Array.isArray(payload)) {
    return res.status(400).json(jsonRpcError(null, -32600, 'Batch requests are not supported by Streamable HTTP'));
  }
  if (isJsonRpcResponse(payload)) {
    return res.status(202).end();
  }
  if (isJsonRpcNotification(payload)) {
    const response = await handleMcpRequest(payload);
    return response ? res.status(400).json(response) : res.status(202).end();
  }
  if (!isJsonRpcRequest(payload)) {
    return res.status(400).json(jsonRpcError(null, -32600, 'Invalid Request'));
  }

  const response = await handleMcpRequest(payload);
  return response ? res.type('application/json').json(response) : res.status(202).end();
});


// Health endpoint
app.get('/health', (req, res) => {
  res.json(printerStatus());
});

app.get('/queue', requireApiToken, (req, res) => {
  res.json({ ok: true, ...queueSnapshot() });
});

app.delete('/queue/:id', requireApiToken, (req, res) => {
  const job = cancelQueuedJob(req.params.id);
  if (!job) {
    return res.status(404).json({ ok: false, error: 'queued job not found' });
  }
  res.json({ ok: true, cancelled: publicQueueJob(job) });
});

// Print endpoint
// Extended print endpoint.  Accepts optional `qr` and `image` properties on
// the request body.  These fields will be converted into ESC/POS commands via
// qrToEscPos() and imageToEscPos() respectively and appended to the print
// job.  The base text/markdown conversion still occurs via receiptline.
app.post('/print', requireApiToken, async (req, res) => {
  try {
    const markdown = normalisePayload(req);
    const escpos = await composePrintJob({
      markdown,
      qr: req.body && req.body.qr,
      image: req.body && req.body.image,
    });
    const result = await publishOrQueueEscPos(escpos, MQTT_TOPIC, scheduleOptionsFromRequest(req, 'http POST /print'));
    res.json({
      ok: true,
      queued: result.queued,
      job: result.job,
      bytes: escpos.length,
      chunks: result.chunks,
      chunkBytes: result.chunkBytes,
      topic: MQTT_TOPIC,
      mode: RASTER_MARKDOWN ? 'raster' : 'receiptline',
      widthDots: PRINTER_DOTS,
    });
  } catch (err) {
    const status = err.message === 'MQTT broker not connected' ? 503 : 400;
    res.status(status).json({ ok: false, error: err.message });
  }
});

// Preview endpoint for debugging: returns hex of the ESC/POS bytes (no MQTT publish)
app.post('/preview', requireApiToken, async (req, res) => {
  try {
    const markdown = normalisePayload(req);
    const escpos = await composePrintJob({
      markdown,
      qr: req.body && req.body.qr,
      image: req.body && req.body.image,
    });
    res.json({ ok: true, bytes: escpos.length, mode: RASTER_MARKDOWN ? 'raster' : 'receiptline', widthDots: PRINTER_DOTS, hex: escpos.toString('hex') });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log(`Server listening on ${HOST}:${PORT}`);
  });
}

module.exports = {
  app,
  composePrintJob,
  handleMcpRequest,
  mcpTools,
  printerStatus,
};
