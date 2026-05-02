import { CATEGORY_ORDER, classifyTab, normalizeCategoryName } from "./categories.js";
import { countScreeningReasons, screenTab } from "./screener.js";

export const MAX_GROUPS_PER_WINDOW = 3;

export function buildWindowPlan(tabs, options = {}) {
  const sortedTabs = [...tabs].sort((a, b) => a.index - b.index);
  const startIndex = sortedTabs.filter((tab) => tab.pinned).length;

  return buildPlanFromOrderedTabs(sortedTabs, startIndex, options);
}

export function buildCrossWindowPlan(orderedTabs, targetWindowId, options = {}) {
  const targetPinnedCount = orderedTabs.filter((tab) => tab.windowId === targetWindowId && tab.pinned).length;

  return buildPlanFromOrderedTabs(orderedTabs, targetPinnedCount, options);
}

export function buildApplyPlanFromPreview(previewPlan, options = {}) {
  const excludedTabIds = new Set(options.excludedTabIds || []);
  const liveTabIds = options.liveTabIds ? new Set(options.liveTabIds) : null;
  const renamedGroups = options.renamedGroups || {};
  const maxGroups = options.maxGroups ?? MAX_GROUPS_PER_WINDOW;
  const groups = [];
  const singles = [];
  const skippedApplyTabIds = [];

  for (const group of previewPlan.groups || []) {
    const tabIds = filterApplyTabIds(group.tabIds, excludedTabIds, liveTabIds, skippedApplyTabIds);
    const category = normalizeCategoryName(renamedGroups[group.id]) || group.category;

    if (tabIds.length >= 2 && groups.length < maxGroups) {
      groups.push({
        id: group.id,
        category,
        tabIds,
        originalIndexes: tabIds.map((tabId) => getPreviewTabIndex(previewPlan, tabId))
      });
    } else {
      for (const tabId of tabIds) {
        singles.push({
          tabId,
          category,
          originalIndex: getPreviewTabIndex(previewPlan, tabId)
        });
      }
    }
  }

  for (const single of previewPlan.singles || []) {
    if (shouldApplyTab(single.tabId, excludedTabIds, liveTabIds)) {
      singles.push({
        tabId: single.tabId,
        category: single.category,
        originalIndex: single.originalIndex
      });
    } else {
      skippedApplyTabIds.push(single.tabId);
    }
  }

  return {
    pinnedTabIds: previewPlan.pinnedTabIds || [],
    startIndex: previewPlan.startIndex || 0,
    groups,
    singles,
    skippedTabs: previewPlan.skippedTabs || [],
    screeningReasonCounts: previewPlan.screeningReasonCounts || {},
    skippedApplyTabIds,
    orderedTabIds: [
      ...groups.flatMap((group) => group.tabIds),
      ...singles.map((single) => single.tabId)
    ],
    skippedPinnedCount: previewPlan.skippedPinnedCount || 0,
    screenedOutCount: previewPlan.screenedOutCount || 0,
    organizedTabCount: groups.reduce((count, group) => count + group.tabIds.length, 0) + singles.length,
    groupCount: groups.length
  };
}

function buildPlanFromOrderedTabs(orderedTabs, startIndex, options = {}) {
  const categoryOverrides = options.categoryOverrides || new Map();
  const preferredCategoryOrder = options.categoryOrder || CATEGORY_ORDER;
  const maxGroups = options.maxGroups ?? MAX_GROUPS_PER_WINDOW;
  const sortedTabs = [...orderedTabs];
  const screenedTabs = sortedTabs.map((tab) => ({
    tab,
    screen: screenTab(tab)
  }));
  const candidates = screenedTabs
    .filter((item) => item.screen.eligible)
    .map((item) => item.tab)
    .map((tab) => ({
      tab,
      category: getTabCategory(tab, categoryOverrides)
    }));
  const skippedTabs = screenedTabs
    .filter((item) => !item.screen.eligible)
    .map((item) => ({
      tabId: item.tab.id,
      originalIndex: item.tab.index,
      reason: item.screen.reason,
      reasonLabel: item.screen.reasonLabel
    }));

  const groups = [];
  const groupedTabIds = new Set();
  const categoryOrder = buildCategoryOrder(preferredCategoryOrder, candidates);

  for (const category of categoryOrder) {
    const items = candidates.filter((item) => item.category === category);
    if (items.length < 2 || groups.length >= maxGroups) {
      continue;
    }

    const tabIds = items.map((item) => item.tab.id);
    tabIds.forEach((id) => groupedTabIds.add(id));
    groups.push({
      category,
      tabIds,
      originalIndexes: items.map((item) => item.tab.index)
    });
  }

  const singles = candidates
    .filter((item) => !groupedTabIds.has(item.tab.id))
    .map((item) => ({
      tabId: item.tab.id,
      category: item.category,
      originalIndex: item.tab.index
    }));

  return {
    pinnedTabIds: skippedTabs.filter((tab) => tab.reason === "pinned").map((tab) => tab.tabId),
    startIndex,
    groups,
    singles,
    skippedTabs,
    screeningReasonCounts: countScreeningReasons(screenedTabs),
    orderedTabIds: [
      ...groups.flatMap((group) => group.tabIds),
      ...singles.map((single) => single.tabId)
    ],
    skippedPinnedCount: skippedTabs.filter((tab) => tab.reason === "pinned").length,
    screenedOutCount: skippedTabs.length,
    organizedTabCount: candidates.length,
    groupCount: groups.length
  };
}

function getTabCategory(tab, categoryOverrides) {
  const override = normalizeCategoryName(categoryOverrides.get(tab.id));
  return override || classifyTab(tab);
}

function buildCategoryOrder(preferredCategoryOrder, candidates) {
  const categoryOrder = [];
  const seen = new Set();

  for (const category of preferredCategoryOrder) {
    const normalized = normalizeCategoryName(category);
    if (normalized && !seen.has(normalized)) {
      categoryOrder.push(normalized);
      seen.add(normalized);
    }
  }

  for (const item of candidates) {
    if (!seen.has(item.category)) {
      categoryOrder.push(item.category);
      seen.add(item.category);
    }
  }

  return categoryOrder;
}

function filterApplyTabIds(tabIds, excludedTabIds, liveTabIds, skippedApplyTabIds) {
  return tabIds.filter((tabId) => {
    const shouldApply = shouldApplyTab(tabId, excludedTabIds, liveTabIds);

    if (!shouldApply) {
      skippedApplyTabIds.push(tabId);
    }

    return shouldApply;
  });
}

function shouldApplyTab(tabId, excludedTabIds, liveTabIds) {
  return !excludedTabIds.has(tabId) && (!liveTabIds || liveTabIds.has(tabId));
}

function getPreviewTabIndex(previewPlan, tabId) {
  const tab = previewPlan.tabDetails?.[tabId];
  return tab?.index ?? 0;
}
