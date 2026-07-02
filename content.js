(function () {
  'use strict';

  function parseGitHubUrl() {
    const match = window.location.pathname.match(/^\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)/);
    if (!match) return null;
    return { owner: match[1], repo: match[2], runId: match[3] };
  }

  async function getToken() {
    // 1. Try PAT from storage first (user preference)
    const stored = await new Promise(resolve =>
      chrome.storage.local.get('github_pat', d => resolve(d.github_pat || ''))
    );
    if (stored) return { token: stored, type: 'pat' };

    // 2. Fall back to GitHub session token from the page
    const metaToken = document.querySelector('meta[name="user-csrf-token"]')?.content
      || window.__gitHubToken
      || null;
    if (metaToken) return { token: metaToken, type: 'session' };

    return { token: null, type: null };
  }

  async function apiFetch(url, tokenInfo, options = {}) {
    const headers = {
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...options.headers,
    };

    if (tokenInfo.type === 'pat') {
      headers['Authorization'] = `Bearer ${tokenInfo.token}`;
    }

    const res = await fetch(url, {
      ...options,
      credentials: tokenInfo.type === 'session' ? 'include' : 'omit',
      headers,
    });

    if (!res.ok) {
      let msg = `GitHub API error ${res.status}`;
      try {
        const e = await res.json();
        msg = e.message || msg;
      } catch {}
      throw new Error(msg);
    }

    return res.status === 204 ? null : res.json();
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function showModal(runInputs, ref, event, onConfirm) {
    document.getElementById('gh-rerun-modal')?.remove();

    const inputEntries = Object.entries(runInputs || {});
    const hasInputs = inputEntries.length > 0;
    const isDispatch = event === 'workflow_dispatch';

    let notice = '';
    if (!isDispatch) {
      notice = `<p class="gh-rerun-notice">
        This run was triggered by <strong>${escapeHtml(event)}</strong>, not workflow_dispatch.
        You can still dispatch a new run below if the workflow supports it.
      </p>`;
    }

    const inputsHtml = hasInputs
      ? inputEntries.map(([key, value]) => `
          <div class="gh-rerun-field">
            <label for="gh-input-${escapeHtml(key)}">${escapeHtml(key)}</label>
            <input
              type="text"
              id="gh-input-${escapeHtml(key)}"
              name="${escapeHtml(key)}"
              value="${escapeHtml(String(value ?? ''))}"
            />
          </div>
        `).join('')
      : '<p class="gh-rerun-empty">No inputs found for this run. The workflow may not define any <code>workflow_dispatch</code> inputs.</p>';

    const modal = document.createElement('div');
    modal.id = 'gh-rerun-modal';
    modal.innerHTML = `
      <div class="gh-rerun-backdrop"></div>
      <div class="gh-rerun-dialog" role="dialog" aria-modal="true" aria-labelledby="gh-rerun-title">
        <div class="gh-rerun-header">
          <h3 id="gh-rerun-title">Re-run with modified inputs</h3>
          <button class="gh-rerun-close" aria-label="Close">✕</button>
        </div>
        <p class="gh-rerun-ref">Branch: <code>${escapeHtml(ref)}</code></p>
        ${notice}
        <div class="gh-rerun-inputs">${inputsHtml}</div>
        <div class="gh-rerun-actions">
          <button class="gh-rerun-cancel">Cancel</button>
          <button class="gh-rerun-confirm">Run workflow</button>
        </div>
        <p class="gh-rerun-error" style="display:none"></p>
      </div>
    `;

    document.body.appendChild(modal);

    const confirmBtn = modal.querySelector('.gh-rerun-confirm');
    const errorEl = modal.querySelector('.gh-rerun-error');

    const close = () => modal.remove();
    modal.querySelector('.gh-rerun-backdrop').addEventListener('click', close);
    modal.querySelector('.gh-rerun-cancel').addEventListener('click', close);
    modal.querySelector('.gh-rerun-close').addEventListener('click', close);

    document.addEventListener('keydown', function onKeyDown(e) {
      if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKeyDown); }
    });

    confirmBtn.addEventListener('click', async () => {
      const newInputs = {};
      modal.querySelectorAll('.gh-rerun-field input').forEach(input => {
        newInputs[input.name] = input.value;
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
    btn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
        <path d="M8 2.5a5.487 5.487 0 0 0-4.131 1.869l1.204 1.204A.25.25 0 0 1 4.896 6H1.25A.25.25 0 0 1 1 5.75V2.104a.25.25 0 0 1 .427-.177l1.38 1.38A7.001 7.001 0 0 1 14.95 7.16a.75.75 0 0 1-1.49.178A5.501 5.501 0 0 0 8 2.5ZM1.705 8.005a.75.75 0 0 1 .834.656 5.501 5.501 0 0 0 9.592 2.97l-1.204-1.204a.25.25 0 0 1 .177-.427h3.646a.25.25 0 0 1 .25.25v3.646a.25.25 0 0 1-.427.177l-1.38-1.38A7.001 7.001 0 0 1 1.05 8.84a.75.75 0 0 1 .656-.834Z"/>
      </svg>
      Re-run with new inputs
    `;

    btn.addEventListener('click', async () => {
      const tokenInfo = await getToken();
      if (!tokenInfo.token) {
        alert('No auth found. Click the extension icon to set a GitHub PAT.');
        return;
      }

      btn.disabled = true;
      btn.innerHTML = `<span class="gh-rerun-spinner"></span> Loading…`;

      try {
        const run = await apiFetch(
          `https://api.github.com/repos/${urlInfo.owner}/${urlInfo.repo}/actions/runs/${urlInfo.runId}`,
          tokenInfo
        );

        showModal(run.inputs || {}, run.head_branch, run.event, async (newInputs) => {
          await apiFetch(
            `https://api.github.com/repos/${urlInfo.owner}/${urlInfo.repo}/actions/workflows/${run.workflow_id}/dispatches`,
            tokenInfo,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ ref: run.head_branch, inputs: newInputs }),
            }
          );
        });
      } catch (e) {
        alert(`Error: ${e.message}`);
      } finally {
        btn.disabled = false;
        btn.innerHTML = `
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 2.5a5.487 5.487 0 0 0-4.131 1.869l1.204 1.204A.25.25 0 0 1 4.896 6H1.25A.25.25 0 0 1 1 5.75V2.104a.25.25 0 0 1 .427-.177l1.38 1.38A7.001 7.001 0 0 1 14.95 7.16a.75.75 0 0 1-1.49.178A5.501 5.501 0 0 0 8 2.5ZM1.705 8.005a.75.75 0 0 1 .834.656 5.501 5.501 0 0 0 9.592 2.97l-1.204-1.204a.25.25 0 0 1 .177-.427h3.646a.25.25 0 0 1 .25.25v3.646a.25.25 0 0 1-.427.177l-1.38-1.38A7.001 7.001 0 0 1 1.05 8.84a.75.75 0 0 1 .656-.834Z"/>
          </svg>
          Re-run with new inputs
        `;
      }
    });

    rerunBtn.before(btn);
  }

  function init() {
    const urlInfo = parseGitHubUrl();
    if (!urlInfo) return;

    injectButton(urlInfo);

    const observer = new MutationObserver(() => injectButton(urlInfo));
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // Handle GitHub's SPA navigation
  document.addEventListener('turbo:load', () => {
    document.getElementById('gh-rerun-btn')?.remove();
    init();
  });

  init();
})();
