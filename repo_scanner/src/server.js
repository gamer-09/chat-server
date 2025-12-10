const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const cors = require('cors');
const path = require('path');
const dotenv = require('dotenv');
const readline = require('readline');
const { RepoScanManager } = require('./scan_manager');
const { GithubClient } = require('./github_client');
const { Server } = require('socket.io');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const app = express();
// Disable ETag to prevent 304 Not Modified on JSON APIs (polling)
app.set('etag', false);
const PORT = Number(process.env.PORT || 4000);
const HOST = process.env.HOST || '127.0.0.1';
const HEALTH_CACHE_MS = Number(process.env.HEALTH_CACHE_MS || 15000);

let lastHealth = null;
let lastHealthAt = 0;
let httpServer = null;

let AUTH_TOKEN = process.env.AUTH_TOKEN || '';
if (!AUTH_TOKEN) {
  AUTH_TOKEN = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  console.log('AUTH_TOKEN=', AUTH_TOKEN);
}

app.use(helmet());
app.use(cors({ origin: [/^http:\/\/localhost(:\d+)?$/, /^http:\/\/127\.0\.0\.1(:\d+)?$/], methods: ['GET','POST'], allowedHeaders: ['Content-Type','x-auth-token'] }));
app.use(express.json({ limit: '1mb' }));
app.use(morgan('dev'));

app.get('/', (req, res) => res.redirect('/ui'));
app.use('/ui', express.static(path.join(__dirname, '..', 'public')));
app.get('/ui', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

function requireAuth(req, res, next) {
  const token = req.headers['x-auth-token'] || req.query.token;
  if (!token || token !== AUTH_TOKEN) return res.status(401).json({ ok: false, error: 'unauthorized' });
  next();
}

// Health
app.get('/health', (req, res) => {
  const now = Date.now();
  if (lastHealth && now - lastHealthAt < HEALTH_CACHE_MS) return res.json(lastHealth);
  lastHealth = { ok: true, name: 'repo_scanner', version: '0.1.0' };
  lastHealthAt = now;
  res.json(lastHealth);
});

// List GitHub repositories for an owner (user or org). Public without ghToken; private requires ghToken from caller.
app.post('/github/repos', requireAuth, async (req, res) => {
  try {
    const { owner, includePrivate = false, ghToken } = req.body || {};
    if (!owner || typeof owner !== 'string') return res.status(400).json({ ok: false, error: 'owner required' });
    const client = new GithubClient({ token: ghToken });
    const repos = await client.listRepos({ owner, includePrivate: !!includePrivate });
    res.json({ ok: true, repos });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e && e.message || e) });
  }
});

// Start scan job over selected repos
const scanManager = new RepoScanManager();

app.post('/scan/start', requireAuth, async (req, res) => {
  try {
    const { owner, repos, ghToken, maxBytesPerFile, includePatterns, excludePatterns } = req.body || {};
    if (!owner || !Array.isArray(repos) || repos.length === 0) {
      return res.status(400).json({ ok: false, error: 'owner and non-empty repos[] required' });
    }
    const job = scanManager.create({ owner, repos, ghToken, maxBytesPerFile, includePatterns, excludePatterns });
    // Log job events to server console for debugging
    ['start','repo','count','file','finding','progress','warn','error','end'].forEach(ev => {
      job.on(ev, (data) => {
        try { console.log(`JOB ${job.id} ${ev}:`, typeof data === 'string' ? data : JSON.stringify(data)); } catch (e) { console.log(`JOB ${job.id} ${ev}:`, data); }
      });
    });
    res.json({ ok: true, jobId: job.id });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e && e.message || e) });
  }
});

app.get('/scan/jobs/:id/status', requireAuth, (req, res) => {
  const job = scanManager.get(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: 'job not found' });
  // Ensure clients never cache this response
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.json({ ok: true, status: job.snapshot() });
});

app.get('/scan/jobs/:id/stream', requireAuth, (req, res) => {
  const job = scanManager.get(req.params.id);
  if (!job) return res.status(404).end();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders && res.flushHeaders();

  const send = (event, data) => {
    try { res.write(`event: ${event}\n`); res.write(`data: ${JSON.stringify(data)}\n\n`); } catch {}
  };

  const onStart = (ev) => send('start', ev);
  const onRepo = (ev) => send('repo', ev);
  const onCount = (ev) => send('count', ev);
  const onFile = (ev) => send('file', ev);
  const onFinding = (ev) => send('finding', ev);
  const onProgress = (ev) => send('progress', ev);
  const onWarn = (ev) => send('warn', ev);
  const onError = (ev) => send('error', ev);
  const onEnd = (ev) => { send('end', ev); cleanup(); try { res.end(); } catch {} };

  const cleanup = () => {
    job.off('start', onStart);
    job.off('repo', onRepo);
    job.off('count', onCount);
    job.off('file', onFile);
    job.off('finding', onFinding);
    job.off('progress', onProgress);
    job.off('warn', onWarn);
    job.off('error', onError);
    job.off('end', onEnd);
    clearInterval(keepAlive);
  };

  job.on('start', onStart);
  job.on('repo', onRepo);
  job.on('count', onCount);
  job.on('file', onFile);
  job.on('finding', onFinding);
  job.on('progress', onProgress);
  job.on('warn', onWarn);
  job.on('error', onError);
  job.on('end', onEnd);

  const keepAlive = setInterval(() => { send('ping', { t: Date.now() }); }, 15000);
  req.on('close', cleanup);
});

app.post('/scan/jobs/:id/cancel', requireAuth, (req, res) => {
  const ok = scanManager.cancel(req.params.id);
  res.json({ ok });
});

// Create PRs to clean suspicious binaries across multiple repos
app.post('/github/clean/pr', requireAuth, async (req, res) => {
  try {
    const { owner, ghToken, targets } = req.body || {};
    if (!owner || !ghToken) return res.status(400).json({ ok: false, error: 'owner and ghToken are required' });
    if (!Array.isArray(targets) || targets.length === 0) return res.status(400).json({ ok: false, error: 'targets[] required' });

    // Group by repo and only keep suspicious_binary
    const byRepo = new Map();
    for (const t of targets) {
      if (!t || !t.repo || !t.path) continue;
      if (t.rule && t.rule !== 'suspicious_binary') continue;
      if (!byRepo.has(t.repo)) byRepo.set(t.repo, new Set());
      byRepo.get(t.repo).add(String(t.path));
    }

    const client = new GithubClient({ token: ghToken });
    const summary = [];
    for (const [repo, pathSet] of byRepo.entries()) {
      const files = Array.from(pathSet);
      if (!files.length) continue;
      const result = await createCleanPRForRepo({ client, owner, repo, files });
      summary.push(result);
    }
    res.json({ ok: true, summary });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e && e.message || e) });
  }
});

async function createCleanPRForRepo({ client, owner, repo, files }) {
  const meta = await client.getRepo({ owner, repo });
  const base = (meta && meta.default_branch) || 'main';
  const newBranch = `security/cleanup-${Date.now()}`;
  let branchCreated = false;
  let pr = null;
  const deleted = [];
  const skipped = [];
  const errors = [];
  try {
    await client.createBranch({ owner, repo, fromBranch: base, newBranch });
    branchCreated = true;
  } catch (e) {
    errors.push(`createBranch: ${String(e && e.message || e)}`);
    // If branch exists, proceed; otherwise fail
  }
  for (const p of files) {
    try {
      const file = await client.getFile({ owner, repo, path: p, ref: newBranch });
      if (!file || !file.sha) { skipped.push(p); continue; }
      await client.deleteFile({ owner, repo, path: p, message: `chore(security): remove suspicious binary ${p}`, sha: file.sha, branch: newBranch });
      deleted.push(p);
    } catch (e) {
      errors.push(`delete ${p}: ${String(e && e.message || e)}`);
    }
  }
  if (deleted.length) {
    try {
      pr = await client.createPullRequest({ owner, repo, title: 'Security cleanup: remove suspicious binaries', head: newBranch, base, body: `This automated PR removes ${deleted.length} suspicious binary file(s):\n\n` + deleted.map(x => `- ${x}`).join('\n') });
    } catch (e) {
      errors.push(`createPR: ${String(e && e.message || e)}`);
    }
  }
  return { repo, base, branch: newBranch, branchCreated, deletedCount: deleted.length, skippedCount: skipped.length, errors, prUrl: pr && pr.html_url };
}

function listen() {
  httpServer = app.listen(PORT, HOST, () => {
    console.log(`repo_scanner listening on http://${HOST}:${PORT}`);
    const io = new Server(httpServer);
    io.on('connection', (socket) => {
      console.log('a user connected');
      socket.on('disconnect', () => {
        console.log('user disconnected');
      });
    });
  });
  httpServer.on('error', (err) => {
    console.error('Failed to start server:', err);
  });
}

function confirmAndStart() {
  const val = String(process.env.SERVER_CONFIRM || '').trim().toLowerCase();
  if (val) {
    if (['y', 'yes', '1', 'true'].includes(val)) return listen();
    if (['n', 'no', '0', 'false'].includes(val)) {
      console.log('repo_scanner start canceled by SERVER_CONFIRM');
      process.exit(0);
      return;
    }
  }

  if (!process.stdin.isTTY) {
    console.log('Awaiting confirmation but no TTY detected. Set SERVER_CONFIRM=yes to start, or no to cancel.');
    process.exit(0);
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(`Start repo_scanner on http://${HOST}:${PORT}? [y/N]: `, (ans) => {
    rl.close();
    const a = String(ans || '').trim().toLowerCase();
    if (a === 'y' || a === 'yes') listen();
    else {
      console.log('repo_scanner start canceled.');
      process.exit(0);
    }
  });
}

confirmAndStart();

// ---- Termination confirmation ----
let terminating = false;
function shutdownNow() {
  if (terminating) return;
  terminating = true;
  try { httpServer && httpServer.close && httpServer.close(() => process.exit(0)); } catch { process.exit(0); }
}

function confirmTerminate(signal) {
  if (terminating) return;
  const val = String(process.env.SERVER_TERMINATE_CONFIRM || '').trim().toLowerCase();
  const keepRunning = ['y', 'yes', '1', 'true'].includes(val);
  const shouldShutdown = ['n', 'no', '0', 'false'].includes(val);
  if (val) {
    if (keepRunning) { console.log(`Termination (${signal}) canceled by SERVER_TERMINATE_CONFIRM`); return; }
    if (shouldShutdown) { console.log(`Shutting down on ${signal} (SERVER_TERMINATE_CONFIRM=no)`); return shutdownNow(); }
  }
  if (!process.stdin.isTTY) {
    console.log(`Received ${signal}. No TTY for confirmation. Set SERVER_TERMINATE_CONFIRM=yes to keep running, or no to shutdown. Defaulting to shutdown.`);
    return shutdownNow();
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question('Keep server running? [y/N]: ', (ans) => {
    rl.close();
    const a = String(ans || '').trim().toLowerCase();
    if (a === 'y' || a === 'yes') {
      console.log('Termination canceled. Continuing to run.');
    } else {
      console.log('Shutting down...');
      shutdownNow();
    }
  });
}

process.on('SIGINT', () => confirmTerminate('SIGINT'));
process.on('SIGTERM', () => confirmTerminate('SIGTERM'));
