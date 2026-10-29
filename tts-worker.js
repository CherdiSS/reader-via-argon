// Classic Web Worker для однопоточного нейросетевого синтеза речи sherpa-onnx WASM
'use strict';

let tts = null;
let isInitializing = false;
let isMockMode = false;
let blobUrls = {};
let initStartTime = 0;

async function fetchWithProgress(url, label, mimeType, progressOffset, totalExpected) {
  const response = await fetch(url, { cache: 'default' });
  if (!response.ok) {
    throw new Error(
      'HTTP ' + response.status + ' при загрузке ' + url +
      '. Убедитесь, что GitHub Actions workflow собрал и опубликовал артефакты WASM.'
    );
  }

  const contentType = (response.headers.get('Content-Type') || '').toLowerCase();
  if (contentType.includes('text/html')) {
    throw new Error(
      'Сервер вернул HTML-страницу вместо бинарного файла ' + url +
      '. Проверьте публикацию артефактов GitHub Actions.'
    );
  }

  const contentLength = Number(response.headers.get('Content-Length')) || 0;
  const grandTotal = totalExpected || contentLength;

  if (!response.body || typeof response.body.getReader !== 'function') {
    const buf = await response.arrayBuffer();
    self.postMessage({
      type: 'progress',
      label: label,
      loaded: progressOffset + buf.byteLength,
      total: grandTotal || (progressOffset + buf.byteLength)
    });
    return new Blob([buf], { type: mimeType });
  }

  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  let lastReport = 0;

  while (true) {
    const step = await reader.read();
    if (step.done) break;
    chunks.push(step.value);
    received += step.value.byteLength;

    const now = Date.now();
    if (now - lastReport > 80) {
      lastReport = now;
      self.postMessage({
        type: 'progress',
        label: label,
        loaded: progressOffset + received,
        total: grandTotal
      });
    }
  }

  self.postMessage({
    type: 'progress',
    label: label,
    loaded: progressOffset + received,
    total: grandTotal || (progressOffset + received)
  });

  return new Blob(chunks, { type: mimeType });
}

async function resolveArtifactNames() {
  // Проверяем корневой каталог (основная структура) и подкаталог ./tts-test/ (для совместимости)
  const prefixes = ['./', './tts-test/'];
  const variants = [
    {
      mainJs: 'sherpa-onnx-wasm-main-tts.js',
      ttsJs: 'sherpa-onnx-tts.js',
      wasm: 'sherpa-onnx-wasm-main-tts.wasm',
      data: 'sherpa-onnx-wasm-main-tts.data',
      meta: 'model-meta.json'
    },
    {
      mainJs: 'sherpa-onnx-wasm-main.js',
      ttsJs: 'sherpa-onnx.js',
      wasm: 'sherpa-onnx-wasm-main.wasm',
      data: 'sherpa-onnx-wasm-main.data',
      meta: 'model-meta.json'
    }
  ];

  for (let p = 0; p < prefixes.length; p++) {
    const prefix = prefixes[p];
    for (let v = 0; v < variants.length; v++) {
      const cand = variants[v];
      const mainUrl = prefix + cand.mainJs;
      try {
        const resp = await fetch(mainUrl, { method: 'HEAD', cache: 'no-store' });
        const ct = (resp.headers.get('Content-Type') || '').toLowerCase();
        if (resp.ok && !ct.includes('text/html')) {
          return {
            prefix: prefix,
            mainJs: prefix + cand.mainJs,
            ttsJs: prefix + cand.ttsJs,
            wasm: prefix + cand.wasm,
            data: prefix + cand.data,
            meta: prefix + cand.meta,
            wasmKey: cand.wasm,
            dataKey: cand.data
          };
        }
      } catch (_) {}
    }
  }

  throw new Error(
    'Файлы нейросетевой модели (sherpa-onnx-wasm-main-tts.js / .wasm / .data) не найдены на сервере. ' +
    'Запустите workflow "Build & Deploy Russian WASM TTS to GitHub Pages" во вкладке Actions вашего репозитория ' +
    'или переключитесь на системный голос браузера.'
  );
}

async function initEngine(options) {
  const opts = options || {};

  if (opts.mockMode) {
    isMockMode = true;
    tts = {
      sampleRate: 22050,
      numSpeakers: 1,
      generate: function (req) {
        const sr = 22050;
        const speed = Math.max(0.5, Math.min(2.0, Number(req.speed) || 1.0));
        const clean = String(req.text || '').trim();
        if (!clean) {
          return { samples: new Float32Array(0), sampleRate: sr };
        }
        const durationSec = Math.min(10.0, Math.max(0.25, (clean.length * 0.045) / speed));
        const numSamples = Math.floor(sr * durationSec);
        const samples = new Float32Array(numSamples);
        for (let i = 0; i < numSamples; i++) {
          const t = i / sr;
          const syl = Math.sin(2 * Math.PI * (3.2 * speed) * t);
          const env = syl > -0.2 ? Math.min(1, (syl + 0.2) * 1.5) : 0.05;
          const f0 = 140 + 20 * Math.sin(2 * Math.PI * 1.2 * t);
          const wave =
            0.5 * Math.sin(2 * Math.PI * f0 * t) +
            0.25 * Math.sin(2 * Math.PI * (f0 * 2) * t) +
            0.15 * Math.sin(2 * Math.PI * 540 * t);
          const fade = Math.min(1, i / 350, (numSamples - i) / 500);
          samples[i] = wave * env * fade * 0.4;
        }
        return { samples: samples, sampleRate: sr };
      }
    };
    self.postMessage({
      type: 'ready',
      sampleRate: 22050,
      numSpeakers: 1,
      initTimeMs: 12,
      mockMode: true
    });
    return;
  }

  if (tts && !isMockMode) {
    self.postMessage({
      type: 'ready',
      sampleRate: tts.sampleRate || 22050,
      numSpeakers: tts.numSpeakers || 1,
      initTimeMs: 0,
      cached: true
    });
    return;
  }

  if (isInitializing) return;
  isInitializing = true;
  isMockMode = false;

  try {
    initStartTime = performance.now();
    const names = await resolveArtifactNames();

    let totalBytes = 0;
    try {
      const metaResp = await fetch(names.meta, { cache: 'no-store' });
      if (metaResp.ok) {
        const meta = await metaResp.json();
        totalBytes = Number(meta.totalBytes) || 0;
      }
    } catch (_) {}

    const wasmBlob = await fetchWithProgress(
      names.wasm,
      'Скачивание движка WASM',
      'application/wasm',
      0,
      totalBytes
    );

    const dataBlob = await fetchWithProgress(
      names.data,
      'Скачивание русской модели VITS-Piper',
      'application/octet-stream',
      wasmBlob.size,
      totalBytes || 0
    );

    blobUrls[names.wasmKey] = URL.createObjectURL(wasmBlob);
    blobUrls[names.dataKey] = URL.createObjectURL(dataBlob);

    self.postMessage({
      type: 'status',
      text: 'Распаковка виртуальной ФС Emscripten и инициализация ONNX Runtime...'
    });

    self.Module = {
      locateFile: function (path, prefix) {
        const baseName = path.split('/').pop();
        if (blobUrls[path]) return blobUrls[path];
        if (blobUrls[baseName]) return blobUrls[baseName];
        return (prefix || names.prefix || './') + path;
      },
      setStatus: function (status) {
        if (status) {
          self.postMessage({ type: 'status', text: 'WASM: ' + status });
        }
      },
      print: function (text) {
        console.log('[sherpa-onnx]', text);
      },
      printErr: function (text) {
        console.warn('[sherpa-onnx err]', text);
      },
      onRuntimeInitialized: function () {
        try {
          tts = createOfflineTts(self.Module);
          isInitializing = false;

          Object.keys(blobUrls).forEach(function (k) {
            URL.revokeObjectURL(blobUrls[k]);
          });
          blobUrls = {};

          self.postMessage({
            type: 'ready',
            sampleRate: tts.sampleRate || 22050,
            numSpeakers: tts.numSpeakers || 1,
            initTimeMs: performance.now() - initStartTime,
            mockMode: false
          });
        } catch (initErr) {
          isInitializing = false;
          self.postMessage({
            type: 'error',
            code: 'INIT_FAILED',
            message: 'Ошибка инициализации OfflineTts в WebAssembly.',
            details: initErr.message || String(initErr)
          });
        }
      }
    };

    importScripts(names.mainJs, names.ttsJs);
  } catch (err) {
    isInitializing = false;
    Object.keys(blobUrls).forEach(function (k) {
      try { URL.revokeObjectURL(blobUrls[k]); } catch (_) {}
    });
    blobUrls = {};

    self.postMessage({
      type: 'error',
      code: 'LOAD_FAILED',
      message: 'Не удалось загрузить или инициализировать нейросетевую модель.',
      details: err.message || String(err)
    });
  }
}

self.onmessage = function (e) {
  const data = e.data || {};

  if (data.type === 'init') {
    initEngine(data);
  } else if (data.type === 'generate') {
    if (!tts) {
      self.postMessage({
        type: 'error',
        code: 'NOT_READY',
        sessionId: data.sessionId,
        chunkIndex: data.chunkIndex,
        requestId: data.requestId,
        message: 'Модель ещё не инициализирована. Сначала загрузите модель.'
      });
      return;
    }

    try {
      const t0 = performance.now();
      const delayMs = isMockMode ? Math.min(180, Math.max(25, Number(data.mockDelayMs) || 35)) : 0;

      const finishGeneration = function () {
        try {
          const audio = tts.generate({
            text: data.text,
            sid: data.sid || 0,
            speed: data.speed || 1.0
          });
          const elapsedMs = performance.now() - t0;
          const rawSamples = (audio && audio.samples) ? audio.samples : new Float32Array(0);
          const samplesCopy = new Float32Array(rawSamples);

          self.postMessage(
            {
              type: 'result',
              sessionId: data.sessionId,
              chunkIndex: data.chunkIndex,
              requestId: data.requestId,
              speed: data.speed || 1.0,
              samples: samplesCopy,
              sampleRate: (audio && audio.sampleRate) || tts.sampleRate || 22050,
              elapsedMs: elapsedMs
            },
            [samplesCopy.buffer]
          );
        } catch (innerErr) {
          self.postMessage({
            type: 'error',
            code: 'GENERATE_FAILED',
            sessionId: data.sessionId,
            chunkIndex: data.chunkIndex,
            requestId: data.requestId,
            message: 'Ошибка во время нейросетевого синтеза фрагмента.',
            details: innerErr.message || String(innerErr)
          });
        }
      };

      if (delayMs > 0) {
        setTimeout(finishGeneration, delayMs);
      } else {
        finishGeneration();
      }
    } catch (genErr) {
      self.postMessage({
        type: 'error',
        code: 'GENERATE_FAILED',
        sessionId: data.sessionId,
        chunkIndex: data.chunkIndex,
        requestId: data.requestId,
        message: 'Ошибка во время генерации речи.',
        details: genErr.message || String(genErr)
      });
    }
  }
};
