# Chrome Web Store Listing

## Name
Re-run with Inputs for GitHub Actions

## Short Description (max 132 chars)
Re-run any GitHub Actions workflow with pre-filled inputs from a previous run — modify what you need and trigger in one click.

## Category
Developer Tools

## Detailed Description

**Re-run GitHub Actions workflows with modified inputs — without filling everything from scratch.**

When you need to re-run a workflow with slightly different parameters, GitHub's native UI makes you fill in every field again. This extension adds a **"Re-run with new inputs"** button directly on any Actions run page, pre-fills the form with the exact values from that run, and lets you change only what you need.

---

### How it works

1. Navigate to any GitHub Actions run page
2. Click **"Re-run with new inputs"** (appears next to the existing Re-run button)
3. The form pre-fills with the inputs from that run
4. Modify what you need
5. Click **"Run workflow"** — done

---

### Works on any workflow with `workflow_dispatch` inputs

The extension reads the workflow's YAML to understand the input definitions (types, options, descriptions, defaults) and fetches the actual values used in the previous run. It handles:

- **Direct `workflow_dispatch` runs** — pre-fills from the run's job logs
- **Scheduled / automated runs** — reads the actual parameters passed to the run
- **Reusable workflows** — extracts inputs from the called workflow's output

---

### Setup

A GitHub Personal Access Token (PAT) is required for private repositories:

1. Click the extension icon
2. Enter a PAT with **`repo`** and **`workflow`** scopes
3. Save — that's it

For public repositories no setup is needed.

---

### Privacy

- Your GitHub PAT is stored **locally** in Chrome storage — never sent to any third party
- The extension only communicates with `github.com` and `api.github.com`
- No analytics, no tracking, no external servers

---

### Source code

Open source — available on GitHub.
