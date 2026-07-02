(function () {
  'use strict';

  function parseGitHubUrl() {
    const match = window.location.pathname.match(/^\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)/);
    if (!match) return null;
    return { owner: match[1], repo: match[2], runId: match[3] };
  }

  async function getToken() {
    const stored = await new Promise(resolve =>
      chrome.storage.local.get('github_pat', d => resolve(d.github_pat || ''))
    );
    return stored ? { token: stored, type: 'pat' } : { token: null, type: null };
  }

  async function apiFetch(url, tokenInfo, options = {}) {
    const headers = {
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2026-03-10',
      ...options.headers,
    };
    if (tokenInfo && tokenInfo.token) {
      headers['Authorization'] = `Bearer ${tokenInfo.token}`;
    }
    const res = await fetch(url, { ...options, headers });
    if (!res.ok) {
      let msg = `GitHub API error ${res.status}`;
      try { const e = await res.json(); msg = e.message || msg; } catch {}
      throw new Error(msg);
    }
    return res.status === 204 ? null : res.json();
  }

  // Route log fetches through background service worker to bypass CORS on redirect URLs
  function fetchViaBackground(url, headers = {}) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action: 'fetchText', url, headers }, res => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else if (res?.ok) resolve(res.text);
        else reject(new Error(res?.error || 'Unknown error'));
      });
    });
  }

  // Fetch YAML using GitHub session (no extra PAT scope needed)
  async function fetchYamlViaSession(owner, repo, branch, workflowPath) {
    const url = `https://github.com/${owner}/${repo}/raw/${branch}/${workflowPath}`;
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching YAML`);
    return res.text();
  }

  // Fetch job logs via background service worker
  function fetchJobLogs(owner, repo, jobId, tokenInfo) {
    return fetchViaBackground(
      `https://api.github.com/repos/${owner}/${repo}/actions/jobs/${jobId}/logs`,
      { 'Authorization': `Bearer ${tokenInfo.token}`, 'Accept': 'application/vnd.github+json' }
    );
  }

  // Parse item_json from claim job logs (queue-based runs)
  function parseItemJsonFromLogs(logText) {
    const clean = logText.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z\s*/g, '');
    let m = clean.match(/\bitem_json=({.+})/);
    if (m) { try { return JSON.parse(m[1]); } catch {} }
    m = clean.match(/::set-output name=item_json::({.+})/);
    if (m) { try { return JSON.parse(m[1]); } catch {} }
    for (const match of clean.matchAll(/({[^{}]{20,}})/g)) {
      if (match[1].includes('"team"')) {
        try { return JSON.parse(match[1]); } catch {}
      }
    }
    return null;
  }

  // Parse aligned "key         : value" lines from a "Print inputs" step in job logs.
  // Filtering to valid keys happens at the call site using definedInputs from the YAML.
  function parseInputsFromPrintStep(logText) {
    const clean = logText.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z\s*/g, '');
    const inputs = {};
    for (const line of clean.split('\n')) {
      const m = line.match(/^(\w[\w_]*)\s{2,}:\s*(.*)$/);
      if (m) inputs[m[1].trim()] = m[2].trim();
    }
    return Object.keys(inputs).length > 0 ? inputs : null;
  }

  // Get actual run values from job logs.
  // Note: GitHub's public REST and GraphQL APIs do not expose workflow_dispatch inputs
  // from previous runs. Job logs are the only reliable source.
  async function getActualRunValues(owner, repo, runId, tokenInfo) {
    try {
      const jobsData = await apiFetch(
        `https://api.github.com/repos/${owner}/${repo}/actions/runs/${runId}/jobs?per_page=50`,
        tokenInfo
      );

      // Source 1: reusable workflow job logs → "Print inputs" step
      const reusableJob = jobsData.jobs.find(j => j.name.includes(' / '));
      if (reusableJob) {
        try {
          const logs = await fetchJobLogs(owner, repo, reusableJob.id, tokenInfo);
          const inputs = parseInputsFromPrintStep(logs);
          if (inputs) return inputs;
        } catch {}
      }

      // Source 2: claim job logs → item_json (queue-based runs)
      const claimJob = jobsData.jobs.find(j => /^claim$/i.test(j.name));
      if (claimJob) {
        try {
          const logs = await fetchJobLogs(owner, repo, claimJob.id, tokenInfo);
          const itemJson = parseItemJsonFromLogs(logs);
          if (itemJson) return itemJson;
        } catch {}
      }

      return null;
    } catch {
      return null;
    }
  }

  // DOM fallback to get workflow file + branch when no PAT is available
  function extractRunInfoFromDOM() {
    let workflowFile = null;
    for (const a of document.querySelectorAll('a[href]')) {
      const m = a.pathname.match(/\/actions\/workflows\/([^/?#]+\.ya?ml)/i);
      if (m) { workflowFile = m[1]; break; }
    }
    let branch = null;
    for (const s of document.querySelectorAll('script[type="application/json"]')) {
      try {
        const text = s.textContent;
        let m = text.match(/"headBranch"\s*:\s*"([^"]+)"/);
        if (m) { branch = m[1]; break; }
        m = text.match(/"head_branch"\s*:\s*"([^"]+)"/);
        if (m) { branch = m[1]; break; }
      } catch {}
    }
    return (workflowFile && branch) ? { workflowFile, branch } : null;
  }

  // Parse workflow_dispatch.inputs from YAML
  function parseWorkflowDispatchInputs(yaml) {
    const inputs = {};
    const lines = yaml.split(/\r?\n/);
    let state = 'scanning';
    let onIndent = -1, wdIndent = -1, inputsIndent = -1;
    let inputIndent = -1, currentInput = null;

    for (const raw of lines) {
      if (!raw.trim() || raw.trim().startsWith('#')) continue;
      const indent = raw.search(/\S/);
      const content = raw.trim();

      if (state === 'scanning') {
        if (content === 'on:' || content.startsWith('on: ') ||
            content === '"on":' || content.startsWith('"on": ')) {
          state = 'in_on'; onIndent = indent;
        }
      } else if (state === 'in_on') {
        if (indent <= onIndent) { state = 'scanning'; continue; }
        if (content === 'workflow_dispatch:' || content.startsWith('workflow_dispatch: ')) {
          state = 'in_workflow_dispatch'; wdIndent = indent;
        }
      } else if (state === 'in_workflow_dispatch') {
        if (indent <= wdIndent) { state = 'scanning'; continue; }
        if (content === 'inputs:') { state = 'in_inputs'; inputsIndent = indent; }
      } else if (state === 'in_inputs') {
        if (indent <= inputsIndent) { state = 'scanning'; continue; }
        if ((inputIndent === -1 || indent === inputIndent) && /^[\w-]+:$/.test(content)) {
          inputIndent = indent;
          currentInput = content.slice(0, -1);
          inputs[currentInput] = '';
          state = 'in_input';
        }
      } else if (state === 'in_input') {
        if (indent > inputIndent) {
          if (currentInput) {
            const dm = content.match(/^default:\s*(.*)$/);
            if (dm) {
              let val = dm[1].trim();
              if (val.length >= 2 &&
                  ((val[0] === '"' && val[val.length - 1] === '"') ||
                   (val[0] === "'" && val[val.length - 1] === "'"))) {
                val = val.slice(1, -1);
              }
              inputs[currentInput] = val;
            }
          }
        } else if (indent === inputIndent && /^[\w-]+:$/.test(content)) {
          currentInput = content.slice(0, -1);
          inputs[currentInput] = '';
        } else if (indent <= inputsIndent) {
          state = 'scanning';
        } else {
          state = 'in_inputs';
        }
      }
    }
    return inputs;
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function buildInputRow(key, value) {
    const div = document.createElement('div');
    div.className = 'gh-rerun-field';
    div.innerHTML = `
      <label>${escapeHtml(key)}</label>
      <input type="text" name="${escapeHtml(key)}" value="${escapeHtml(String(value ?? ''))}" />`;
    return div;
  }

  function showModal({ definedInputs, runInputs, branch, event, yamlFailed, noPat, onConfirm }) {
    document.getElementById('gh-rerun-modal')?.remove();

    const merged = { ...(definedInputs || {}), ...(runInputs || {}) };
    const inputEntries = Object.entries(merged);
    const hasInputs = inputEntries.length > 0;

    let notices = '';
    if (event && event !== 'workflow_dispatch') {
      notices += `<p class="gh-rerun-notice">
        Triggered by <strong>${escapeHtml(event)}</strong> — a new <code>workflow_dispatch</code> run will be created.
      </p>`;
    }
    if (yamlFailed) {
      notices += `<p class="gh-rerun-notice">
        Could not read workflow YAML. Use <strong>+ Add input</strong> to add inputs manually.
      </p>`;
    }
    if (noPat) {
      notices += `<p class="gh-rerun-notice gh-rerun-notice-warn">
        No PAT configured — needed to trigger the run.
        <a href="#" class="gh-rerun-open-popup">Configure PAT ↗</a>
      </p>`;
    }

    const modal = document.createElement('div');
    modal.id = 'gh-rerun-modal';
    modal.innerHTML = `
      <div class="gh-rerun-backdrop"></div>
      <div class="gh-rerun-dialog" role="dialog" aria-modal="true" aria-labelledby="gh-rerun-title">
        <div class="gh-rerun-header">
          <h3 id="gh-rerun-title">Re-run with modified inputs</h3>
          <button class="gh-rerun-close" aria-label="Close">✕</button>
        </div>
        <p class="gh-rerun-ref">Branch: <code>${escapeHtml(branch || 'unknown')}</code></p>
        ${notices}
        <div class="gh-rerun-inputs" id="gh-rerun-inputs-list"></div>
        <button class="gh-rerun-add-field" type="button">+ Add input</button>
        <div class="gh-rerun-actions">
          <button class="gh-rerun-cancel">Cancel</button>
          <button class="gh-rerun-confirm">Run workflow</button>
        </div>
        <p class="gh-rerun-error" style="display:none"></p>
      </div>`;

    document.body.appendChild(modal);

    const inputsList = modal.querySelector('#gh-rerun-inputs-list');
    if (hasInputs) {
      inputEntries.forEach(([k, v]) => inputsList.appendChild(buildInputRow(k, v)));
    } else if (!yamlFailed) {
      inputsList.innerHTML = `<p class="gh-rerun-empty">
        No <code>workflow_dispatch</code> inputs found. Use <strong>+ Add input</strong> to add manually.
      </p>`;
    }

    const confirmBtn = modal.querySelector('.gh-rerun-confirm');
    const errorEl = modal.querySelector('.gh-rerun-error');
    const close = () => modal.remove();

    modal.querySelector('.gh-rerun-backdrop').addEventListener('click', close);
    modal.querySelector('.gh-rerun-cancel').addEventListener('click', close);
    modal.querySelector('.gh-rerun-close').addEventListener('click', close);
    modal.querySelector('.gh-rerun-open-popup')?.addEventListener('click', e => {
      e.preventDefault();
      chrome.runtime.sendMessage({ action: 'openPopup' });
    });
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
    });

    modal.querySelector('.gh-rerun-add-field').addEventListener('click', () => {
      inputsList.querySelector('.gh-rerun-empty')?.remove();
      const row = document.createElement('div');
      row.className = 'gh-rerun-field gh-rerun-manual-field';
      row.innerHTML = `
        <div class="gh-rerun-field-row">
          <input type="text" class="gh-rerun-key" placeholder="input name" />
          <span class="gh-rerun-field-sep">=</span>
          <input type="text" class="gh-rerun-val" placeholder="value" />
          <button class="gh-rerun-remove-field" title="Remove">✕</button>
        </div>`;
      row.querySelector('.gh-rerun-remove-field').addEventListener('click', () => row.remove());
      inputsList.appendChild(row);
      row.querySelector('.gh-rerun-key').focus();
    });

    confirmBtn.addEventListener('click', async () => {
      const newInputs = {};
      inputsList.querySelectorAll('.gh-rerun-field:not(.gh-rerun-manual-field) input').forEach(inp => {
        newInputs[inp.name] = inp.value;
      });
      inputsList.querySelectorAll('.gh-rerun-manual-field').forEach(row => {
        const key = row.querySelector('.gh-rerun-key').value.trim();
        const val = row.querySelector('.gh-rerun-val').value;
        if (key) newInputs[key] = val;
      });

      confirmBtn.disabled = true;
      confirmBtn.textContent = 'Running…';
      errorEl.style.display = 'none';

      try {
        await onConfirm(newInputs);
        confirmBtn.textContent = '✓ Queued!';
        confirmBtn.classList.add('gh-rerun-success');
        setTimeout(close, 1800);
      } catch (e) {
        confirmBtn.disabled = false;
        confirmBtn.textContent = 'Run workflow';
        errorEl.textContent = e.message;
        errorEl.style.display = 'block';
      }
    });
  }

  function findRerunButton() {
    return [...document.querySelectorAll('button')].find(
      btn => /re-?run/i.test(btn.textContent.trim()) && btn.offsetParent !== null
    );
  }

  function injectButton(urlInfo) {
    if (document.getElementById('gh-rerun-btn')) return;
    const rerunBtn = findRerunButton();
    if (!rerunBtn) return;

    const btn = document.createElement('button');
    btn.id = 'gh-rerun-btn';
    btn.className = 'gh-rerun-trigger-btn';
    btn.title = 'Re-run this workflow with different inputs';
    btn.innerHTML = rerunIcon() + ' Re-run with new inputs';

    btn.addEventListener('click', async () => {
      const tokenInfo = await getToken();
      btn.disabled = true;
      btn.innerHTML = `<span class="gh-rerun-spinner"></span> Loading…`;

      try {
        // ── Step 1: get run metadata ────────────────────────────────────────
        let runMeta = null;

        if (tokenInfo.token) {
          try {
            const run = await apiFetch(
              `https://api.github.com/repos/${urlInfo.owner}/${urlInfo.repo}/actions/runs/${urlInfo.runId}`,
              tokenInfo
            );
            runMeta = {
              workflowId: run.workflow_id,
              workflowFile: null,
              branch: run.head_branch,
              event: run.event,
              runInputs: run.inputs || {},
            };
          } catch {}
        }

        if (!runMeta) {
          const dom = extractRunInfoFromDOM();
          if (dom) {
            runMeta = { workflowId: null, workflowFile: dom.workflowFile,
                        branch: dom.branch, event: 'workflow_dispatch', runInputs: {} };
          } else {
            alert('Could not determine workflow info. Please configure a PAT via the extension icon.');
            return;
          }
        }

        // ── Step 2: get workflow file path ──────────────────────────────────
        let workflowPath = null;
        if (runMeta.workflowFile) {
          workflowPath = `.github/workflows/${runMeta.workflowFile}`;
        } else if (runMeta.workflowId && tokenInfo.token) {
          try {
            const wf = await apiFetch(
              `https://api.github.com/repos/${urlInfo.owner}/${urlInfo.repo}/actions/workflows/${runMeta.workflowId}`,
              tokenInfo
            );
            workflowPath = wf.path;
            runMeta.workflowFile = workflowPath.split('/').pop();
          } catch {}
        }

        // ── Step 3: fetch YAML for input definitions + defaults ─────────────
        let definedInputs = null;
        let yamlFailed = false;
        if (workflowPath && runMeta.branch) {
          try {
            const yaml = await fetchYamlViaSession(urlInfo.owner, urlInfo.repo, runMeta.branch, workflowPath);
            definedInputs = parseWorkflowDispatchInputs(yaml);
          } catch {
            yamlFailed = true;
          }
        } else {
          yamlFailed = true;
        }

        // ── Step 4: get actual run values from job logs ─────────────────────
        // GitHub does not expose workflow_dispatch inputs through any public API
        // (REST, GraphQL, or internal endpoints). Job logs are the only source.
        if (tokenInfo.token) {
          const rawValues = await getActualRunValues(urlInfo.owner, urlInfo.repo, urlInfo.runId, tokenInfo);
          if (rawValues) {
            const validKeys = new Set(Object.keys(definedInputs || {}));
            runMeta.runInputs = validKeys.size
              ? Object.fromEntries(Object.entries(rawValues).filter(([k]) => validKeys.has(k)))
              : rawValues;
          }
        }

        // ── Step 5: show modal ──────────────────────────────────────────────
        const workflowIdOrFile = runMeta.workflowFile || String(runMeta.workflowId);

        showModal({
          definedInputs,
          runInputs: runMeta.runInputs,
          branch: runMeta.branch,
          event: runMeta.event,
          yamlFailed,
          noPat: !tokenInfo.token,
          onConfirm: async (newInputs) => {
            const dispatchToken = await getToken();
            if (!dispatchToken.token) {
              throw new Error('A GitHub PAT is required. Click the extension icon to add one.');
            }
            await apiFetch(
              `https://api.github.com/repos/${urlInfo.owner}/${urlInfo.repo}/actions/workflows/${workflowIdOrFile}/dispatches`,
              dispatchToken,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ref: runMeta.branch, inputs: newInputs }),
              }
            );
          },
        });

      } catch (e) {
        alert(`Error: ${e.message}`);
      } finally {
        btn.disabled = false;
        btn.innerHTML = rerunIcon() + ' Re-run with new inputs';
      }
    });

    rerunBtn.before(btn);
  }

  function rerunIcon() {
    return `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 2.5a5.487 5.487 0 0 0-4.131 1.869l1.204 1.204A.25.25 0 0 1 4.896 6H1.25A.25.25 0 0 1 1 5.75V2.104a.25.25 0 0 1 .427-.177l1.38 1.38A7.001 7.001 0 0 1 14.95 7.16a.75.75 0 0 1-1.49.178A5.501 5.501 0 0 0 8 2.5ZM1.705 8.005a.75.75 0 0 1 .834.656 5.501 5.501 0 0 0 9.592 2.97l-1.204-1.204a.25.25 0 0 1 .177-.427h3.646a.25.25 0 0 1 .25.25v3.646a.25.25 0 0 1-.427.177l-1.38-1.38A7.001 7.001 0 0 1 1.05 8.84a.75.75 0 0 1 .656-.834Z"/>
    </svg>`;
  }

  function init() {
    const urlInfo = parseGitHubUrl();
    if (!urlInfo) return;
    injectButton(urlInfo);
    const observer = new MutationObserver(() => injectButton(urlInfo));
    observer.observe(document.body, { childList: true, subtree: true });
  }

  document.addEventListener('turbo:load', () => {
    document.getElementById('gh-rerun-btn')?.remove();
    init();
  });

  init();
})();
