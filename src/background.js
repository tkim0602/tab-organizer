import { CATEGORY_ORDER, getCategoryColor, getHostname } from "./shared/categories.js";
import { fetchAiCategoryMap } from "./shared/ai-classifier.js";
import { buildApplyPlanFromPreview, buildCrossWindowPlan, buildWindowPlan } from "./shared/organizer.js";

const STORAGE_KEYS = {
  lastSnapshot: "lastSnapshot",
  lastRunSummary: "lastRunSummary",
  pendingPreviewPlan: "pendingPreviewPlan"
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message)
    .then((response) => sendResponse(response))
    .catch((error) => {
      console.error(error);
      sendResponse({ ok: false, error: error.message || "Unexpected error" });
    });

  return true;
});

async function handleMessage(message) {
  switch (message?.type) {
    case "PREVIEW_ORGANIZATION":
      return previewOrganization(message.mode);
    case "APPLY_ORGANIZATION":
      return applyPreviewOrganization(message);
    case "CANCEL_PREVIEW":
      return cancelPreview();
    case "ORGANIZE_CURRENT_WINDOW":
      return previewOrganization("currentWindow");
    case "ORGANIZE_ALL_WINDOWS":
      return previewOrganization("allWindowsSeparate");
    case "CONSOLIDATE_ACROSS_WINDOWS":
      return previewOrganization("crossWindow");
    case "UNDO_LAST_ORGANIZATION":
      return undoLastOrganization();
    case "GET_STATUS":
      return getStatus();
    default:
      return { ok: false, error: "Unknown message type" };
  }
}

async function previewOrganization(mode) {
  if (mode === "crossWindow") {
    return previewCrossWindowOrganization();
  }

  if (mode === "allWindowsSeparate") {
    return previewAllWindowsOrganization();
  }

  return previewCurrentWindowOrganization();
}

async function previewCurrentWindowOrganization() {
  const window = await getFocusedNormalWindow(true);
  const tabs = window.tabs || [];
  const snapshot = await createSnapshot([window]);
  const classifier = await classifyTabsForOrganization(tabs);
  const plan = buildWindowPlan(tabs, {
    categoryOverrides: classifier.categoryMap,
    categoryOrder: classifier.categoryOrder
  });

  const previewPlan = createPreviewPlan({
    mode: "currentWindow",
    targetWindowId: window.id,
    windowsProcessed: 1,
    tabs,
    classifier,
    plan,
    snapshot
  });

  await savePreviewPlan(previewPlan);

  return { ok: true, previewPlan, undoAvailable: await hasUndoSnapshot() };
}

async function previewAllWindowsOrganization() {
  const windows = await chrome.windows.getAll({ populate: true, windowTypes: ["normal"] });
  const snapshot = await createSnapshot(windows);
  const classifier = await classifyTabsForOrganization(flattenWindowTabs(windows));
  const plans = [];

  for (const window of windows) {
    const tabs = window.tabs || [];
    const plan = buildWindowPlan(tabs, {
      categoryOverrides: classifier.categoryMap,
      categoryOrder: classifier.categoryOrder
    });

    plans.push(plan);
  }

  const previewPlan = createMultiWindowPreviewPlan({
    mode: "allWindowsSeparate",
    windowsProcessed: windows.length,
    windows,
    classifier,
    plans,
    snapshot
  });

  await savePreviewPlan(previewPlan);

  return { ok: true, previewPlan, undoAvailable: await hasUndoSnapshot() };
}

async function previewCrossWindowOrganization() {
  const targetWindow = await getFocusedNormalWindow(false);
  const windows = await chrome.windows.getAll({ populate: true, windowTypes: ["normal"] });
  const snapshot = await createSnapshot(windows);
  const orderedTabs = flattenWindowTabs(windows);
  const classifier = await classifyTabsForOrganization(orderedTabs);
  const plan = buildCrossWindowPlan(orderedTabs, targetWindow.id, {
    categoryOverrides: classifier.categoryMap,
    categoryOrder: classifier.categoryOrder
  });

  const previewPlan = createPreviewPlan({
    mode: "crossWindow",
    targetWindowId: targetWindow.id,
    windowsProcessed: windows.length,
    tabs: orderedTabs,
    classifier,
    plan,
    snapshot
  });

  await savePreviewPlan(previewPlan);

  return { ok: true, previewPlan, undoAvailable: await hasUndoSnapshot() };
}

async function applyPreviewOrganization(message) {
  const data = await chrome.storage.local.get(STORAGE_KEYS.pendingPreviewPlan);
  const previewPlan = data[STORAGE_KEYS.pendingPreviewPlan];

  if (!previewPlan || previewPlan.id !== message.planId) {
    return { ok: false, error: "No matching preview plan is available to apply." };
  }

  const liveTabs = await getLiveTabsById();
  const liveWindowIds = new Set((await chrome.windows.getAll({ windowTypes: ["normal"] })).map((window) => window.id));

  if (!liveWindowIds.has(previewPlan.targetWindowId)) {
    return { ok: false, error: "The target window for this preview is no longer open." };
  }

  const applyPlan = buildApplyPlanFromPreview(previewPlan, {
    excludedTabIds: message.excludedTabIds || [],
    renamedGroups: message.renamedGroups || {},
    liveTabIds: [...liveTabs.keys()]
  });
  const tabsMovedAcrossWindows = previewPlan.mode === "crossWindow"
    ? countMovedAcrossPreview(applyPlan.orderedTabIds, previewPlan.tabDetails, previewPlan.targetWindowId)
    : 0;
  const summary = createOrganizationSummary({
    windowsProcessed: previewPlan.windowsProcessed,
    mode: previewPlan.mode,
    targetWindowId: previewPlan.targetWindowId,
    classifier: previewPlan.classifier,
    tabsMovedAcrossWindows,
    skippedApplyTabs: applyPlan.skippedApplyTabIds.length,
    plans: [applyPlan]
  });

  await applyWindowPlan(previewPlan.targetWindowId, applyPlan);
  await chrome.storage.local.remove(STORAGE_KEYS.pendingPreviewPlan);
  await saveOrganizationState(previewPlan.snapshot, summary);

  return {
    ok: true,
    summary,
    undoAvailable: applyPlan.orderedTabIds.length > 0
  };
}

async function cancelPreview() {
  await chrome.storage.local.remove(STORAGE_KEYS.pendingPreviewPlan);
  return { ok: true, undoAvailable: await hasUndoSnapshot() };
}

async function applyWindowPlan(windowId, plan) {
  if (plan.orderedTabIds.length === 0) {
    return;
  }

  await ungroupTabsSafely(plan.orderedTabIds);

  await moveTabsSafely(plan.orderedTabIds, {
    windowId,
    index: plan.startIndex
  });

  for (const [index, group] of plan.groups.entries()) {
    const groupId = await chrome.tabs.group({
      tabIds: group.tabIds,
      createProperties: { windowId }
    });

    await chrome.tabGroups.update(groupId, {
      title: group.category,
      color: getCategoryColor(group.category, index),
      collapsed: false
    });
  }
}

async function createSnapshot(windows) {
  const groupIds = new Set();
  for (const window of windows) {
    for (const tab of window.tabs || []) {
      if (typeof tab.groupId === "number" && tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
        groupIds.add(tab.groupId);
      }
    }
  }

  const groupDetails = {};
  await Promise.all(
    [...groupIds].map(async (groupId) => {
      try {
        groupDetails[groupId] = await chrome.tabGroups.get(groupId);
      } catch {
        groupDetails[groupId] = null;
      }
    })
  );

  return {
    timestamp: Date.now(),
    windows: windows.map((window) => ({
      id: window.id,
      tabs: (window.tabs || []).map((tab) => ({
        id: tab.id,
        index: tab.index,
        pinned: tab.pinned,
        groupId: tab.groupId,
        group: groupDetails[tab.groupId] || null
      }))
    }))
  };
}

async function saveOrganizationState(snapshot, summary) {
  await chrome.storage.local.set({
    [STORAGE_KEYS.lastSnapshot]: snapshot,
    [STORAGE_KEYS.lastRunSummary]: summary
  });
}

async function savePreviewPlan(previewPlan) {
  await chrome.storage.local.set({
    [STORAGE_KEYS.pendingPreviewPlan]: previewPlan
  });
}

async function undoLastOrganization() {
  const data = await chrome.storage.local.get([STORAGE_KEYS.lastSnapshot, STORAGE_KEYS.lastRunSummary]);
  const snapshot = data[STORAGE_KEYS.lastSnapshot];

  if (!snapshot?.windows?.length) {
    return { ok: false, error: "No organization snapshot is available to undo." };
  }

  const liveTabs = await getLiveTabsById();
  const liveWindowIds = new Set((await chrome.windows.getAll({ windowTypes: ["normal"] })).map((window) => window.id));
  let restoredTabs = 0;
  let restoredGroups = 0;

  for (const windowSnapshot of snapshot.windows) {
    if (!liveWindowIds.has(windowSnapshot.id)) {
      continue;
    }

    const tabsToRestore = windowSnapshot.tabs
      .filter((tab) => liveTabs.has(tab.id))
      .sort((a, b) => a.index - b.index);

    if (tabsToRestore.length === 0) {
      continue;
    }

    await Promise.all(
      tabsToRestore.map(async (tab) => {
        const liveTab = liveTabs.get(tab.id);
        if (liveTab.pinned !== tab.pinned) {
          await chrome.tabs.update(tab.id, { pinned: tab.pinned });
        }
      })
    );

    await ungroupTabsSafely(tabsToRestore.map((tab) => tab.id));

    await moveTabsSafely(
      tabsToRestore.map((tab) => tab.id),
      {
        windowId: windowSnapshot.id,
        index: 0
      }
    );

    const previousGroups = groupSnapshotTabs(tabsToRestore);
    for (const previousGroup of previousGroups) {
      const groupId = await chrome.tabs.group({
        tabIds: previousGroup.tabIds,
        createProperties: { windowId: windowSnapshot.id }
      });

      await chrome.tabGroups.update(groupId, buildGroupUpdate(previousGroup.group));
      restoredGroups += 1;
    }

    restoredTabs += tabsToRestore.length;
  }

  await chrome.storage.local.remove(STORAGE_KEYS.lastSnapshot);

  const summary = {
    timestamp: Date.now(),
    windowsProcessed: snapshot.windows.length,
    tabsRestored: restoredTabs,
    groupsRestored: restoredGroups
  };

  await chrome.storage.local.set({
    [STORAGE_KEYS.lastRunSummary]: summary
  });

  return { ok: true, summary, undoAvailable: false };
}

async function getStatus() {
  const data = await chrome.storage.local.get([
    STORAGE_KEYS.lastSnapshot,
    STORAGE_KEYS.lastRunSummary,
    STORAGE_KEYS.pendingPreviewPlan
  ]);
  return {
    ok: true,
    undoAvailable: Boolean(data[STORAGE_KEYS.lastSnapshot]),
    summary: data[STORAGE_KEYS.lastRunSummary] || null,
    previewPlan: data[STORAGE_KEYS.pendingPreviewPlan] || null
  };
}

async function getLiveTabsById() {
  const liveTabs = await chrome.tabs.query({});
  return new Map(liveTabs.map((tab) => [tab.id, tab]));
}

function groupSnapshotTabs(tabs) {
  const grouped = new Map();

  for (const tab of tabs) {
    if (!tab.group || tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) {
      continue;
    }

    const key = tab.groupId;
    if (!grouped.has(key)) {
      grouped.set(key, {
        group: tab.group,
        tabIds: []
      });
    }

    grouped.get(key).tabIds.push(tab.id);
  }

  return [...grouped.values()];
}

async function moveTabsSafely(tabIds, moveProperties) {
  if (tabIds.length === 0) {
    return;
  }

  const startIndex = moveProperties.index ?? -1;

  for (let offset = 0; offset < tabIds.length; offset += 1) {
    try {
      await chrome.tabs.move(tabIds[offset], {
        ...moveProperties,
        index: startIndex === -1 ? -1 : startIndex + offset
      });
    } catch (error) {
      console.warn(`Unable to move tab ${tabIds[offset]}`, error);
    }
  }
}

async function ungroupTabsSafely(tabIds) {
  if (tabIds.length === 0) {
    return;
  }

  try {
    await chrome.tabs.ungroup(tabIds);
  } catch (error) {
    console.warn("Unable to ungroup some tabs", error);
  }
}

function buildGroupUpdate(group) {
  const update = {};

  if (typeof group.title === "string") {
    update.title = group.title;
  }

  if (group.color) {
    update.color = group.color;
  }

  if (typeof group.collapsed === "boolean") {
    update.collapsed = group.collapsed;
  }

  return update;
}

function mergeCounts(target, source) {
  for (const [key, value] of Object.entries(source)) {
    target[key] = (target[key] || 0) + value;
  }
}

async function getFocusedNormalWindow(populate) {
  return chrome.windows.getLastFocused({
    populate,
    windowTypes: ["normal"]
  });
}

async function classifyTabsForOrganization(tabs) {
  const result = await fetchAiCategoryMap(tabs);

  return {
    source: result.ok && result.categoryMap.size > 0 ? result.source : "local",
    error: result.error,
    categoryMap: result.categoryMap,
    categoryOrder: result.categoryOrder?.length ? result.categoryOrder : CATEGORY_ORDER
  };
}

async function hasUndoSnapshot() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.lastSnapshot);
  return Boolean(data[STORAGE_KEYS.lastSnapshot]);
}

function flattenWindowTabs(windows) {
  return windows.flatMap((window, windowOrder) =>
    (window.tabs || [])
      .map((tab) => ({
        ...tab,
        windowOrder
      }))
      .sort((a, b) => a.index - b.index)
  );
}

function createOrganizationSummary({
  windowsProcessed,
  mode,
  targetWindowId = null,
  tabsMovedAcrossWindows = 0,
  skippedApplyTabs = 0,
  classifier = { source: "local", error: null, categoryMap: new Map(), categoryOrder: CATEGORY_ORDER },
  plans
}) {
  const summary = {
    timestamp: Date.now(),
    mode,
    classifierSource: classifier.source,
    classifierError: classifier.error || null,
    aiClassifiedTabs: classifier.categoryMap?.size || classifier.categoryMapSize || 0,
    generatedCategories: classifier.categoryOrder || [],
    windowsProcessed,
    tabsOrganized: 0,
    groupsCreated: 0,
    skippedPinnedTabs: 0,
    screenedOutTabs: 0,
    skippedByReason: {},
    tabsMovedAcrossWindows,
    skippedApplyTabs
  };

  for (const plan of plans) {
    summary.tabsOrganized += plan.organizedTabCount;
    summary.groupsCreated += plan.groupCount;
    summary.skippedPinnedTabs += plan.skippedPinnedCount;
    summary.screenedOutTabs += plan.screenedOutCount;
    mergeCounts(summary.skippedByReason, plan.screeningReasonCounts);
  }

  if (targetWindowId !== null) {
    summary.targetWindowId = targetWindowId;
  }

  return summary;
}

function countMovedAcrossWindows(tabIds, orderedTabs, targetWindowId) {
  const tabsById = new Map(orderedTabs.map((tab) => [tab.id, tab]));
  return tabIds.filter((tabId) => tabsById.get(tabId)?.windowId !== targetWindowId).length;
}

function createPreviewPlan({ mode, targetWindowId, windowsProcessed, tabs, classifier, plan, snapshot }) {
  const tabDetails = createTabDetails(tabs);

  return {
    id: createPlanId(),
    timestamp: Date.now(),
    mode,
    targetWindowId,
    windowsProcessed,
    snapshot,
    classifier: serializeClassifier(classifier),
    startIndex: plan.startIndex,
    pinnedTabIds: plan.pinnedTabIds,
    groups: plan.groups.map((group, index) => ({
      id: `group-${index}`,
      category: group.category,
      tabIds: group.tabIds,
      tabs: group.tabIds.map((tabId) => tabDetails[tabId]).filter(Boolean)
    })),
    singles: plan.singles.map((single) => ({
      ...single,
      tab: tabDetails[single.tabId]
    })),
    skippedTabs: plan.skippedTabs,
    screeningReasonCounts: plan.screeningReasonCounts,
    skippedPinnedCount: plan.skippedPinnedCount,
    screenedOutCount: plan.screenedOutCount,
    organizedTabCount: plan.organizedTabCount,
    groupCount: plan.groupCount,
    tabDetails
  };
}

function createMultiWindowPreviewPlan({ mode, windowsProcessed, windows, classifier, plans, snapshot }) {
  const combinedTabs = flattenWindowTabs(windows);
  const tabDetails = createTabDetails(combinedTabs);
  const groups = [];
  const singles = [];
  const skippedTabs = [];
  const screeningReasonCounts = {};
  let organizedTabCount = 0;
  let skippedPinnedCount = 0;
  let screenedOutCount = 0;

  for (const [windowIndex, plan] of plans.entries()) {
    for (const group of plan.groups) {
      groups.push({
        id: `window-${windowIndex}-group-${groups.length}`,
        category: group.category,
        tabIds: group.tabIds,
        tabs: group.tabIds.map((tabId) => tabDetails[tabId]).filter(Boolean)
      });
    }

    for (const single of plan.singles) {
      singles.push({
        ...single,
        tab: tabDetails[single.tabId]
      });
    }

    skippedTabs.push(...plan.skippedTabs);
    mergeCounts(screeningReasonCounts, plan.screeningReasonCounts);
    organizedTabCount += plan.organizedTabCount;
    skippedPinnedCount += plan.skippedPinnedCount;
    screenedOutCount += plan.screenedOutCount;
  }

  return {
    id: createPlanId(),
    timestamp: Date.now(),
    mode,
    targetWindowId: null,
    windowsProcessed,
    snapshot,
    classifier: serializeClassifier(classifier),
    startIndex: 0,
    pinnedTabIds: plans.flatMap((plan) => plan.pinnedTabIds),
    groups,
    singles,
    skippedTabs,
    screeningReasonCounts,
    skippedPinnedCount,
    screenedOutCount,
    organizedTabCount,
    groupCount: groups.length,
    tabDetails
  };
}

function createTabDetails(tabs) {
  return Object.fromEntries(tabs.map((tab) => [
    tab.id,
    {
      id: tab.id,
      title: tab.title || "Untitled tab",
      hostname: getHostname(tab.url),
      windowId: tab.windowId,
      index: tab.index
    }
  ]));
}

function serializeClassifier(classifier) {
  return {
    source: classifier.source,
    error: classifier.error,
    categoryOrder: classifier.categoryOrder || CATEGORY_ORDER,
    categoryMapSize: classifier.categoryMap?.size || 0
  };
}

function createPlanId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function countMovedAcrossPreview(tabIds, tabDetails, targetWindowId) {
  return tabIds.filter((tabId) => tabDetails?.[tabId]?.windowId !== targetWindowId).length;
}
