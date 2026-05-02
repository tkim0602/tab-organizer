const organizeCurrentButton = document.querySelector("#organizeCurrentButton");
const consolidateButton = document.querySelector("#consolidateButton");
const undoButton = document.querySelector("#undoButton");
const applyPreviewButton = document.querySelector("#applyPreviewButton");
const cancelPreviewButton = document.querySelector("#cancelPreviewButton");
const statusElement = document.querySelector("#status");
const previewPanel = document.querySelector("#previewPanel");
const previewMeta = document.querySelector("#previewMeta");
const previewGroups = document.querySelector("#previewGroups");
let undoAvailableState = false;
let currentPreviewPlan = null;

const ACTIONS = {
  currentWindow: {
    command: "tab-organizer preview --window=current",
    pendingLines: [
      "screen tabs",
      "classify metadata",
      "draft plan"
    ]
  },
  crossWindow: {
    command: "tab-organizer preview --windows=all --target=current",
    pendingLines: [
      "scan windows",
      "screen tabs",
      "classify metadata",
      "draft plan"
    ]
  },
  apply: {
    command: "tab-organizer apply --reviewed",
    pendingLines: [
      "load review",
      "move approved tabs",
      "write groups"
    ]
  },
  undo: {
    command: "tab-organizer undo --last",
    pendingLines: [
      "load snapshot",
      "restore windows",
      "restore groups"
    ]
  }
};

organizeCurrentButton.addEventListener("click", async () => {
  await runPreviewAction("currentWindow");
});

consolidateButton.addEventListener("click", async () => {
  await runPreviewAction("crossWindow");
});

applyPreviewButton.addEventListener("click", async () => {
  await applyPreview();
});

cancelPreviewButton.addEventListener("click", async () => {
  await cancelPreview();
});

undoButton.addEventListener("click", async () => {
  await runUndoAction();
});

document.addEventListener("DOMContentLoaded", refreshStatus);
refreshStatus();

async function runPreviewAction(mode) {
  const action = ACTIONS[mode];

  setBusy(true);
  await runTerminalSequence(action.command, action.pendingLines);
  const response = await sendMessage({
    type: "PREVIEW_ORGANIZATION",
    mode
  });

  if (!response.ok) {
    await typeTerminal([`> ${action.command}`, `error: ${response.error || "Something went wrong."}`]);
    setBusy(false);
    return;
  }

  currentPreviewPlan = response.previewPlan;
  undoAvailableState = Boolean(response.undoAvailable);
  renderPreview(currentPreviewPlan);
  await typeTerminal([
    `> ${action.command}`,
    `review: ${countPreviewTabs(currentPreviewPlan)} tabs`,
    `groups: ${currentPreviewPlan.groups.length}`,
    `classifier: ${formatClassifier(currentPreviewPlan.classifier)}`
  ]);
  setBusy(false);
}

async function applyPreview() {
  if (!currentPreviewPlan) {
    return;
  }

  setBusy(true);
  const action = ACTIONS.apply;
  await runTerminalSequence(action.command, action.pendingLines);
  const response = await sendMessage({
    type: "APPLY_ORGANIZATION",
    planId: currentPreviewPlan.id,
    renamedGroups: collectRenamedGroups(),
    excludedTabIds: collectExcludedTabIds()
  });

  if (!response.ok) {
    await typeTerminal([`> ${action.command}`, `error: ${response.error || "Unable to apply preview."}`]);
    setBusy(false);
    return;
  }

  hidePreview();
  undoAvailableState = Boolean(response.undoAvailable);
  await renderStatus(response.summary, response.undoAvailable, action.command, true);
  setBusy(false);
}

async function cancelPreview() {
  setBusy(true);
  const response = await sendMessage({ type: "CANCEL_PREVIEW" });
  hidePreview();

  if (!response.ok) {
    renderTerminal(["> tab-organizer cancel", `error: ${response.error || "Unable to cancel preview."}`]);
  } else {
    undoAvailableState = Boolean(response.undoAvailable);
    renderTerminal(["> tab-organizer cancel", "review: discarded"]);
  }

  setBusy(false);
}

async function runUndoAction() {
  const action = ACTIONS.undo;

  setBusy(true);
  await runTerminalSequence(action.command, action.pendingLines);
  const response = await sendMessage({ type: "UNDO_LAST_ORGANIZATION" });

  if (!response.ok) {
    await typeTerminal([`> ${action.command}`, `error: ${response.error || "Something went wrong."}`]);
    setBusy(false);
    return;
  }

  hidePreview();
  await renderStatus(response.summary, response.undoAvailable, action.command, true);
  undoAvailableState = Boolean(response.undoAvailable);
  setBusy(false);
}

async function refreshStatus() {
  const response = await sendMessage({ type: "GET_STATUS" });

  if (!response.ok) {
    renderTerminal(["> tab-organizer status", `error: ${response.error || "Unable to load status."}`]);
    undoAvailableState = false;
    undoButton.disabled = true;
    return;
  }

  undoAvailableState = Boolean(response.undoAvailable);

  if (response.previewPlan) {
    currentPreviewPlan = response.previewPlan;
    renderPreview(currentPreviewPlan);
    renderTerminal([
      "> tab-organizer status",
      `review: ${countPreviewTabs(currentPreviewPlan)} tabs pending`,
      `groups: ${currentPreviewPlan.groups.length}`,
      `classifier: ${formatClassifier(currentPreviewPlan.classifier)}`
    ]);
  } else {
    hidePreview();
    await renderStatus(response.summary, response.undoAvailable, "tab-organizer status");
  }

  setBusy(false);
}

async function sendMessage(message) {
  if (!globalThis.chrome?.runtime?.sendMessage) {
    return createFakeResponse(message);
  }

  try {
    return await chrome.runtime.sendMessage(message);
  } catch (error) {
    return {
      ok: false,
      error: error.message
    };
  }
}

function setBusy(isBusy) {
  organizeCurrentButton.disabled = isBusy || Boolean(currentPreviewPlan);
  consolidateButton.disabled = isBusy || Boolean(currentPreviewPlan);
  applyPreviewButton.disabled = isBusy || !currentPreviewPlan;
  cancelPreviewButton.disabled = isBusy || !currentPreviewPlan;
  undoButton.disabled = isBusy || !undoAvailableState;
}

async function renderStatus(summary, undoAvailable, command, shouldType = false) {
  const renderer = shouldType ? typeTerminal : renderTerminal;

  if (!summary) {
    await renderer([`> ${command}`, "ready: preview this window or collect all windows"]);
    return;
  }

  if (typeof summary.tabsRestored === "number") {
    await renderer([
      `> ${command}`,
      `restored: ${summary.tabsRestored} tabs`,
      `windows: ${summary.windowsProcessed}`
    ]);
    return;
  }

  const screenedText = summary.screenedOutTabs
    ? ` ${summary.screenedOutTabs} tabs were screened out.`
    : "";
  const movedText = summary.tabsMovedAcrossWindows
    ? ` Moved ${summary.tabsMovedAcrossWindows} tabs into this window.`
    : "";
  const skippedApplyText = summary.skippedApplyTabs
    ? ` Skipped ${summary.skippedApplyTabs} tabs.`
    : "";
  const windowText = summary.mode === "currentWindow"
    ? "this window"
    : `${summary.windowsProcessed} windows`;

  await renderer([
    `> ${command}`,
    `classifier: ${formatClassifier(summary)}`,
    `organized: ${summary.tabsOrganized} tabs`,
    `groups: ${summary.groupsCreated}`,
    `scope: ${windowText}`,
    movedText.trim(),
    screenedText.trim(),
    skippedApplyText.trim(),
    undoAvailable ? "undo: available" : ""
  ].filter(Boolean));
}

function renderPreview(previewPlan) {
  previewPanel.hidden = false;
  previewMeta.textContent = `${countPreviewTabs(previewPlan)} tabs / ${previewPlan.groups.length} groups`;
  previewGroups.textContent = "";

  for (const group of previewPlan.groups) {
    previewGroups.append(createGroupPreview(group));
  }

  if (previewPlan.singles.length > 0) {
    previewGroups.append(createSinglesPreview(previewPlan.singles));
  }
}

function createGroupPreview(group) {
  const section = document.createElement("section");
  section.className = "preview-group";

  const input = document.createElement("input");
  input.className = "group-name-input";
  input.type = "text";
  input.value = group.category;
  input.dataset.groupId = group.id;
  input.ariaLabel = `Rename ${group.category} group`;
  section.append(input);

  section.append(createTabList(group.tabs));
  return section;
}

function createSinglesPreview(singles) {
  const section = document.createElement("section");
  section.className = "preview-group preview-group-ungrouped";

  const label = document.createElement("p");
  label.className = "ungrouped-title";
  label.textContent = `ungrouped / ${singles.length}`;
  section.append(label);
  section.append(createTabList(singles.map((single) => single.tab).filter(Boolean)));

  return section;
}

function createTabList(tabs) {
  const list = document.createElement("div");
  list.className = "preview-tabs";

  for (const tab of tabs) {
    const row = document.createElement("label");
    row.className = "preview-tab-row";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.dataset.tabId = String(tab.id);
    checkbox.ariaLabel = `Exclude ${tab.title}`;

    const text = document.createElement("span");
    text.className = "preview-tab-text";
    text.textContent = `${tab.title} / ${tab.hostname || "unknown"}`;

    row.append(checkbox, text);
    list.append(row);
  }

  return list;
}

function hidePreview() {
  currentPreviewPlan = null;
  previewPanel.hidden = true;
  previewGroups.textContent = "";
  previewMeta.textContent = "";
}

function collectRenamedGroups() {
  return Object.fromEntries([...previewGroups.querySelectorAll(".group-name-input")]
    .map((input) => [input.dataset.groupId, input.value.trim()]));
}

function collectExcludedTabIds() {
  return [...previewGroups.querySelectorAll(".preview-tab-row input:checked")]
    .map((checkbox) => Number(checkbox.dataset.tabId))
    .filter(Number.isFinite);
}

function countPreviewTabs(previewPlan) {
  return previewPlan.groups.reduce((count, group) => count + group.tabIds.length, 0) + previewPlan.singles.length;
}

function formatClassifier(summaryOrClassifier) {
  const source = summaryOrClassifier.classifierSource || summaryOrClassifier.source;
  const classifiedCount = summaryOrClassifier.aiClassifiedTabs || summaryOrClassifier.categoryMapSize || 0;
  const error = summaryOrClassifier.classifierError || summaryOrClassifier.error;

  if (source?.startsWith("ai:")) {
    return `${source.replace("ai:", "")} (${classifiedCount})`;
  }

  return error ? "local fallback" : "local rules";
}

function renderTerminal(lines) {
  statusElement.textContent = lines.join("\n");
}

async function runTerminalSequence(command, pendingLines) {
  await typeTerminal([`> ${command}`], { lineDelay: 120 });

  for (const line of pendingLines) {
    await appendTerminalLine(`run: ${line} ...`);
  }
}

async function typeTerminal(lines, options = {}) {
  const text = lines.join("\n");
  const lineDelay = options.lineDelay ?? 180;
  statusElement.classList.add("is-typing");
  statusElement.textContent = "";

  for (let index = 0; index < text.length; index += 1) {
    statusElement.textContent += text[index];
    await delay(text[index] === "\n" ? lineDelay : 12);
  }

  statusElement.classList.remove("is-typing");
}

async function appendTerminalLine(line) {
  statusElement.classList.add("is-typing");
  statusElement.textContent += `\n`;

  for (let index = 0; index < line.length; index += 1) {
    statusElement.textContent += line[index];
    await delay(10);
  }

  statusElement.classList.remove("is-typing");
}

function createFakeResponse(message) {
  if (message.type === "GET_STATUS") {
    return {
      ok: true,
      summary: null,
      previewPlan: null,
      undoAvailable: false
    };
  }

  if (message.type === "PREVIEW_ORGANIZATION") {
    return {
      ok: true,
      previewPlan: createFakePreview(message.mode),
      undoAvailable: false
    };
  }

  if (message.type === "APPLY_ORGANIZATION") {
    return {
      ok: true,
      summary: createFakeSummary(),
      undoAvailable: true
    };
  }

  if (message.type === "CANCEL_PREVIEW") {
    return {
      ok: true,
      undoAvailable: false
    };
  }

  return {
    ok: true,
    summary: {
      timestamp: Date.now(),
      windowsProcessed: 2,
      tabsRestored: 18,
      groupsRestored: 5
    },
    undoAvailable: false
  };
}

function createFakePreview(mode) {
  return {
    id: "preview-demo",
    mode,
    classifier: {
      source: "ai:anthropic",
      categoryMapSize: 9,
      error: null
    },
    groups: [
      {
        id: "group-0",
        category: "AI",
        tabIds: [1, 2, 3],
        tabs: [
          { id: 1, title: "Claude", hostname: "claude.ai" },
          { id: 2, title: "OpenAI Docs", hostname: "platform.openai.com" },
          { id: 3, title: "Prompt notes", hostname: "notion.so" }
        ]
      },
      {
        id: "group-1",
        category: "Design",
        tabIds: [4, 5],
        tabs: [
          { id: 4, title: "Figma", hostname: "figma.com" },
          { id: 5, title: "Moodboard", hostname: "pinterest.com" }
        ]
      }
    ],
    singles: [
      {
        tabId: 6,
        category: "Shopping",
        tab: { id: 6, title: "Desk lamp", hostname: "amazon.com" }
      }
    ]
  };
}

function createFakeSummary() {
  return {
    timestamp: Date.now(),
    mode: "crossWindow",
    classifierSource: "ai:anthropic",
    aiClassifiedTabs: 9,
    classifierError: null,
    windowsProcessed: 3,
    tabsOrganized: 8,
    groupsCreated: 2,
    screenedOutTabs: 1,
    skippedApplyTabs: 1,
    tabsMovedAcrossWindows: 4
  };
}

function delay(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
