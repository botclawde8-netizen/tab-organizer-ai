# AI Tab Organizer - Chrome Extension Build Prompt

## Overview
Build a Chrome extension (Manifest V3) that uses OpenRouter’s `stepfun/step-3.5-flash:free` model to organize browser tabs into user-defined or AI-generated groups. The extension provides a popup for configuration and a full-page Kanban board for visual management. It supports native Chrome tab groups (optional) and allows moving groups between windows.

---

## Key Features

### 1. Popup (`popup.html`/`popup.js`/`popup.css`)
- **Window selection**:
  - List all Chrome windows (id, title, tabs count).
  - Checkbox to include/exclude a window’s tabs in AI operations.
  - Expandable (▶) to show each tab in that window with its favicon and title.
- **Settings**:
  - Toggle checkbox: “Use native Chrome tab groups”. When unchecked, categories are only shown in the Kanban UI without affecting Chrome’s groups.
- **Group management**:
  - A container showing current group names as a list:
    * Each row: text input (value=group name) + delete (×) button.
    * “Add group” button adds a new empty input row.
  - The list reflects the working set of groups; user can edit, add, remove.
- **Buttons**:
  - **Generate Groups**:
    * Fetches all tabs from the *selected* windows.
    * Calls OpenRouter to propose meaningful group names (3–8) based on those tabs.
    * Updates the group list in the popup with suggestions. No Chrome changes yet.
  - **Organise Tabs**:
    * Uses the *current* group list (after any edits).
    * Calls OpenRouter to assign each tab (from selected windows) to one of the groups.
    * Applies assignments:
      - If “native groups” is enabled: for each group, ensure a Chrome tab group exists (create if needed), then move/group tabs accordingly. Ungroup tabs not assigned.
      - If disabled: only update local assignments; Kanban reflects changes.
    * Sends a message to any open Kanban page to refresh.
  - **Open Kanban**: opens `kanban.html` in a new tab.
- **API Key storage**: Store the user’s OpenRouter API key in `chrome.storage.local` (set via a simple options page or first-run prompt). The extension reads it for all API calls.

### 2. Kanban Board (`kanban.html`/`kanban.js`/`kanban.css`)
- Single-page app showing all tabs from *selected* windows (as stored in `selectedWindowIds`). If nothing selected, show all windows.
- **Layout**: One column per group (plus “Ungrouped” for tabs with no assignment). Columns are draggable drop zones.
- **Tab cards**: draggable cards within columns. Each card displays:
  - Favicon (if any), title truncated (max 3 lines), and a small badge with its window name.
- **Drag & Drop**:
  - **Card → Column**: changes the tab’s assignment to that group. If native groups are on, immediately call background to move the tab to that group in its current window.
  - **Column → Window drop zone**: a sidebar lists windows (by name/id). Drag a column header onto a window to move *all* tabs of that group to the target window (and if native groups, create/retain group in that window).
  - **Double-click column**: toggles filter mode – only tabs of that group are visible; double-click again restores all.
- **Live updates**: listens to `chrome.storage.onChanged` to refresh assignments and group list. Also listens for messages from background to refresh tab data.

### 3. Background Service Worker (`background.js`)
- Handles OpenRouter API calls and tab operations.
- **Storage defaults** on install:
  ```js
  {
    groups: [],              // list of group names (strings)
    assignments: {},         // { tabId: groupName }
    selectedWindowIds: [],   // array of window IDs to include
    useNativeGroups: false,
    windowInfo: {},          // { [windowId]: { title, tabs: [{tabId, title, url, favIconUrl}] } }
    groupIds: {}             // { [windowId]: { [groupName]: groupId } }
  }
  ```
- **Message handlers** (`chrome.runtime.onMessage`):
  - `getTabData`: queries all windows and tabs; updates `windowInfo` and returns a snapshot.
  - `generateGroups`: reads `selectedWindowIds`; builds a prompt with tab titles & URLs; calls OpenRouter; expects JSON `{ "groups": ["Name1", ...] }`. Stores `groups` and returns them.
  - `organise`: reads `groups` and tab data (for selected windows). Prompts OpenRouter to assign each tab ID to a group. Expects JSON `{ "assignments": { "tabId1": "GroupName", ... } }`. Stores `assignments`, then calls `applyAssignments()`.
  - `applyAssignments`:
      - For each tab in `assignments`:
        * If `useNativeGroups`:
          - Get/create a Chrome tab group for the tab’s current window and the target group name (`getOrCreateGroupId(windowId, groupName)`).
          - If tab is in a different group, `chrome.tabs.ungroup([tabId])`.
          - Then add tab to the target group (`chrome.tabs.group({tabIds: [tabId], groupId: targetGroupId})`? Actually `chrome.tabs.group` creates a new group containing those tabs; to add to existing group we use `chrome.tabs.move`? The correct method: `chrome.tabs.group({tabIds: [tabId]})` creates a new group. To add to an existing group we need to `chrome.tabs.ungroup` and then `chrome.tabs.group` again with that group’s ID via `groupProperties`? However, the Chrome API allows `chrome.tabs.group` only to create a new group; to add tabs to an existing group, we use `chrome.tabs.move(tabIds, {windowId, index})`? Wait, there’s `chrome.tabs.group` to create a group and return groupId. Once you have a groupId, you can call `chrome.tabs.group` again with `groupProperties`? I need to check: The way to add a tab to an existing group is to `chrome.tabs.ungroup` and then `chrome.tabs.group` the set of tabs that belong together? That can disrupt existing groups. Better approach: keep a mapping of groupName → groupId per window. When assigning a tab to a group, we want to ensure the tab ends up in that group. Implementation:
            - If the tab already belongs to the correct group (check via `chrome.tabs.get(tabId)` then `tab.groupId`), do nothing.
            - Else, if the tab is already in a group, remove it with `chrome.tabs.ungroup([tabId])`.
            - Then create/obtain the target group for that window: if groupId exists, we can directly add the tab by calling `chrome.tabs.group({tabIds: [tabId]})`? That would create a new group. To add to an existing group, we must move the tab into that group: `chrome.tabs.move(tabIds, {windowId: windowId, index: -1})` doesn't guarantee group membership. Actually there is `chrome.tabs.group` only to create a new group. There is no API to explicitly add a tab to an existing group. The standard method: a tab belongs to a group if its groupId is set. You can set a tab’s group by calling `chrome.tabs.group({tabIds: [...], groupId: existingGroupId})`? According to Chrome docs, `chrome.tabs.group` accepts `groupId` as an optional property? Let me recall: The `chrome.tabs.group` method can either create a new group (by passing tabIds) or update an existing group if you pass `groupId`? Checking memory: `chrome.tabs.group` either creates a new group containing the given tabs, or if you want to add tabs to an existing group you actually use `chrome.tabs.move`? Actually I'm not 100% sure. I think the correct approach: each tab has a `groupId`. To assign a tab to a group, you can call `chrome.tabs.group({tabIds: [tabId]})` if you want to create a new group containing that tab; but to add it to an existing group, you need to include other tabs that are already in that group? That seems messy. Alternatively, we can just use `chrome.tabs.ungroup` and then create a new group that contains all tabs that should be in that group each time we apply. That would be inefficient. Let's research: The Chrome tabs API: `chrome.tabs.group({tabIds?: number[], windowId?: number, groupProperties?: {color?: string, title?: string, collapsed?: boolean}})` – if `tabIds` is provided, the method either creates a new group containing those tabs or moves them into an existing group if you also provide `groupId`? Actually `chrome.tabs.group` can also be used to update an existing group's properties if you don't pass `tabIds` but pass `groupId`? Hmm. The better way: When we want to assign a tab to a group, we can simply set its `groupId` property via `chrome.tabs.update`? No, `chrome.tabs.update` doesn't have groupId. The only way is `chrome.tabs.group`. According to MDN: `chrome.tabs.group()` creates a new group containing the specified tabs. It returns the group ID of the newly created group. There is no method to add a tab to an existing group except by calling `chrome.tabs.group` with the tabIds of the existing group's tabs plus the new tab? That would merge groups. That could work: for each group, we can gather all tabIds that should be in that group, then call `chrome.tabs.group({tabIds: allTabIds})`. This will create a new group or move tabs into that group? If you call `chrome.tabs.group` on a set of tabs that are already in a group, it will merge them into a new group? Actually the docs say: "If any of the tabs are already in a group, they will be combined into the new group." So calling it repeatedly with the superset will effectively ensure all desired tabs are in one group. Implementation: for each group name in our assignments, collect all tabIds that belong to that group (including those we already had). Then call `chrome.tabs.group({tabIds})`. That will create a new group containing all of them. That is idempotent-ish? If we call it again with the same set, it'll just merge those tabs into a new group (creating a new group every time) – not idempotent. We don't want to create duplicate groups. We need to manage existing group IDs. Chrome also has `chrome.tabGroups` API: you can `chrome.tabGroups.update` to change properties, and you can `chrome.tabs.move` with `groupId`? Actually `chrome.tabs.move` moves tabs between windows, not groups. There is `chrome.tabs.group` that also accepts `groupId` in `groupProperties`? Let's check quickly: In Chrome extension docs: `chrome.tabs.group(details: object, callback: function)`. The `details` object:
- `tabIds` (optional)
- `windowId` (optional)
- `groupProperties` (optional): `color`, `title`, `collapsed`.
The method returns the `groupId` of the group that was created or updated. If `tabIds` are omitted, calling `chrome.tabs.group` on a groupId updates its properties. But to assign a tab to an existing group, you do need to pass the tabIds along with the groupId? I think you can use `chrome.tabs.group({tabIds: [tabId], groupProperties: {}})` but you cannot specify an existing groupId there. However, you can use `chrome.tabs.move(tabIds, {windowId, index})` to move tabs within a window, but that doesn’t set group. There is `chrome.tabs.group` that can also accept `groupId`? Some sources say you can add tabs to an existing group by calling `chrome.tabs.group` with the `tabIds` you want to add and also specifying `groupId` inside `groupProperties`? Actually I'm mixing with `chrome.tabGroups`; there is `chrome.tabs.group` which only creates a new group. But there is `chrome.tabGroups.update` which updates group properties. There is no direct add-to-group. However, you can achieve adding a tab to a group by using `chrome.tabs.ungroup([tabId])` to remove it from its current group (if any) and then `chrome.tabs.group({tabIds: [tabId]})` creates a new group containing only that tab. That's not what we want.

The proper way: To move a tab into an existing group, you can call `chrome.tabs.group({tabIds: [tabId]})` and then `chrome.tabGroups.merge`? That's not right.

Let's recall actual Chrome extension API usage: The typical pattern for moving a tab to a group is:
```js
// Assume you have the groupId.
chrome.tabs.update(tabId, {active: true}); // not needed.
chrome.tabs.group({tabIds: [tabId]}); // This creates a new group.
```
But to move an existing tab into an existing group, you can use `chrome.tabs.group` with `groupId` as a property? Actually the `groupProperties` parameter can include `groupId`? Not according to MDN.

Wait, I think the method is: You call `chrome.tabs.group` with the `tabIds` you want to put in the group. If those tabs are not already in a group, they'll be grouped together into a new group. If you want to add a tab to an existing group, you select that group and the tab, then use the Chrome UI. Programmatically, I believe you can use `chrome.tabs.group` with both `tabIds` and `groupId` in `groupProperties`? Let's search memory: I've used `chrome.tabs.group` before; it only creates new groups. There is also `chrome.tabGroups.move`? No. There is `chrome.tabs.move` to move tabs between windows but not groups. How does one assign a tab to an existing group programmatically? I think you have to get all tabs in that group via `chrome.tabs.query({currentWindow: true, groupId: groupId})`, then union with the new tab, then call `chrome.tabs.group({tabIds: allTabIds})` which creates a new group and leaves the old group empty? Actually, if you call `chrome.tabs.group` on a mix of tabs that are already grouped, it merges them into a new group and discards the old groups? Let's test conceptually: Suppose group A has tabs [1,2]. You want to add tab 3. If you call `chrome.tabs.group({tabIds: [1,2,3]})`, it would combine them into a new group (new groupId). The old group A disappears (becomes empty). That's okay if we then assign the new group's ID to the name mapping. That's acceptable: effectively we recreate the group with all tabs. That is simpler: for each group name, we collect all tabIds that should be in that group. We call `chrome.tabs.group({tabIds})` once per group. This will create a fresh group containing those tabs. Tabs not included will be ungrouped (we need to handle those separately). That approach works and is idempotent: if you call it again with the same set, you'll get a new group each time (new groupId). That's messy but we can first clear existing groups in the window? Alternatively, we could just always recreate groups from scratch: first ungroup all tabs in the window (ungroup everything), then for each group create a new group with its tabs. That's easy: for a given window, we can get all tabs, then for each group, call `chrome.tabs.group({tabIds})`. The groups will be created in order, and we can set properties like title/color.

Implementation plan for `applyAssignments` per window:
- For a given window, gather all tabIds that belong to that window and are in our `assignments`.
- If `useNativeGroups`:
   - First, ungroup all tabs in that window: `chrome.tabs.ungroup(allTabIds)` (or just ungroup each tab? There's `chrome.tabs.ungroup` that takes an array of tabIds to remove from groups).
   - Then for each group name in `groups`:
        * Get tabIds for that group and window.
        * If non-empty, call `chrome.tabs.group({tabIds})` to create a new group. Optionally set its title and color using `chrome.tabGroups.update` after we get the groupId.
   - For tabs without assignment, they remain ungrouped.
This will recreate groups from scratch each time we apply. That's fine; it simplifies logic. There's no need to track groupIds across runs. We just need to set the group title and maybe color.

- For moving tabs between windows (dragging a column to a window):
   * We move tabs: `chrome.tabs.move(tabIds, {windowId: targetWindowId})`.
   * Then after moving, we will apply grouping for the target window? We could simply rely on the next `applyAssignments` to re-create groups. Or we can call `applyAssignments` after moves. Simpler: after moving, just update storage assignments; the Kanban UI will reflect new windows. The actual grouping in the target window will be corrected when Organise is run again. But the user expects immediate grouping? Possibly yes. We can also call a function to ensure group exists in the target window for that group name and add moved tabs. But if we adopt the full `applyAssignments` approach, we can just trigger it automatically after any manual changes (like tab move or group edit). That might cause full recreation each time, which is acceptable for small numbers. However, it may be heavy if many tabs. But it's okay for a prototype.

Given complexity, we might choose to implement `applyAssignments` as the single source of truth: whenever we want synchronization (after Organise or after any manual drag that changes assignments or window), we call `applyAssignments` which re-creates groups from scratch for all windows that have affected tabs. That ensures consistency.

Thus, background will expose:
- `syncAll`: reads all assignments and windows, and for each window, ungroup all tabs then group according to assignments for that window. Also moves tabs to their assigned windows if they differ? Actually `assignments` only store group, not window. Window selection is separate; we may need to store intended window per tab if user moved them? Actually when a user drags a card between columns, we only change group; window stays the same. When dragging a column to a window, we move tabs to that window; that changes their windowId. We need to update our stored tab data accordingly. After moving, we should also re-group in the new window. So we can just call `syncTab(tabId)` which ensures the tab is in the correct group for its current window. But easier: after any change, call a full `applyAssignments` that goes through all windows and re-creates groups based on current assignments. The `windowInfo` should reflect current window of each tab (we query Chrome to get actual windowId). We'll need to refresh `windowInfo` before applying.

So workflow:
- Background keeps `assignments` and `groups`.
- When applying, it first queries all windows and tabs to get up-to-date `windowInfo` (including which window each tab is in). Then for each window, ungroup all tabs, then for each group, create group with tabs that are in that window and have that group assignment.

This ensures that if a tab was manually moved to another window, it ends up in the correct group there after apply.

We can trigger `applyAssignments` automatically after `organise` (AI assignment), after any drag-and-drop from Kanban (which updates assignments or window moves), or after group name changes (which affect title updates). That's fine.

Performance: `applyAssignments` may be heavy if hundreds of tabs, but okay.

**OpenRouter API**:
- Endpoint: `https://openrouter.ai/api/v1/chat/completions`
- Headers: `Authorization: Bearer <apiKey>`, `Content-Type: application/json`, optional `HTTP-Referer` and `X-Title`.
- Body: `{ model: "stepfun/step-3.5-flash:free", messages: [...] }`.
- Use low temperature (0.2) for deterministic assignments.

**Prompts**:
- Generate groups:
  ```
  You are an assistant that suggests meaningful categories for a set of browser tabs.

  I have a list of tabs (each with a title and URL). Please analyze them and propose between 3 and 8 concise group names (2-4 words) that would logically categorize these tabs. Return JSON: {"groups": ["Name1", "Name2", ...]}. Only return the JSON.
  ```
  Provide the tab list as numbered items with their title and URL.

- Organise (assign to existing groups):
  ```
  You are an assistant that assigns each of the given browser tabs to exactly one of the provided category names.

  Categories: [comma-separated list from groups]
  Tabs: (index or title/url)
  For each tab, choose the best-fitting category. If none fit well, assign "Other" (include "Other" as a default if not present). Return JSON: {"assignments": {"TabID1": "Category", "TabID2": "Category", ...}} where TabID is the tab's unique identifier we provide.
  ```

**Shared Utilities** (`utils.js`):
- `callOpenRouter(prompt)` function that fetches the API key from storage, makes the request, and parses JSON.
- Storage helpers: `getState()`, `setState(partial)`.

**Implementation Notes**:
- Use vanilla JavaScript; no external libraries.
- Use native HTML5 Drag and Drop API for Kanban.
- All UI updates should be responsive and clean.
- When applying assignments, handle errors gracefully (e.g., tabs closed).
- The extension should not break if OpenRouter key is missing; prompt the user to set it in popup (show warning).

**Deliverables**:
- `manifest.json`
- `popup.html`, `popup.js`, `popup.css`
- `kanban.html`, `kanban.js`, `kanban.css`
- `background.js`
- `utils.js`
- `icons/` (optional placeholder icons; can be empty or use default)
- `README.md` with usage instructions, notes about setting the OpenRouter API key, and explanation of features.

**Constraints**:
- Ensure the extension loads without errors in Chrome.
- Use Manifest V3; avoid deprecated APIs.
- Do not include `eval()` or inline JavaScript in HTML; use external JS files.
- Keep code modular and readable.

---

Start by reading `PROMPT.md`, then implement the full extension step by step. Test logic mentally; avoid placeholders like “TODO”. The extension must be functional out of the box (once the user provides an OpenRouter API key). 

If you need to make reasonable assumptions, do so and note them in code comments.

Good luck!
