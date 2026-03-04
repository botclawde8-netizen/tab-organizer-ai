const { getState, setState, sanitizeGroupName } = self.TabOrganizerUtils;

const state = {
  windowInfo: {},
  selectedWindowIds: [],
  groups: [],
  useNativeGroups: false,
  apiKey: "",
  expandedWindows: new Set()
};

const el = {
  apiKeyInput: document.getElementById("apiKeyInput"),
  saveApiKeyBtn: document.getElementById("saveApiKeyBtn"),
  windowsContainer: document.getElementById("windowsContainer"),
  nativeGroupsToggle: document.getElementById("nativeGroupsToggle"),
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
  const hasExplicitSelection = state.selectedWindowIds.length > 0;
  const allWindowIds = windows.map(([windowId]) => Number(windowId));

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

    const head = document.createElement("div");
    head.className = "window-head";

    const expander = document.createElement("button");
    expander.type = "button";
    expander.className = "expander";
    const expanded = state.expandedWindows.has(numericId);
    expander.textContent = expanded ? "▼" : "▶";
    expander.addEventListener("click", () => {
      if (state.expandedWindows.has(numericId)) {
        state.expandedWindows.delete(numericId);
      } else {
        state.expandedWindows.add(numericId);
      }
      renderWindows();
    });

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = hasExplicitSelection ? state.selectedWindowIds.includes(numericId) : true;
    checkbox.addEventListener("change", async () => {
      const selected = new Set(
        state.selectedWindowIds.length > 0 ? state.selectedWindowIds : allWindowIds
      );
      if (checkbox.checked) {
        selected.add(numericId);
      } else {
        selected.delete(numericId);
      }
      state.selectedWindowIds = Array.from(selected);
      await sendMessage({ type: "setSelectedWindows", windowIds: state.selectedWindowIds });
      setStatus("Window selection updated.");
    });

    const title = document.createElement("div");
    title.className = "window-title";
    title.textContent = `${info.title || `Window ${windowId}`} (${(info.tabs || []).length} tabs)`;

    head.append(expander, checkbox, title);
    wrapper.appendChild(head);

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
  state.selectedWindowIds = data.selectedWindowIds || [];
  state.groups = data.groups || [];
  state.useNativeGroups = Boolean(data.useNativeGroups);
  state.apiKey = data.apiKeySet ? "********" : "";

  el.nativeGroupsToggle.checked = state.useNativeGroups;
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
