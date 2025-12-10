(() => {
  const $ = (sel) => document.querySelector(sel);
  const toggle = $('#debugToggle');
  const logEl = $('#debugLog');
  const clearBtn = $('#btnClearDebug');

  function enabled() {
    return !!(toggle && toggle.checked && logEl);
  }

  function saveEnabled(v) {
    try { localStorage.setItem('debug-enabled', v ? '1' : '0'); } catch {}
  }

  function loadEnabled() {
    try { return localStorage.getItem('debug-enabled') === '1'; } catch { return false; }
  }

  function logLine(msg, data) {
    if (!enabled()) return;
    try {
      const t = new Date().toISOString();
      const suffix = data === undefined ? '' : (' ' + (typeof data === 'string' ? data : JSON.stringify(data)));
      logEl.textContent += `[${t}] ${msg}${suffix}\n`;
      logEl.scrollTop = logEl.scrollHeight;
    } catch {}
  }

  function sanitizeHeaders(h) {
    const out = {};
    try {
      if (!h) return out;
      for (const [k, v] of Object.entries(h)) {
        const key = String(k).toLowerCase();
        if (key === 'authorization') out[k] = '<redacted>';
        else if (key === 'x-auth-token') out[k] = '<redacted>';
        else out[k] = v;
      }
    } catch {}
    return out;
  }

  // Initialize toggle state and clear button
  try {
    if (toggle) {
      toggle.checked = loadEnabled();
      toggle.addEventListener('change', () => saveEnabled(toggle.checked));
    }
    if (clearBtn && logEl) {
      clearBtn.addEventListener('click', () => { logEl.textContent = ''; });
    }
  } catch {}

  // Patch fetch to log requests/responses
  try {
    const origFetch = window.fetch;
    window.fetch = async function(input, init) {
      try {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        const method = (init && init.method) || 'GET';
        const headers = init && init.headers ? sanitizeHeaders(init.headers) : undefined;
        const bodyLen = init && init.body ? (typeof init.body === 'string' ? init.body.length : (init.body.size || undefined)) : undefined;
        logLine('fetch:req', { url, method, headers, bodyLen });
      } catch {}
      try {
        const res = await origFetch(input, init);
        try { logLine('fetch:res', { url: res.url, status: res.status }); } catch {}
        return res;
      } catch (e) {
        logLine('fetch:err', String(e && e.message || e));
        throw e;
      }
    };
  } catch {}

  // ===== UI live update helpers (top-level) =====
  const repoScanCounts = Object.create(null);
  const repoMetaBase = Object.create(null);

  function findRowAndMeta(repo) {
    try {
      const list = document.getElementById('repoList');
      if (!list) return {};
      const cb = list.querySelector(`input[type="checkbox"][data-name="${CSS.escape(repo)}"]`);
      if (!cb) return {};
      const rowEl = cb.closest('.list-row');
      const metaEl = rowEl && rowEl.querySelector('.meta');
      return { rowEl, metaEl };
    } catch { return {}; }
  }

  function markRepoScanning(repo) {
    const { rowEl, metaEl } = findRowAndMeta(repo);
    if (!metaEl) return;
    try {
      const base = repoMetaBase[repo] || metaEl.textContent.replace(/\s*\|\s*scanned:.*/, '');
      repoMetaBase[repo] = base;
      metaEl.textContent = base + ' | scanning...';
      if (rowEl) rowEl.style.outline = '1px solid #22c55e';
    } catch {}
  }

  function updateRepoFromPath(path) {
    try {
      const repo = String(path || '').split('/')[0] || '';
      if (!repo) return;
      repoScanCounts[repo] = (repoScanCounts[repo] || 0) + 1;
      const { rowEl, metaEl } = findRowAndMeta(repo);
      if (metaEl) {
        const base = repoMetaBase[repo] || metaEl.textContent.replace(/\s*\|\s*scanned:.*/, '');
        repoMetaBase[repo] = base;
        metaEl.textContent = base + ' | scanned: ' + (repoScanCounts[repo] || 0);
      }
      if (rowEl) rowEl.style.outline = '1px solid #22c55e';
    } catch {}
  }

  function ensureUiListeners(es, origAdd) {
    if (es.__uiListenersAdded) return;
    es.__uiListenersAdded = true;
    try {
      origAdd.call(es, 'repo', (e) => {
        try { const d = e && e.data ? JSON.parse(e.data) : {}; if (d && d.repo) markRepoScanning(d.repo); } catch {}
      });
      origAdd.call(es, 'file', (e) => {
        try { const d = e && e.data ? JSON.parse(e.data) : {}; if (d && d.path) updateRepoFromPath(d.path); } catch {}
      });
      origAdd.call(es, 'end', () => { /* keep outline for session */ });
    } catch {}
  }

  // Patch EventSource to log event payloads via wrapping addEventListener
  try {
    const proto = window.EventSource && window.EventSource.prototype;
    if (proto && !proto.__debugWrapped) {
      const origAdd = proto.addEventListener;
      const endedMap = new WeakMap();
      const listenersMap = new WeakMap(); // es -> [{type, fn}]
      const pollMap = new WeakMap(); // es -> { timer, sentCount }
      const uiAdded = new WeakSet(); // es -> ui listeners installed

      function addListener(es, type, fn) {
        let arr = listenersMap.get(es);
        if (!arr) { arr = []; listenersMap.set(es, arr); }
        arr.push({ type, fn });
      }

      function callListeners(es, type, payloadObj) {
        const arr = listenersMap.get(es);
        if (!arr) return;
        const e = { data: JSON.stringify(payloadObj || {}) };
        for (const { type: t, fn } of arr) {
          if (t === type) {
            try { fn.call(es, e); } catch (err) { logLine('handler:err', String(err && err.message || err)); }
          }
        }
      }

      function startStatusPoll(es) {
        if (pollMap.get(es)) return; // already polling
        try {
          const u = new URL(es.url, location.origin);
          const m = /\/scan\/jobs\/([^/]+)\/stream/.exec(u.pathname);
          if (!m) return;
          const jobId = m[1];
          const token = u.searchParams.get('token') || '';
          let sentCount = false;
          const timer = setInterval(async () => {
            try {
              const url = `/scan/jobs/${encodeURIComponent(jobId)}/status?token=${encodeURIComponent(token)}`;
              const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
              const json = await res.json();
              if (!json || !json.ok || !json.status) return;
              const st = json.status;
              if (!sentCount && typeof st.total === 'number') { callListeners(es, 'count', { total: st.total || 0 }); sentCount = true; }
              callListeners(es, 'progress', { scanned: st.scanned || 0, total: st.total || 0, percent: (st.total > 0 ? Math.min(100, Math.round((st.scanned / st.total) * 100)) : 0) });
              if (!st.running) {
                clearInterval(timer);
                pollMap.delete(es);
                endedMap.set(es, true);
                callListeners(es, 'end', { scanned: st.scanned || 0, total: st.total || 0, cancelled: !!st.cancelled, ms: (st.endedAt && st.startedAt ? (st.endedAt - st.startedAt) : undefined) });
              }
            } catch (err) {
              logLine('poll:err', String(err && err.message || err));
            }
          }, 1500);
          pollMap.set(es, { timer, sentCount });
          logLine('sse:fallback_poll_started', { jobId });
        } catch {}
      }

      proto.addEventListener = function(type, listener, options) {
        const es = this;
        // Ensure our UI listeners exist once per EventSource
        ensureUiListeners(es, origAdd);
        const wrapped = (e) => {
          // Log event payload
          try {
            const data = e && e.data ? (JSON.parse(e.data)) : undefined;
            logLine(`event:${type}`, data !== undefined ? data : (e && e.data));
          } catch {
            logLine(`event:${type}`, e && e.data);
          }
          try {
            if (type === 'end') { endedMap.set(es, true); }
            if (type === 'error') {
              if (endedMap.get(es)) {
                logLine('sse:suppressed_error_after_end');
                return;
              } else {
                // Start fallback polling when error occurs before end
                startStatusPoll(es);
              }
            }
            return listener.call(es, e);
          } catch (err) { logLine('handler:err', String(err && err.message || err)); }
        };
        addListener(es, type, wrapped);
        return origAdd.call(es, type, wrapped, options);
      };
      proto.__debugWrapped = true;
    }
  } catch {}
})();
