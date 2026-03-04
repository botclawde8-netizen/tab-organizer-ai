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

// Token efficiency (diff-based) - temporarily disabled
// function filterWindowInfo(windowInfo, selectedIds) {
//   if (selectedIds == null) return windowInfo;
//   const out = {};
//   selectedIds.forEach(id => {
//     if (windowInfo[id]) out[id] = windowInfo[id];
//   });
//   return out;
// }

// function buildGeneratePromptWithDiff(currentGroups, diff) {
//   // Disabled
//   return "";
// }

// function buildOrganisePromptWithDiff(groups, newTabs) {
//   // Disabled
//   return "";
// }

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
  const { tabs } = await getSelectedTabSummary();
  if (tabs.length === 0) {
    return { groups: [] };
  }

  const prompt = buildGeneratePrompt(tabs);
  const result = await callOpenRouter(prompt, { temperature: 0.2 });

  const proposed = normalizeGroups(result.groups || []);
  const groups = proposed.slice(0, 8);

  await setState({ groups });
  await broadcastRefresh();

  return { groups };
}

async function organiseTabs() {
  const { tabs, state } = await getSelectedTabSummary();
  const groups = normalizeGroups(state.groups || []);

  if (!groups.length) {
    throw new Error("Please add at least one group before organizing tabs.");
  }

  if (tabs.length === 0) {
    await setState({ assignments: {} });
    return { assignments: {} };
  }

  const prompt = buildOrganisePrompt(tabs, groups);
  const result = await callOpenRouter(prompt, { temperature: 0.1 });

  const incomingAssignments = result.assignments || {};
  const validGroupSet = new Set(groups);
  const tabIdSet = new Set(tabs.map((tab) => tab.tabId));

  const assignments = {};
  Object.entries(incomingAssignments).forEach(([tabIdKey, groupName]) => {
    const tabId = Number(tabIdKey);
    if (!tabIdSet.has(tabId)) {
      return;
    }
    if (!validGroupSet.has(groupName)) {
      return;
    }
    assignments[tabId] = groupName;
  });

  await setState({ assignments });
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

    if (type === "moveTabToWindow") {
      const tabId = Number(message.tabId);
      const targetWindowId = Number(message.targetWindowId);
      try {
        await chrome.tabs.move(tabId, { windowId: targetWindowId, index: -1 });
        await broadcastRefresh();
        sendResponse({ ok: true });
        return;
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
        return;
      }
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

    if (type === "addGroup") {
      const state = await getState();
      const groupName = (message.groupName || "").trim();
      if (!groupName) {
        sendResponse({ ok: false, error: "Group name cannot be empty" });
        return;
      }
      if (state.groups.includes(groupName)) {
        sendResponse({ ok: false, error: "Group already exists" });
        return;
      }
      const newGroups = [...state.groups, groupName];
      await setState({ groups: newGroups });
      await broadcastRefresh();
      sendResponse({ ok: true });
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
