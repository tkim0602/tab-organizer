import { CATEGORY_ORDER, getHostname, normalizeGeneratedCategoryName } from "./categories.js";
import { screenTab } from "./screener.js";

export const AI_CLASSIFIER_ENDPOINT = "http://127.0.0.1:8787/classify-tabs";
export const AI_CLASSIFIER_TIMEOUT_MS = 1800;

export async function fetchAiCategoryMap(tabs, options = {}) {
  const endpoint = options.endpoint || AI_CLASSIFIER_ENDPOINT;
  const timeoutMs = options.timeoutMs ?? AI_CLASSIFIER_TIMEOUT_MS;
  const eligibleTabs = tabs.filter((tab) => screenTab(tab).eligible);

  if (eligibleTabs.length === 0) {
    return emptyResult("none");
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        categories: CATEGORY_ORDER,
        tabs: eligibleTabs.map((tab) => ({
          id: tab.id,
          title: tab.title || "",
          hostname: getHostname(tab.url)
        }))
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`AI classifier returned HTTP ${response.status}`);
    }

    const data = await response.json();
    const classification = normalizeClassification(data);

    return {
      ok: classification.categoryMap.size > 0,
      source: data.provider ? `ai:${data.provider}` : "ai",
      categoryMap: classification.categoryMap,
      categoryOrder: classification.categoryOrder,
      error: null
    };
  } catch (error) {
    return {
      ok: false,
      source: "local",
      categoryMap: new Map(),
      categoryOrder: CATEGORY_ORDER,
      error: error.name === "AbortError" ? "AI classifier timed out" : error.message
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

function normalizeClassification(data) {
  const categoryMap = new Map();
  const categoryOrder = [];
  const seenCategories = new Set();

  for (const category of Array.isArray(data.categories) ? data.categories : []) {
    addCategory(category, categoryOrder, seenCategories);
  }

  if (!Array.isArray(data.assignments)) {
    return { categoryMap, categoryOrder };
  }

  for (const assignment of data.assignments) {
    const category = normalizeGeneratedCategoryName(assignment?.category);
    if (typeof assignment?.tabId !== "number" || !category) {
      continue;
    }

    categoryMap.set(assignment.tabId, category);
    addCategory(category, categoryOrder, seenCategories);
  }

  return { categoryMap, categoryOrder };
}

function addCategory(category, categoryOrder, seenCategories) {
  const normalized = normalizeGeneratedCategoryName(category);

  if (normalized && !seenCategories.has(normalized)) {
    categoryOrder.push(normalized);
    seenCategories.add(normalized);
  }
}

function emptyResult(source) {
  return {
    ok: true,
    source,
    categoryMap: new Map(),
    categoryOrder: CATEGORY_ORDER,
    error: null
  };
}
