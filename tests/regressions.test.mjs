import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  createApiContext, createAppHarness, createNode, deferred,
  projectRoot, punchFixture, snapshot, userFixture,
} from "./helpers.mjs";

const settle = () => new Promise((resolve) => setImmediate(resolve));

function assertMarkupIntegrity(markup, route) {
  const ids = Array.from(markup.matchAll(/\bid="([^"]+)"/g), (match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, route + " contém IDs duplicados");
  for (const match of markup.matchAll(/\b(?:for|aria-labelledby|aria-controls|aria-describedby)="([^"]+)"/g)) {
    for (const reference of match[1].split(/\s+/)) {
      assert.ok(ids.includes(reference), route + " referencia #" + reference + " inexistente");
    }
  }
  for (const match of markup.matchAll(/<button\b([^>]*)>/g)) {
    assert.match(match[1], /\btype="(?:button|submit|reset)"/, route + " contém botão sem tipo");
  }
  for (const match of markup.matchAll(/<img\b([^>]*)>/g)) {
    assert.match(match[1], /\balt="[^"]*"/, route + " contém imagem sem texto alternativo");
  }
  assert.doesNotMatch(markup, /\bon[a-z]+=/i, route + " contém manipulador HTML inline");
}

function relativeLuminance(hex) {
  const channels = hex.match(/[0-9a-f]{2}/gi).map((value) => parseInt(value, 16) / 255);
  const linear = channels.map((value) => value <= 0.04045
    ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(left, right) {
  const values = [relativeLuminance(left), relativeLuminance(right)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

function ready(options) {
  const harness = createAppHarness(options);
  harness.qa.beginSession(userFixture);
  harness.qa.storeMonthResponse(snapshot({ now: harness.qa.currentInstant().toISOString() }));
  harness.qa.suppressPolling();
  return harness;
}

test("telas geradas têm IDs únicos, referências ARIA válidas e controles explícitos", () => {
  for (const route of ["#/login", "#/cadastro"]) {
    const h = createAppHarness({ token: null, route });
    h.qa.render();
    assertMarkupIntegrity(h.node("app").innerHTML, route);
  }
  const h = ready();
  for (const route of ["#/dashboard", "#/calendario", "#/historico", "#/perfil"]) {
    h.context.window.location.hash = route;
    h.qa.render();
    assertMarkupIntegrity(h.node("app").innerHTML, route);
  }
});

test("tokens de texto atendem contraste AA nos dois temas", () => {
  const css = fs.readFileSync(path.join(projectRoot, "css/styles.css"), "utf8");
  const light = css.match(/:root\s*\{([\s\S]*?)\n\}/)[1];
  const dark = css.match(/\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/)[1];
  const token = (block, name) => block.match(new RegExp("--" + name + ":\\s*(#[0-9a-fA-F]{6})"))[1];
  for (const [block, label] of [[light, "claro"], [dark, "escuro"]]) {
    const background = token(block, "surface");
    for (const name of ["text", "text-2", "text-3"]) {
      assert.ok(contrast(token(block, name), background) >= 4.5, name + " falha no tema " + label);
    }
  }
});

test("health, meta, revisão e data usam o contrato completo da API", async () => {
  const calls = [];
  const { window } = createApiContext(async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, json: async () => ({}) };
  });
  await window.PontoPlusApi.getHealth();
  await window.PontoPlusApi.updateProfile("Ana", 390);
  await window.PontoPlusApi.createPunch(3, "2026-09-15");
  await window.PontoPlusApi.deletePunch(7, 4);
  assert.equal(calls[0].url, "http://127.0.0.1:5001/api/health");
  assert.deepEqual(JSON.parse(calls[1].options.body), { name: "Ana", daily_goal_minutes: 390 });
  assert.deepEqual(JSON.parse(calls[2].options.body), { expected_revision: 3, expected_date: "2026-09-15" });
  assert.match(calls[3].url, /\/7\?expected_revision=4$/);
});

test("timeout abrange a conexão e a leitura do corpo da resposta", async () => {
  for (const duringBody of [false, true]) {
    let expire;
    let cleared = false;
    const context = createApiContext(async (_url, { signal }) => {
      const blocked = () => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      });
      return duringBody ? { ok: true, status: 200, json: blocked } : blocked();
    }, {
      setTimeout: (handler) => { expire = handler; return 1; },
      clearTimeout: () => { cleared = true; },
    });
    const request = context.window.PontoPlusApi.getHealth();
    await settle();
    assert.equal(cleared, false);
    expire();
    await assert.rejects(request, /demorou para responder/);
    assert.equal(cleared, true);
  }
});

test("resposta inválida é apresentada como erro, sem sucesso silencioso", async () => {
  const context = createApiContext(async () => ({
    ok: true, status: 200, json: async () => { throw new SyntaxError("not JSON"); },
  }));
  await assert.rejects(context.window.PontoPlusApi.getProfile(), /resposta inválida/);
});

test("cliente lê a expiração do token sem confiar nela para autorizar a API", () => {
  const { window } = createApiContext(async () => {});
  const api = window.PontoPlusApi;
  assert.equal(api.tokenExpiresAt(), null);
  api.saveToken("invalid", true);
  assert.equal(api.tokenExpiresAt(), null);
  api.saveToken("header." + Buffer.from(JSON.stringify({ exp: 1800000000 })).toString("base64url") + ".signature", true);
  assert.equal(api.tokenExpiresAt(), 1800000000000);
});

test("401 limpa todos os dados e uma conta nova começa sem batidas da anterior", () => {
  const h = ready();
  h.qa.storeMonthResponse(snapshot({ records: punchFixture("2026-09-15", ["08:00:00"]) }));
  h.qa.handleApiError({ status: 401 }, h.qa.sessionContext());
  assert.equal(h.api.accessToken(), null);
  assert.equal(h.qa.state().punches.length, 0);
  assert.equal(Object.keys(h.qa.state().punchesByMonth).length, 0);
  assert.equal(h.qa.state().user.name, "Usuário");
  h.setToken("token-bia");
  h.qa.beginSession({ ...userFixture, id: 2, name: "Bia", daily_goal_minutes: 360 });
  assert.equal(h.qa.state().dailyGoalMinutes, 360);
  assert.equal(h.qa.state().journeyLoaded, false);
  assert.equal(h.qa.state().punches.length, 0);
  assert.equal(h.qa.state().undoExpiresAt, 0);
});

test("401 atrasado de outra conta não encerra a conta atual", () => {
  const h = ready();
  const old = h.qa.sessionContext();
  h.setToken("token-bia");
  h.qa.beginSession({ ...userFixture, id: 2 });
  h.qa.handleApiError({ status: 401 }, old);
  assert.equal(h.api.accessToken(), "token-bia");
  assert.equal(h.qa.state().user.id, 2);
});

test("consulta atrasada não repovoa o cache depois da troca de conta", async () => {
  const response = deferred();
  const h = ready({ api: { getPunches: () => response.promise } });
  const pending = h.qa.loadMonth("2026-09", true);
  h.setToken("token-bia");
  h.qa.beginSession({ ...userFixture, id: 2 });
  response.resolve(snapshot({ records: punchFixture("2026-09-15", ["08:00:00"]) }));
  await pending;
  assert.equal(h.qa.state().punches.length, 0);
  assert.equal(Object.keys(h.qa.state().punchesByMonth).length, 0);
});

test("batida atrasada após logout não reabre painel nem restaura registros", async () => {
  const response = deferred();
  const h = ready({ api: { createPunch: () => response.promise } });
  const pending = h.qa.registerPunch();
  h.qa.logout();
  const records = punchFixture("2026-09-15", ["18:00:00"]);
  response.resolve({ ...snapshot({ records }), punch: records[0] });
  await pending;
  assert.equal(h.context.window.location.hash, "#/login");
  assert.equal(h.qa.state().punches.length, 0);
  assert.doesNotMatch(h.node("app").innerHTML, /Controle de ponto/);
});

test("resposta canônica substitui o estado local; clique duplicado é bloqueado", async () => {
  const response = deferred();
  const calls = [];
  const h = ready({ api: { createPunch: (...args) => { calls.push(args); return response.promise; } } });
  const pending = h.qa.registerPunch();
  await h.qa.registerPunch();
  const records = punchFixture("2026-09-15", ["08:00:00", "12:00:00"]);
  response.resolve({ ...snapshot({ records }), punch: records[1] });
  await pending;
  assert.deepEqual(calls, [[0, "2026-09-15"]]);
  assert.equal(h.qa.state().punches.length, 2);
  assert.equal(h.qa.state().journeyRevision, 2);
  assert.match(h.qa.journeyCardMarkup(), /Retornar ao trabalho/);
});

test("conflito entre abas recarrega a jornada e exige um novo clique", async () => {
  let calls = 0;
  const records = punchFixture("2026-09-15", ["08:00:00"]);
  const h = ready({ api: {
    createPunch: async () => { calls += 1; throw Object.assign(new Error("Jornada atualizada em outra aba."), { status: 409, code: "stale_journey" }); },
    getPunches: async () => snapshot({ records }),
  } });
  await h.qa.registerPunch();
  assert.equal(calls, 1);
  assert.equal(h.qa.state().punches.length, 1);
  assert.equal(h.qa.state().journeyRevision, 1);
  assert.equal(h.qa.state().mutationPending, false);
  assert.match(h.qa.state().dataMessage, /outra aba/);
});

test("resposta antiga nunca desfaz uma revisão já recebida", () => {
  const h = ready();
  const records = punchFixture("2026-09-15", ["08:00:00", "12:00:00"]);
  h.qa.storeMonthResponse(snapshot({ records, revision: 4 }));
  h.qa.storeMonthResponse(snapshot({ records: records.slice(0, 1), revision: 3 }));
  assert.equal(h.qa.state().punches.length, 2);
  assert.equal(h.qa.state().punchesByMonth["2026-09"].length, 2);
  assert.equal(h.qa.state().journeyRevision, 4);
});

test("desfazer usa revisão e consulta o estado persistido após a exclusão", async () => {
  const calls = [];
  const h = ready({ api: {
    deletePunch: async (...args) => { calls.push(args); },
    getPunches: async () => snapshot({ revision: 2 }),
  } });
  h.qa.storeMonthResponse(snapshot({ records: punchFixture("2026-09-15", ["18:00:00"]) }));
  await h.qa.undoPunch();
  assert.deepEqual(calls, [[1, 1]]);
  assert.equal(h.qa.state().punches.length, 0);
  assert.equal(h.qa.state().journeyRevision, 2);
  assert.equal(h.qa.state().undoExpiresAt, 0);
});

test("ao terminar os cinco segundos a quarta batida permanece encerrada", () => {
  const h = ready();
  const records = punchFixture("2026-09-15", ["08:00:00", "12:00:00", "13:00:00", "18:00:00"]);
  h.qa.storeMonthResponse(snapshot({ records }));
  assert.match(h.qa.journeyCardMarkup(), /Desfazer saída/);
  const button = h.node("punch-button");
  h.setNow("2026-09-15T18:00:06-03:00");
  h.qa.updateUndoCountdown();
  assert.equal(button.disabled, true);
  assert.match(button.innerHTML, /Jornada encerrada/);
});

for (const nextDay of ["2026-09-16", "2026-10-01"]) {
  test(`virada para ${nextDay} habilita apenas a jornada atual após consultar a API`, async () => {
    const previousDay = nextDay === "2026-10-01" ? "2026-09-30" : "2026-09-15";
    const h = ready({ now: previousDay + "T23:59:59-03:00", api: {
      getPunches: async (month) => snapshot({ day: nextDay, revision: 4, month, now: nextDay + "T00:00:01-03:00" }),
    } });
    h.qa.storeMonthResponse(snapshot({ day: previousDay, now: previousDay + "T23:59:59-03:00",
      records: punchFixture(previousDay, ["08:00:00", "12:00:00", "13:00:00", "17:00:00"]) }));
    h.setNow(nextDay + "T00:00:01-03:00");
    h.qa.updateLiveData();
    assert.equal(h.qa.state().journeyLoaded, false);
    assert.match(h.qa.journeyCardMarkup(), /Atualizando jornada/);
    await settle();
    assert.equal(h.qa.state().currentDayKey, nextDay);
    assert.equal(h.qa.state().journeyLoaded, true);
    assert.equal(h.qa.state().punches.length, 0);
    assert.match(h.qa.journeyCardMarkup(), /Registrar entrada/);
    assert.equal(h.qa.formatDateKey(h.qa.state().selectedDate), nextDay);
    assert.equal(h.intervals.size, 1);
  });
}

for (const times of [["08:00:00"], ["08:00:00", "12:00:00"], ["08:00:00", "12:00:00", "13:00:00"]]) {
  test(`jornada antiga com ${times.length} batidas soma só intervalos fechados, sem saldo final`, () => {
    const h = ready();
    h.qa.storeMonthResponse(snapshot({ all: punchFixture("2026-09-14", times), revision: times.length }));
    h.qa.selectDay("2026-09-14");
    const data = h.qa.dayRecordData(h.qa.parseDateKey("2026-09-14"));
    assert.equal(data.incomplete, true);
    assert.equal(data.live, false);
    assert.equal(data.totalSeconds, times.length === 1 ? 0 : 4 * 3600);
    assert.equal(h.qa.dayStatus(data), "Jornada incompleta");
    assert.equal(h.qa.dayGoalChipData(data).value, "");
    assert.match(h.qa.selectedDayMarkup(), /Total parcial confirmado/);
    const row = h.qa.weeklyPayrollHistoryMarkup().match(/<div class="payroll-row [^>]*data-date="2026-09-14">[\s\S]*?<span class="payroll-status[\s\S]*?<\/span><\/div>/)[0];
    assert.match(row, /parcial/);
    assert.match(row, /Jornada incompleta/);
    assert.doesNotMatch(row, /Saída antecipada|-04:00|-08:00/);
  });
}

test("total semanal acompanha o minuto trabalhado e não conta o intervalo", () => {
  const h = ready({ now: "2026-09-15T08:00:30-03:00" });
  h.qa.storeMonthResponse(snapshot({ records: punchFixture("2026-09-15", ["08:00:30"]), now: "2026-09-15T08:00:30-03:00" }));
  const total = h.node("weekly-worked-time");
  h.qa.updateLiveData();
  h.setNow("2026-09-15T08:01:31-03:00");
  h.qa.suppressPolling();
  h.qa.updateLiveData();
  assert.equal(total.textContent, "0h 01min");
  h.qa.storeMonthResponse(snapshot({ records: punchFixture("2026-09-15", ["08:00:30", "08:01:31"]), now: "2026-09-15T08:01:31-03:00" }));
  h.setNow("2026-09-15T09:30:00-03:00");
  h.qa.suppressPolling();
  h.qa.updateLiveData();
  assert.equal(total.textContent, "0h 01min");
});

test("gauge de 10h adapta escala: 80% regular, 20% extra e marcador da meta", () => {
  const h = ready();
  h.qa.storeMonthResponse(snapshot({ records: punchFixture("2026-09-15", ["08:00:00"]) }));
  const regular = h.node("gauge-regular");
  const extra = h.node("gauge-extra");
  const marker = h.node("gauge-goal-marker");
  h.qa.updateGauge(h.qa.currentInstant());
  assert.equal(regular.style.strokeDasharray, "80 101");
  assert.equal(extra.style.strokeDasharray, "20 101");
  assert.equal(extra.style.strokeDashoffset, "-80");
  assert.ok(Number(marker.getAttribute("cx")) < 196);
  assert.ok(Number(marker.getAttribute("cy")) < 122);
});

test("meta não é herdada de localStorage nem de outra conta", () => {
  const h = ready({ storage: { "ponto-plus-daily-goal-minutes": "600" } });
  assert.equal(h.qa.state().dailyGoalMinutes, 480);
  h.qa.beginSession({ ...userFixture, daily_goal_minutes: 390 });
  assert.equal(h.qa.state().dailyGoalMinutes, 390);
  h.setToken("outra-conta");
  h.qa.beginSession({ ...userFixture, id: 2, daily_goal_minutes: 480 });
  assert.equal(h.qa.state().dailyGoalMinutes, 480);
});

test("mudança em outra aba e retorno de foco consultam dados atuais", async () => {
  let reads = 0;
  const h = ready({ api: {
    getPunches: async () => { reads += 1; return snapshot({ records: punchFixture("2026-09-15", ["08:00:00"]) }); },
  } });
  h.windowListeners.get("storage")({ key: "ponto-plus-data-update" });
  await settle();
  assert.equal(h.qa.state().punches.length, 1);
  h.windowListeners.get("focus")();
  await settle();
  assert.equal(reads, 2);
});

function profileForm(h) {
  const form = h.node("profile-form");
  const name = createNode("profile-name");
  const goal = createNode("profile-goal");
  name.value = "Ana Atualizada";
  goal.value = "06:30";
  form.elements = Object.assign([name, goal], { name, goal });
  let submit;
  form.addEventListener = (_type, handler) => { submit = handler; };
  h.qa.bindProfileForm();
  return () => submit({ preventDefault() {} });
}

test("salvar perfil persiste nome e meta; resposta antiga não reverte a alteração", async () => {
  const response = deferred();
  const calls = [];
  const h = ready({ route: "#/perfil", api: {
    getProfile: () => response.promise,
    updateProfile: async (name, goal) => {
      calls.push([name, goal]);
      return { user: { ...userFixture, name, daily_goal_minutes: goal } };
    },
  } });
  const submit = profileForm(h);
  const refresh = h.qa.refreshSessionData();
  await submit();
  response.resolve({ user: userFixture });
  await refresh;
  assert.deepEqual(calls, [["Ana Atualizada", 390]]);
  assert.equal(h.qa.state().dailyGoalMinutes, 390);
  assert.equal(h.qa.state().user.name, "Ana Atualizada");
  assert.equal(h.context.localStorage.getItem("ponto-plus-user"), null);
});

test("consulta e gravação de perfil atrasadas após logout são descartadas", async () => {
  const response = deferred();
  const h = ready({ route: "#/perfil", api: { updateProfile: () => response.promise } });
  const submit = profileForm(h);
  const pending = submit();
  h.qa.logout();
  response.resolve({ user: { ...userFixture, daily_goal_minutes: 600 } });
  await pending;
  assert.equal(h.qa.state().user.id, undefined);
  assert.equal(h.qa.state().dailyGoalMinutes, 480);
  assert.equal(h.context.window.location.hash, "#/login");
});

test("expiração e logout em outra aba invalidam dados privados", () => {
  for (const reason of ["expiry", "storage"]) {
    const h = ready();
    h.qa.storeMonthResponse(snapshot({ records: punchFixture("2026-09-15", ["08:00:00"]) }));
    if (reason === "expiry") h.setExpiresAt(Date.parse("2026-09-15T17:59:59-03:00"));
    else h.setToken(null);
    assert.equal(h.qa.checkSession(), false);
    assert.equal(h.qa.state().punches.length, 0);
    assert.equal(h.context.window.location.hash, "#/login");
  }
});

test("calendário mantém o dia escolhido e o dia de São Paulo em outros fusos", () => {
  const oldTZ = process.env.TZ;
  try {
    for (const zone of ["UTC", "Europe/Lisbon", "Asia/Tokyo", "America/Sao_Paulo"]) {
      process.env.TZ = zone;
      const h = createAppHarness({ now: "2026-09-16T01:00:00Z" });
      assert.equal(h.qa.formatDateKey(h.qa.todayDate()), "2026-09-15", zone);
      assert.equal(h.qa.formatLongDate(new Date(2026, 8, 15), true), "Terça-feira, 15 de setembro", zone);
    }
  } finally {
    if (oldTZ === undefined) delete process.env.TZ;
    else process.env.TZ = oldTZ;
  }
});

test("atalho de acessibilidade dá foco ao conteúdo sem trocar a rota", () => {
  const h = ready();
  const main = h.node("main-content");
  let prevented = false;
  h.documentListeners.get("click")({
    target: { closest: (selector) => selector === ".skip-link" ? {} : null },
    preventDefault: () => { prevented = true; },
  });
  assert.equal(prevented, true);
  assert.equal(main.focused, true);
  assert.equal(h.context.window.location.hash, "#/dashboard");
});

test("seletor mantém limite de 31 dias e aceita seleção invertida", () => {
  const h = ready();
  const error = h.node("history-range-error");
  h.qa.selectHistoryDate("2026-09-15");
  h.qa.selectHistoryDate("2026-08-01");
  assert.match(error.textContent, /máximo 31 dias/);
  assert.equal(h.qa.state().historyDraftEnd, null);
  h.qa.selectHistoryDate("2026-08-16");
  assert.equal(h.qa.historyRangeLength(h.qa.state().historyDraftStart, h.qa.state().historyDraftEnd), 31);
  assert.equal(h.qa.formatDateKey(h.qa.state().historyDraftStart), "2026-08-16");
});

test("notificações ficam entre sino e perfil no desktop, com margens no mobile", () => {
  const h = ready();
  const bell = createNode();
  const profile = createNode();
  const panel = h.node("notification-panel");
  bell.getBoundingClientRect = () => ({ left: 1090, bottom: 80 });
  profile.getBoundingClientRect = () => ({ right: 1400 });
  h.selectors.set('[data-action="notifications"]', bell);
  h.selectors.set(".profile-trigger", profile);
  h.qa.setNotificationsPanel(true);
  assert.equal(panel.style.left, "1090px");
  assert.equal(panel.style.right, "40px");
  assert.equal(panel.style.top, "92px");
  assert.equal(panel.hidden, false);
  for (const width of [900, 640, 375, 320]) {
    h.context.window.innerWidth = width;
    h.qa.positionNotificationsPanel();
    assert.equal(panel.style.left, width <= 640 ? "16px" : "20px");
    assert.equal(panel.style.right, panel.style.left);
  }
  h.documentListeners.get("keydown")({ key: "Escape" });
  assert.equal(panel.hidden, true);
});

test("bootstrap usa health, perfil e histórico antes de mostrar dados autenticados", async () => {
  const calls = [];
  const h = createAppHarness({ api: {
    getHealth: async () => { calls.push("health"); return { status: "ok" }; },
    getProfile: async () => { calls.push("profile"); return { user: userFixture }; },
    getPunches: async (month) => { calls.push(month); return snapshot({ month }); },
  } });
  await h.qa.bootstrap();
  await settle();
  assert.deepEqual(calls.slice(0, 3), ["health", "profile", "2026-09"]);
  assert.equal(h.qa.state().journeyLoaded, true);
  assert.match(h.node("app").innerHTML, /Ana/);
});

test("HTML escapa dados de usuário e de notificações", () => {
  const h = ready();
  h.qa.beginSession({ ...userFixture, name: '<img src=x onerror="alert(1)">' });
  h.qa.suppressPolling();
  h.qa.render();
  assert.doesNotMatch(h.node("app").innerHTML, /<img src=x/);
  h.qa.setNotifications([{ title: "<script>alert(1)</script>", message: "<img src=x>", read: false }]);
  assert.doesNotMatch(h.qa.notificationPanelMarkup(), /<script>|<img src=x>/);
});
