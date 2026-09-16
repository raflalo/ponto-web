/* Ambiente de teste em memória: não abre navegador nem acessa dados reais. */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

export const projectRoot = path.resolve(import.meta.dirname, "..");
export const apiSource = fs.readFileSync(path.join(projectRoot, "js/api.js"), "utf8");
export const appSource = fs.readFileSync(path.join(projectRoot, "js/app.js"), "utf8");
export const userFixture = {
  id: 1, name: "Ana Teste", email: "ana@example.com",
  created_at: "2026-01-01T12:00:00Z", daily_goal_minutes: 480,
};

export function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export function createApiContext(fetchImplementation, overrides = {}) {
  const context = {
    window: {}, localStorage: createStorage(), sessionStorage: createStorage(),
    encodeURIComponent, fetch: fetchImplementation, AbortController, atob,
    setTimeout, clearTimeout, ...overrides,
  };
  vm.runInNewContext(apiSource, context, { filename: "api.js" });
  return context;
}

export function punchFixture(day, times, firstId = 1) {
  return times.map((time, index) => ({
    id: firstId + index,
    type: ["clock_in", "break_start", "break_end", "clock_out"][index],
    occurred_at: `${day}T${time}-03:00`,
  }));
}

export function snapshot({ day = "2026-09-15", records = [], revision = records.length,
  month = day.slice(0, 7), all = records, now = `${day}T18:00:00-03:00` } = {}) {
  return { month, punches: all, today: { date: day, punches: records, revision }, server_time: now };
}

export function createNode(id = "") {
  const attributes = new Map();
  const classes = new Set();
  const properties = new Map();
  return {
    id, innerHTML: "", textContent: "", hidden: true, disabled: false, dataset: {},
    classList: {
      add: (value) => classes.add(value), remove: (value) => classes.delete(value),
      contains: (value) => classes.has(value),
      toggle(value, enabled) { enabled ? classes.add(value) : classes.delete(value); },
    },
    style: {
      setProperty: (key, value) => properties.set(key, value),
      removeProperty: (key) => properties.delete(key),
      getPropertyValue: (key) => properties.get(key),
    },
    setAttribute: (key, value) => attributes.set(key, String(value)),
    getAttribute: (key) => attributes.get(key),
    removeAttribute: (key) => attributes.delete(key),
    focus() { this.focused = true; },
    scrollIntoView() {}, addEventListener() {}, querySelector() { return null; },
  };
}

export function createAppHarness(options = {}) {
  let now = Date.parse(options.now || "2026-09-15T18:00:00-03:00");
  let token = options.token === undefined ? "token-ana" : options.token;
  let expiresAt = null;
  class TestDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const documentListeners = new Map();
  const windowListeners = new Map();
  const nodes = new Map(["app", "announcer"].map((id) => [id, createNode(id)]));
  const selectors = new Map();
  const intervals = new Map();
  const timeouts = new Map();
  let timerId = 0;
  const api = {
    accessToken: () => token, tokenExpiresAt: () => expiresAt,
    clearToken: () => { token = null; }, saveToken: (value) => { token = value; },
    getHealth: async () => ({ status: "ok" }),
    getProfile: async () => ({ user: userFixture }),
    getPunches: async (month) => snapshot({ month, now: new TestDate().toISOString() }),
    ...options.api,
  };
  const document = {
    getElementById: (id) => nodes.get(id) || null,
    querySelector: (selector) => selectors.get(selector) || null,
    querySelectorAll: () => [],
    addEventListener: (name, handler) => documentListeners.set(name, handler),
    documentElement: { dataset: {} }, hidden: false,
  };
  const context = {
    console, Intl, Date: TestDate, Math, Number, String, Boolean, JSON, Array, Object, Promise,
    localStorage: createStorage(options.storage), sessionStorage: createStorage(),
    document,
    window: {
      PontoPlusApi: api, location: { hash: options.route || "#/dashboard" },
      innerWidth: 1440, innerHeight: 900, scrollY: 0,
      matchMedia: () => ({ matches: false }),
      addEventListener: (name, handler) => windowListeners.set(name, handler),
      setTimeout: (handler) => { timeouts.set(++timerId, handler); return timerId; },
      clearTimeout: (id) => timeouts.delete(id),
      setInterval: (handler) => { intervals.set(++timerId, handler); return timerId; },
      clearInterval: (id) => intervals.delete(id),
      requestAnimationFrame: (handler) => handler(), scrollTo() {},
    },
  };
  const hook = `globalThis.__qa = {
    bootstrap, beginSession, resetSessionState, sessionContext, handleApiError,
    checkSession, logout, loadMonth, loadDateRange, loadInitialData, refreshSessionData,
    storeMonthResponse, storeTodayResponse, dayRecordData, dayStatus, dayStatusClass,
    dayGoalChipData, weeklyHistoryData, weeklyPayrollHistoryMarkup, selectedDayMarkup,
    registerPunch, undoPunch, updateLiveData, updateUndoCountdown, updateGauge,
    formatLongDate, formatDateKey, zonedDateKey, parseDateKey, todayDate, currentInstant,
    notificationControlMarkup, notificationPanelMarkup, positionNotificationsPanel,
    setNotificationsPanel, journeyCardMarkup, validateEmail, render, bindProfileForm,
    selectHistoryDate, applyHistoryRange, historyRangeLength, changeMonth,
    setNotifications(value) { notifications = value; },
    selectDay(value) { selectedDate = parseDateKey(value); },
    suppressPolling() { lastSyncAt = Date.now(); },
    state() { return { punches, punchesByMonth, undoExpiresAt, dailyGoalMinutes,
      journeyLoaded, journeyRevision, currentDayKey, sessionVersion, user, mutationPending,
      historyDraftStart, historyDraftEnd, historyRangeStart, historyRangeEnd,
      selectedDate, dataMessage, syncPromise }; }
  };`;
  const instrumented = appSource.replace(/\n  bootstrap\(\);\n\}\)\(\);\s*$/, `\n  ${hook}\n})();`);
  if (instrumented === appSource) throw new Error("Ponto de instrumentação não encontrado");
  vm.runInNewContext(instrumented, context, { filename: "app.js" });
  return {
    qa: context.__qa, context, api, nodes, selectors, intervals, timeouts,
    documentListeners, windowListeners,
    setNow: (value) => { now = Date.parse(value); },
    setToken: (value) => { token = value; }, setExpiresAt: (value) => { expiresAt = value; },
    node(id) { if (!nodes.has(id)) nodes.set(id, createNode(id)); return nodes.get(id); },
  };
}
