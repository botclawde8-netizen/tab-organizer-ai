importScripts("utils.js");

const {
  DEFAULT_STATE,
  normalizeGroups,
  createTabSummary,
  pickTabData,
  pickWindowTitle,
  getState,
  setState,
  storageGet,
  callOpenRouter,
  computeTabDiff,
  escapeQuotes
} = self.TabOrganizerUtils;

chrome.runtime.onInstalled.addListener(async () => {
  const current = await storageGet(Object.keys(DEFAULT_STATE));
  const toSet = {};
  Object.entries(DEFAULT_STATE).forEach(([key, value]) => {
    if (typeof current[key] === "undefined") {
      toSet[key] = value;
    }
  });
  if (Object.keys(toSet).length > 0) {
    await setState(toSet);
  }
});

async function queryAllWindowData() {
  const windows = await chrome.windows.getAll({ populate: true });
  const windowInfo = {};

  windows.forEach((windowObj) => {
    const tabs = (windowObj.tabs || []).map(pickTabData);
    windowInfo[windowObj.id] = {
      title: pickWindowTitle(windowObj, tabs),
      tabs,
      state: windowObj.state
    };
  });

  await setState({ windowInfo });
  return windowInfo;
}

async function getSelectedTabSummary() {
  const state = await getState();
  const windowInfo = await queryAllWindowData();
  const tabs = createTabSummary(windowInfo, state.selectedWindowIds);
  return { tabs, state: { ...state, windowInfo } };
}

function buildGeneratePrompt(tabs) {
  const tabLines = tabs
    .map(
      (tab) =>
        `- [tabId:${tab.tabId}] title="${tab.title.replace(/"/g, '\\"')}" url="${tab.url.replace(/"/g, '\\"')}"`
    )
    .join("\n");

  return [
    "Analyze these browser tabs and suggest useful category names.",
    "Requirements:",
    "1. Return between 3 and 8 groups.",
    "2. Group names should be concise (1-4 words) and human-readable.",
    "3. Avoid duplicates and overly generic labels.",
    "4. Return exactly this JSON shape: {\"groups\":[\"Group 1\",\"Group 2\"]}",
    "Tabs:",
    tabLines
  ].join("\n");
}

function buildOrganisePrompt(tabs, groups) {
  const tabLines = tabs
    .map(
      (tab) =>
        `- tabId=${tab.tabId}; title="${tab.title.replace(/"/g, '\\"')}"; url="${tab.url.replace(/"/g, '\\"')}"`
    )
    .join("\n");

  return [
    "Assign each tab to exactly one existing group name.",
    "Rules:",
    "1. Use only group names from the provided list.",
    "2. Every tabId must appear exactly once.",
    "3. Return only JSON with shape: {\"assignments\":{\"123\":\"Group\"}}",
    `Groups: ${JSON.stringify(groups)}`,
    "Tabs:",
    tabLines
  ].join("\n");
}

function filterWindowInfo(windowInfo, selectedIds) {
  if (selectedIds == null) return windowInfo;
  const out = {};
  selectedIds.forEach(id => {
    if (windowInfo[id]) out[id] = windowInfo[id];
  });
  return out;
}

function buildGeneratePromptWithDiff(currentGroups, diff) {
  const lines = [
    "Analyze browser tab changes and suggest updated group names.",
    "Current groups: " + JSON.stringify(currentGroups),
    "Changes since last generation:"
  ];

  if (diff.added.length) {
    lines.push(`- Added ${diff.added.length} tab(s):`);
    diff.added.forEach(tab => {
      lines.push(`  • title: "${escapeQuotes(tab.title)}"`);
    });
  }
  if (diff.removed.length) {
    lines.push(`- Removed ${diff.removed.length} tab(s).`);
  }
  if (diff.modified.length) {
    lines.push(`- Modified ${diff.modified.length} tab(s) (title/url changed).`);
  }

  lines.push(
    "Requirements:",
    "1. Return between 3 and 8 group names.",
    "2. Names should be concise (1-4 words) and human-readable.",
    "3. Consider both existing groups and new tab content; you may keep, rename, or add groups.",
    "4. Return exactly this JSON shape: {\"groups\":[\"Group 1\",\"Group 2\"]}"
  );

  return lines.join("\n");
}

function buildOrganisePromptWithDiff(groups, newTabs) {
  const lines = [
    "Assign each of the following new/updated tabs to one of the existing groups.",
    "Groups: " + JSON.stringify(groups),
    "New/updated tabs:"
  ];

  newTabs.forEach(tab => {
    lines.push(`  - tabId=${tab.tabId}; title="${escapeQuotes(tab.title)}"`);
  });

  lines.push(
    "Rules:",
    "1. Use only group names from the provided list.",
    "2. Assign each tabId exactly once.",
    "3. Return only JSON: {\"assignments\":{\"tabId\":\"Group\"}}"
  );

  return lines.join("\n");
}

async function broadcastRefresh() {
  try {
    await chrome.runtime.sendMessage({ type: "refreshKanban" });
  } catch (_error) {
    // No listeners is acceptable.
  }
}

async function applyAssignments() {
  const state = await getState();
  const useNativeGroups = state.useNativeGroups;
  const groups = normalizeGroups(state.groups);

  const windowInfo = await queryAllWindowData();
  const allTabs = Object.values(windowInfo).flatMap((entry) => entry.tabs || []);
  const liveTabIds = new Set(allTabs.map((tab) => tab.tabId));

  const cleanedAssignments = {};
  Object.entries(state.assignments || {}).forEach(([tabIdKey, groupName]) => {
    const tabId = Number(tabIdKey);
    if (!liveTabIds.has(tabId)) {
      return;
    }
    if (!groupName || !groups.includes(groupName)) {
      return;
    }
    cleanedAssignments[tabId] = groupName;
  });

  await setState({ assignments: cleanedAssignments, groups });

  if (!useNativeGroups) {
    await broadcastRefresh();
    return { updated: true, nativeApplied: false };
  }

  const tabsByWindow = new Map();
  allTabs.forEach((tab) => {
    if (!tabsByWindow.has(tab.windowId)) {
      tabsByWindow.set(tab.windowId, []);
    }
    tabsByWindow.get(tab.windowId).push(tab);
  });

  const newGroupIds = {};

  for (const [windowId, tabs] of tabsByWindow.entries()) {
    const windowTabIds = tabs.map((tab) => tab.tabId);
    if (windowTabIds.length === 0) {
      continue;
    }

    try {
      await chrome.tabs.ungroup(windowTabIds);
    } catch (_error) {
      // Some tabs may already be ungrouped.
    }

    const perGroup = new Map();
    tabs.forEach((tab) => {
      const assigned = cleanedAssignments[tab.tabId];
      if (!assigned) {
        return;
      }
      if (!perGroup.has(assigned)) {
        perGroup.set(assigned, []);
      }
      perGroup.get(assigned).push(tab.tabId);
    });

    for (const [groupName, tabIds] of perGroup.entries()) {
      if (!tabIds.length) {
        continue;
      }
      try {
        const groupId = await chrome.tabs.group({ tabIds });
        await chrome.tabGroups.update(groupId, { title: groupName, collapsed: false });
        if (!newGroupIds[windowId]) {
          newGroupIds[windowId] = {};
        }
        newGroupIds[windowId][groupName] = groupId;
      } catch (_error) {
        // Ignore per-group failure and continue.
      }
    }
  }

  await setState({ groupIds: newGroupIds });
  await broadcastRefresh();
  return { updated: true, nativeApplied: true };
}

async function generateGroups() {
  const state = await getState();
  const windowInfo = await queryAllWindowData();
  const selectedWindowIds = state.selectedWindowIds;

  const currentFiltered = filterWindowInfo(windowInfo, selectedWindowIds);
  const lastSnapshot = state.lastSnapshot;
  let groups;

  if (lastSnapshot && lastSnapshot.windowInfo) {
    const prevFiltered = filterWindowInfo(lastSnapshot.windowInfo, selectedWindowIds);
    const diff = computeTabDiff(currentFiltered, prevFiltered);
    if (diff.added.length === 0 && diff.removed.length === 0 && diff.modified.length === 0) {
      groups = state.groups;
    } else {
      const prompt = buildGeneratePromptWithDiff(state.groups, diff);
      const result = await callOpenRouter(prompt, { temperature: 0.2 });
      groups = normalizeGroups(result.groups || []);
    }
  } else {
    const tabs = createTabSummary(windowInfo, selectedWindowIds);
    if (tabs.length === 0) {
      return { groups: [] };
    }
    const prompt = buildGeneratePrompt(tabs);
    const result = await callOpenRouter(prompt, { temperature: 0.2 });
    groups = normalizeGroups(result.groups || []);
  }

  const limitedGroups = groups.slice(0, 8);
  await setState({
    groups: limitedGroups,
    lastSnapshot: {
      windowInfo,
      assignments: state.assignments,
      timestamp: Date.now()
    }
  });
  await broadcastRefresh();
  return { groups: limitedGroups };
}

async function organiseTabs() {
  const state = await getState();
  const windowInfo = await queryAllWindowData();
  const groups = normalizeGroups(state.groups || []);
  if (!groups.length) {
    throw new Error("Please add at least one group before organizing tabs.");
  }

  const selectedWindowIds = state.selectedWindowIds;
  const useAll = selectedWindowIds == null;

  // Gather visible tabs (for live tab set)
  const visibleTabs = [];
  Object.entries(windowInfo).forEach(([winId, info]) => {
    const numericId = Number(winId);
    if (!useAll && !selectedWindowIds.includes(numericId)) return;
    visibleTabs.push(...(info.tabs || []));
  });
  const liveTabIds = new Set(visibleTabs.map(t => t.tabId));

  const lastSnapshot = state.lastSnapshot;
  let assignments;

  if (lastSnapshot && lastSnapshot.windowInfo && lastSnapshot.assignments) {
    const filter = (winInfo) => {
      if (useAll) return winInfo;
      const out = {};
      selectedWindowIds.forEach(id => {
        if (winInfo[id]) out[id] = winInfo[id];
      });
      return out;
    };
    const currentFiltered = filter(windowInfo);
    const prevFiltered = filter(lastSnapshot.windowInfo);
    const diff = computeTabDiff(currentFiltered, prevFiltered);
    const newTabs = [
      ...diff.added,
      ...diff.modified.map(m => m.current)
    ];

    if (newTabs.length === 0) {
      assignments = Object.fromEntries(
        Object.entries(state.assignments || {}).filter(([tid]) => liveTabIds.has(Number(tid)))
      );
    } else {
      const prompt = buildOrganisePromptWithDiff(groups, newTabs);
      const result = await callOpenRouter(prompt, { temperature: 0.1 });
      const newAssignmentsRaw = result.assignments || {};
      const validNew = {};
      Object.entries(newAssignmentsRaw).forEach(([tabIdKey, groupName]) => {
        const tabId = Number(tabIdKey);
        if (newTabs.some(t => t.tabId === tabId) && groups.includes(groupName)) {
          validNew[tabId] = groupName;
        }
      });
      const base = Object.fromEntries(
        Object.entries(state.assignments || {}).filter(([tid]) => liveTabIds.has(Number(tid)))
      );
      assignments = { ...base, ...validNew };
    }
  } else {
    const tabs = createTabSummary(windowInfo, selectedWindowIds);
    if (tabs.length === 0) {
      await setState({ assignments: {} });
      await broadcastRefresh();
      return { assignments: {} };
    }
    const prompt = buildOrganisePrompt(tabs, groups);
    const result = await callOpenRouter(prompt, { temperature: 0.1 });
    let rawAssignments = result.assignments || {};
    assignments = Object.fromEntries(
      Object.entries(rawAssignments).filter(([tid]) => liveTabIds.has(Number(tid)) && groups.includes(rawAssignments[tid]))
    );
  }

  await setState({
    assignments,
    lastSnapshot: {
      windowInfo,
      assignments,
      timestamp: Date.now()
    }
  });
  await applyAssignments();
  return { assignments };
}

async function updateAssignment(tabId, groupName) {
  const state = await getState();
  const next = { ...(state.assignments || {}) };

  if (!groupName || groupName === "Ungrouped") {
    delete next[tabId];
  } else {
    next[tabId] = groupName;
  }

  await setState({ assignments: next });
  await applyAssignments();
  return { success: true };
}

async function moveGroupToWindow(groupName, targetWindowId) {
  const state = await getState();
  const windowInfo = await queryAllWindowData();

  const sourceTabIds = [];
  Object.values(windowInfo).forEach((info) => {
    (info.tabs || []).forEach((tab) => {
      if ((state.assignments || {})[tab.tabId] === groupName) {
        sourceTabIds.push(tab.tabId);
      }
    });
  });

  for (const tabId of sourceTabIds) {
    try {
      await chrome.tabs.move(tabId, { windowId: targetWindowId, index: -1 });
    } catch (_error) {
      // Ignore closed tabs.
    }
  }

  await applyAssignments();
  return { moved: sourceTabIds.length };
}

async function setSelectedWindows(windowIds) {
  let safeIds;
  if (windowIds === null || windowIds === undefined) {
    safeIds = null;
  } else {
    safeIds = Array.isArray(windowIds) ? windowIds.map(Number).filter(Number.isFinite) : [];
  }
  await setState({ selectedWindowIds: safeIds });
  await broadcastRefresh();
  return { selectedWindowIds: safeIds };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    const type = message && message.type;

    if (type === "getTabData") {
      const state = await getState();
      const windowInfo = await queryAllWindowData();
      sendResponse({
        ok: true,
        data: {
          windowInfo,
          groups: state.groups,
          assignments: state.assignments,
          selectedWindowIds: state.selectedWindowIds,
          useNativeGroups: state.useNativeGroups,
          apiKeySet: Boolean(state.apiKey),
          confirmDestructive: state.confirmDestructive
        }
      });
      return;
    }

    if (type === "generateGroups") {
      const data = await generateGroups();
      sendResponse({ ok: true, data });
      return;
    }

    if (type === "organise") {
      const data = await organiseTabs();
      sendResponse({ ok: true, data });
      return;
    }

    if (type === "applyAssignments") {
      const data = await applyAssignments();
      sendResponse({ ok: true, data });
      return;
    }

    if (type === "updateAssignment") {
      const data = await updateAssignment(Number(message.tabId), message.groupName);
      sendResponse({ ok: true, data });
      return;
    }

    if (type === "moveGroupToWindow") {
      const data = await moveGroupToWindow(message.groupName, Number(message.targetWindowId));
      sendResponse({ ok: true, data });
      return;
    }

    if (type === "setSelectedWindows") {
      const data = await setSelectedWindows(message.windowIds);
      sendResponse({ ok: true, data });
      return;
    }

    if (type === "setGroups") {
      const groups = normalizeGroups(message.groups || []);
      await setState({ groups });
      await broadcastRefresh();
      sendResponse({ ok: true, data: { groups } });
      return;
    }

    if (type === "setUseNativeGroups") {
      await setState({ useNativeGroups: Boolean(message.useNativeGroups) });
      await applyAssignments();
      sendResponse({ ok: true });
      return;
    }

    if (type === "setApiKey") {
      await setState({ apiKey: String(message.apiKey || "").trim() });
      sendResponse({ ok: true });
      return;
    }

    if (type === "closeWindow") {
      const windowId = Number(message.windowId);
      await new Promise((resolve, reject) => {
        chrome.windows.remove(windowId, () => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve();
        });
      });
      sendResponse({ ok: true });
      return;
    }

    if (type === "toggleWindowMinimize") {
      const windowId = Number(message.windowId);
      await new Promise((resolve, reject) => {
        chrome.windows.get(windowId, {}, (win) => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          const newState = win.state === 'minimized' ? 'normal' : 'minimized';
          chrome.windows.update(windowId, { state: newState }, () => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve();
          });
        });
      });
      sendResponse({ ok: true });
      return;
    }

    if (type === "minimizeAll") {
      const windows = await chrome.windows.getAll();
      const promises = windows.filter(w => w.state !== 'minimized' && w.type === 'normal').map(w => {
        return new Promise((resolve, reject) => {
          chrome.windows.update(w.id, { state: 'minimized' }, () => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve();
          });
        });
      });
      await Promise.allSettled(promises);
      sendResponse({ ok: true });
      return;
    }

    if (type === "setConfirmDestructive") {
      await setState({ confirmDestructive: Boolean(message.confirmDestructive) });
      sendResponse({ ok: true });
      return;
    }

    if (type === "refreshKanban") {
      sendResponse({ ok: true });
      return;
    }

    sendResponse({ ok: false, error: `Unknown message type: ${type}` });
  })().catch((error) => {
    sendResponse({ ok: false, error: error.message || String(error) });
  });

  return true;
});
