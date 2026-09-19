// Instrumentation for the extension API survey. scripts/ext-survey/survey.js injects this
// file into a throwaway COPY of each extension — first in the service worker, first in
// every extension page, and first in every ISOLATED-world content script. Never ship it.
//
// It replaces the global `chrome` with a Proxy that reports, once per path and context:
//   call          a chrome.* function was invoked (and did not throw synchronously)
//   missing       a property read on the API tree returned undefined and does not exist
//   probe-absent  `'x' in chrome.y` was false — feature detection, not necessarily a bug
//   threw         a chrome.* function threw synchronously
//   rejected      a chrome.* function's promise rejected
//   lastError     a callback ran with chrome.runtime.lastError set
//   uncaught      an uncaught error or unhandled rejection in the context
//   stub-get      (stub mode) a member of a missing namespace was read
//   stub-call     (stub mode) a member of a missing namespace was called
// plus one `surface` record listing every chrome.* path that exists in the context.
// Records go to the console with a fixed prefix, which survey.js collects via Electron's
// console-message events.
//
// In stub mode (survey.js sets globalThis.__extSurveyStub before this file runs) a missing
// property on the API tree comes back as an inert stub instead of undefined: every read
// yields another stub, calls resolve to undefined, and addListener does nothing. Execution
// then continues past the first missing API, so one run finds all of them. Errors that
// follow a stub are artefacts (the stub returned undefined where data was expected).
(() => {
  if (globalThis.__extSurveyInstalled) return;
  globalThis.__extSurveyInstalled = true;

  const TAG = '__EXT_SURVEY__';
  const STUB = globalThis.__extSurveyStub === true;
  const log = console.info.bind(console);
  const isWorker = typeof ServiceWorkerGlobalScope !== 'undefined' && globalThis instanceof ServiceWorkerGlobalScope;
  const ctx = isWorker
    ? 'worker'
    : location.protocol === 'chrome-extension:' ? `page:${location.pathname}` : 'content';

  const real = globalThis.chrome;
  const extId = (() => { try { return real.runtime.id; } catch { return null; } })();

  const emit = (rec) => {
    try { log(TAG + JSON.stringify({ ext: extId, ctx, ...rec })); } catch { /* never break the host */ }
  };
  // Minified bundles are one enormous line, so keep line:column of the top frames — that is
  // what locates the failing call in the source (Chromium's own report says column 1).
  const frames = (e) => String(e?.stack || '').split('\n').slice(1, 4)
    .map(l => l.trim().replace(/chrome-extension:\/\/[a-p]{32}/, '')).join(' < ');
  const describe = (e) => {
    const msg = String((e && (e.message || e.reason?.message)) || e).slice(0, 300);
    const at = e instanceof Error ? frames(e) : '';
    return at ? `${msg} @ ${at}` : msg;
  };

  const seen = new Set();
  const report = (kind, path, detail) => {
    const key = `${kind}|${path}`;
    if (seen.has(key)) return;
    seen.add(key);
    emit({ type: 'event', kind, path, ...(detail === undefined ? {} : { detail: describe(detail) }) });
  };

  addEventListener('error', (e) => report('uncaught', 'error', e.error || e.message));
  addEventListener('unhandledrejection', (e) => report('uncaught', 'rejection', e.reason));

  if (!real) {
    emit({ type: 'no-chrome' });
    return;
  }

  // --- surface: what actually exists here, to depth chrome.a.b.c --------------------------
  const surface = {};
  const isEvent = (v) => v && typeof v === 'object' && typeof v.addListener === 'function';
  const walk = (obj, path, depth) => {
    let keys;
    try { keys = Object.getOwnPropertyNames(obj); } catch { return; }
    for (const key of keys) {
      const sub = `${path}.${key}`;
      let v;
      try { v = obj[key]; } catch { surface[sub] = 'throws'; continue; }
      if (v === undefined || v === null) continue;
      const type = isEvent(v) ? 'event' : typeof v;
      surface[sub] = type === 'object' && depth >= 3 ? 'object-unwalked' : type;
      if (type === 'object' && depth < 3) walk(v, sub, depth + 1);
    }
  };
  walk(real, 'chrome', 1);
  emit({ type: 'surface', surface });

  // --- proxy ------------------------------------------------------------------------------
  // Chrome defines lastError only while a callback runs, so its absence is normal.
  const NOT_MISSING = new Set(['lastError', 'then', 'toJSON']);
  // Wrapping a listener would change its identity and break removeListener/hasListener.
  const LISTENER_METHODS = new Set(['addListener', 'removeListener', 'hasListener', 'hasListeners']);
  const stubCache = new Map();
  const makeStub = (path) => {
    let stub = stubCache.get(path);
    if (stub) return stub;
    const method = path.slice(path.lastIndexOf('.') + 1);
    stub = new Proxy(() => {}, {
      get(_t, key) {
        if (typeof key === 'symbol' || NOT_MISSING.has(key)) return undefined;
        const sub = `${path}.${key}`;
        report('stub-get', sub);
        return makeStub(sub);
      },
      apply(_t, _this, args) {
        report('stub-call', path);
        if (LISTENER_METHODS.has(method)) return method.startsWith('has') ? false : undefined;
        const cb = args[args.length - 1];
        if (typeof cb === 'function') {
          setTimeout(() => cb(), 0);
          return undefined;
        }
        return Promise.resolve(undefined);
      },
    });
    stubCache.set(path, stub);
    return stub;
  };

  const objCache = new WeakMap();
  // Keyed by owner THEN function: methods like addListener live on a shared prototype, so a
  // cache keyed by function alone would bind every event's addListener to whichever event
  // object was wrapped first — silently cross-wiring listeners between events.
  const fnCache = new WeakMap();

  const wrapFn = (fn, owner, path) => {
    let byFn = fnCache.get(owner);
    if (!byFn) fnCache.set(owner, (byFn = new WeakMap()));
    const cached = byFn.get(fn);
    if (cached) return cached;
    const method = path.slice(path.lastIndexOf('.') + 1);
    const wrapped = function (...args) {
      const last = args.length - 1;
      if (last >= 0 && typeof args[last] === 'function' && !LISTENER_METHODS.has(method)) {
        const cb = args[last];
        args[last] = function (...res) {
          const le = real.runtime && real.runtime.lastError;
          if (le) report('lastError', path, le.message);
          return cb.apply(this, res);
        };
      }
      let result;
      try {
        result = fn.apply(owner, args);
      } catch (e) {
        const where = frames(new Error());
        report('threw', path, `${describe(e)}${where ? ` [called from ${where}]` : ''}`);
        throw e;
      }
      report('call', path);
      if (result && typeof result.then === 'function') {
        result.then(null, (e) => report('rejected', path, e));
      }
      return result;
    };
    byFn.set(fn, wrapped);
    return wrapped;
  };

  const wrapObj = (obj, path) => {
    const cached = objCache.get(obj);
    if (cached) return cached;
    const proxy = new Proxy(obj, {
      get(target, key) {
        if (typeof key === 'symbol') return Reflect.get(target, key);
        const sub = `${path}.${key}`;
        let v;
        try {
          v = Reflect.get(target, key);
        } catch (e) {
          report('threw', sub, e);
          throw e;
        }
        if (v === undefined) {
          if (NOT_MISSING.has(key) || key in target) return v;
          report('missing', sub);
          return STUB ? makeStub(sub) : v;
        }
        // Proxy invariant: a non-configurable, non-writable property must come back as-is.
        const desc = Reflect.getOwnPropertyDescriptor(target, key);
        if (desc && !desc.configurable && desc.writable === false) return v;
        if (typeof v === 'function') return wrapFn(v, target, sub);
        if (typeof v === 'object' && v !== null) return wrapObj(v, sub);
        return v;
      },
      has(target, key) {
        const present = Reflect.has(target, key);
        if (!present && typeof key === 'string') report('probe-absent', `${path}.${key}`);
        return present;
      },
    });
    objCache.set(obj, proxy);
    return proxy;
  };

  const proxied = wrapObj(real, 'chrome');
  try {
    Object.defineProperty(globalThis, 'chrome', { value: proxied, configurable: true, writable: true, enumerable: true });
  } catch (e) {
    emit({ type: 'install-failed', detail: describe(e) });
  }
  if (globalThis.chrome !== proxied) emit({ type: 'install-failed', detail: 'global chrome was not replaced' });
})();
