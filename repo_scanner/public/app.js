(function() {
  const $ = (sel) => document.querySelector(sel);
  const out = $('#output');
  const tokenInput = $('#token');
  const serverPortEl = $('#serverPort');

  const ownerInput = $('#owner');
  const ghTokenInput = $('#ghToken');
  const includePrivateCb = $('#includePrivate');
  const repoFilter = $('#repoFilter');
  const repoListEl = $('#repoList');
  const repoLinksEl = document.getElementById('repoLinks');

  const scanBar = $('#scanBar');
  const scanPercent = $('#scanPercent');
  const scanCounts = $('#scanCounts');
  const scannedListEl = $('#scannedList');
  const scanStatus = document.getElementById('scanStatus');
  const findingsListEl = $('#findingsList');

  let currentJobId = null;
  let currentES = null;
  let scannedFiles = [];
  let findings = [];
  let reposData = [];
  let preSelectedRepoNames = [];
  let isScanning = false;

  function stopLive(cancel = false) {
    if (currentES) {
      try { currentES.close(); } catch {}
      currentES = null;
    }
    currentJobId = null;
    setScanUi(false);
    if (cancel) {
      setOutput('Scan cancelled');
      if (scanStatus) scanStatus.textContent = 'Scan cancelled';
    }
  }

  function setScanUi(running) {
    isScanning = !!running;
    try {
      const ids = ['btnStartScan','btnStartScanAll','btnStartFromLinks'];
      for (const id of ids) {
        const el = document.getElementById(id);
        if (el) el.disabled = !!running;
      }
      const cancelBtn = document.getElementById('btnCancel');
      if (cancelBtn) cancelBtn.disabled = !running;
    } catch {}
  }

  function setOutput(data, append = false) {
    try {
      const message = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
      if (append && out.textContent) {
        out.textContent = out.textContent + '\n' + message;
      } else {
        out.textContent = message;
      }
      // Auto-scroll to bottom
      out.scrollTop = out.scrollHeight;
    } catch { out.textContent = String(data); }
  }

  function getToken() { return localStorage.getItem('x-auth-token') || ''; }
  function setToken(t) { if (t) localStorage.setItem('x-auth-token', t); else localStorage.removeItem('x-auth-token'); }
  function getGhToken() { return localStorage.getItem('gh-token') || ''; }
  function setGhToken(t) { if (t) localStorage.setItem('gh-token', t); else localStorage.removeItem('gh-token'); }

  async function api(path, { method = 'GET', body } = {}) {
    const headers = { 'Accept': 'application/json' };
    const token = getToken();
    if (token) headers['x-auth-token'] = token;
    const init = { method, headers };
    if (body !== undefined) { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    const res = await fetch(path, init);
    const ct = res.headers.get('content-type') || '';
    const payload = ct.includes('application/json') ? await res.json() : await res.text();
    if (!res.ok) throw new Error(typeof payload === 'string' ? payload : JSON.stringify(payload));
    return payload;
  }

  function resetScanUI() {
    if (scanBar) scanBar.style.width = '0%';
    if (scanPercent) scanPercent.textContent = '0%';
    if (scanCounts) scanCounts.textContent = '0 / 0 files';
    scannedFiles = [];
    findings = [];
    if (scannedListEl) scannedListEl.innerHTML = '';
    if (findingsListEl) findingsListEl.innerHTML = '';
    if (scanStatus) scanStatus.textContent = '';
  }

  function updateProgress(scanned, total) {
    const percent = total > 0 ? Math.min(100, Math.round((scanned / total) * 100)) : 0;
    if (scanBar) scanBar.style.width = `${percent}%`;
    if (scanPercent) scanPercent.textContent = `${percent}%`;
    if (scanCounts) scanCounts.textContent = `${scanned} / ${total} files`;
  }

  function appendScanned(path) {
    scannedFiles.push(path);
    if (!scannedListEl) return;
    const row = document.createElement('div');
    row.className = 'list-row';
    row.innerHTML = `<span class="name">${escapeHtml(path)}</span>`;
    scannedListEl.appendChild(row);
    const MAX_DISPLAY = 500;
    while (scannedListEl.children.length > MAX_DISPLAY) scannedListEl.removeChild(scannedListEl.firstChild);
    scannedListEl.scrollTop = scannedListEl.scrollHeight;
  }

  function appendFinding(f) {
    findings.push(f);
    if (!findingsListEl) return;
    const row = document.createElement('div');
    row.className = 'list-row';
    row.innerHTML = `
      <div class="name">${escapeHtml(f.repo + '/' + f.path)}<div class="meta">Rule: ${escapeHtml(f.rule)}</div></div>
      <div class="meta">${escapeHtml(f.match || '')}</div>
    `;
    findingsListEl.appendChild(row);
    const MAX_DISPLAY = 500;
    while (findingsListEl.children.length > MAX_DISPLAY) findingsListEl.removeChild(findingsListEl.firstChild);
    findingsListEl.scrollTop = findingsListEl.scrollHeight;
  }

  function suspiciousTargets() {
    // unique by repo+path
    const seen = new Set();
    const out = [];
    for (const f of findings) {
      if (f.rule !== 'suspicious_binary') continue;
      const k = `${f.repo}|${f.path}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ repo: f.repo, path: f.path, rule: f.rule });
    }
    return out;
  }

  async function createCleanPRs() {
    const owner = (ownerInput.value || '').trim();
    const ghToken = (ghTokenInput.value || '').trim();
    if (!owner) { setOutput('Enter owner'); return; }
    if (!ghToken) { setOutput('GitHub token required to create PRs'); return; }
    const targets = suspiciousTargets();
    if (!targets.length) { setOutput('No suspicious binaries to clean'); return; }
    try {
      const resp = await api('/github/clean/pr', { method: 'POST', body: { owner, ghToken, targets } });
      setOutput(resp);
    } catch (e) {
      setOutput(String(e.message || e));
    }
  }

  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[c])); }

  function renderRepos(items) {
    repoListEl.innerHTML = '';
    const filter = (repoFilter.value || '').toLowerCase();
    const frag = document.createDocumentFragment();
    items.filter(r => r.name.toLowerCase().includes(filter)).forEach(r => {
      const row = document.createElement('div');
      row.className = 'list-row';
      row.innerHTML = `
        <label class="chk">
          <input type="checkbox" data-name="${r.name}">
          <span class="name">${escapeHtml(r.full_name)}${r.private ? ' (private)' : ''}</span>
        </label>
        <span class="meta">${r.default_branch || ''}${r.archived ? ' | archived' : ''}${r.fork ? ' | fork' : ''}</span>
      `;
      frag.appendChild(row);
    });
    repoListEl.appendChild(frag);
    // Apply preselection if any
    if (preSelectedRepoNames && preSelectedRepoNames.length) {
      const want = new Set(preSelectedRepoNames);
      Array.from(repoListEl.querySelectorAll('input[type="checkbox"]')).forEach(cb => {
        const name = cb.getAttribute('data-name');
        if (name && want.has(name)) cb.checked = true;
      });
    }
  }

  function selectedRepos() {
    return Array.from(repoListEl.querySelectorAll('input[type="checkbox"]:checked')).map(cb => cb.getAttribute('data-name')).filter(Boolean);
  }

  function setAllRepoCheckboxes(checked) {
    Array.from(repoListEl.querySelectorAll('input[type="checkbox"]')).forEach(cb => { cb.checked = !!checked; });
  }

  async function listRepos() {
    const owner = (ownerInput.value || '').trim();
    const ghToken = (ghTokenInput.value || '').trim();
    const includePrivate = !!includePrivateCb.checked;
    if (!owner) { setOutput('Enter owner (user or org)'); return; }
    try {
      const resp = await api('/github/repos', { method: 'POST', body: { owner, includePrivate, ghToken } });
      reposData = resp.repos || [];
      renderRepos(reposData);
      setOutput({ listed: reposData.length });
    } catch (e) { setOutput(String(e.message || e)); }
  }

  function parseLinks(raw) {
    const lines = String(raw || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const owners = new Set();
    const repoNames = [];
    for (let line of lines) {
      // Accept owner or owner/repo without scheme
      if (!/^https?:\/\//i.test(line) && /^([A-Za-z0-9_.-]+)(\/[A-Za-z0-9_.-]+)?$/.test(line)) {
        line = 'https://github.com/' + line;
      }
      let url;
      try { url = new URL(line); } catch { continue; }
      if ((url.host || '').toLowerCase() !== 'github.com') continue;
      const parts = url.pathname.replace(/^\/+|\/+$/g, '').split('/');
      if (!parts[0]) continue;
      const owner = parts[0];
      owners.add(owner);
      if (parts[1]) {
        let repo = parts[1].replace(/\.git$/i, '');
        repoNames.push({ owner, repo });
      }
    }
    return { owners: Array.from(owners), repoNames };
  }

  async function useLinks() {
    const { owners, repoNames } = parseLinks(repoLinksEl ? repoLinksEl.value : '');
    if (!owners.length && !repoNames.length) { setOutput('Paste at least one GitHub link'); return; }
    if (owners.length > 1) { setOutput('Multiple owners detected. Please handle one owner at a time.'); return; }
    const owner = owners.length ? owners[0] : (repoNames[0] && repoNames[0].owner) || '';
    if (!owner) { setOutput('Could not determine owner'); return; }
    ownerInput.value = owner;
    preSelectedRepoNames = repoNames.filter(r => r.owner === owner).map(r => r.repo);
    await listRepos();
  }

  async function startFromLinks() {
    if (currentJobId || isScanning) { setOutput('A scan is already running. Cancel first.'); return; }
    const ghToken = (ghTokenInput.value || '').trim();
    const { owners, repoNames } = parseLinks(repoLinksEl ? repoLinksEl.value : '');
    if (!owners.length && !repoNames.length) { setOutput('Paste at least one GitHub link'); return; }
    if (owners.length > 1) { setOutput('Multiple owners detected. Please handle one owner at a time.'); return; }
    const owner = owners.length ? owners[0] : (repoNames[0] && repoNames[0].owner) || '';
    if (!owner) { setOutput('Could not determine owner'); return; }
    ownerInput.value = owner;
    const includePatterns = ($('#includes').value || '').split(',').map(s => s.trim()).filter(Boolean);
    const excludePatterns = ($('#excludes').value || '').split(',').map(s => s.trim()).filter(Boolean);
    const maxBytesPerFile = Number($('#maxBytes').value || 0) || undefined;

    // If only owner link(s) provided (no repo names), scan all repos of owner
    const ownerOnly = repoNames.filter(r => r.owner === owner).length === 0;
    if (ownerOnly) {
      // Ensure reposData loaded
      await listRepos();
      const repos = (reposData || []).map(r => r.name);
      if (!repos.length) { setOutput('No repositories found for owner'); return; }
      return startScanAll();
    }

    // Otherwise scan the specific repos named (must be same owner)
    const repos = repoNames.filter(r => r.owner === owner).map(r => r.repo);
    if (!repos.length) { setOutput('No valid repository links for this owner'); return; }

    try {
      resetScanUI();
      const resp = await api('/scan/start', { method: 'POST', body: { owner, repos, ghToken, includePatterns, excludePatterns, maxBytesPerFile } });
      currentJobId = resp.jobId;
      setOutput(`Scan started. Job ID: ${currentJobId}`);
      const token = encodeURIComponent(getToken() || '');
      currentES = new EventSource(`/scan/jobs/${currentJobId}/stream?token=${token}`);
      currentES.addEventListener('start', (e) => { try { const d = JSON.parse(e.data); setOutput(`Scan started at ${d.at || ''}`); if (scanStatus) scanStatus.textContent = 'Scanning…'; } catch {} });
      currentES.addEventListener('count', (e) => { try { const d = JSON.parse(e.data); updateProgress(0, d.total || 0); } catch {} });
      currentES.addEventListener('file', (e) => { try { const d = JSON.parse(e.data); if (d.path) appendScanned(d.path); } catch {} });
      currentES.addEventListener('finding', (e) => { try { const d = JSON.parse(e.data); appendFinding(d); } catch {} });
      currentES.addEventListener('progress', (e) => { try { const d = JSON.parse(e.data); updateProgress(d.scanned || 0, d.total || 0); } catch {} });
      currentES.addEventListener('warn', (e) => { try { const d = JSON.parse(e.data); setOutput(`Warn: ${d.repo || d.path || ''} -> ${d.error || ''}`, true); } catch {} });
      currentES.addEventListener('empty_repo', (e) => { try { const d = JSON.parse(e.data); setOutput(`Empty Repository: ${d.repo} - ${d.error || 'No files to scan'}`, true); } catch {} });
      currentES.addEventListener('error', (e) => { try { const d = JSON.parse(e.data); setOutput(`Error: ${d.error || ''}`, true); } catch { setOutput('Stream error', true); } });
      currentES.addEventListener('end', (e) => { try { const d = JSON.parse(e.data); setOutput(`Scan finished: ${d.scanned}/${d.total} files${d.cancelled ? ' (cancelled)' : ''}`, true); if (scanStatus) scanStatus.textContent = 'Scan complete'; } catch { setOutput('Scan finished', true); if (scanStatus) scanStatus.textContent = 'Scan complete'; } stopLive(false); });
    } catch (e) { setOutput(String(e.message || e)); }
  }

  async function startScan() {
    if (currentJobId || isScanning) { setOutput('A scan is already running. Cancel first.'); return; }
    const owner = (ownerInput.value || '').trim();
    const ghToken = (ghTokenInput.value || '').trim();
    const repos = selectedRepos();
    if (!owner || !repos.length) { setOutput('Select owner and at least one repo'); return; }
    const includePatterns = ($('#includes').value || '').split(',').map(s => s.trim()).filter(Boolean);
    const excludePatterns = ($('#excludes').value || '').split(',').map(s => s.trim()).filter(Boolean);
    const maxBytesPerFile = Number($('#maxBytes').value || 0) || undefined;

    try {
      resetScanUI();
      const resp = await api('/scan/start', { method: 'POST', body: { owner, repos, ghToken, includePatterns, excludePatterns, maxBytesPerFile } });
      currentJobId = resp.jobId;
      setOutput(`Scan started. Job ID: ${currentJobId}`);
      const token = encodeURIComponent(getToken() || '');
      currentES = new EventSource(`/scan/jobs/${currentJobId}/stream?token=${token}`);
      currentES.addEventListener('start', (e) => { try { const d = JSON.parse(e.data); setOutput(`Scan started at ${d.at || ''}`); if (scanStatus) scanStatus.textContent = 'Scanning…'; } catch {} });
      currentES.addEventListener('count', (e) => { try { const d = JSON.parse(e.data); updateProgress(0, d.total || 0); } catch {} });
      currentES.addEventListener('file', (e) => { try { const d = JSON.parse(e.data); if (d.path) appendScanned(d.path); } catch {} });
      currentES.addEventListener('finding', (e) => { try { const d = JSON.parse(e.data); appendFinding(d); } catch {} });
      currentES.addEventListener('progress', (e) => { try { const d = JSON.parse(e.data); updateProgress(d.scanned || 0, d.total || 0); } catch {} });
      currentES.addEventListener('warn', (e) => { try { const d = JSON.parse(e.data); setOutput(`Warn: ${d.repo || d.path || ''} -> ${d.error || ''}`, true); } catch {} });
      currentES.addEventListener('empty_repo', (e) => { try { const d = JSON.parse(e.data); setOutput(`Empty Repository: ${d.repo} - ${d.error || 'No files to scan'}`, true); } catch {} });
      currentES.addEventListener('error', (e) => { try { const d = JSON.parse(e.data); setOutput(`Error: ${d.error || ''}`, true); } catch { setOutput('Stream error', true); } });
      currentES.addEventListener('end', (e) => { try { const d = JSON.parse(e.data); setOutput(`Scan finished: ${d.scanned}/${d.total} files${d.cancelled ? ' (cancelled)' : ''}`, true); if (scanStatus) scanStatus.textContent = 'Scan complete'; } catch { setOutput('Scan finished', true); if (scanStatus) scanStatus.textContent = 'Scan complete'; } stopLive(false); });
    } catch (e) { setOutput(String(e.message || e)); }
  }

  async function startScanAll() {
    if (currentJobId || isScanning) { setOutput('A scan is already running. Cancel first.'); return; }
    const owner = (ownerInput.value || '').trim();
    const ghToken = (ghTokenInput.value || '').trim();
    if (!owner || !reposData.length) { setOutput('List repos first'); return; }
    // Use current filter to determine which repos are visible
    const filter = (repoFilter.value || '').toLowerCase();
    const repos = reposData.filter(r => r.name.toLowerCase().includes(filter)).map(r => r.name);
    if (!repos.length) { setOutput('No repos to scan'); return; }
    const includePatterns = ($('#includes').value || '').split(',').map(s => s.trim()).filter(Boolean);
    const excludePatterns = ($('#excludes').value || '').split(',').map(s => s.trim()).filter(Boolean);
    const maxBytesPerFile = Number($('#maxBytes').value || 0) || undefined;

    try {
      resetScanUI();
      const resp = await api('/scan/start', { method: 'POST', body: { owner, repos, ghToken, includePatterns, excludePatterns, maxBytesPerFile } });
      currentJobId = resp.jobId;
      setOutput(`Scan started. Job ID: ${currentJobId}`);
      const token = encodeURIComponent(getToken() || '');
      currentES = new EventSource(`/scan/jobs/${currentJobId}/stream?token=${token}`);
      currentES.addEventListener('start', (e) => { try { const d = JSON.parse(e.data); setOutput(`Scan started at ${d.at || ''}`); if (scanStatus) scanStatus.textContent = 'Scanning…'; } catch {} });
      currentES.addEventListener('count', (e) => { try { const d = JSON.parse(e.data); updateProgress(0, d.total || 0); } catch {} });
      currentES.addEventListener('file', (e) => { try { const d = JSON.parse(e.data); if (d.path) appendScanned(d.path); } catch {} });
      currentES.addEventListener('finding', (e) => { try { const d = JSON.parse(e.data); appendFinding(d); } catch {} });
      currentES.addEventListener('progress', (e) => { try { const d = JSON.parse(e.data); updateProgress(d.scanned || 0, d.total || 0); } catch {} });
      currentES.addEventListener('warn', (e) => { try { const d = JSON.parse(e.data); setOutput(`Warn: ${d.repo || d.path || ''} -> ${d.error || ''}`, true); } catch {} });
      currentES.addEventListener('empty_repo', (e) => { try { const d = JSON.parse(e.data); setOutput(`Empty Repository: ${d.repo} - ${d.error || 'No files to scan'}`, true); } catch {} });
      currentES.addEventListener('error', (e) => { try { const d = JSON.parse(e.data); setOutput(`Error: ${d.error || ''}`, true); } catch { setOutput('Stream error', true); } });
      currentES.addEventListener('end', (e) => { try { const d = JSON.parse(e.data); setOutput(`Scan finished: ${d.scanned}/${d.total} files${d.cancelled ? ' (cancelled)' : ''}`, true); if (scanStatus) scanStatus.textContent = 'Scan complete'; } catch { setOutput('Scan finished', true); if (scanStatus) scanStatus.textContent = 'Scan complete'; } stopLive(false); });
    } catch (e) { setOutput(String(e.message || e)); }
  }

  function init() {
    $('#saveToken').addEventListener('click', () => { setToken(tokenInput.value.trim()); setOutput('Token saved'); });
    $('#clearToken').addEventListener('click', () => { tokenInput.value = ''; setToken(''); setOutput('Token cleared'); });
    $('#btnListRepos').addEventListener('click', listRepos);
    repoFilter.addEventListener('input', () => renderRepos(reposData));
    const btnUseLinks = document.getElementById('btnUseLinks');
    if (btnUseLinks) btnUseLinks.addEventListener('click', useLinks);
    const btnStartFromLinks = document.getElementById('btnStartFromLinks');
    if (btnStartFromLinks) btnStartFromLinks.addEventListener('click', () => { setGhToken(ghTokenInput.value.trim()); startFromLinks(); });
    const selAll = document.getElementById('btnSelectAll');
    if (selAll) selAll.addEventListener('click', () => setAllRepoCheckboxes(true));
    const selNone = document.getElementById('btnSelectNone');
    if (selNone) selNone.addEventListener('click', () => setAllRepoCheckboxes(false));
    $('#btnStartScan').addEventListener('click', () => { setGhToken(ghTokenInput.value.trim()); startScan(); });
    const startAll = document.getElementById('btnStartScanAll');
    if (startAll) startAll.addEventListener('click', () => { setGhToken(ghTokenInput.value.trim()); startScanAll(); });
    $('#btnCancel').addEventListener('click', () => stopLive(true));
    $('#btnClearScanned').addEventListener('click', () => { scannedFiles = []; if (scannedListEl) scannedListEl.innerHTML = ''; setOutput('Cleared scanned files list'); });
    $('#btnDownloadFindings').addEventListener('click', () => {
      const blob = new Blob([JSON.stringify({ findings }, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `findings-${Date.now()}.json`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    });
    const btnPR = document.getElementById('btnCreateCleanPRs');
    if (btnPR) btnPR.addEventListener('click', createCleanPRs);
  }

  window.addEventListener('DOMContentLoaded', function() {
    init();
    setScanUi(false);
  });
})();
