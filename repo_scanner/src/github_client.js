const fetch = require('node-fetch');

const BASE = 'https://api.github.com';

class GithubClient {
  constructor({ token } = {}) {
    this.token = token || '';
    this.headers = {
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'repo-scanner/0.1.0',
    };
    if (this.token) this.headers['Authorization'] = `Bearer ${this.token}`;
  }

  async request(path, { method = 'GET', qs, headers, body } = {}) {
    const url = new URL(path.startsWith('http') ? path : BASE + path);
    if (qs) Object.entries(qs).forEach(([k, v]) => url.searchParams.set(k, String(v)));
    const res = await fetch(url.toString(), {
      method,
      headers: { ...this.headers, ...(headers || {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GitHub ${method} ${url.pathname} -> ${res.status}: ${text}`);
    }
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) return res.json();
    return res.text();
  }

  async getAuthUser() {
    if (!this.token) return null;
    try { return await this.request(`/user`); } catch { return null; }
  }

  async getUser(owner) {
    try { return await this.request(`/users/${encodeURIComponent(owner)}`); }
    catch (e) { return null; }
  }

  async listRepos({ owner, includePrivate = false, perPage = 100, maxPages = 20 }) {
    const user = await this.getUser(owner);
    const auth = await this.getAuthUser();
    const isOrg = user && user.type === 'Organization';
    const isSelf = !!(auth && auth.login && auth.login.toLowerCase() === String(owner).toLowerCase());
    const repos = [];

    if (isOrg) {
      for (let page = 1; page <= maxPages; page++) {
        const data = await this.request(`/orgs/${encodeURIComponent(owner)}/repos`, {
          qs: { per_page: perPage, page, type: includePrivate ? 'all' : 'public' },
        });
        if (!Array.isArray(data) || data.length === 0) break;
        for (const r of data) {
          repos.push({
            name: r.name,
            full_name: r.full_name,
            private: !!r.private,
            default_branch: r.default_branch || 'main',
            archived: !!r.archived,
            fork: !!r.fork,
            size: r.size,
            pushed_at: r.pushed_at,
            language: r.language,
          });
        }
      }
      return repos;
    }

    if (isSelf && includePrivate && this.token) {
      for (let page = 1; page <= maxPages; page++) {
        const data = await this.request(`/user/repos`, {
          qs: { per_page: perPage, page, visibility: 'all', affiliation: 'owner,collaborator,organization_member' },
        });
        if (!Array.isArray(data) || data.length === 0) break;
        for (const r of data) {
          if (r && r.owner && String(r.owner.login).toLowerCase() === String(owner).toLowerCase()) {
            repos.push({
              name: r.name,
              full_name: r.full_name,
              private: !!r.private,
              default_branch: r.default_branch || 'main',
              archived: !!r.archived,
              fork: !!r.fork,
              size: r.size,
              pushed_at: r.pushed_at,
              language: r.language,
            });
          }
        }
      }
      return repos;
    }

    for (let page = 1; page <= maxPages; page++) {
      const data = await this.request(`/users/${encodeURIComponent(owner)}/repos`, {
        qs: { per_page: perPage, page, type: 'public' },
      });
      if (!Array.isArray(data) || data.length === 0) break;
      for (const r of data) {
        repos.push({
          name: r.name,
          full_name: r.full_name,
          private: !!r.private,
          default_branch: r.default_branch || 'main',
          archived: !!r.archived,
          fork: !!r.fork,
          size: r.size,
          pushed_at: r.pushed_at,
          language: r.language,
        });
      }
    }
    return repos;
  }

  async listTree({ owner, repo, ref }) {
    const branch = ref || 'HEAD';
    // Get default branch sha first
    let sha = branch;
    if (branch === 'HEAD') {
      const meta = await this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
      sha = (meta && meta.default_branch) || 'main';
    }
    const data = await this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(sha)}`, { qs: { recursive: 1 } });
    const files = [];
    if (data && Array.isArray(data.tree)) {
      for (const t of data.tree) {
        if (t.type === 'blob') files.push({ path: t.path, size: t.size || 0 });
      }
    }
    return files;
  }

  async fetchArchiveZip({ owner, repo, ref, signal }) {
    const url = `${BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/zipball/${ref || ''}`;
    // Do NOT auto-follow redirects so we can preserve Authorization across origins
    let res = await fetch(url, { headers: this.headers, redirect: 'manual', signal });
    // Handle redirect to codeload (or other host) manually with Authorization header
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new Error(`GitHub zipball redirect without location (${res.status})`);
      res = await fetch(loc, { headers: this.headers, signal });
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GitHub zipball -> ${res.status}: ${text}`);
    }
    return res.body; // Node stream
  }

  async getRepo({ owner, repo }) {
    return this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
  }

  async getRefSha({ owner, repo, branch }) {
    const data = await this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/heads/${encodeURIComponent(branch)}`);
    return data && data.object && data.object.sha;
  }

  async createBranch({ owner, repo, fromBranch, newBranch }) {
    const sha = await this.getRefSha({ owner, repo, branch: fromBranch });
    if (!sha) throw new Error(`Base branch not found: ${fromBranch}`);
    return this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs`, {
      method: 'POST',
      body: { ref: `refs/heads/${newBranch}`, sha },
    });
  }

  async getFile({ owner, repo, path, ref }) {
    const data = await this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodeURIComponent(path)}`, { qs: ref ? { ref } : undefined });
    // When path is a file, API returns an object with sha
    if (Array.isArray(data)) throw new Error('Path is a directory, expected file: ' + path);
    return data; // includes sha, content (base64), path
  }

  async deleteFile({ owner, repo, path, message, sha, branch }) {
    return this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodeURIComponent(path)}`, {
      method: 'DELETE',
      body: { message, sha, branch },
    });
  }

  async createPullRequest({ owner, repo, title, head, base, body }) {
    return this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`, {
      method: 'POST',
      body: { title, head, base, body },
    });
  }
}

module.exports = { GithubClient };
