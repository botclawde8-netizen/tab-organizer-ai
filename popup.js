const { getState, setState, sanitizeGroupName } = self.TabOrganizerUtils;

const state = {
  windowInfo: {},
  selectedWindowIds: null,
  groups: [],
  useNativeGroups: false,
  apiKey: "",
  confirmDestructive: false,
  expandedWindows: new Set()
};

const el = {
  apiKeyInput: document.getElementById("apiKeyInput"),
  saveApiKeyBtn: document.getElementById("saveApiKeyBtn"),
  windowsContainer: document.getElementById("windowsContainer"),
  selectAllBtn: document.getElementById("selectAllBtn"),
  minimizeAllBtn: document.getElementById("minimizeAllBtn"),
  nativeGroupsToggle: document.getElementById("nativeGroupsToggle"),
  confirmToggle: document.getElementById("confirmToggle"),
  groupsContainer: document.getElementById("groupsContainer"),
  addGroupBtn: document.getElementById("addGroupBtn"),
  generateBtn: document.getElementById("generateBtn"),
  organiseBtn: document.getElementById("organiseBtn"),
  kanbanBtn: document.getElementById("kanbanBtn"),
  status: document.getElementById("status")
};

function setStatus(message, isError) {
  el.status.textContent = message || "";
  el.status.classList.toggle("error", Boolean(isError));
}

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

function createTabRow(tab) {
  const row = document.createElement("div");
  row.className = "tab-item";

  const icon = document.createElement("img");
  icon.src = tab.favIconUrl || "";
  icon.alt = "";
  icon.referrerPolicy = "no-referrer";
  icon.onerror = () => {
    icon.style.visibility = "hidden";
  };

  const title = document.createElement("span");
  title.textContent = tab.title || "Untitled";

  row.append(icon, title);
  return row;
}

function renderWindows() {
  const windows = Object.entries(state.windowInfo);
  el.windowsContainer.textContent = "";
  const allWindowIds = windows.map(([windowId]) => Number(windowId));

  // Update Select All button text
  const allSelected = state.selectedWindowIds == null || (Array.isArray(state.selectedWindowIds) && state.selectedWindowIds.length === allWindowIds.length && allWindowIds.every(id => state.selectedWindowIds.includes(id)));
  el.selectAllBtn.textContent = allSelected ? "Deselect All" : "Select All";

  if (!windows.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No windows detected.";
    el.windowsContainer.appendChild(empty);
    return;
  }

  windows.forEach(([windowId, info]) => {
    const numericId = Number(windowId);
    const wrapper = document.createElement("div");
    wrapper.className = "window-row";
    // Highlight open windows (not minimized)
    if (info.state && info.state !== 'minimized') {
      wrapper.classList.add("open-window");
    }

    const head = document.createElement("div");
    head.className = "window-head";

    const expander = document.createElement("button");
    expander.type = "button";
    expander.className = "expander";
    const expanded = state.expandedWindows.has(numericId);
    expander.textContent = expanded ? "▼" : "▶";
    expander.addEventListener("click", (e) => {
      e.stopPropagation();
      if (state.expandedWindows.has(numericId)) {
        state.expandedWindows.delete(numericId);
      } else {
        state.expandedWindows.add(numericId);
      }
      renderWindows();
    });

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    const explicit = state.selectedWindowIds != null;
    checkbox.checked = explicit ? state.selectedWindowIds.includes(numericId) : true;
    checkbox.addEventListener("change", async () => {
      const currentExplicit = state.selectedWindowIds != null;
      let selectedSet = currentExplicit ? new Set(state.selectedWindowIds) : new Set(allWindowIds);
      if (checkbox.checked) {
        selectedSet.add(numericId);
      } else {
        selectedSet.delete(numericId);
      }
      let newSelection;
      if (selectedSet.size === allWindowIds.length) {
        newSelection = null;
      } else {
        newSelection = Array.from(selectedSet);
      }
      state.selectedWindowIds = newSelection;
      try {
        await sendMessage({ type: "setSelectedWindows", windowIds: newSelection });
        setStatus("Window selection updated.");
        renderWindows();
      } catch (error) {
        setStatus(error.message, true);
      }
    });

    const title = document.createElement("div");
    title.className = "window-title";
    title.textContent = `${info.title || `Window ${windowId}`} (${(info.tabs || []).length} tabs)`;

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "close-window-btn";
    closeBtn.textContent = "×";
    closeBtn.title = "Close window";
    closeBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const confirmed = !state.confirmDestructive || window.confirm(`Close window "${info.title}"?`);
      if (confirmed) {
        try {
          await sendMessage({ type: "closeWindow", windowId: numericId });
          await refreshSnapshot();
        } catch (err) {
          setStatus(err.message, true);
        }
      }
    });

    head.append(expander, checkbox, title, closeBtn);
    wrapper.appendChild(head);

    head.addEventListener("dblclick", async (e) => {
      if (e.target === closeBtn) return;
      const confirmed = !state.confirmDestructive || window.confirm(`Toggle minimize for window "${info.title}"?`);
      if (confirmed) {
        try {
          await sendMessage({ type: "toggleWindowMinimize", windowId: numericId });
          await refreshSnapshot();
        } catch (err) {
          setStatus(err.message, true);
        }
      }
    });

    const tabList = document.createElement("div");
    tabList.className = "tab-list";
    tabList.style.display = expanded ? "flex" : "none";
    (info.tabs || []).forEach((tab) => tabList.appendChild(createTabRow(tab)));
    wrapper.appendChild(tabList);

    el.windowsContainer.appendChild(wrapper);
  });
}

function getDraftGroups() {
  const rows = Array.from(el.groupsContainer.querySelectorAll(".group-row input"));
  const out = [];
  const seen = new Set();
  rows.forEach((input) => {
    const name = sanitizeGroupName(input.value);
    if (!name) {
      return;
    }
    const key = name.toLowerCase();
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    out.push(name);
  });
  return out;
}

function saveGroupsFromUi() {
  state.groups = getDraftGroups();
  return sendMessage({ type: "setGroups", groups: state.groups });
}

function renderGroups() {
  el.groupsContainer.textContent = "";

  if (!state.groups.length) {
    addGroupRow("");
    return;
  }

  state.groups.forEach((groupName) => addGroupRow(groupName));
}

function addGroupRow(groupName) {
  const row = document.createElement("div");
  row.className = "group-row";

  const input = document.createElement("input");
  input.type = "text";
  input.value = groupName || "";
  input.placeholder = "Group name";

  // Paste multiple groups (newline separated)
  input.addEventListener("paste", async (e) => {
    e.preventDefault();
    const paste = e.clipboardData.getData("text");
    const names = paste.split('\n').map(s => s.trim()).filter(s => s);
    if (names.length === 0) return;

    // Replace current row with first pasted group
    const currentValue = input.value.trim();
    const allNames = currentValue ? [currentValue, ...names] : names;
    // Clear existing groups and rebuild from all names
    state.groups = allNames;
    await saveGroupsFromUi();
    renderGroups();
    // After paste re-render, focus the last input
    const inputs = el.groupsContainer.querySelectorAll('input');
    if (inputs.length) {
      const last = inputs[inputs.length - 1];
      last.focus();
      last.select();
    }
  });

  input.addEventListener("blur", async () => {
    await saveGroupsFromUi();
    state.groups = getDraftGroups();
    renderGroups();
  });

  const del = document.createElement("button");
  del.type = "button";
  del.className = "delete-btn";
  del.textContent = "×";
  del.addEventListener("click", async () => {
    row.remove();
    await saveGroupsFromUi();
    state.groups = getDraftGroups();
    renderGroups();
  });

  row.append(input, del);
  el.groupsContainer.appendChild(row);
}

async function refreshSnapshot() {
  const data = await sendMessage({ type: "getTabData" });
  state.windowInfo = data.windowInfo || {};
  state.selectedWindowIds = data.selectedWindowIds || null;
  state.groups = data.groups || [];
  state.useNativeGroups = Boolean(data.useNativeGroups);
  state.confirmDestructive = data.confirmDestructive || false;
  state.apiKey = data.apiKeySet ? "********" : "";

  el.nativeGroupsToggle.checked = state.useNativeGroups;
  el.confirmToggle.checked = state.confirmDestructive;
  el.apiKeyInput.value = "";
  renderWindows();
  renderGroups();

  if (!data.apiKeySet) {
    setStatus("OpenRouter API key required before AI actions.", true);
  } else {
    setStatus("");
  }
}

function disableActions(disabled) {
  [el.generateBtn, el.organiseBtn, el.saveApiKeyBtn].forEach((button) => {
    button.disabled = disabled;
  });
}

el.saveApiKeyBtn.addEventListener("click", async () => {
  try {
    const key = el.apiKeyInput.value.trim();
    await sendMessage({ type: "setApiKey", apiKey: key });
    setStatus(key ? "API key saved." : "API key cleared.");
    el.apiKeyInput.value = "";
  } catch (error) {
    setStatus(error.message, true);
  }
});

el.nativeGroupsToggle.addEventListener("change", async () => {
  try {
    await sendMessage({ type: "setUseNativeGroups", useNativeGroups: el.nativeGroupsToggle.checked });
    setStatus("Native group setting updated.");
  } catch (error) {
    setStatus(error.message, true);
    el.nativeGroupsToggle.checked = !el.nativeGroupsToggle.checked;
  }
});

el.addGroupBtn.addEventListener("click", () => {
  addGroupRow("");
  const inputs = el.groupsContainer.querySelectorAll('input');
  if (inputs.length) {
    const last = inputs[inputs.length - 1];
    last.focus();
    last.select();
  }
});

el.generateBtn.addEventListener("click", async () => {
  disableActions(true);
  setStatus("Generating groups...");
  try {
    await saveGroupsFromUi();
    const result = await sendMessage({ type: "generateGroups" });
    state.groups = result.groups || [];
    renderGroups();
    setStatus(`Generated ${state.groups.length} groups.`);
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    disableActions(false);
  }
});

el.organiseBtn.addEventListener("click", async () => {
  disableActions(true);
  setStatus("Organising tabs...");
  try {
    await saveGroupsFromUi();
    await sendMessage({ type: "organise" });
    setStatus("Tabs organised.");
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    disableActions(false);
  }
});

el.kanbanBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("kanban.html") });
});

el.selectAllBtn.addEventListener("click", async () => {
  const allWindowIds = Object.keys(state.windowInfo).map(Number);
  const allSelected = state.selectedWindowIds == null || (Array.isArray(state.selectedWindowIds) && state.selectedWindowIds.length === allWindowIds.length && allWindowIds.every(id => state.selectedWindowIds.includes(id)));
  const newSelection = allSelected ? [] : null;
  state.selectedWindowIds = newSelection;
  try {
    await sendMessage({ type: "setSelectedWindows", windowIds: newSelection });
    renderWindows();
  } catch (error) {
    setStatus(error.message, true);
  }
});

el.minimizeAllBtn.addEventListener("click", async () => {
  const confirmed = !state.confirmDestructive || window.confirm("Minimize all windows?");
  if (confirmed) {
    try {
      await sendMessage({ type: "minimizeAll" });
      await refreshSnapshot();
    } catch (error) {
      setStatus(error.message, true);
    }
  }
});

el.confirmToggle.addEventListener("change", async () => {
  const newVal = el.confirmToggle.checked;
  try {
    await sendMessage({ type: "setConfirmDestructive", confirmDestructive: newVal });
    state.confirmDestructive = newVal;
    setStatus("Confirmation setting updated.");
  } catch (error) {
    setStatus(error.message, true);
    el.confirmToggle.checked = !newVal;
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") {
    return;
  }
  if (changes.groups || changes.selectedWindowIds || changes.useNativeGroups || changes.windowInfo) {
    refreshSnapshot().catch((error) => setStatus(error.message, true));
  }
});

refreshSnapshot().catch((error) => {
  setStatus(error.message, true);
});
