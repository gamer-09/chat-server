const statusEl = document.getElementById('status');
const apiKeyInput = document.getElementById('apiKeyInput');
const saveKeyBtn = document.getElementById('saveKeyBtn');
const keySavedMsg = document.getElementById('keySavedMsg');
const serviceSelect = document.getElementById('serviceSelect');
const methodSelect = document.getElementById('methodSelect');
const pathInput = document.getElementById('pathInput');
const bodyInput = document.getElementById('bodyInput');
const sendBtn = document.getElementById('sendBtn');
const requestMeta = document.getElementById('requestMeta');
const responseOutput = document.getElementById('responseOutput');

const helpBtn = document.getElementById('helpBtn');
const helpOverlay = document.getElementById('helpOverlay');
const closeHelpBtn = document.getElementById('closeHelpBtn');

const STORAGE_KEY = 'hhu87_api_key';

function loadStoredApiKey() {
  try {
    return localStorage.getItem(STORAGE_KEY) || '';
  } catch (e) {
    return '';
  }
}

function saveStoredApiKey(value) {
  try {
    localStorage.setItem(STORAGE_KEY, value || '');
  } catch (e) {
    // ignore storage errors
  }
}

async function loadGatewayInfo() {
  try {
    const res = await fetch('/');
    const data = await res.json();

    const portInfo = data && data.port ? `port ${data.port}` : '';
    const services = Array.isArray(data.services) ? data.services : [];

    const parts = [];
    if (data && data.message) {
      parts.push(data.message);
    }
    if (portInfo) {
      parts.push(`(${portInfo})`);
    }
    if (services.length > 0) {
      parts.push(`· ${services.length} service(s) configured`);
    }

    statusEl.textContent = parts.join(' ');
    updateServicesList(services);
  } catch (err) {
    statusEl.textContent = 'Failed to load gateway info';
  }
}

function updateServicesList(services) {
  while (serviceSelect.firstChild) {
    serviceSelect.removeChild(serviceSelect.firstChild);
  }

  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = '-- select service --';
  serviceSelect.appendChild(placeholder);

  services.forEach((svc) => {
    if (!svc || !svc.name) return;
    const opt = document.createElement('option');
    opt.value = svc.name;
    opt.textContent = svc.url ? `${svc.name} (${svc.url})` : svc.name;
    serviceSelect.appendChild(opt);
  });
}

function showKeySavedMessage() {
  keySavedMsg.textContent = 'Key saved locally';
  setTimeout(() => {
    keySavedMsg.textContent = '';
  }, 1500);
}

async function sendRequest() {
  const service = (serviceSelect.value || '').trim();
  const method = (methodSelect.value || 'GET').toUpperCase();
  const rawPath = (pathInput.value || '').trim();
  const apiKey = (apiKeyInput.value || '').trim();

  if (!service) {
    responseOutput.textContent = 'Please select a service.';
    return;
  }

  let path = rawPath || '/';
  if (!path.startsWith('/')) {
    path = '/' + path;
  }

  const url = `/api/${encodeURIComponent(service)}${path}`;

  const options = {
    method,
    headers: {
      Accept: 'application/json, text/plain, */*',
    },
  };

  if (apiKey) {
    options.headers.Authorization = `Bearer ${apiKey}`;
  }

  const methodAllowsBody = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);

  if (methodAllowsBody) {
    const bodyText = (bodyInput.value || '').trim();
    if (bodyText) {
      try {
        const parsed = JSON.parse(bodyText);
        options.headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(parsed);
      } catch (err) {
        responseOutput.textContent = 'Request body is not valid JSON: ' + err.message;
        return;
      }
    }
  }

  sendBtn.disabled = true;
  requestMeta.textContent = 'Sending...';
  responseOutput.textContent = '';

  const start = performance.now();

  try {
    const res = await fetch(url, options);
    const elapsed = performance.now() - start;

    const meta = [];
    meta.push(`${res.status} ${res.statusText || ''}`.trim());
    meta.push(`${elapsed.toFixed(0)} ms`);
    meta.push(url);

    requestMeta.textContent = meta.join(' · ');

    const text = await res.text();
    try {
      const json = JSON.parse(text);
      responseOutput.textContent = JSON.stringify(json, null, 2);
    } catch (e) {
      responseOutput.textContent = text || '[empty response]';
    }
  } catch (err) {
    requestMeta.textContent = 'Request failed';
    responseOutput.textContent = String(err);
  } finally {
    sendBtn.disabled = false;
  }
}

function openHelp() {
  if (!helpOverlay) return;
  helpOverlay.classList.add('help-visible');
}

function closeHelp() {
  if (!helpOverlay) return;
  helpOverlay.classList.remove('help-visible');
}

function initHelp() {
  if (helpBtn) {
    helpBtn.addEventListener('click', () => {
      openHelp();
    });
  }

  if (closeHelpBtn) {
    closeHelpBtn.addEventListener('click', () => {
      closeHelp();
    });
  }

  if (helpOverlay) {
    helpOverlay.addEventListener('click', (evt) => {
      if (evt.target === helpOverlay) {
        closeHelp();
      }
    });
  }

  document.addEventListener('keydown', (evt) => {
    if (evt.key === 'Escape') {
      closeHelp();
    }
  });
}

function init() {
  apiKeyInput.value = loadStoredApiKey();

  saveKeyBtn.addEventListener('click', () => {
    saveStoredApiKey(apiKeyInput.value.trim());
    showKeySavedMessage();
  });

  sendBtn.addEventListener('click', () => {
    sendRequest();
  });

  initHelp();
  loadGatewayInfo();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
