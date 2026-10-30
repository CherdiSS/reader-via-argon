// Classic Web Worker для фонемизации текста через piper-phonemize WASM (espeak-ng).
// sherpa-onnx >= 2.0 больше не содержит espeak-ng: модели VITS-Piper принимают
// только phonemeCodepoints. Фонемизатор живёт в отдельном воркере, потому что
// оба Emscripten-бандла используют один и тот же глобальный Module.
'use strict';

let initStarted = false;

function init(base) {
  if (initStarted) return;
  initStarted = true;
  const dir = (base || './') + 'piper-phonemize/';

  self.Module = {
    locateFile: function (path) {
      return dir + path;
    },
    printErr: function (text) {
      console.warn('[piper-phonemize err]', text);
    },
    onRuntimeInitialized: function () {
      try {
        const ret = piperPhonemizeInitialize();
        if (ret >= 0) {
          self.postMessage({ type: 'ready' });
        } else {
          self.postMessage({ type: 'init-error', message: 'Не удалось инициализировать espeak-ng (код ' + ret + ').' });
        }
      } catch (err) {
        self.postMessage({ type: 'init-error', message: err.message || String(err) });
      }
    }
  };

  try {
    importScripts(dir + 'piper-phonemize.js', dir + 'piper-phonemize-wasm-main.js');
  } catch (err) {
    self.postMessage({
      type: 'init-error',
      message: 'Не найден бандл piper-phonemize (' + dir + '): ' + (err.message || String(err))
    });
  }
}

self.onmessage = function (e) {
  const data = e.data || {};
  if (data.type === 'init') {
    init(data.base);
  } else if (data.type === 'phonemize') {
    try {
      const sentences = piperPhonemize(String(data.text || ''), data.voice || 'ru');
      if (!sentences) throw new Error('piper-phonemize вернул пустой результат.');
      self.postMessage({ type: 'result', id: data.id, sentences: sentences });
    } catch (err) {
      self.postMessage({ type: 'result', id: data.id, error: err.message || String(err) });
    }
  }
};
