const { EventEmitter } = require('events');
const { GithubClient } = require('./github_client');
const unzipper = require('unzipper');

const DEFAULT_MAX_BYTES = 1024 * 1024; // 1MB per file cap

const DEFAULT_EXCLUDES = [
  '/.git/', '/node_modules/', '/dist/', '/build/', '/coverage/', '/.next/', '/out/', '/vendor/', '/target/', '/bin/', '/obj/', '/Pods/', '/ios/Pods/', '/android/build/'
];

const TEXT_EXTS = new Set([
  'js','jsx','ts','tsx','json','yml','yaml','env','ini','properties','xml','html','css','md','txt','py','rb','go','java','kt','cs','php','rs','c','h','cpp','hpp','sh','bash','zsh','ps1','bat','dockerfile','gradle','sbt','toml','lock','config','tf','tfvars','tsconfig','eslintrc','prettierrc','gitignore','gitattributes'
]);

const SUSPICIOUS_BINARY_EXTS = new Set([
  'exe','dll','scr','pif','com','bat','cmd','vbs','vbe','js','jse','msi','msp','sys','drv','so','dylib','o','obj'
]);

function toLowerExt(p) {
  const m = /\.([A-Za-z0-9_\-]+)$/i.exec(p);
  return m ? m[1].toLowerCase() : '';
}

function isTextPath(p) {
  const name = p.split('/').pop() || '';
  if (name.toLowerCase() === 'dockerfile') return true;
  const ext = toLowerExt(p);
  return TEXT_EXTS.has(ext);
}

function pathExcluded(p, excludes = []) {
  const hay = '/' + p.replace(/\\/g, '/');
  for (const ex of [...DEFAULT_EXCLUDES, ...(excludes || [])]) {
    if (!ex) continue;
    const needle = ex.startsWith('/') ? ex : '/' + ex;
    if (hay.includes(needle)) return true;
  }
  return false;
}

function stripZipTop(p) {
  const parts = p.split('/');
  if (parts.length <= 1) return p;
  return parts.slice(1).join('/');
}

function detectFindings(path, content) {
  const text = content.toString('utf8');
  const rules = [
    { id: 'aws_access_key', re: /AKIA[0-9A-Z]{16}/g },
    { id: 'aws_secret_key', re: /(aws|amazon).{0,20}(secret|sk).{0,20}[:=\s\"\']+([A-Za-z0-9\/+=]{40})/gi },
    { id: 'github_token', re: /(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}/g },
    { id: 'slack_token', re: /xox[baprs]-[A-Za-z0-9-]{10,48}/g },
    { id: 'google_api_key', re: /AIza[0-9A-Za-z\-_]{35}/g },
    { id: 'jwt', re: /eyJ[\w-]+\.[\w-]+\.[\w-]+/g },
    { id: 'private_key_block', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g },
    { id: 'ssh_private_key', re: /BEGIN OPENSSH PRIVATE KEY/g },
    { id: 'heroku_api_key', re: /heroku.{0,20}[:=\s\"\']+[0-9a-fA-F]{32}/gi },
    { id: 'azure_conn_key', re: /(AccountKey|SharedAccessKey|PrimaryKey)\s*=\s*[A-Za-z0-9+/=]{32,}/g },
    { id: 'db_url', re: /(postgres|mysql|mongodb(?:\+srv)?):\/\/[A-Za-z0-9:_@%\-\.]+/gi },
    // Suspicious execution/obfuscation
    { id: 'suspicious_eval', re: /\b(eval|Function)\s*\(/g },
    { id: 'base64_decode_exec', re: /(Buffer\.from\([^)]+'base64'\)|atob\().{0,80}\b(eval|Function)\s*\(/g },
    { id: 'curl_pipe_sh', re: /(curl|wget)[^\n]{0,120}\|\s*(sh|bash)/gi },
    { id: 'powershell_exec', re: /(powershell\.exe|Start-Process|Invoke-WebRequest|IWR|Invoke-Expression)/gi },
    { id: 'cmd_exec', re: /\b(cmd\.exe|\bpowershell\b|\bstart\s+\/?[a-z])/gi },
  ];
  const findings = [];
  for (const { id, re } of rules) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const match = m[0];
      const start = Math.max(0, m.index - 40);
      const end = Math.min(text.length, m.index + match.length + 40);
      const snippet = text.slice(start, end);
      findings.push({ rule: id, path, match, snippet });
      if (findings.length >= 50) return findings; // cap per file
    }
  }
  return findings;
}

class RepoScanJob extends EventEmitter {
  constructor(id, { owner, repos, ghToken, maxBytesPerFile, includePatterns, excludePatterns }) {
    super();
    this.id = String(id);
    this.owner = owner;
    this.repos = repos;
    this.ghToken = ghToken || '';
    this.maxBytes = Number(maxBytesPerFile || DEFAULT_MAX_BYTES);
    this.includes = Array.isArray(includePatterns) ? includePatterns : [];
    this.excludes = Array.isArray(excludePatterns) ? excludePatterns : [];

    this.scanned = 0;
    this.total = 0;
    this.running = false;
    this.cancelled = false;
    this.startedAt = 0;
    this.endedAt = 0;
    this.findings = [];
    this.currentAbort = null;
  }

  snapshot() {
    return {
      id: this.id, owner: this.owner, repos: this.repos, scanned: this.scanned, total: this.total,
      running: this.running, cancelled: this.cancelled, startedAt: this.startedAt, endedAt: this.endedAt,
      findingsCount: this.findings.length,
    };
  }

  cancel() { this.cancelled = true; try { if (this.currentAbort) this.currentAbort.abort(); } catch {} }

  async start() {
    if (this.running) return;
    this.running = true;
    this.startedAt = Date.now();
    this.emit('start', { id: this.id, owner: this.owner, repos: this.repos, at: new Date(this.startedAt).toISOString() });

    const gh = new GithubClient({ token: this.ghToken });

    try {
      // Count files across repos (approximate via tree API)
      let total = 0;
      for (const repo of this.repos) {
        if (this.cancelled) break;
        try {
          const list = await gh.listTree({ owner: this.owner, repo, ref: 'HEAD' });
          const filtered = list.filter(f => {
            const p = f.path;
            if (!p) return false;
            if (pathExcluded(p, this.excludes)) return false;
            if (this.includes.length && !this.includes.some(s => p.includes(s))) return false;
            if (!isTextPath(p)) return false;
            return true;
          });
          total += filtered.length;
        } catch (e) {
          this.emit('warn', { repo, error: String(e && e.message || e) });
        }
      }
      this.total = total;
      this.emit('count', { total: this.total });

      // Scan
      for (const repo of this.repos) {
        if (this.cancelled) break;
        this.emit('repo', { repo });
        let stream;
        try {
          this.currentAbort = new AbortController();
          stream = await gh.fetchArchiveZip({ owner: this.owner, repo, ref: '', signal: this.currentAbort.signal });
        } catch (e) {
          this.emit('warn', { repo, error: String(e && e.message || e) });
          if (this.cancelled) break;
          continue;
        } finally {
          this.currentAbort = null;
        }
        await this._scanZipStream(repo, stream);
        if (this.cancelled) break;
      }

      this.endedAt = Date.now();
      this.running = false;
      this.emit('end', { scanned: this.scanned, total: this.total, ms: this.endedAt - this.startedAt, at: new Date(this.endedAt).toISOString(), cancelled: this.cancelled, findings: this.findings.slice(0, 1000) });
    } catch (e) {
      this.endedAt = Date.now();
      this.running = false;
      this.emit('error', { error: String(e && e.message || e), ms: this.endedAt - this.startedAt });
    }
  }

  async _scanZipStream(repo, stream) {
    const directory = unzipper.Parse();
    const pipeline = stream.pipe(directory);
    try {
      for await (const entry of pipeline) {
        if (this.cancelled) { try { entry.autodrain(); } catch {} break; }
      if (entry.type !== 'File') { entry.autodrain(); continue; }
      let fullPath = stripZipTop(entry.path || '');
      const relPath = fullPath.replace(/\\/g, '/');
      if (!relPath) { entry.autodrain(); continue; }
      const repoPath = `${repo}/${relPath}`;
      if (pathExcluded(repoPath, this.excludes)) { entry.autodrain(); continue; }
      if (this.includes.length && !this.includes.some(s => repoPath.includes(s))) { entry.autodrain(); continue; }
      if (!isTextPath(repoPath)) {
        const ext = toLowerExt(repoPath);
        if (SUSPICIOUS_BINARY_EXTS.has(ext)) {
          const f = { rule: 'suspicious_binary', path: relPath, match: ext, snippet: '' };
          this.findings.push({ ...f, repo });
          this.emit('finding', { ...f, repo });
        }
        entry.autodrain();
        this._bump(repoPath);
        continue;
      }

      // Read up to maxBytes
      let chunks = [];
      let total = 0;
      try {
        for await (const chunk of entry) {
          chunks.push(chunk);
          total += chunk.length;
          if (total >= this.maxBytes) break;
        }
      } catch (e) {
        this.emit('warn', { repo, path: repoPath, error: String(e && e.stack || e) });
        continue;
      } finally {
        try { entry.autodrain(); } catch {}
      }

      const buf = Buffer.concat(chunks, Math.min(total, this.maxBytes));
      this._bump(repoPath);

      try {
        const findings = detectFindings(relPath, buf);
        if (findings && findings.length) {
          for (const f of findings) {
            this.findings.push({ ...f, repo });
            this.emit('finding', { ...f, repo });
          }
        }
      } catch (e) {
        this.emit('warn', { repo, path: repoPath, error: String(e && e.stack || e) });
      }
      }
    } catch (e) {
      if (!this.cancelled) this.emit('warn', { repo, error: String(e && e.stack || e) });
    }
  }

  _bump(path) {
    this.scanned++;
    const percent = this.total > 0 ? Math.min(100, Math.round((this.scanned / this.total) * 100)) : 0;
    this.emit('file', { index: this.scanned, total: this.total, path });
    this.emit('progress', { scanned: this.scanned, total: this.total, percent });
  }
}

class RepoScanManager {
  constructor() {
    this.jobs = new Map();
    this.nextId = 1;
  }
  create(opts) {
    const id = String(this.nextId++);
    const job = new RepoScanJob(id, opts);
    this.jobs.set(id, job);
    job.start();
    return job;
  }
  get(id) { return this.jobs.get(String(id)); }
  cancel(id) { const job = this.get(id); if (job) job.cancel(); return !!job; }
}

module.exports = { RepoScanManager };
