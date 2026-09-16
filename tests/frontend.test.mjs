/* Testes sem dependências externas para o contrato e o estado do front-end. */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const projectRoot = path.resolve(import.meta.dirname, "..");
const apiSource = fs.readFileSync(path.join(projectRoot, "js/api.js"), "utf8");
const appSource = fs.readFileSync(path.join(projectRoot, "js/app.js"), "utf8");

function createStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}

function createApiContext(fetchImplementation) {
  const context = {
    window: {},
    AbortController,
    setTimeout,
    clearTimeout,
    atob,
    localStorage: createStorage(),
    sessionStorage: createStorage(),
    encodeURIComponent,
    fetch: fetchImplementation,
  };
  vm.runInNewContext(apiSource, context, { filename: "api.js" });
  return context;
}

test("arquivos locais, sintaxe e chamadas obrigatórias estão presentes", () => {
  assert.doesNotThrow(() => new Function(apiSource));
  assert.doesNotThrow(() => new Function(appSource));

  const htmlPath = path.join(projectRoot, "index.html");
  const html = fs.readFileSync(htmlPath, "utf8");
  const localReferences = html.matchAll(/(?:href|src)="(\.\/[^"#]+)"/g);
  for (const match of localReferences) {
    assert.ok(fs.existsSync(path.join(projectRoot, match[1].slice(2))));
  }
  assert.ok(html.indexOf("./js/api.js") < html.indexOf("./js/app.js"));

  const cssPath = path.join(projectRoot, "css/styles.css");
  const css = fs.readFileSync(cssPath, "utf8");
  for (const match of css.matchAll(/url\(["']?([^"')]+)["']?\)/g)) {
    if (/^(data:|https?:)/.test(match[1])) continue;
    assert.ok(fs.existsSync(path.resolve(path.dirname(cssPath), match[1])));
  }
  assert.match(css, /\.notification-panel\s*\{[^}]*position:\s*fixed;/s);
  assert.match(css, /\.notification-panel\s*\{[^}]*width:\s*auto;/s);
  assert.match(css, /--notification-surface:\s*rgb\([^)]+\);/);
  assert.match(css, /\.notification-panel\s*\{[^}]*border:\s*0;/s);
  assert.match(css, /\.notification-panel\s*\{[^}]*var\(--notification-surface\) 88%/s);
  assert.match(css, /\.notification-panel\s*\{[^}]*box-shadow:\s*var\(--shadow-md\)/s);
  assert.match(css, /\.notification-panel\s*\{[^}]*backdrop-filter:\s*blur\(18px\)/s);
  assert.match(css, /\.notification-panel\s*\{[^}]*transition:/s);
  assert.match(css, /\.notification-panel\[hidden\]\s*\{[^}]*opacity:\s*0;/s);

  for (const method of [
    "getHealth",
    "register",
    "login",
    "getProfile",
    "updateProfile",
    "getPunches",
    "createPunch",
    "deletePunch",
  ]) {
    assert.match(appSource, new RegExp(`PontoPlusApi\\.${method}\\(`));
  }
});

test("cliente HTTP usa todas as rotas, métodos e formas de sessão", async () => {
  const requests = [];
  const context = createApiContext(async (url, options) => {
    requests.push({ url, options });
    const isDelete = options.method === "DELETE";
    return {
      ok: true,
      status: isDelete ? 204 : 200,
      async json() {
        return { ok: true };
      },
    };
  });
  const api = context.window.PontoPlusApi;

  api.saveToken("token-local", true);
  assert.equal(context.localStorage.getItem("ponto-plus-access-token"), "token-local");
  assert.equal(context.sessionStorage.getItem("ponto-plus-access-token"), null);

  await api.register({ name: "Ana", email: "ana@example.com", password: "123456" });
  await api.login({ email: "ana@example.com", password: "123456" });
  await api.getHealth();
  await api.getProfile();
  await api.updateProfile("Ana Souza");
  await api.getPunches("2026-09");
  await api.createPunch();
  assert.equal(await api.deletePunch(42), null);

  assert.deepEqual(
    requests.map(({ url, options }) => [url, options.method]),
    [
      ["http://127.0.0.1:5000/api/auth/register", "POST"],
      ["http://127.0.0.1:5000/api/auth/login", "POST"],
      ["http://127.0.0.1:5000/api/health", "GET"],
      ["http://127.0.0.1:5000/api/profile", "GET"],
      ["http://127.0.0.1:5000/api/profile", "PATCH"],
      ["http://127.0.0.1:5000/api/punches?month=2026-09", "GET"],
      ["http://127.0.0.1:5000/api/punches", "POST"],
      ["http://127.0.0.1:5000/api/punches/42", "DELETE"],
    ],
  );
  assert.ok(requests.every(({ options }) => options.headers.Authorization === "Bearer token-local"));

  api.saveToken("token-sessao", false);
  assert.equal(context.localStorage.getItem("ponto-plus-access-token"), null);
  assert.equal(context.sessionStorage.getItem("ponto-plus-access-token"), "token-sessao");
});

test("cliente apresenta falhas e identifica a sessão rejeitada sem apagar outra", async () => {
  const offline = createApiContext(async () => {
    throw new Error("offline");
  });
  await assert.rejects(
    offline.window.PontoPlusApi.getProfile(),
    /Não foi possível conectar à API/,
  );

  const unauthorized = createApiContext(async () => ({
    ok: false,
    status: 401,
    async json() {
      return { error: { code: "expired_token", message: "Sua sessão expirou." } };
    },
  }));
  unauthorized.window.PontoPlusApi.saveToken("expirado", true);
  await assert.rejects(
    unauthorized.window.PontoPlusApi.getProfile(),
    (error) => error.status === 401 && error.code === "expired_token" && error.requestToken === "expirado",
  );
  assert.equal(unauthorized.window.PontoPlusApi.accessToken(), "expirado");
});

test("estado agrupa batidas reais e calcula a jornada por dia", async () => {
  const fixedNow = Date.parse("2026-09-15T18:00:00-03:00");
  class TestDate extends Date {
    constructor(...args) { super(...(args.length ? args : [fixedNow])); }
    static now() { return fixedNow; }
  }
  const hook = `globalThis.__qa = {
    zonedDateKey,
    formatLongDate,
    notificationControlMarkup,
    notificationPanelMarkup,
    setNotifications(value) { notifications = value; },
    storeMonthResponse,
    dayRecordData,
    loadDateRange,
    state() { return { punches, punchesByMonth, undoExpiresAt }; }
  };`;
  const instrumented = appSource.replace(
    /\n  bootstrap\(\);\n\}\)\(\);\s*$/,
    `\n  ${hook}\n})();`,
  );
  assert.notEqual(instrumented, appSource);

  const emptyResponse = (month) => ({
    month,
    punches: [],
    today: { date: "", punches: [], revision: 0 },
  });
  const context = {
    console,
    Intl,
    Date: TestDate,
    Math,
    Number,
    String,
    Boolean,
    JSON,
    Array,
    Object,
    Promise,
    localStorage: createStorage(),
    sessionStorage: createStorage(),
    document: {
      getElementById() {
        return null;
      },
      addEventListener() {},
      documentElement: { dataset: {} },
    },
    window: {
      PontoPlusApi: { accessToken: () => "qa-token", getPunches: async (month) => emptyResponse(month) },
      location: { hash: "#/login" },
      matchMedia() {
        return { matches: false };
      },
      addEventListener() {},
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
    },
  };
  context.globalThis = context;
  vm.runInNewContext(instrumented, context, { filename: "app.js" });

  const qa = context.__qa;
  assert.equal(
    qa.formatLongDate(new Date("2026-09-15T15:00:00Z")),
    "Terça-feira, 15 de setembro",
  );
  const emptyNotifications = qa.notificationPanelMarkup();
  assert.match(emptyNotifications, /Sem novas notificações/);
  const emptyNotificationControl = qa.notificationControlMarkup();
  assert.match(emptyNotificationControl, /aria-expanded="false"/);
  assert.doesNotMatch(emptyNotificationControl, /notification-badge/);
  qa.setNotifications([
    { title: "Jornada", message: "Entrada registrada.", read: false },
  ]);
  const unreadNotificationControl = qa.notificationControlMarkup();
  const unreadNotifications = qa.notificationPanelMarkup();
  assert.match(unreadNotificationControl, /notification-badge/);
  assert.match(unreadNotifications, /Entrada registrada\./);

  const now = new TestDate();
  const todayKey = qa.zonedDateKey(now);
  const yesterdayKey = qa.zonedDateKey(new Date(now.getTime() - 86400000));
  const month = todayKey.slice(0, 7);
  const types = ["clock_in", "break_start", "break_end", "clock_out"];
  const times = ["08:00", "12:00", "13:00", "17:00"];
  const yesterdayPunches = types.map((type, index) => ({
    id: index + 10,
    type,
    occurred_at: `${yesterdayKey}T${times[index]}:00-03:00`,
  }));
  const todayPunch = {
    id: 1,
    type: "clock_in",
    occurred_at: now.toISOString(),
  };
  qa.storeMonthResponse({
    month,
    punches: yesterdayPunches.concat(todayPunch),
    today: { date: todayKey, punches: [todayPunch], revision: 1 },
  });

  const yesterdayParts = yesterdayKey.split("-").map(Number);
  const yesterdayData = qa.dayRecordData(
    new Date(yesterdayParts[0], yesterdayParts[1] - 1, yesterdayParts[2]),
  );
  assert.equal(qa.state().punches.length, 1);
  assert.equal(yesterdayData.complete, true);
  assert.equal(yesterdayData.totalSeconds, 8 * 3600);
  assert.deepEqual(Array.from(yesterdayData.times), times);

  await qa.loadDateRange(new Date(2026, 0, 31), new Date(2026, 1, 1));
  assert.ok(Object.hasOwn(qa.state().punchesByMonth, "2026-01"));
  assert.ok(Object.hasOwn(qa.state().punchesByMonth, "2026-02"));
});
