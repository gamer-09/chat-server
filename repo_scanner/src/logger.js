// Simple structured logger with redaction utilities
const util = require('util');

function redactFinding(f) {
  if (!f || typeof f !== 'object') return f;
  const m = String(f.match || '');
  const snippet = String(f.snippet || '');
  const shortMatch = m.length > 8 ? `${m.slice(0,4)}...${m.slice(-4)}` : (m ? 'REDACTED' : '');
  const shortSnippet = snippet ? (snippet.length > 120 ? `${snippet.slice(0,60)}...${snippet.slice(-60)}` : snippet) : '';
  return { rule: f.rule, path: f.path, match: shortMatch, snippet: shortSnippet, repo: f.repo };
}

function createLogger(name) {
  function write(level, message, meta) {
    const out = { ts: new Date().toISOString(), level, name, message };
    if (meta && typeof meta === 'object') {
      out.meta = meta;
    }
    try { console.log(JSON.stringify(out)); } catch (e) { console.log(out); }
  }
  return {
    info: (message, meta) => write('info', message, meta),
    warn: (message, meta) => write('warn', message, meta),
    error: (message, meta) => write('error', message, meta),
    debug: (message, meta) => write('debug', message, meta),
  };
}

module.exports = { createLogger, redactFinding };
