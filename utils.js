(function () {
  const DEFAULT_STATE = {
    groups: [],
    assignments: {},
    selectedWindowIds: null,
    useNativeGroups: false,
    windowInfo: {},
    groupIds: {},
    apiKey: "",
    confirmDestructive: false,
    mirrorMode: true,
    deleteGroupOnClose: false,
    organiseMode: 'groups',
    tabOrders: {}
  };

  const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
  const OPENROUTER_MODEL = "stepfun/step-3.5-flash:free";

  function sanitizeGroupName(name) {
    return String(name || "").trim();
  }

  function normalizeGroups(groups) {
    const seen = new Set();
    const output = [];

    (Array.isArray(groups) ? groups : []).forEach((group) => {
      const cleaned = sanitizeGroupName(group);
      if (!cleaned) {
        return;
      }
      const key = cleaned.toLowerCase();
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      output.push(cleaned);
    });

    return output;
  }

  function extractJsonObject(text) {
    const raw = String(text || "").trim();
    if (!raw) {
      throw new Error("Empty model response.");
    }

    try {
      return JSON.parse(raw);
    } catch (_directError) {
      const start = raw.indexOf("{");
      const end = raw.lastIndexOf("}");
      if (start === -1 || end === -1 || end <= start) {
        throw new Error("Model did not return valid JSON.");
      }
      const sliced = raw.slice(start, end + 1);
      return JSON.parse(sliced);
    }
  }

  function pickTabData(tab) {
    return {
      tabId: tab.id,
      title: tab.title || "Untitled",
      url: tab.url || "",
      favIconUrl: tab.favIconUrl || "",
      groupId: typeof tab.groupId === "number" ? tab.groupId : -1,
      windowId: tab.windowId
    };
  }

  function pickWindowTitle(windowObj, tabs) {
    const firstTitle = tabs.find((tab) => tab.title)?.title || "";
    if (windowObj.focused) {
      return `Current Window (${tabs.length} tabs)`;
    }
    if (firstTitle) {
      return `${firstTitle.slice(0, 40)}${firstTitle.length > 40 ? "..." : ""}`;
    }
    return `Window ${windowObj.id}`;
  }

  function computeTabDiff(currentWindowInfo, previousWindowInfo) {
    // Disabled: token efficiency not implemented correctly
    // const currentTabs = new Map();
    // const previousTabs = new Map();

    // Object.entries(currentWindowInfo).forEach(([winId, win]) => {
    //   (win.tabs || []).forEach(tab => {
    //     currentTabs.set(tab.tabId, { ...tab, windowId: Number(winId), windowTitle: win.title });
    //   });
    // });

    // Object.entries(previousWindowInfo).forEach(([winId, win]) => {
    //   (win.tabs || []).forEach(tab => {
    //     previousTabs.set(tab.tabId, { ...tab, windowId: Number(winId), windowTitle: win.title });
    //   });
    // });

    // const added = [];
    // const removed = [];
    // const modified = [];

    // for (const [id, tab] of currentTabs) {
    //   if (!previousTabs.has(id)) {
    //     added.push(tab);
    //   } else {
    //     const prev = previousTabs.get(id);
    //     if (tab.title !== prev.title || tab.url !== prev.url) {
    //       modified.push({ current: tab, previous: prev });
    //     }
    //   }
    // }

    // for (const [id, tab] of previousTabs) {
    //   if (!currentTabs.has(id)) {
    //     removed.push(tab);
    //   }
    // }

    // return { added, removed, modified };
    return { added: [], removed: [], modified: [] };
  }

  function escapeQuotes(str) {
    return String(str || "").replace(/"/g, '\\"');
  }

  function createTabSummary(windowInfo, selectedWindowIds) {
    const useAll = selectedWindowIds == null;
    const selectedSet = useAll ? null : new Set(selectedWindowIds);
    const items = [];
    Object.entries(windowInfo || {}).forEach(([windowId, info]) => {
      const numericId = Number(windowId);
      if (!useAll && !selectedSet.has(numericId)) {
        return;
      }
      (info.tabs || []).forEach((tab) => {
        items.push({
          windowId: numericId,
          windowTitle: info.title || `Window ${windowId}`,
          tabId: tab.tabId,
          title: tab.title || "Untitled",
          url: tab.url || ""
        });
      });
    });
    return items;
  }

  function storageGet(keys) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.get(keys, (result) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(result);
      });
    });
  }

  function storageSet(values) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.set(values, () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve();
      });
    });
  }

  async function getState() {
    const current = await storageGet(Object.keys(DEFAULT_STATE));
    return {
      ...DEFAULT_STATE,
      ...current,
      groups: normalizeGroups(current.groups || DEFAULT_STATE.groups),
      assignments: current.assignments || DEFAULT_STATE.assignments,
      selectedWindowIds: Array.isArray(current.selectedWindowIds)
        ? current.selectedWindowIds
        : DEFAULT_STATE.selectedWindowIds,
      useNativeGroups: Boolean(current.useNativeGroups),
      windowInfo: current.windowInfo || DEFAULT_STATE.windowInfo,
      groupIds: current.groupIds || DEFAULT_STATE.groupIds,
      apiKey: String(current.apiKey || "")
    };
  }

  async function setState(partial) {
    const toSet = { ...partial };
    if (Object.prototype.hasOwnProperty.call(toSet, "groups")) {
      toSet.groups = normalizeGroups(toSet.groups);
    }
    await storageSet(toSet);
  }

  async function callOpenRouter(userPrompt, options) {
    const state = await getState();
    const apiKey = state.apiKey;
    if (!apiKey) {
      throw new Error("Missing OpenRouter API key. Add it in the popup first.");
    }

    const body = {
      model: OPENROUTER_MODEL,
      temperature: options && typeof options.temperature === "number" ? options.temperature : 0.2,
      messages: [
        {
          role: "system",
          content:
            "You are a strict JSON API. Return only valid JSON with no markdown, code fences, or commentary."
        },
        {
          role: "user",
          content: userPrompt
        }
      ]
    };

    const response = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://chrome-extension.local/ai-tab-organizer",
        "X-Title": "AI Tab Organizer"
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OpenRouter request failed (${response.status}): ${text.slice(0, 400)}`);
    }

    const payload = await response.json();
    const content = payload?.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("OpenRouter returned no message content.");
    }

    return extractJsonObject(content);
  }

  const TabOrganizerUtils = {
    DEFAULT_STATE,
    OPENROUTER_MODEL,
    sanitizeGroupName,
    normalizeGroups,
    extractJsonObject,
    pickTabData,
    pickWindowTitle,
    createTabSummary,
    storageGet,
    storageSet,
    getState,
    setState,
    callOpenRouter
  };

  if (typeof self !== "undefined") {
    self.TabOrganizerUtils = TabOrganizerUtils;
  }
})();
