const state = {
  groups: [],
  assignments: {},
  selectedWindowIds: [],
  windowInfo: {},
  useNativeGroups: false,
  filterGroup: null,
  dragCardTabId: null,
  dragColumnGroup: null
};

const el = {
  subtitle: document.getElementById("subtitle"),
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
  const columns = {};

  (state.groups || []).forEach((group) => {
    columns[group] = [];
  });
  columns.Ungrouped = [];

  tabs.forEach((tab) => {
    const assigned = state.assignments?.[tab.tabId];
    if (assigned && Object.prototype.hasOwnProperty.call(columns, assigned)) {
      columns[assigned].push(tab);
    } else {
      columns.Ungrouped.push(tab);
    }
  });

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
      if (!state.dragColumnGroup || state.dragColumnGroup === "Ungrouped") {
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

      if (!state.dragColumnGroup || state.dragColumnGroup === "Ungrouped") {
        return;
      }

      try {
        await sendMessage({
          type: "moveGroupToWindow",
          groupName: state.dragColumnGroup,
          targetWindowId: Number(windowId)
        });
        await refresh();
      } catch (error) {
        showError(error.message);
      } finally {
        state.dragColumnGroup = null;
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

  icon.src = tab.favIconUrl || "";
  icon.referrerPolicy = "no-referrer";
  icon.onerror = () => {
    icon.style.visibility = "hidden";
  };

  title.textContent = tab.title || "Untitled";
  badge.textContent = tab.windowTitle;

  node.dataset.tabId = String(tab.tabId);

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

async function onCardDrop(groupName) {
  if (!state.dragCardTabId) {
    return;
  }

  const targetGroup = groupName === "Ungrouped" ? "Ungrouped" : groupName;

  await sendMessage({
    type: "updateAssignment",
    tabId: state.dragCardTabId,
    groupName: targetGroup
  });
  await refresh();
}

function createColumn(groupName, tabs) {
  const column = document.createElement("section");
  column.className = "column";
  if (state.filterGroup && state.filterGroup !== groupName) {
    column.classList.add("filtered-out");
  }

  const header = document.createElement("header");
  header.className = "column-header";
  header.draggable = groupName !== "Ungrouped";

  const title = document.createElement("h2");
  title.className = "column-title";
  title.textContent = groupName;

  const count = document.createElement("span");
  count.className = "column-count";
  count.textContent = `${tabs.length}`;

  header.append(title, count);

  header.addEventListener("dblclick", () => {
    if (state.filterGroup === groupName) {
      state.filterGroup = null;
    } else {
      state.filterGroup = groupName;
    }
    renderBoard();
  });

  if (groupName !== "Ungrouped") {
    header.addEventListener("dragstart", () => {
      state.dragColumnGroup = groupName;
    });

    header.addEventListener("dragend", () => {
      state.dragColumnGroup = null;
    });
  }

  const body = document.createElement("div");
  body.className = "column-body";

  body.addEventListener("dragover", (event) => {
    if (!state.dragCardTabId) {
      return;
    }
    event.preventDefault();
    body.classList.add("drag-over");
  });

  body.addEventListener("dragleave", () => {
    body.classList.remove("drag-over");
  });

  body.addEventListener("drop", async (event) => {
    event.preventDefault();
    body.classList.remove("drag-over");
    try {
      await onCardDrop(groupName);
    } catch (error) {
      showError(error.message);
    }
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
  const order = [...(state.groups || []), "Ungrouped"];

  el.board.textContent = "";
  order.forEach((groupName) => {
    const tabs = columnsData[groupName] || [];
    el.board.appendChild(createColumn(groupName, tabs));
  });
}

async function refresh() {
  const data = await sendMessage({ type: "getTabData" });
  state.groups = data.groups || [];
  state.assignments = data.assignments || {};
  state.windowInfo = data.windowInfo || {};
  state.selectedWindowIds = data.selectedWindowIds || [];
  state.useNativeGroups = Boolean(data.useNativeGroups);

  if (state.filterGroup && !state.groups.includes(state.filterGroup) && state.filterGroup !== "Ungrouped") {
    state.filterGroup = null;
  }

  renderBoard();
}

el.refreshBtn.addEventListener("click", () => {
  refresh().catch((error) => showError(error.message));
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") {
    return;
  }

  if (changes.groups || changes.assignments || changes.selectedWindowIds || changes.windowInfo || changes.useNativeGroups) {
    refresh().catch((error) => showError(error.message));
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message && message.type === "refreshKanban") {
    refresh().catch((error) => showError(error.message));
  }
});

refresh().catch((error) => showError(error.message));
