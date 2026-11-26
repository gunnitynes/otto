# otto

A one-page site where anyone with the link can drag in photos (single files, many at once or whole
folders) or click to pick them. Every photo lands in a **otto** folder in your Google Drive;
uploaded folders keep their structure as subfolders.

- `index.html` — the page (GitHub Pages). `const API` holds the Apps Script web app URL.
- `Code.gs` — the backend (Google Apps Script web app that writes to Drive).

## Setup
1. Go to script.google.com ▸ New project, paste `Code.gs`, save.
2. Pick `setup` in the function menu ▸ Run ▸ allow access. The log shows the Drive folder link.
3. Deploy ▸ New deployment ▸ type **Web app**, Execute as **Me**, Who has access **Anyone** ▸ Deploy.
   Copy the URL ending in `/exec`.
4. Put that URL in `const API` in `index.html`, push to GitHub, turn on Pages (main branch, root).

Limits: photos up to 35 MB each (Apps Script request limit). Non-photo files are skipped (checked by their first bytes on the server too).
Anyone with the page link can upload, so only share it with people you trust.

## Live
- Page: https://gunnitynes.github.io/otto/
- Backend: Apps Script project "otto" on the separate Google account; photos land in its Drive folder "otto".
- After editing Code.gs: Deploy ▸ Manage deployments ▸ Edit ▸ New version (keeps the same URL).
