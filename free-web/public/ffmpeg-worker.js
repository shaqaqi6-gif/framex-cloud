/*
 * FrameX engine worker — CLASSIC worker on purpose.
 *
 * It is loaded with `new Worker(url)` (no `{ type: 'module' }`) and pulls the
 * FFmpeg core in with importScripts(). Nothing here is an ES module and nothing
 * here uses a dynamic import(), because module workers / module imports are the
 * exact thing that fails on several mobile browsers with
 * "TypeError: Importing a module script failed".
 */

var core = null;
var lastLog = '';

function fail(code, cause) {
  var err = new Error(cause && cause.message ? code + ': ' + cause.message : code);
  err.code = code;
  return err;
}

function post(message, transfer) {
  if (transfer && transfer.length) self.postMessage(message, transfer);
  else self.postMessage(message);
}

self.onmessage = function (event) {
  var msg = event.data || {};
  var job = msg.job;
  Promise.resolve()
    .then(function () {
      if (msg.type === 'load') return load(msg);
      if (msg.type === 'run') return run(msg);
      throw fail('UNKNOWN_COMMAND');
    })
    .catch(function (err) {
      post({
        type: 'error',
        job: job,
        code: (err && err.code) || 'ENGINE_FAILED',
        message: String((err && err.message) || err),
        log: lastLog
      });
    });
};

function load(msg) {
  if (core) {
    post({ type: 'ready', job: msg.job });
    return;
  }
  try {
    importScripts(msg.coreURL);
  } catch (err) {
    throw fail('CORE_SCRIPT_FAILED', err);
  }
  if (typeof createFFmpegCore !== 'function') throw fail('CORE_GLOBAL_MISSING');

  var config = btoa(JSON.stringify({ wasmURL: msg.wasmURL }));
  return Promise.resolve(createFFmpegCore({ mainScriptUrlOrBlob: msg.coreURL + '#' + config })).then(function (instance) {
    if (!instance || !instance.FS || typeof instance.exec !== 'function') throw fail('CORE_INVALID');
    core = instance;
    if (core.setLogger) {
      core.setLogger(function (entry) {
        if (!entry || !entry.message) return;
        lastLog = String(entry.message).slice(-240);
        post({ type: 'log', message: lastLog });
      });
    }
    if (core.setProgress) {
      core.setProgress(function (entry) {
        if (!entry || !isFinite(entry.progress)) return;
        post({ type: 'progress', progress: entry.progress });
      });
    }
    post({ type: 'ready', job: msg.job });
  });
}

function unlink(name) {
  try {
    core.FS.unlink(name);
  } catch (err) {
    /* the file simply was not there */
  }
}

function run(msg) {
  if (!core) throw fail('CORE_NOT_LOADED');

  var input = msg.input;
  var output = msg.output;

  unlink(input);
  unlink(output);
  try {
    core.FS.writeFile(input, new Uint8Array(msg.data));
  } catch (err) {
    throw fail('INPUT_WRITE_FAILED', err);
  }

  if (core.setTimeout) {
    try {
      core.setTimeout(-1);
    } catch (err) {
      /* older cores do not expose it */
    }
  }

  var code = exec(msg.args);
  if (code !== 0 && msg.fallbackArgs) {
    unlink(output);
    post({ type: 'retry', job: msg.job });
    code = exec(msg.fallbackArgs);
  }

  if (code !== 0) {
    unlink(input);
    unlink(output);
    throw fail('FFMPEG_EXIT_' + code);
  }

  var data;
  try {
    data = core.FS.readFile(output);
  } catch (err) {
    throw fail('OUTPUT_MISSING', err);
  }
  unlink(input);
  unlink(output);

  var buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  post({ type: 'done', job: msg.job, data: buffer }, [buffer]);
}

function exec(args) {
  var code;
  try {
    code = core.exec.apply(core, args);
  } catch (err) {
    throw fail('FFMPEG_CRASHED', err);
  }
  if (core.reset) {
    try {
      core.reset();
    } catch (err) {
      /* ignore */
    }
  }
  return Number(code);
}
