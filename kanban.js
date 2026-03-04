const state = {
  groups: [],
  assignments: {},
  selectedWindowIds: [],
  windowInfo: {},
  useNativeGroups: false,
  filterGroup: null,
  dragCardTabId: null,
  dragColumnGroup: null,
  dragInsertionIndex: null,
  confirmDestructive: false,
  viewMode: 'groups',
  pendingOps: [],
  mirrorMode: true,
  deleteGroupOnClose: false,
  organiseMode: 'groups',
  tabOrders: {}
};

const el = {
  subtitle: document.getElementById("subtitle"),
  viewToggle: document.getElementById("viewToggle"),
  newGroupInput: document.getElementById("newGroupInput"),
  addGroupBtn: document.getElementById("addGroupBtn"),
  organiseMode: document.getElementById("organiseMode"),
  organiseBtn: document.getElementById("organiseBtn"),
  mirrorToggle: document.getElementById("mirrorToggle"),
  changeCounter: document.getElementById("changeCounter"),
  applyBtn: document.getElementById("applyBtn"),
  revertBtn: document.getElementById("revertBtn"),
  refreshBtn: document.getElementById("refreshBtn"),
  board: document.getElementById("board"),
  windowDropList: document.getElementById("windowDropList"),
  cardTemplate: document.getElementById("cardTemplate")
};

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response || !response.ok) {
        reject(new Error(response?.error || "Unknown error"));
        return;
      }
      resolve(response.data);
    });
  });
}

function selectedSet() {
  const set = new Set((state.selectedWindowIds || []).map(Number));
  return set;
}

function shouldIncludeWindow(windowId) {
  const set = selectedSet();
  if (set.size === 0) {
    return true;
  }
  return set.has(Number(windowId));
}

function getVisibleTabs() {
  const out = [];
  Object.entries(state.windowInfo || {}).forEach(([windowId, info]) => {
    if (!shouldIncludeWindow(Number(windowId))) {
      return;
    }
    (info.tabs || []).forEach((tab) => {
      out.push({
        ...tab,
        windowId: Number(windowId),
        windowTitle: info.title || `Window ${windowId}`
      });
    });
  });
  return out;
}

function buildColumnsData() {
  const tabs = getVisibleTabs();
  const columns = new Map();

  if (state.viewMode === 'windows') {
    Object.entries(state.windowInfo || {}).forEach(([windowId, info]) => {
      if (!shouldIncludeWindow(Number(windowId))) return;
      const key = `win-${windowId}`;
      columns.set(key, {
        key,
        title: info.title || `Window ${windowId}`,
        tabs: (info.tabs || []).map(tab => ({
          ...tab,
          windowId: Number(windowId),
          windowTitle: info.title
        })),
        type: 'window',
        windowId: Number(windowId)
      });
    });
  } else {
    (state.groups || []).forEach((group) => {
      columns.set(group, {
        key: group,
        title: group,
        tabs: [],
        type: 'group'
      });
    });
    columns.set('Ungrouped', {
      key: 'Ungrouped',
      title: 'Ungrouped',
      tabs: [],
      type: 'group'
    });
    tabs.forEach((tab) => {
      const assigned = state.assignments?.[tab.tabId];
      const colKey = assigned && columns.has(assigned) ? assigned : 'Ungrouped';
      const col = columns.get(colKey);
      col.tabs.push(tab);
    });
    columns.forEach(col => {
      const order = state.tabOrders[col.key];
      if (order && Array.isArray(order)) {
        const ordered = [];
        const tabMap = new Map(col.tabs.map(t => [t.tabId, t]));
        order.forEach(tabId => {
          const tab = tabMap.get(tabId);
          if (tab) ordered.push(tab);
        });
        const remaining = col.tabs.filter(t => !order.includes(t.tabId));
        col.tabs = ordered.concat(remaining);
      }
    });
  }

  return columns;
}

function setSubtitle() {
  const set = selectedSet();
  if (set.size === 0) {
    el.subtitle.textContent = "Showing tabs from all windows.";
    return;
  }
  el.subtitle.textContent = `Showing tabs from ${set.size} selected window${set.size === 1 ? "" : "s"}.`;
}

function updatePendingCounter() {
  const count = state.pendingOps.length;
  el.changeCounter.textContent = `${count} pending`;
  if (state.mirrorMode) {
    el.applyBtn.style.display = 'none';
    el.revertBtn.style.display = 'none';
  } else {
    el.applyBtn.style.display = count > 0 ? 'inline-block' : 'none';
    el.revertBtn.style.display = count > 0 ? 'inline-block' : 'none';
  }
}

function executeOrQueue(op) {
  if (state.mirrorMode) {
    return sendMessage(op);
  } else {
    state.pendingOps.push(op);
    optimisticApply(op);
    updatePendingCounter();
    return Promise.resolve();
  }
}

function optimisticApply(op) {
  switch (op.type) {
    case 'addGroup': {
      const groupName = op.groupName;
      if (!state.groups.includes(groupName)) {
        state.groups.push(groupName);
      }
      if (!state.tabOrders[groupName]) {
        state.tabOrders[groupName] = [];
      }
      break;
    }
    case 'closeTab': {
      const tabId = op.tabId;
      let found = false;
      Object.values(state.windowInfo).forEach(win => {
        const idx = win.tabs.findIndex(t => t.tabId === tabId);
        if (idx !== -1) {
          win.tabs.splice(idx, 1);
          found = true;
        }
      });
      if (found) {
        delete state.assignments[tabId];
      }
      break;
    }
    case 'closeGroup': {
      const groupName = op.groupName;
      const tabIdsToRemove = [];
      Object.entries(state.assignments).forEach(([tabId, grp]) => {
        if (grp === groupName) {
          tabIdsToRemove.push(Number(tabId));
        }
      });
      tabIdsToRemove.forEach(tabId => {
        delete state.assignments[tabId];
        Object.values(state.windowInfo).forEach(win => {
          const idx = win.tabs.findIndex(t => t.tabId === tabId);
          if (idx !== -1) win.tabs.splice(idx, 1);
        });
      });
      if (state.deleteGroupOnClose) {
        state.groups = state.groups.filter(g => g !== groupName);
        delete state.tabOrders[groupName];
      }
      break;
    }
    case 'closeWindow': {
      const windowId = op.windowId;
      delete state.windowInfo[windowId];
      break;
    }
    case 'moveTabToWindow': {
      const tabId = op.tabId;
      const targetWindowId = op.targetWindowId;
      let movedTab = null;
      Object.values(state.windowInfo).forEach(win => {
        const idx = win.tabs.findIndex(t => t.tabId === tabId);
        if (idx !== -1) {
          movedTab = win.tabs.splice(idx, 1)[0];
        }
      });
      if (movedTab) {
        movedTab.windowId = targetWindowId;
        // Ensure target window exists in state
        if (!state.windowInfo[targetWindowId]) {
          state.windowInfo[targetWindowId] = { title: `Window ${targetWindowId}`, tabs: [] };
        }
        state.windowInfo[targetWindowId].tabs.push(movedTab);
      }
      break;
    }
    case 'setTabOrder': {
      const { key, tabIds } = op;
      state.tabOrders[key] = tabIds;
      break;
    }
    case 'organise':
      // no local change
      break;
    case 'updateAssignment':
      // will be handled by re-render from refresh after apply, but we can optimistic
      const { tabId, groupName } = op;
      if (groupName === 'Ungrouped' || !groupName) {
        delete state.assignments[tabId];
      } else {
        state.assignments[tabId] = groupName;
      }
      // Also move tab visually within state for immediate feedback; simpler to just refresh later
      break;
    default:
      break;
  }
  renderBoard();
}

async function applyAll() {
  const ops = state.pendingOps.slice();
  state.pendingOps = [];
  updatePendingCounter();
  for (const op of ops) {
    try {
      await sendMessage(op);
    } catch (error) {
      console.error("Failed to apply operation:", op, error);
      // Could revert all? For now, continue
    }
  }
  await refresh();
}

function revertAll() {
  state.pendingOps = [];
  updatePendingCounter();
  refresh();
}

function renderWindowDropZones() {
  el.windowDropList.textContent = "";
  const windows = Object.entries(state.windowInfo || {}).filter(([id]) => shouldIncludeWindow(Number(id)));

  if (!windows.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No target windows available.";
    el.windowDropList.appendChild(empty);
    return;
  }

  windows.forEach(([windowId, info]) => {
    const zone = document.createElement("div");
    zone.className = "window-drop-zone";
    zone.dataset.windowId = String(windowId);

    const title = document.createElement("strong");
    title.textContent = info.title || `Window ${windowId}`;

    const meta = document.createElement("p");
    meta.className = "window-meta";
    meta.textContent = `ID ${windowId} · ${(info.tabs || []).length} tabs`;

    zone.append(title, meta);

    zone.addEventListener("dragover", (event) => {
      const isGroupDrag = state.dragColumnGroup && state.dragColumnGroup !== "Ungrouped";
      const isTabDrag = state.dragCardTabId != null;
      if (!isGroupDrag && !isTabDrag) {
        return;
      }
      event.preventDefault();
      zone.classList.add("drag-over");
    });

    zone.addEventListener("dragleave", () => {
      zone.classList.remove("drag-over");
    });

    zone.addEventListener("drop", async (event) => {
      event.preventDefault();
      zone.classList.remove("drag-over");

      const isGroupDrag = state.dragColumnGroup && state.dragColumnGroup !== "Ungrouped";
      const isTabDrag = state.dragCardTabId != null;
      const targetWindowId = Number(windowId);

      if (isGroupDrag) {
        await executeOrQueue({
          type: "moveGroupToWindow",
          groupName: state.dragColumnGroup,
          targetWindowId
        });
        state.dragColumnGroup = null;
      } else if (isTabDrag) {
        const tabId = state.dragCardTabId;
        await executeOrQueue({
          type: "moveTabToWindow",
          tabId,
          targetWindowId
        });
        state.dragCardTabId = null;
      }
    });

    el.windowDropList.appendChild(zone);
  });
}

function createCard(tab) {
  const node = el.cardTemplate.content.firstElementChild.cloneNode(true);
  const icon = node.querySelector(".tab-icon");
  const title = node.querySelector(".tab-title");
  const badge = node.querySelector(".tab-badge");
  const closeBtn = node.querySelector(".card-close");

  icon.src = tab.favIconUrl || "";
  icon.referrerPolicy = "no-referrer";
  icon.onerror = () => {
    icon.style.visibility = "hidden";
  };

  title.textContent = tab.title || "Untitled";
  badge.textContent = tab.windowTitle;

  node.dataset.tabId = String(tab.tabId);

  closeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    executeOrQueue({
      type: 'closeTab',
      tabId: tab.tabId
    });
  });

  node.addEventListener("dragstart", () => {
    state.dragCardTabId = tab.tabId;
    node.classList.add("dragging");
  });

  node.addEventListener("dragend", () => {
    state.dragCardTabId = null;
    node.classList.remove("dragging");
  });

  return node;
}

function createColumn(descriptor) {
  const { key, title, tabs, type, windowId } = descriptor;
  const column = document.createElement("section");
  column.className = "column";
  if (state.filterGroup && state.filterGroup !== key) {
    column.classList.add("filtered-out");
  }

  const header = document.createElement("header");
  header.className = "column-header";
  if (type === 'group') {
    header.draggable = true;
    header.addEventListener("dragstart", () => {
      state.dragColumnGroup = key;
    });
    header.addEventListener("dragend", () => {
      state.dragColumnGroup = null;
    });
  }

  const titleEl = document.createElement("h2");
  titleEl.className = "column-title";
  titleEl.textContent = title;

  const count = document.createElement("span");
  count.className = "column-count";
  count.textContent = `${tabs.length}`;

  header.append(titleEl, count);

  const closeBtn = document.createElement("button");
  closeBtn.className = "header-close";
  closeBtn.textContent = "×";
  closeBtn.title = type === 'group' ? "Close group" : "Close window";
  closeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (type === 'group') {
      executeOrQueue({ type: 'closeGroup', groupName: key });
    } else if (type === 'window') {
      // Confirm? According to spec, confirmDestructive only for Organise/Apply, so no confirm here.
      executeOrQueue({ type: 'closeWindow', windowId });
    }
  });
  header.appendChild(closeBtn);

  header.addEventListener("dblclick", () => {
    if (state.filterGroup === key) {
      state.filterGroup = null;
    } else {
      state.filterGroup = key;
    }
    renderBoard();
  });

  const body = document.createElement("div");
  body.className = "column-body";
  body.dataset.columnKey = key;

  body.addEventListener("dragover", (event) => {
    if (!state.dragCardTabId) {
      return;
    }
    event.preventDefault();
    body.classList.add("drag-over");
    const rect = body.getBoundingClientRect();
    const y = event.clientY - rect.top;
    const children = Array.from(body.children).filter(c => c.classList.contains('tab-card'));
    let index = children.length;
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      const childRect = child.getBoundingClientRect();
      if (y < childRect.top + childRect.height / 2) {
        index = i;
        break;
      }
    }
    state.dragInsertionIndex = index;
    body.dataset.insertionIndex = index;
    // drop indicator
    let indicator = body.querySelector('.drop-indicator');
    if (!indicator) {
      indicator = document.createElement('div');
      indicator.className = 'drop-indicator';
      body.appendChild(indicator);
    }
    const childrenList = Array.from(body.children).filter(c => c.classList.contains('tab-card'));
    if (index < childrenList.length) {
      const target = childrenList[index];
      const targetRect = target.getBoundingClientRect();
      indicator.style.top = `${targetRect.top - rect.top}px`;
    } else {
      indicator.style.top = `${body.scrollHeight}px`;
    }
  });

  body.addEventListener("dragleave", () => {
    body.classList.remove("drag-over");
    state.dragInsertionIndex = null;
    if (body.dataset.insertionIndex) delete body.dataset.insertionIndex;
  });

  body.addEventListener("drop", async (event) => {
    event.preventDefault();
    body.classList.remove("drag-over");
    const insertionIndex = Number(body.dataset.insertionIndex) || 0;
    state.dragInsertionIndex = null;
    if (body.querySelector('.drop-indicator')) {
      body.querySelector('.drop-indicator').remove();
    }
    const tabId = state.dragCardTabId;
    if (!tabId) return;

    if (type === 'group' && state.viewMode === 'groups') {
      if (key === 'Ungrouped') {
        await executeOrQueue({ type: 'updateAssignment', tabId, groupName: 'Ungrouped' });
      } else {
        if (key === state.dragColumnGroup) {
          const columnTabs = tabs;
          const newOrder = [...columnTabs.map(t => t.tabId)];
          const currentIdx = newOrder.indexOf(tabId);
          if (currentIdx !== -1) {
            newOrder.splice(currentIdx, 1);
          }
          newOrder.splice(insertionIndex, 0, tabId);
          await executeOrQueue({ type: 'setTabOrder', key, tabIds: newOrder });
        } else {
          await executeOrQueue({ type: 'updateAssignment', tabId, groupName: key });
        }
      }
    } else {
      // dropping onto a window column is not allowed
      // ignore or could move tab assignment? But we only allow moving via sidebar
    }
    state.dragCardTabId = null;
  });

  if (tabs.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No tabs";
    body.appendChild(empty);
  } else {
    tabs.forEach((tab) => body.appendChild(createCard(tab)));
  }

  column.append(header, body);
  return column;
}

function showError(message) {
  el.board.textContent = "";
  const p = document.createElement("p");
  p.className = "error";
  p.textContent = message;
  el.board.appendChild(p);
}

function renderBoard() {
  setSubtitle();
  renderWindowDropZones();

  const columnsData = buildColumnsData();
  el.board.textContent = "";
  if (state.viewMode === 'windows') {
    const sortedKeys = Array.from(columnsData.keys()).sort((a, b) => {
      const idA = parseInt(a.replace('win-', ''), 10);
      const idB = parseInt(b.replace('win-', ''), 10);
      return idA - idB;
    });
    sortedKeys.forEach(key => {
      const col = columnsData.get(key);
      el.board.appendChild(createColumn(col));
    });
  } else {
    const order = [...(state.groups || []), 'Ungrouped'];
    order.forEach(key => {
      if (columnsData.has(key)) {
        el.board.appendChild(createColumn(columnsData.get(key)));
      }
    });
  }
}

async function refresh() {
  const data = await sendMessage({ type: "getTabData" });
  state.groups = data.groups || [];
  state.assignments = data.assignments || {};
  state.windowInfo = data.windowInfo || {};
  state.selectedWindowIds = data.selectedWindowIds || [];
  state.useNativeGroups = Boolean(data.useNativeGroups);
  state.confirmDestructive = Boolean(data.confirmDestructive);
  state.mirrorMode = data.mirrorMode !== undefined ? data.mirrorMode : true;
  state.deleteGroupOnClose = data.deleteGroupOnClose || false;
  state.organiseMode = data.organiseMode || 'groups';
  state.tabOrders = data.tabOrders || {};

  if (state.filterGroup && !state.groups.includes(state.filterGroup) && state.filterGroup !== "Ungrouped") {
    state.filterGroup = null;
  }

  // Sync UI controls
  el.mirrorToggle.checked = state.mirrorMode;
  el.organiseMode.value = state.organiseMode;

  updatePendingCounter();
  renderBoard();
}

el.viewToggle.addEventListener("click", () => {
  state.viewMode = state.viewMode === 'groups' ? 'windows' : 'groups';
  el.viewToggle.textContent = state.viewMode === 'groups' ? 'View: Windows' : 'View: Groups';
  renderBoard();
});

el.addGroupBtn.addEventListener("click", async () => {
  const value = el.newGroupInput.value.trim();
  if (!value) {
    return;
  }
  try {
    await executeOrQueue({ type: 'addGroup', groupName: value });
    el.newGroupInput.value = '';
    el.newGroupInput.focus();
  } catch (error) {
    showError(error.message);
  }
});

el.newGroupInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    el.addGroupBtn.click();
  }
});

el.organiseMode.addEventListener("change", async () => {
  const newMode = el.organiseMode.value;
  try {
    await sendMessage({
      type: 'setAppSettings',
      settings: { organiseMode: newMode }
    });
    state.organiseMode = newMode;
  } catch (error) {
    showError(error.message);
    el.organiseMode.value = state.organiseMode;
  }
});

el.mirrorToggle.addEventListener("change", async () => {
  const newMode = el.mirrorToggle.checked;
  try {
    await sendMessage({
      type: 'setAppSettings',
      settings: { mirrorMode: newMode }
    });
    state.mirrorMode = newMode;
    updatePendingCounter();
  } catch (error) {
    showError(error.message);
    el.mirrorToggle.checked = state.mirrorMode;
  }
});

el.organiseBtn.addEventListener("click", async () => {
  if (state.confirmDestructive) {
    const msg = state.organiseMode === 'groups'
      ? "Organise tabs into groups? This will reassign all tabs."
      : "Organise tabs into windows? This will move tabs to new windows.";
    if (!window.confirm(msg)) {
      return;
    }
  }
  const opType = state.organiseMode === 'groups' ? 'organise' : 'organiseIntoWindows';
  await executeOrQueue({ type: opType });
});

el.applyBtn.addEventListener("click", async () => {
  if (state.confirmDestructive && state.pendingOps.length > 0) {
    if (!window.confirm(`Apply ${state.pendingOps.length} pending changes?`)) {
      return;
    }
  }
  await applyAll();
});

el.revertBtn.addEventListener("click", () => {
  revertAll();
});

el.refreshBtn.addEventListener("click", () => {
  refresh().catch(error => showError(error.message));
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") {
    return;
  }
  const relevant = changes.groups || changes.assignments || changes.selectedWindowIds ||
    changes.windowInfo || changes.useNativeGroups || changes.mirrorMode ||
    changes.deleteGroupOnClose || changes.organiseMode || changes.tabOrders;
  if (relevant) {
    refresh().catch(error => showError(error.message));
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message && message.type === "refreshKanban") {
    refresh().catch(error => showError(error.message));
  }
});

refresh().catch(error => showError(error.message));
