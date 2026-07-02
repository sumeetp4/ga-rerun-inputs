const patInput = document.getElementById('pat');
const saveBtn = document.getElementById('save');
const clearBtn = document.getElementById('clear');
const statusEl = document.getElementById('status');
const patStatusEl = document.getElementById('pat-status');
const patStatusIcon = document.getElementById('pat-status-icon');
const patStatusText = document.getElementById('pat-status-text');

function setStatus(msg, type) {
  statusEl.textContent = msg;
  statusEl.className = `status ${type}`;
  if (type !== 'error') setTimeout(() => (statusEl.textContent = ''), 2500);
}

function updatePatStatus(hasPat) {
  if (hasPat) {
    patStatusEl.className = 'pat-status set';
    patStatusIcon.textContent = '✓';
    patStatusText.textContent = 'PAT configured';
    clearBtn.style.display = 'block';
  } else {
    patStatusEl.className = 'pat-status unset';
    patStatusIcon.textContent = '⚠';
    patStatusText.textContent = 'No PAT — using GitHub session (public repos only)';
    clearBtn.style.display = 'none';
  }
}

chrome.storage.local.get('github_pat', data => {
  const hasPat = !!data.github_pat;
  if (hasPat) patInput.value = data.github_pat;
  updatePatStatus(hasPat);
});

saveBtn.addEventListener('click', () => {
  const token = patInput.value.trim();
  if (!token) {
    setStatus('Please enter a token.', 'error');
    return;
  }
  if (!token.startsWith('ghp_') && !token.startsWith('github_pat_')) {
    setStatus('Token looks invalid. Should start with ghp_ or github_pat_', 'error');
    return;
  }
  chrome.storage.local.set({ github_pat: token }, () => {
    updatePatStatus(true);
    setStatus('✓ Token saved!', 'success');
  });
});

clearBtn.addEventListener('click', () => {
  chrome.storage.local.remove('github_pat', () => {
    patInput.value = '';
    updatePatStatus(false);
    setStatus('Token removed.', 'success');
  });
});

patInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') saveBtn.click();
});
