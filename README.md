# AI Tab Organizer (Chrome Extension)

AI Tab Organizer is a Chrome Manifest V3 extension that groups tabs using OpenRouter (`stepfun/step-3.5-flash:free`) and provides a Kanban interface for manual organization.

## Files

- `manifest.json`
- `background.js`
- `utils.js`
- `popup.html`, `popup.js`, `popup.css`
- `kanban.html`, `kanban.js`, `kanban.css`

## Features

- Select which windows are included in AI operations.
- Expand window rows in popup to inspect tabs.
- Save OpenRouter API key in `chrome.storage.local`.
- Generate 3-8 AI-suggested group names from selected tabs.
- Edit/add/remove groups before organizing.
- Organize tabs into chosen groups with AI assignments.
- Optional native Chrome tab grouping sync.
- Kanban board with:
  - Group columns plus `Ungrouped`
  - Drag card to column to reassign
  - Drag column header to window drop zone to move all tabs in that group
  - Double-click column header to toggle filter mode
  - Live updates from storage changes and background refresh messages

## Setup

1. Open Chrome and go to `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this folder.
4. Open extension popup and paste your OpenRouter API key.

## Usage

1. In popup, choose windows to include. If no windows are selected, all windows are used.
2. Add/edit groups manually or click **Generate Groups**.
3. Toggle **Use native Chrome tab groups** if you want browser-native tab groups updated.
4. Click **Organise Tabs** to get AI assignments and apply changes.
5. Click **Open Kanban** for drag-and-drop management.

## OpenRouter Notes

- Endpoint used: `https://openrouter.ai/api/v1/chat/completions`
- Model used: `stepfun/step-3.5-flash:free`
- API key is stored only in local extension storage (`chrome.storage.local`).

## Implementation Notes

- Uses only vanilla JavaScript and Chrome extension APIs.
- Manifest V3 service worker handles all OpenRouter calls and tab operations.
- Assignment synchronization tolerates closed/missing tabs.
- Native grouping is rebuilt from assignment state during apply to keep group titles aligned with configured groups.
