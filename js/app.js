(function () {
  "use strict";

  var APP_NAME = "Ponto+";
  var USER_STORAGE_KEY = "ponto-plus-user";
  var TIME_ZONE = "America/Sao_Paulo";
  var DEFAULT_DAILY_GOAL_MINUTES = 8 * 60;
  var UNDO_WINDOW_MS = 5000;
  var ROUTES = [
    "#/login",
    "#/cadastro",
    "#/dashboard",
    "#/calendario",
    "#/historico",
    "#/perfil",
  ];
  var PUNCH_TYPES = ["clock_in", "break_start", "break_end", "clock_out"];
  var PUNCH_LABELS = ["Entrada", "Início do intervalo", "Retorno", "Saída"];
  var ACTION_LABELS = [
    "Registrar entrada",
    "Iniciar intervalo",
    "Retornar ao trabalho",
    "Encerrar jornada",
    "Jornada encerrada",
  ];
  var STATUS_LABELS = [
    "Não iniciada",
    "Trabalhando",
    "Em intervalo",
    "Trabalhando",
    "Encerrada",
  ];
  var STATUS_MESSAGES = [
    "Sua jornada ainda não começou.",
    "Você está trabalhando.",
    "Você está em intervalo.",
    "Você retornou ao trabalho.",
    "Jornada concluída por hoje.",
  ];
  var app = document.getElementById("app");
  var announcer = document.getElementById("announcer");
  var tickTimer = null;
  var undoTimer = null;
  var sessionAppTheme = null;
  var punches = [];
  var punchesByMonth = {};
  var loadingMonths = {};
  var dataMessage = "";
  var undoExpiresAt = 0;
  var selectedDate = new Date();
  var displayedMonth = new Date();
  var historyRangeEnd = new Date();
  var historyRangeStart = new Date(
    historyRangeEnd.getFullYear(),
    historyRangeEnd.getMonth(),
    historyRangeEnd.getDate() - 6,
  );
  var historyPickerMonth = new Date(
    historyRangeEnd.getFullYear(),
    historyRangeEnd.getMonth(),
    1,
  );
  var historyDraftStart = new Date(historyRangeStart);
  var historyDraftEnd = new Date(historyRangeEnd);
  var preservedScrollY = null;
  var storedGoalMinutes = Number(
    localStorage.getItem("ponto-plus-daily-goal-minutes"),
  );
  var dailyGoalMinutes =
    Number.isFinite(storedGoalMinutes) &&
    storedGoalMinutes >= 1 &&
    storedGoalMinutes <= 1439
      ? storedGoalMinutes
      : DEFAULT_DAILY_GOAL_MINUTES;

  function readJSON(key, fallback) {
    try {
      var value = localStorage.getItem(key);
      return value ? JSON.parse(value) : fallback;
    } catch (_error) {
      return fallback;
    }
  }

  var user = readJSON(USER_STORAGE_KEY, {
    name: "Usuário",
    email: "",
    createdAt: "—",
  });

  function setCurrentUser(apiUser) {
    var createdDate = new Date(apiUser.created_at);
    user = {
      id: apiUser.id,
      name: apiUser.name,
      email: apiUser.email,
      createdAt: Number.isNaN(createdDate.getTime())
        ? "—"
        : new Intl.DateTimeFormat("pt-BR").format(createdDate),
    };
    localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(user));
  }

  function normalizePunch(apiPunch) {
    return {
      id: apiPunch.id,
      type: apiPunch.type,
      at: new Date(apiPunch.occurred_at),
    };
  }

  function zonedDateKey(date) {
    var parts = new Intl.DateTimeFormat("en-US", {
      timeZone: TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    var values = {};
    parts.forEach(function (part) {
      if (part.type !== "literal") values[part.type] = part.value;
    });
    return values.year + "-" + values.month + "-" + values.day;
  }

  function monthKey(date) {
    return formatDateKey(date).slice(0, 7);
  }

  function punchesForDate(date) {
    var dateKey = formatDateKey(date);
    var monthPunches = punchesByMonth[dateKey.slice(0, 7)] || [];
    return monthPunches.filter(function (punch) {
      return zonedDateKey(punch.at) === dateKey;
    });
  }

  function syncTodayHistory() {
    var todayKey = zonedDateKey(new Date());
    var currentMonth = todayKey.slice(0, 7);
    if (!Object.prototype.hasOwnProperty.call(punchesByMonth, currentMonth)) {
      return;
    }
    punchesByMonth[currentMonth] = punchesByMonth[currentMonth]
      .filter(function (punch) {
        return zonedDateKey(punch.at) !== todayKey;
      })
      .concat(punches)
      .sort(function (left, right) {
        return left.at.getTime() - right.at.getTime();
      });
  }

  function storeMonthResponse(response) {
    punchesByMonth[response.month] = response.punches.map(normalizePunch);
    if (response.today && response.today.date === zonedDateKey(new Date())) {
      punches = response.today.punches.map(normalizePunch);
      var lastPunch = punches[punches.length - 1];
      undoExpiresAt = lastPunch
        ? Math.max(0, lastPunch.at.getTime() + UNDO_WINDOW_MS)
        : 0;
    }
  }

  async function loadMonth(month) {
    if (Object.prototype.hasOwnProperty.call(punchesByMonth, month)) return;
    if (!loadingMonths[month]) {
      loadingMonths[month] = window.PontoPlusApi.getPunches(month)
        .then(storeMonthResponse)
        .finally(function () {
          delete loadingMonths[month];
        });
    }
    await loadingMonths[month];
  }

  async function loadDateRange(startDate, endDate) {
    var cursor = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
    var last = new Date(endDate.getFullYear(), endDate.getMonth(), 1);
    var months = [];
    while (cursor <= last) {
      months.push(monthKey(cursor));
      cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
    }
    await Promise.all(months.map(loadMonth));
  }

  function handleApiError(error) {
    if (error && error.status === 401) {
      window.PontoPlusApi.clearToken();
      localStorage.removeItem(USER_STORAGE_KEY);
      announce("Sua sessão expirou. Entre novamente.");
      routeTo("#/login");
      return false;
    }
    dataMessage =
      (error && error.message) || "Não foi possível atualizar os dados.";
    announce(dataMessage);
    return true;
  }

  async function loadInitialData() {
    try {
      await loadDateRange(historyRangeStart, historyRangeEnd);
      dataMessage = "";
      return true;
    } catch (error) {
      handleApiError(error);
      return false;
    }
  }

  function escapeHTML(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function announce(message) {
    announcer.textContent = "";
    window.setTimeout(function () {
      announcer.textContent = message;
    }, 40);
  }

  function initials(name) {
    return name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map(function (part) {
        return part.charAt(0).toUpperCase();
      })
      .join("");
  }

  function isAuthenticated() {
    return Boolean(
      window.PontoPlusApi && window.PontoPlusApi.accessToken(),
    );
  }

  function preferredAppTheme() {
    if (sessionAppTheme) return sessionAppTheme;
    var saved = localStorage.getItem("ponto-plus-theme");
    if (saved) return saved;
    return window.matchMedia &&
      window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }

  function timeBasedTheme() {
    var hour = Number(
      new Intl.DateTimeFormat("en-US", {
        timeZone: TIME_ZONE,
        hour: "2-digit",
        hour12: false,
      }).format(new Date()),
    );
    return hour >= 18 || hour < 6 ? "dark" : "light";
  }

  function applyAuthTimeTheme() {
    document.documentElement.dataset.theme = timeBasedTheme();
    document.documentElement.dataset.authTheme = "automatic";
  }

  function restoreAppTheme() {
    delete document.documentElement.dataset.authTheme;
    document.documentElement.dataset.theme = preferredAppTheme();
  }

  function currentRoute() {
    var route = window.location.hash || "#/login";
    return ROUTES.indexOf(route) >= 0 ? route : "#/login";
  }

  function routeTo(route) {
    if (window.location.hash === route) {
      render();
    } else {
      window.location.hash = route;
    }
  }

  function ensureRouteAccess(route) {
    if (
      route !== "#/login" &&
      route !== "#/cadastro" &&
      !isAuthenticated()
    ) {
      routeTo("#/login");
      return false;
    }
    if ((route === "#/login" || route === "#/cadastro") && isAuthenticated()) {
      routeTo("#/dashboard");
      return false;
    }
    return true;
  }

  function formatTime(date) {
    return new Intl.DateTimeFormat("pt-BR", {
      timeZone: TIME_ZONE,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(date);
  }

  function formatShortTime(date) {
    return new Intl.DateTimeFormat("pt-BR", {
      timeZone: TIME_ZONE,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);
  }

  function formatLongDate(date) {
    return new Intl.DateTimeFormat("pt-BR", {
      weekday: "long",
      day: "numeric",
      month: "long",
    }).format(date);
  }

  function formatMonth(date) {
    var text = new Intl.DateTimeFormat("pt-BR", {
      month: "long",
      year: "numeric",
    }).format(date);
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  function formatDateKey(date) {
    var year = date.getFullYear();
    var month = String(date.getMonth() + 1).padStart(2, "0");
    var day = String(date.getDate()).padStart(2, "0");
    return year + "-" + month + "-" + day;
  }

  function parseDateKey(value) {
    var parts = value.split("-").map(Number);
    return new Date(parts[0], parts[1] - 1, parts[2]);
  }

  function historyRangeLength(startDate, endDate) {
    var startUTC = Date.UTC(
      startDate.getFullYear(),
      startDate.getMonth(),
      startDate.getDate(),
    );
    var endUTC = Date.UTC(
      endDate.getFullYear(),
      endDate.getMonth(),
      endDate.getDate(),
    );
    return Math.floor((endUTC - startUTC) / 86400000) + 1;
  }

  function secondsToClock(totalSeconds) {
    var safe = Math.max(0, Math.floor(totalSeconds));
    var hours = Math.floor(safe / 3600);
    var minutes = Math.floor((safe % 3600) / 60);
    var seconds = safe % 60;
    return (
      String(hours).padStart(2, "0") +
      ":" +
      String(minutes).padStart(2, "0") +
      ":" +
      String(seconds).padStart(2, "0")
    );
  }

  function dailyGoalSeconds() {
    return dailyGoalMinutes * 60;
  }

  function goalInputValue() {
    var hours = Math.floor(dailyGoalMinutes / 60);
    var minutes = dailyGoalMinutes % 60;
    return (
      String(hours).padStart(2, "0") +
      ":" +
      String(minutes).padStart(2, "0")
    );
  }

  function goalShortLabel(minutes) {
    var value = typeof minutes === "number" ? minutes : dailyGoalMinutes;
    var hours = Math.floor(value / 60);
    var remaining = value % 60;
    if (!remaining) return hours + "h";
    if (!hours) return remaining + "min";
    return hours + "h " + String(remaining).padStart(2, "0") + "min";
  }

  function getGreeting(date) {
    var hour = Number(
      new Intl.DateTimeFormat("en-US", {
        timeZone: TIME_ZONE,
        hour: "2-digit",
        hour12: false,
      }).format(date),
    );
    if (hour < 12) return "Bom dia";
    if (hour < 18) return "Boa tarde";
    return "Boa noite";
  }

  function workedSecondsFor(records, now, live) {
    if (!records.length) return 0;
    var total = 0;
    if (records[0] && (records[1] || live)) {
      var firstEnd = records[1] ? records[1].at : now;
      total += Math.max(0, firstEnd.getTime() - records[0].at.getTime());
    }
    if (records[2] && (records[3] || live)) {
      var secondEnd = records[3] ? records[3].at : now;
      total += Math.max(0, secondEnd.getTime() - records[2].at.getTime());
    }
    return total / 1000;
  }

  function getWorkedSeconds(now) {
    return workedSecondsFor(punches, now, true);
  }

  function getStatusClass() {
    if (punches.length === 1 || punches.length === 3) return "working";
    if (punches.length === 2) return "warning";
    if (punches.length === 4) return "finished";
    return "neutral";
  }

  function presenceState() {
    if (punches.length === 1 || punches.length === 3) {
      return { className: "is-working", label: "Trabalhando" };
    }
    if (punches.length === 2) {
      return { className: "is-break", label: "Em intervalo" };
    }
    return { className: "is-finished", label: "Indisponível" };
  }

  function themeToggleMarkup(extraClass) {
    var theme = document.documentElement.dataset.theme;
    var next = theme === "dark" ? "claro" : "escuro";
    return (
      '<button class="theme-toggle ' +
      (extraClass || "") +
      '" type="button" data-action="toggle-theme" aria-label="Ativar tema ' +
      next +
      '">' +
      '<span class="theme-option" aria-hidden="true">☼</span>' +
      '<span class="theme-option" aria-hidden="true">☾</span>' +
      "</button>"
    );
  }

  function brandMarkup(className) {
    return (
      '<a class="brand ' +
      (className || "") +
      '" href="#/dashboard" aria-label="Ponto+, ir para a jornada">' +
      '<img class="logo-light" src="./assets/brand/logo.svg" alt="Ponto+" />' +
      '<img class="logo-dark" src="./assets/brand/logo-on-dark.svg" alt="Ponto+" />' +
      '<img class="logo-compact" src="./assets/brand/logo-mark.svg" alt="Ponto+" />' +
      "</a>"
    );
  }

  function navMarkup(route, mobile) {
    var items = [
      {
        route: "#/dashboard",
        label: "Minha jornada",
        icon: "nav-dashboard",
      },
      {
        route: "#/calendario",
        label: "Calendário",
        icon: "nav-calendar",
      },
      {
        route: "#/historico",
        label: "Histórico",
        icon: "nav-history",
      },
      {
        route: "#/perfil",
        label: "Configurações",
        icon: "nav-settings",
      },
    ];
    return (
      '<nav class="' +
      (mobile ? "mobile-nav" : "main-nav") +
      '" aria-label="Navegação principal">' +
      items
        .map(function (item) {
          var active = route === item.route;
          return (
            '<a class="nav-link ' +
            (active ? "is-active" : "") +
            '" href="' +
            item.route +
            '" aria-label="' +
            item.label +
            '" ' +
            (active ? 'aria-current="page"' : "") +
            ">" +
            '<span class="nav-symbol ' +
            item.icon +
            '" aria-hidden="true"></span>' +
            '<span class="nav-text">' +
            item.label +
            "</span></a>"
          );
        })
        .join("") +
      "</nav>"
    );
  }

  function authenticatedShell(route, pageTitle, content) {
    var safeName = escapeHTML(user.name);
    var safeEmail = escapeHTML(user.email);
    var safeInitials = escapeHTML(initials(user.name));
    var presence = presenceState();
    return (
      '<div class="app-shell">' +
      '<aside class="sidebar">' +
      '<div class="sidebar-header">' +
      brandMarkup("sidebar-brand") +
      "</div>" +
      '<p class="sidebar-label">Menu</p>' +
      navMarkup(route, false) +
      '<div class="sidebar-footer">' +
      '<a class="user-summary" href="#/perfil" aria-label="Abrir configurações do perfil">' +
      '<span class="avatar" aria-hidden="true">' +
      safeInitials +
      "</span>" +
      '<span class="user-copy"><strong>' +
      safeName +
      "</strong><span>" +
      safeEmail +
      '</span></span><span class="profile-arrow" aria-hidden="true">›</span>' +
      "</a>" +
      '<button class="logout-button" type="button" data-action="logout">' +
      '<span class="logout-icon" aria-hidden="true">↪</span><span class="logout-text">Sair</span></button>' +
      "</div>" +
      "</aside>" +
      '<div class="main-column">' +
      '<header class="topbar">' +
      '<div class="topbar-title-wrap">' +
      '<a class="topbar-brand" href="#/dashboard" aria-label="Ponto+, ir para a jornada">' +
      '<img src="./assets/brand/logo-mark.svg" alt="" />' +
      "</a>" +
      '<h1 class="page-title">' +
      pageTitle +
      "</h1>" +
      "</div>" +
      '<div class="topbar-actions">' +
      themeToggleMarkup() +
      '<button class="notification-button" type="button" data-action="notifications" aria-label="Abrir notificações">' +
      '<span class="notification-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9.5 2.2C9.92 1.44 10.83 0.95 12 0.95C13.17 0.95 14.08 1.44 14.5 2.2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><g transform="translate(0 1.4)"><path d="M18 8.75C18 5.44 15.31 2.75 12 2.75C8.69 2.75 6 5.44 6 8.75C6 12.15 5.45 14.1 4.52 15.55C4.04 16.3 4.58 17.25 5.47 17.25H18.53C19.42 17.25 19.96 16.3 19.48 15.55C18.55 14.1 18 12.15 18 8.75Z" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M9.5 20C9.92 20.76 10.83 21.25 12 21.25C13.17 21.25 14.08 20.76 14.5 20" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></g><circle cx="18.4" cy="5.4" r="3.6" fill="var(--primary)" stroke="var(--surface)" stroke-width="1.3"/></svg></span>' +
      "</button>" +
      '<a class="profile-trigger" href="#/perfil" aria-label="Abrir meu perfil, status: ' +
      presence.label +
      '">' +
      '<span class="profile-avatar-wrap">' +
      '<span class="avatar" aria-hidden="true">' +
      safeInitials +
      '</span><span class="online-indicator ' +
      presence.className +
      '" aria-hidden="true"></span></span>' +
      '<span class="profile-trigger-copy"><strong>' +
      safeName +
      "</strong><span>" +
      presence.label +
      "</span></span>" +
      '<span class="profile-arrow" aria-hidden="true">›</span>' +
      "</a>" +
      "</div>" +
      "</header>" +
      '<main id="main-content" class="content ' +
      (route === "#/dashboard" ? "is-dashboard" : "") +
      '" tabindex="-1">' +
      content +
      "</main>" +
      navMarkup(route, true) +
      "</div>" +
      "</div>"
    );
  }

  function authAsideMarkup(mode) {
    var isRegister = mode === "register";
    return (
      '<aside class="auth-aside" aria-label="Apresentação do Ponto+">' +
      (!isRegister
        ? '<img class="auth-aside-logo" src="./assets/brand/logo-on-dark.svg" alt="Ponto+" />'
        : "") +
      '<div class="auth-line-art" aria-hidden="true">' +
      '<span class="contour contour-one"></span>' +
      '<span class="contour contour-two"></span>' +
      '<span class="contour contour-three"></span>' +
      '<span class="contour contour-four"></span>' +
      '<span class="art-circle art-circle-one"></span>' +
      '<span class="art-circle art-circle-two"></span>' +
      '<span class="art-plus art-plus-one"></span>' +
      '<span class="art-plus art-plus-two"></span>' +
      '<span class="art-dots"></span>' +
      "</div>" +
      '<div class="aside-content">' +
      '<p class="aside-eyebrow">Jornada simples, todos os dias</p>' +
      "<h2>" +
      (isRegister ? "Seu dia começa por aqui." : "Bem-vindo de volta!") +
      "</h2>" +
      "<p>" +
      (isRegister
        ? "Crie sua conta e tenha clareza sobre cada etapa da sua jornada."
        : "Entre para registrar seu ponto e acompanhar seu tempo com tranquilidade.") +
      "</p>" +
      "</div>" +
      "</aside>"
    );
  }

  function authBackgroundMarkup() {
    return (
      '<div class="auth-background-art" aria-hidden="true">' +
      '<span class="background-shape background-circle"></span>' +
      '<span class="background-shape background-square"></span>' +
      '<span class="background-shape background-diamond"></span>' +
      '<span class="background-line background-line-one"></span>' +
      '<span class="background-line background-line-two"></span>' +
      '<span class="background-plus background-plus-one"></span>' +
      '<span class="background-plus background-plus-two"></span>' +
      '<span class="background-plus background-plus-three"></span>' +
      "</div>"
    );
  }

  function forgotPasswordMarkup() {
    return (
      '<dialog class="forgot-dialog" id="forgot-dialog" aria-labelledby="forgot-title">' +
      '<form class="forgot-card" id="forgot-form" method="dialog" novalidate>' +
      '<button class="dialog-close" type="button" data-action="close-forgot" aria-label="Fechar recuperação de senha">×</button>' +
      '<span class="forgot-icon" aria-hidden="true"></span>' +
      '<h2 id="forgot-title">Recuperar senha</h2>' +
      '<p>Informe seu e-mail. No produto final, enviaremos as instruções de recuperação.</p>' +
      '<div class="field"><label for="forgot-email">E-mail</label>' +
      '<div class="auth-input-wrap"><span class="auth-field-icon auth-email-icon" aria-hidden="true"></span>' +
      '<input id="forgot-email" name="email" type="email" autocomplete="email" placeholder="voce@email.com" required /></div>' +
      '<span class="field-error" id="forgot-email-error"></span></div>' +
      '<div class="success-banner" id="forgot-success" role="status">Instruções simuladas enviadas com sucesso.</div>' +
      '<button class="primary-button auth-submit" type="submit">Enviar instruções</button>' +
      "</form></dialog>"
    );
  }

  function renderLogin() {
    applyAuthTimeTheme();
    document.title = APP_NAME + " | Entrar";
    var rememberedEmail = escapeHTML(
      localStorage.getItem("ponto-plus-remember-email") || "",
    );
    app.innerHTML =
      '<div class="auth-layout">' +
      authBackgroundMarkup() +
      '<div class="auth-frame">' +
      authAsideMarkup("login") +
      '<main id="main-content" class="auth-panel" tabindex="-1">' +
      '<section class="auth-card" aria-labelledby="login-title">' +
      brandMarkup() +
      '<h1 id="login-title">Entrar</h1>' +
      '<form class="form" id="login-form" novalidate>' +
      '<div class="form-message" id="login-message" role="alert" tabindex="-1"></div>' +
      '<div class="field">' +
      '<label class="sr-only" for="login-email">E-mail</label>' +
      '<div class="auth-input-wrap"><span class="auth-field-icon auth-email-icon" aria-hidden="true"></span>' +
      '<input id="login-email" name="email" type="email" autocomplete="email" placeholder="E-mail" value="' +
      rememberedEmail +
      '" required /></div>' +
      '<span class="field-error" id="login-email-error"></span>' +
      "</div>" +
      '<div class="field">' +
      '<label class="sr-only" for="login-password">Senha</label>' +
      '<div class="password-wrap auth-input-wrap">' +
      '<span class="auth-field-icon auth-lock-icon" aria-hidden="true"></span>' +
      '<input id="login-password" name="password" type="password" autocomplete="current-password" placeholder="Senha" minlength="6" required />' +
      '<button class="password-toggle" type="button" data-action="toggle-password" data-target="login-password" aria-label="Mostrar senha">Mostrar</button>' +
      "</div>" +
      '<span class="field-error" id="login-password-error"></span>' +
      "</div>" +
      '<div class="auth-options">' +
      '<label class="remember-option"><input type="checkbox" name="remember" ' +
      (rememberedEmail ? "checked" : "") +
      ' /><span class="custom-checkbox" aria-hidden="true"></span><span>Lembrar de mim</span></label>' +
      '<button class="forgot-link" type="button" data-action="forgot-password">Esqueci a senha</button>' +
      "</div>" +
      '<button class="primary-button auth-submit" type="submit">Entrar</button>' +
      "</form>" +
      '<p class="auth-switch">Ainda não tem conta? <a href="#/cadastro">Criar uma conta</a></p>' +
      "</section>" +
      "</main>" +
      "</div>" +
      forgotPasswordMarkup() +
      "</div>";
    bindLoginForm();
    bindForgotForm();
    startAuthThemeClock();
  }

  function renderRegister() {
    applyAuthTimeTheme();
    document.title = APP_NAME + " | Criar conta";
    app.innerHTML =
      '<div class="auth-layout">' +
      authBackgroundMarkup() +
      '<div class="auth-frame">' +
      authAsideMarkup("register") +
      '<main id="main-content" class="auth-panel" tabindex="-1">' +
      '<section class="auth-card" aria-labelledby="register-title">' +
      brandMarkup() +
      '<h1 id="register-title">Criar conta</h1>' +
      '<form class="form" id="register-form" novalidate>' +
      '<div class="form-message" id="register-message" role="alert" tabindex="-1"></div>' +
      '<div class="field"><label class="sr-only" for="register-name">Nome</label>' +
      '<div class="auth-input-wrap"><span class="auth-field-icon auth-user-icon" aria-hidden="true"></span>' +
      '<input id="register-name" name="name" type="text" autocomplete="name" placeholder="Nome completo" required /></div>' +
      '<span class="field-error" id="register-name-error"></span></div>' +
      '<div class="field"><label class="sr-only" for="register-email">E-mail</label>' +
      '<div class="auth-input-wrap"><span class="auth-field-icon auth-email-icon" aria-hidden="true"></span>' +
      '<input id="register-email" name="email" type="email" autocomplete="email" placeholder="E-mail" required /></div>' +
      '<span class="field-error" id="register-email-error"></span></div>' +
      '<div class="field"><label class="sr-only" for="register-password">Senha</label>' +
      '<div class="password-wrap auth-input-wrap">' +
      '<span class="auth-field-icon auth-lock-icon" aria-hidden="true"></span>' +
      '<input id="register-password" name="password" type="password" autocomplete="new-password" placeholder="Senha" minlength="6" required />' +
      '<button class="password-toggle" type="button" data-action="toggle-password" data-target="register-password" aria-label="Mostrar senha">Mostrar</button>' +
      "</div>" +
      '<span class="field-error" id="register-password-error"></span></div>' +
      '<button class="primary-button auth-submit" type="submit">Criar conta</button>' +
      "</form>" +
      '<p class="auth-switch">Já tem uma conta? <a href="#/login">Entrar</a></p>' +
      "</section>" +
      "</main>" +
      "</div>" +
      "</div>";
    bindRegisterForm();
    startAuthThemeClock();
  }

  function timelineMarkup() {
    var mobileProgress = punches.length === 0 ? 0 : Math.min(100, (punches.length / 3) * 100);
    var desktopProgress = punches.length === 0 ? 0 : Math.min(76, (punches.length / 3) * 76);
    var html =
      '<div class="timeline" aria-label="Sequência de batidas" style="--progress:' +
      desktopProgress +
      "%;--mobile-progress:" +
      mobileProgress +
      '%"><span class="timeline-progress" aria-hidden="true"></span>';
    PUNCH_LABELS.forEach(function (label, index) {
      var complete = Boolean(punches[index]);
      var current = !complete && index === punches.length && punches.length < 4;
      var time = complete ? formatShortTime(punches[index].at) : "--:--";
      html +=
        '<div class="timeline-step ' +
        (complete ? "is-complete" : current ? "is-current" : "") +
        '">' +
        '<span class="timeline-dot" aria-hidden="true">' +
        (complete ? "✓" : "") +
        "</span>" +
        '<span class="timeline-label">' +
        label +
        "</span>" +
        '<span class="timeline-time">' +
        time +
        "</span>" +
        "</div>";
    });
    return html + "</div>";
  }

  function journeyCardMarkup() {
    var index = punches.length;
    var canUndo =
      Boolean(undoExpiresAt) &&
      Date.now() < undoExpiresAt &&
      punches.length > 0;
    var actionClass = canUndo ? "undo-journey-action" : "";
    var action = canUndo ? "undo-punch" : "register-punch";
    var actionLabel = canUndo
      ? 'Desfazer ' +
        PUNCH_LABELS[index - 1].toLowerCase() +
        ' · <span id="undo-countdown">00:05</span>'
      : escapeHTML(ACTION_LABELS[index]);
    return (
      '<section class="card priority-card journey-card combined-journey-card" aria-labelledby="journey-title">' +
      '<div class="card-header">' +
      "<div><h3 id=\"journey-title\">Controle de ponto</h3><p>" +
      escapeHTML(STATUS_MESSAGES[index]) +
      "</p></div>" +
      '<span class="status-pill ' +
      getStatusClass() +
      '">' +
      escapeHTML(STATUS_LABELS[index]) +
      "</span>" +
      "</div>" +
      '<div class="journey-gauge-area">' +
      '<div class="gauge-wrap" role="img" id="hours-gauge" aria-label="Nenhuma hora trabalhada hoje">' +
      '<svg class="gauge-svg" viewBox="0 24 220 118" aria-hidden="true">' +
      '<path class="gauge-track" pathLength="100" d="M 24 122 A 86 86 0 0 1 196 122"></path>' +
      '<path class="gauge-regular" id="gauge-regular" pathLength="100" d="M 24 122 A 86 86 0 0 1 196 122"></path>' +
      '<path class="gauge-extra" id="gauge-extra" pathLength="100" d="M 196 122 A 86 86 0 0 0 24 122"></path>' +
      "</svg>" +
      '<div class="gauge-value"><strong id="worked-time">00:00:00</strong><span>tempo trabalhado</span></div>' +
      "</div>" +
      "</div>" +
      '<button class="primary-button journey-action ' +
      actionClass +
      '" id="punch-button" type="button" data-action="' +
      action +
      '" style="--undo-progress:0%" ' +
      (!canUndo && index >= 4 ? "disabled" : "") +
      '><span class="journey-action-label">' +
      actionLabel +
      "</span></button>" +
      '<div class="journey-timeline-wrap">' +
      timelineMarkup() +
      "</div>" +
      "</section>"
    );
  }

  function calendarMarkup() {
    var year = displayedMonth.getFullYear();
    var month = displayedMonth.getMonth();
    var first = new Date(year, month, 1);
    var last = new Date(year, month + 1, 0);
    var leading = first.getDay();
    var cells = [];
    for (var i = 0; i < leading; i += 1) cells.push(null);
    for (var day = 1; day <= last.getDate(); day += 1) cells.push(day);
    while (cells.length < 42) cells.push(null);

    var daysHTML = cells
      .map(function (dayNumber) {
        if (!dayNumber) {
          return '<button class="calendar-day is-outside" type="button" disabled aria-hidden="true"></button>';
        }
        var date = new Date(year, month, dayNumber);
        var isToday = formatDateKey(date) === zonedDateKey(new Date());
        var isSelected = formatDateKey(date) === formatDateKey(selectedDate);
        var dayData = dayRecordData(date);
        var hasWork = dayData.worked;
        var isAbsent = dayData.absent;
        var hasOvertime =
          dayData.totalSeconds > dailyGoalSeconds();
        var hasReachedGoal =
          hasWork &&
          !hasOvertime &&
          dayData.totalSeconds >= dailyGoalSeconds() * 0.99;
        return (
          '<button class="calendar-day ' +
          (hasWork ? "has-work " : "") +
          (isAbsent ? "is-absent " : "") +
          (hasReachedGoal ? "has-reached-goal " : "") +
          (hasOvertime ? "has-overtime " : "") +
          (isToday ? "is-today " : "") +
          (isSelected ? "is-selected" : "") +
          '" type="button" data-action="select-date" data-date="' +
          formatDateKey(date) +
          '" aria-label="' +
          dayNumber +
          " de " +
          formatMonth(date) +
          (hasWork ? ", dia trabalhado" : "") +
          (isAbsent ? ", ausente" : "") +
          (hasWork && !hasReachedGoal && !hasOvertime
            ? ", meta não atingida"
            : "") +
          (hasReachedGoal ? ", meta atingida" : "") +
          (hasOvertime ? ", com hora extra" : "") +
          '"' +
          (isSelected ? ' aria-pressed="true"' : ' aria-pressed="false"') +
          ">" +
          dayNumber +
          "</button>"
        );
      })
      .join("");

    return (
      '<section class="card calendar-card" id="calendar-section" tabindex="-1" aria-labelledby="calendar-title">' +
      '<div class="card-header">' +
      '<div><h3 id="calendar-title">Calendário</h3><p>Dias trabalhados no mês</p></div>' +
      '<div class="month-controls">' +
      '<button class="icon-button" type="button" data-action="previous-month" aria-label="Mês anterior">‹</button>' +
      '<button class="icon-button" type="button" data-action="next-month" aria-label="Próximo mês">›</button>' +
      "</div></div>" +
      '<p class="eyebrow" id="calendar-month">' +
      formatMonth(displayedMonth) +
      "</p>" +
      '<div class="calendar-weekdays" aria-hidden="true"><span>Dom</span><span>Seg</span><span>Ter</span><span>Qua</span><span>Qui</span><span>Sex</span><span>Sáb</span></div>' +
      '<div class="calendar-grid">' +
      daysHTML +
      "</div>" +
      "</section>"
    );
  }

  function dayRecordData(date) {
    var dateKey = formatDateKey(date);
    var todayKey = zonedDateKey(new Date());
    if (dateKey === todayKey) {
      var totalSeconds = punches.length ? getWorkedSeconds(new Date()) : 0;
      return {
        worked: punches.length > 0,
        times: PUNCH_LABELS.map(function (_label, index) {
          return punches[index] ? formatShortTime(punches[index].at) : "--:--";
        }),
        totalSeconds: totalSeconds,
        minutes: Math.floor(totalSeconds / 60),
        complete: punches.length === 4,
        live: punches.length > 0 && punches.length < 4,
        absent: false,
      };
    }
    var records = punchesForDate(date);
    var totalSeconds = workedSecondsFor(
      records,
      records.length ? records[records.length - 1].at : new Date(),
      false,
    );
    return {
      worked: records.length > 0,
      absent: false,
      times: PUNCH_LABELS.map(function (_label, index) {
        return records[index] ? formatShortTime(records[index].at) : "--:--";
      }),
      totalSeconds: totalSeconds,
      minutes: Math.floor(totalSeconds / 60),
      complete: records.length === 4,
      live: false,
    };
  }

  function dayStatus(data) {
    if (data.absent) return "Ausente";
    if (!data.worked) return "Sem registros";
    if (data.live) return "Em andamento";
    if (data.totalSeconds > dailyGoalSeconds()) return "Hora extra";
    if (data.totalSeconds >= dailyGoalSeconds() * 0.99) return "Concluído";
    return "Saída antecipada";
  }

  function dayStatusClass(data) {
    if (data.absent) return "is-absent";
    if (!data.worked) return "is-empty";
    if (data.live) return "is-live";
    if (data.totalSeconds > dailyGoalSeconds()) return "is-overtime";
    if (data.totalSeconds >= dailyGoalSeconds() * 0.99) {
      return "is-complete";
    }
    return "is-early";
  }

  function dayGoalChipData(data) {
    var difference = data.totalSeconds - dailyGoalSeconds();
    var overtimeValue =
      difference > 0 ? "+" + secondsToClock(difference).slice(0, 5) : "";
    if (data.absent) {
      return {
        label: "Ausente",
        value: "",
        overtime: "",
        statusClass: "is-absent",
      };
    }
    if (!data.worked) {
      return {
        label: "Sem registros",
        value: "",
        overtime: overtimeValue,
        statusClass: "is-empty",
      };
    }
    if (data.live) {
      return {
        label: "Em andamento",
        value: "",
        overtime: "",
        statusClass: "is-live",
      };
    }
    if (difference > 0) {
      return {
        label: "Concluído",
        value: "",
        overtime: overtimeValue,
        statusClass: "is-complete",
      };
    }
    if (data.totalSeconds >= dailyGoalSeconds() * 0.99) {
      return {
        label: "Concluído",
        value: "",
        overtime: overtimeValue,
        statusClass: "is-complete",
      };
    }
    return {
      label: "Saída antecipada",
      value: "-" + secondsToClock(Math.abs(difference)).slice(0, 5),
      overtime: overtimeValue,
      statusClass: "is-early",
    };
  }

  function selectedDayMarkup() {
    var data = dayRecordData(selectedDate);
    var overtime = Math.max(0, data.totalSeconds - dailyGoalSeconds());
    var hasOvertime = overtime > 0;
    var isEarly = dayStatusClass(data) === "is-early";
    var goalPercent = data.totalSeconds
      ? Math.round((data.totalSeconds / dailyGoalSeconds()) * 1000) / 10
      : 0;
    var regularProgressWidth = hasOvertime
      ? (dailyGoalSeconds() / data.totalSeconds) * 100
      : Math.min(100, goalPercent);
    var balanceProgressWidth = hasOvertime
      ? (overtime / data.totalSeconds) * 100
      : isEarly
        ? Math.max(0, 100 - regularProgressWidth)
        : 0;
    var goalChip = dayGoalChipData(data);
    var dateLabel = new Intl.DateTimeFormat("pt-BR", {
      weekday: "long",
      day: "2-digit",
      month: "long",
    }).format(selectedDate);
    var punchesMarkup = PUNCH_LABELS.map(function (label, index) {
      var recorded = data.times[index] !== "--:--";
      var nextRecorded =
        index < PUNCH_LABELS.length - 1 && data.times[index + 1] !== "--:--";
      var itemClasses = [
        "day-punch-timeline-item",
        recorded ? "is-recorded" : "",
        index === 0 ? "is-start" : "",
        index === PUNCH_LABELS.length - 1 ? "is-end" : "",
        recorded && nextRecorded ? "has-connector" : "",
        hasOvertime &&
        recorded &&
        nextRecorded &&
        index === PUNCH_LABELS.length - 2
          ? "is-overtime-connector"
          : "",
        hasOvertime &&
        recorded &&
        index === PUNCH_LABELS.length - 1
          ? "is-overtime-exit"
          : "",
      ]
        .filter(Boolean)
        .join(" ");
      return (
        '<div class="' +
        itemClasses +
        '"><span class="day-punch-timeline-marker" aria-hidden="true"></span>' +
        "<strong>" +
        data.times[index] +
        "</strong><span>" +
        label +
        "</span></div>"
      );
    }).join("");
    var week = centeredComparisonData(selectedDate);
    var comparisonDateFormatter = new Intl.DateTimeFormat("pt-BR", {
      day: "2-digit",
      month: "2-digit",
    });
    var workedDays = week.filter(function (item) {
      return item.minutes > 0;
    });
    var averageMinutes = workedDays.length
      ? Math.round(
          workedDays.reduce(function (sum, item) {
            return sum + item.minutes;
          }, 0) / workedDays.length,
        )
      : 0;
    var weeklyBarsMarkup = week
      .map(function (item) {
        var extraMinutes = Math.max(0, item.minutes - dailyGoalMinutes);
        var missingMinutes =
          item.statusClass === "is-early"
            ? Math.max(0, dailyGoalMinutes - item.minutes)
            : 0;
        var totalHeight = item.minutes
          ? item.statusClass === "is-early"
            ? 48
            : Math.max(
                8,
                Math.min(48, Math.round((item.minutes / dailyGoalMinutes) * 48)),
              )
          : 6;
        // Uma faixa mínima torna poucos minutos de hora extra perceptíveis.
        // O valor exato continua sendo informado numericamente no card.
        var extraRatio = extraMinutes
          ? Math.min(
              32,
              Math.round((8 + (extraMinutes / 120) * 24) * 10) / 10,
            )
          : 0;
        var earlyRatio = missingMinutes
          ? Math.min(
              32,
              Math.round((8 + (missingMinutes / 120) * 24) * 10) / 10,
            )
          : 0;
        var barClasses = [
          "day-week-bar",
          item.minutes ? "" : "is-empty",
          item.statusClass === "is-overtime" ? "is-overtime" : "",
          item.statusClass === "is-early" ? "is-early" : "",
          formatDateKey(item.date) === formatDateKey(selectedDate)
            ? "is-selected"
            : "",
          formatDateKey(item.date) === zonedDateKey(new Date())
            ? "is-today"
            : "",
        ]
          .filter(Boolean)
          .join(" ");
        return (
          '<button class="' +
          barClasses +
          '" type="button" data-action="select-date" data-date="' +
          formatDateKey(item.date) +
          '" aria-label="Selecionar ' +
          escapeHTML(item.fullLabel) +
          '" aria-pressed="' +
          (formatDateKey(item.date) === formatDateKey(selectedDate)
            ? "true"
            : "false") +
          '" style="--total-height:' +
          totalHeight +
          "px;--extra-ratio:" +
          extraRatio +
          "%;--early-ratio:" +
          earlyRatio +
          '%"><span class="day-week-bar-plot" aria-hidden="true"><i></i></span><small><span>' +
          item.shortLabel.toUpperCase() +
          '</span><time datetime="' +
          formatDateKey(item.date) +
          '">' +
          comparisonDateFormatter.format(item.date) +
          "</time></small></button>"
        );
      })
      .join("");
    return (
      '<section class="card history-card selected-day-card ' +
      (hasOvertime ? "is-overtime " : "") +
      (isEarly ? "is-early " : "") +
      (hasOvertime && data.complete ? "is-finalized-overtime" : "") +
      '" id="selected-day-card" aria-labelledby="selected-day-title">' +
      '<div class="card-header"><div><h3 id="selected-day-title">Detalhes do dia</h3><p class="selected-date-label">' +
      dateLabel +
      "</p></div></div>" +
      '<div class="selected-day-insights"><div class="day-punch-timeline-panel"><h4>Jornada registrada</h4>' +
      '<div class="day-punch-timeline">' +
      punchesMarkup +
      '</div></div><div class="day-total-panel"><span>Total do dia</span><strong id="selected-day-total">' +
      secondsToClock(data.totalSeconds) +
      '</strong><div class="day-goal-progress" role="progressbar" aria-label="Progresso da meta diária" aria-valuemin="0" aria-valuemax="' +
      Math.max(100, Math.ceil(goalPercent)) +
      '" aria-valuenow="' +
      goalPercent +
      '"><i id="selected-day-goal-progress" style="width:' +
      regularProgressWidth +
      '%"></i><b id="selected-day-extra-progress" style="left:' +
      regularProgressWidth +
      "%;width:" +
      balanceProgressWidth +
      '%"></b></div><div class="day-goal-meta"><span>Meta diária ' +
      goalInputValue() +
      '</span><strong id="selected-day-goal-percent">' +
      String(goalPercent).replace(".", ",") +
      '%</strong></div><div class="day-goal-chips" aria-live="polite"><span class="day-goal-chip ' +
      goalChip.statusClass +
      '" id="selected-day-goal-chip"><span id="selected-day-goal-chip-label">' +
      goalChip.label +
      '</span><strong id="selected-day-goal-chip-value">' +
      goalChip.value +
      '</strong></span><span class="day-overtime-chip">Hora extra <strong id="selected-day-overtime-chip-value">' +
      goalChip.overtime +
      "</strong></span></div></div></div>" +
      '<div class="day-week-comparison"><div><span>Comparativo da semana</span><strong>Na média</strong><small>' +
      minutesLabel(averageMinutes) +
      ' por dia</small></div><div class="day-week-bars" aria-label="Comparativo de sete dias com a data selecionada ao centro">' +
      weeklyBarsMarkup +
      "</div></div></section>"
    );
  }

  // A janela móvel mantém o dia escolhido na quarta posição do gráfico.
  function centeredComparisonData(centerDate) {
    var shortFormatter = new Intl.DateTimeFormat("pt-BR", {
      weekday: "short",
    });
    var fullFormatter = new Intl.DateTimeFormat("pt-BR", {
      weekday: "long",
      day: "numeric",
      month: "long",
    });
    var days = [];
    for (var offset = -3; offset <= 3; offset += 1) {
      var date = new Date(
        centerDate.getFullYear(),
        centerDate.getMonth(),
        centerDate.getDate() + offset,
      );
      var record = dayRecordData(date);
      days.push({
        date: date,
        minutes: record.minutes,
        totalSeconds: record.totalSeconds,
        times: record.times,
        status: dayStatus(record),
        statusClass: dayStatusClass(record),
        shortLabel: shortFormatter
          .format(date)
          .replace(".", "")
          .slice(0, 3),
        fullLabel: fullFormatter.format(date),
      });
    }
    return days;
  }

  function weeklyHistoryData() {
    var shortFormatter = new Intl.DateTimeFormat("pt-BR", { weekday: "short" });
    var fullFormatter = new Intl.DateTimeFormat("pt-BR", {
      weekday: "long",
      day: "numeric",
      month: "long",
    });
    var days = [];
    var referenceDate = new Date();
    for (var offset = 6; offset >= 0; offset -= 1) {
      var date = new Date(
        referenceDate.getFullYear(),
        referenceDate.getMonth(),
        referenceDate.getDate() - offset,
      );
      var record = dayRecordData(date);
      days.push({
        date: date,
        minutes: record.minutes,
        totalSeconds: record.totalSeconds,
        times: record.times,
        status: dayStatus(record),
        statusClass: dayStatusClass(record),
        shortLabel: shortFormatter
          .format(date)
          .replace(".", "")
          .slice(0, 3),
        fullLabel: fullFormatter.format(date),
      });
    }
    return days;
  }

  function historyPeriodData() {
    var shortFormatter = new Intl.DateTimeFormat("pt-BR", {
      weekday: "short",
    });
    var fullFormatter = new Intl.DateTimeFormat("pt-BR", {
      weekday: "long",
      day: "numeric",
      month: "long",
    });
    var days = [];
    var rangeLength = historyRangeLength(historyRangeStart, historyRangeEnd);
    for (var offset = 0; offset < rangeLength; offset += 1) {
      var date = new Date(
        historyRangeStart.getFullYear(),
        historyRangeStart.getMonth(),
        historyRangeStart.getDate() + offset,
      );
      var record = dayRecordData(date);
      days.push({
        date: date,
        minutes: record.minutes,
        totalSeconds: record.totalSeconds,
        times: record.times,
        status: dayStatus(record),
        statusClass: dayStatusClass(record),
        shortLabel: shortFormatter
          .format(date)
          .replace(".", "")
          .slice(0, 3),
        fullLabel: fullFormatter.format(date),
      });
    }
    return days;
  }

  function historyPeriodSummary() {
    var rangeLength = historyRangeLength(historyRangeStart, historyRangeEnd);
    var today = new Date();
    var previousMonthStart = new Date(
      today.getFullYear(),
      today.getMonth() - 1,
      1,
    );
    var previousMonthEnd = new Date(
      today.getFullYear(),
      today.getMonth(),
      0,
    );
    if (
      formatDateKey(historyRangeStart) ===
        formatDateKey(previousMonthStart) &&
      formatDateKey(historyRangeEnd) === formatDateKey(previousMonthEnd)
    ) {
      return "Mostrando resultados do último mês";
    }
    if (formatDateKey(historyRangeEnd) === formatDateKey(today)) {
      return (
        "Mostrando resultados dos últimos " +
        rangeLength +
        (rangeLength === 1 ? " dia" : " dias")
      );
    }
    var formatter = new Intl.DateTimeFormat("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
    return (
      "Mostrando resultados entre " +
      formatter.format(historyRangeStart) +
      " e " +
      formatter.format(historyRangeEnd)
    );
  }

  function historyPickerMonthOptionsMarkup() {
    var options = [];
    var today = new Date();
    for (var offset = 0; offset < 36; offset += 1) {
      var date = new Date(
        today.getFullYear(),
        today.getMonth() - offset,
        1,
      );
      options.push(
        '<option value="' +
          formatDateKey(date).slice(0, 7) +
          '"' +
          (date.getFullYear() === historyPickerMonth.getFullYear() &&
          date.getMonth() === historyPickerMonth.getMonth()
            ? " selected"
            : "") +
          ">" +
          formatMonth(date) +
          "</option>",
      );
    }
    return options.join("");
  }

  function historyPickerCalendarMarkup() {
    var year = historyPickerMonth.getFullYear();
    var month = historyPickerMonth.getMonth();
    var firstDay = new Date(year, month, 1);
    var lastDay = new Date(year, month + 1, 0);
    var cells = [];
    for (var leading = 0; leading < firstDay.getDay(); leading += 1) {
      cells.push(null);
    }
    for (var day = 1; day <= lastDay.getDate(); day += 1) {
      cells.push(day);
    }
    while (cells.length < 42) cells.push(null);

    var startKey = historyDraftStart
      ? formatDateKey(historyDraftStart)
      : "";
    var endKey = historyDraftEnd ? formatDateKey(historyDraftEnd) : "";
    var todayKey = zonedDateKey(new Date());
    var daysMarkup = cells
      .map(function (dayNumber, index) {
        if (!dayNumber) {
          return '<span class="history-picker-day is-empty" aria-hidden="true"></span>';
        }
        var date = new Date(year, month, dayNumber);
        var dateKey = formatDateKey(date);
        var isFuture = dateKey > todayKey;
        var isStart = dateKey === startKey;
        var isEnd = dateKey === endKey;
        var isInRange =
          startKey &&
          endKey &&
          dateKey >= startKey &&
          dateKey <= endKey;
        var classes = [
          "history-picker-day",
          isInRange ? "is-in-range" : "",
          isStart ? "is-range-start" : "",
          isEnd ? "is-range-end" : "",
          isInRange && (index % 7 === 0 || isStart) ? "is-row-start" : "",
          isInRange && (index % 7 === 6 || isEnd) ? "is-row-end" : "",
          dateKey === todayKey ? "is-today" : "",
        ]
          .filter(Boolean)
          .join(" ");
        return (
          '<button class="' +
          classes +
          '" type="button" data-action="select-history-date" data-date="' +
          dateKey +
          '" aria-label="' +
          escapeHTML(formatLongDate(date)) +
          '"' +
          (isFuture ? " disabled" : "") +
          '><span aria-hidden="true">' +
          dayNumber +
          "</span></button>"
        );
      })
      .join("");
    var currentMonth = new Date(
      new Date().getFullYear(),
      new Date().getMonth(),
      1,
    );
    var isCurrentMonth =
      historyPickerMonth.getFullYear() === currentMonth.getFullYear() &&
      historyPickerMonth.getMonth() === currentMonth.getMonth();
    var earliestMonth = new Date(
      currentMonth.getFullYear(),
      currentMonth.getMonth() - 35,
      1,
    );
    var isEarliestMonth =
      historyPickerMonth.getFullYear() === earliestMonth.getFullYear() &&
      historyPickerMonth.getMonth() === earliestMonth.getMonth();
    var hint = !historyDraftEnd
      ? "Agora escolha a data final"
      : historyRangeLength(historyDraftStart, historyDraftEnd) +
        (historyRangeLength(historyDraftStart, historyDraftEnd) === 1
          ? " dia selecionado"
          : " dias selecionados");
    return (
      '<div class="history-picker-toolbar"><label class="sr-only" for="history-picker-month">Escolher mês</label><select id="history-picker-month" aria-label="Escolher mês">' +
      historyPickerMonthOptionsMarkup() +
      '</select><div class="history-picker-navigation"><button type="button" data-action="previous-history-month" aria-label="Mês anterior"' +
      (isEarliestMonth ? " disabled" : "") +
      '>‹</button><button type="button" data-action="next-history-month" aria-label="Próximo mês"' +
      (isCurrentMonth ? " disabled" : "") +
      ">›</button></div></div>" +
      '<div class="history-picker-weekdays" aria-hidden="true"><span>Dom</span><span>Seg</span><span>Ter</span><span>Qua</span><span>Qui</span><span>Sex</span><span>Sáb</span></div>' +
      '<div class="history-picker-grid" id="history-picker-grid">' +
      daysMarkup +
      '</div><p class="history-picker-hint" id="history-picker-hint">' +
      hint +
      "</p>"
    );
  }

  function minutesLabel(totalMinutes) {
    if (!totalMinutes) return "—";
    var hours = Math.floor(totalMinutes / 60);
    var minutes = totalMinutes % 60;
    return hours + "h" + (minutes ? " " + String(minutes).padStart(2, "0") + "min" : "");
  }

  function weeklyTotalMarkup() {
    var totalMinutes = weeklyHistoryData().reduce(function (sum, item) {
      return sum + item.minutes;
    }, 0);
    var weeklyGoalMinutes = dailyGoalMinutes * 5;
    return (
      '<section class="weekly-total-card weekly-rhythm-card" aria-labelledby="weekly-total-title">' +
      '<div class="weekly-total-top"><h3 id="weekly-total-title">Seu ritmo nesta semana</h3>' +
      '<a href="#/historico">Ver histórico <span aria-hidden="true">↗</span></a></div>' +
      '<div class="weekly-total-bottom"><strong>' +
      minutesLabel(totalMinutes) +
      '</strong><p>Total de horas<br />trabalhadas na semana</p></div>' +
      '<div class="weekly-rhythm-progress"><span style="--week-progress:' +
      Math.min(100, Math.round((totalMinutes / weeklyGoalMinutes) * 100)) +
      '%"></span></div><small>Meta semanal de ' +
      goalShortLabel(weeklyGoalMinutes) +
      "</small></section>"
    );
  }

  function weeklyPayrollHistoryMarkup() {
    var period = historyPeriodData().slice().reverse();
    var rangeFormatter = new Intl.DateTimeFormat("pt-BR", {
      day: "2-digit",
      month: "short",
    });
    var rows = period
      .map(function (item) {
        var balanceSeconds =
          item.statusClass === "is-absent"
            ? -dailyGoalSeconds()
            : item.statusClass !== "is-live" && item.totalSeconds
              ? item.totalSeconds - dailyGoalSeconds()
              : null;
        var balanceClass =
          balanceSeconds === null
            ? ""
            : balanceSeconds > 0
              ? "is-positive"
              : item.statusClass === "is-absent"
                ? "is-absence"
                : balanceSeconds < 0 && item.statusClass === "is-early"
                  ? "is-negative"
                  : balanceSeconds < 0
                    ? "is-tolerated"
                    : "is-neutral";
        var balanceLabel =
          balanceSeconds === null
            ? "—"
            : balanceSeconds === 0
              ? "00:00"
              : (balanceSeconds > 0 ? "+" : "-") +
                secondsToClock(Math.abs(balanceSeconds)).slice(0, 5);
        return (
          '<div class="payroll-row ' +
          (item.statusClass === "is-absent" ? "is-absent" : "") +
          '" role="row">' +
          '<div class="payroll-day" role="cell"><strong>' +
          item.shortLabel +
          '</strong><span>' +
          rangeFormatter.format(item.date) +
          "</span></div>" +
          item.times
            .map(function (time, index) {
              return (
                '<span class="payroll-time" role="cell"><small class="mobile-column-label">' +
                PUNCH_LABELS[index] +
                "</small>" +
                time +
                "</span>"
              );
            })
            .join("") +
          '<strong class="payroll-total" role="cell"><small class="mobile-column-label">Total</small>' +
          (item.totalSeconds ? secondsToClock(item.totalSeconds).slice(0, 5) : "—") +
          '</strong><strong class="payroll-balance ' +
          balanceClass +
          '" role="cell"><small class="mobile-column-label">Saldo</small>' +
          balanceLabel +
          '</strong><span class="payroll-status ' +
          item.statusClass +
          '" role="cell">' +
          item.status +
          "</span></div>"
        );
      })
      .join("");
    return (
      '<section class="card weekly-payroll-card" id="history-section" tabindex="-1" aria-labelledby="history-title">' +
      '<div class="card-header"><div><h3 id="history-title">Histórico</h3><p>' +
      historyPeriodSummary() +
      "</p></div>" +
      '<div class="history-range-control"><button class="history-range" type="button" data-action="toggle-history-range" aria-expanded="false" aria-controls="history-range-panel"><span class="history-range-calendar" aria-hidden="true"></span><span>' +
      rangeFormatter.format(historyRangeStart) +
      " – " +
      rangeFormatter.format(historyRangeEnd) +
      '</span><span class="history-range-chevron" aria-hidden="true">⌄</span></button>' +
      '<div class="history-range-panel" id="history-range-panel" hidden><div class="history-range-panel-header"><div><strong>Escolher período</strong><span>Máximo de 31 dias</span></div></div>' +
      '<div id="history-picker-calendar">' +
      historyPickerCalendarMarkup() +
      '</div><span class="history-range-error" id="history-range-error" role="alert"></span>' +
      '<div class="history-range-actions"><button class="history-range-reset" type="button" data-action="history-last-seven">Últimos 7 dias</button><button class="primary-button history-range-apply" type="button" data-action="apply-history-range">Aplicar período</button></div></div></div></div>' +
      '<div class="payroll-table" role="table" aria-label="Histórico de ponto do período selecionado">' +
      '<div class="payroll-head" role="row"><span role="columnheader">Dia</span><span role="columnheader">Entrada</span><span role="columnheader">Intervalo</span><span role="columnheader">Retorno</span><span role="columnheader">Saída</span><span role="columnheader">Total</span><span role="columnheader">Saldo</span><span role="columnheader">Status</span></div>' +
      rows +
      "</div></section>"
    );
  }

  function renderDashboard(route) {
    restoreAppTheme();
    var activeRoute = route || "#/dashboard";
    var pageTitles = {
      "#/dashboard": "Minha jornada",
      "#/calendario": "Calendário",
      "#/historico": "Histórico",
    };
    var pageTitle = pageTitles[activeRoute] || "Minha jornada";
    document.title = APP_NAME + " | " + pageTitle;
    var now = new Date();
    var firstName = user.name.trim().split(/\s+/)[0] || "você";
    var content =
      '<section class="greeting-panel" aria-labelledby="greeting-title">' +
      '<div><p class="eyebrow">Visão de hoje</p><h2 id="greeting-title">' +
      getGreeting(now) +
      ", " +
      escapeHTML(firstName) +
      '!</h2><p class="greeting-date">' +
      formatLongDate(now) +
      '</p></div><div class="live-time-card" aria-label="Horário local">' +
      '<span class="live-time-icon" aria-hidden="true"></span>' +
      '<div class="live-time-copy"><span>Horário local</span><time class="live-time" id="live-clock" datetime="' +
      now.toISOString() +
      '">' +
      formatTime(now) +
      '</time><small class="time-zone"><span class="time-zone-pin" aria-hidden="true"></span>São Paulo</small></div></div></section>' +
      (dataMessage
        ? '<div class="form-message is-visible dashboard-message" role="alert">' +
          escapeHTML(dataMessage) +
          "</div>"
        : "") +
      '<div class="dashboard-primary-grid">' +
      journeyCardMarkup() +
      weeklyTotalMarkup() +
      "</div>" +
      '<div class="dashboard-secondary-grid">' +
      calendarMarkup() +
      selectedDayMarkup() +
      "</div>" +
      weeklyPayrollHistoryMarkup();
    app.innerHTML = authenticatedShell(activeRoute, pageTitle, content);
    updateLiveData();
    startTicking();
    startUndoCountdown();
  }

  function renderProfile() {
    restoreAppTheme();
    document.title = APP_NAME + " | Configurações";
    var content =
      '<section class="greeting-panel" aria-labelledby="profile-page-title">' +
      '<div><p class="eyebrow">Conta</p><h2 id="profile-page-title">Meu perfil</h2><p class="greeting-date">Gerencie seus dados pessoais.</p></div>' +
      "</section>" +
      '<div class="profile-page-grid">' +
      '<section class="profile-identity" aria-label="Identidade do usuário">' +
      '<span class="profile-avatar" aria-hidden="true">' +
      escapeHTML(initials(user.name)) +
      "</span>" +
      "<h2>" +
      escapeHTML(user.name) +
      "</h2><p>" +
      escapeHTML(user.email) +
      "</p>" +
      '<div class="profile-meta"><span class="meta-pill">Meta ' +
      goalShortLabel() +
      '</span><span class="meta-pill">Desde ' +
      escapeHTML(user.createdAt) +
      "</span></div>" +
      "</section>" +
      '<section class="card profile-card" aria-labelledby="profile-form-title">' +
      '<div class="card-header"><div><h3 id="profile-form-title">Dados pessoais</h3><p>Atualize seu nome e sua meta diária.</p></div></div>' +
      '<div class="success-banner" id="profile-success" role="status">Configurações atualizadas com sucesso.</div>' +
      '<div class="form-message" id="profile-message" role="alert" tabindex="-1"></div>' +
      '<form id="profile-form" novalidate>' +
      '<div class="profile-form-grid">' +
      '<div class="field"><label for="profile-name">Nome</label><input id="profile-name" name="name" type="text" autocomplete="name" value="' +
      escapeHTML(user.name) +
      '" required /><span class="field-error" id="profile-name-error"></span></div>' +
      '<div class="field"><label for="profile-goal">Meta diária</label><input id="profile-goal" name="goal" type="time" min="00:01" max="23:59" step="60" value="' +
      goalInputValue() +
      '" required /><span class="field-error" id="profile-goal-error"></span></div>' +
      '<div class="field"><label for="profile-email">E-mail</label><input class="field-readonly" id="profile-email" type="email" value="' +
      escapeHTML(user.email) +
      '" readonly /></div>' +
      '<div class="field"><label for="profile-created">Data de cadastro</label><input class="field-readonly" id="profile-created" type="text" value="' +
      escapeHTML(user.createdAt) +
      '" readonly /></div>' +
      "</div>" +
      '<div class="profile-actions">' +
      '<button class="danger-button" type="button" data-action="logout">Sair</button>' +
      '<button class="primary-button" type="submit">Salvar alterações</button>' +
      "</div>" +
      "</form>" +
      "</section>" +
      "</div>";
    app.innerHTML = authenticatedShell("#/perfil", "Configurações", content);
    bindProfileForm();
  }

  function render() {
    stopTimers();
    var route = currentRoute();
    if (!ensureRouteAccess(route)) return;
    if (route === "#/login") renderLogin();
    if (route === "#/cadastro") renderRegister();
    if (
      route === "#/dashboard" ||
      route === "#/calendario" ||
      route === "#/historico"
    ) {
      renderDashboard(route);
    }
    if (route === "#/perfil") renderProfile();
    if (preservedScrollY !== null) {
      var targetScrollY = preservedScrollY;
      preservedScrollY = null;
      window.requestAnimationFrame(function () {
        window.scrollTo({ top: targetScrollY, left: 0, behavior: "auto" });
      });
    } else {
      window.scrollTo(0, 0);
      focusDashboardSection(route);
    }
  }

  function focusDashboardSection(route) {
    var targetId =
      route === "#/calendario"
        ? "calendar-section"
        : route === "#/historico"
          ? "history-section"
          : "";
    if (!targetId) return;
    window.requestAnimationFrame(function () {
      var target = document.getElementById(targetId);
      if (!target) return;
      target.scrollIntoView({ behavior: "smooth", block: "start" });
      target.focus({ preventScroll: true });
    });
  }

  function stopTimers() {
    if (tickTimer) window.clearInterval(tickTimer);
    if (undoTimer) window.clearInterval(undoTimer);
    tickTimer = null;
    undoTimer = null;
  }

  function startTicking() {
    tickTimer = window.setInterval(updateLiveData, 1000);
  }

  function startAuthThemeClock() {
    tickTimer = window.setInterval(applyAuthTimeTheme, 60000);
  }

  function updateLiveData() {
    var now = new Date();
    var liveClock = document.getElementById("live-clock");
    if (liveClock) {
      liveClock.textContent = formatTime(now);
      liveClock.setAttribute("datetime", now.toISOString());
    }
    updateGauge(now);
  }

  function updateGauge(now) {
    var total = getWorkedSeconds(now);
    var goalSeconds = dailyGoalSeconds();
    var overtime = Math.max(0, total - goalSeconds);
    var regular = Math.min(total, goalSeconds);
    var regularPercent = (regular / goalSeconds) * 100;
    var extraPercent = Math.min(
      100,
      (overtime / goalSeconds) * 100,
    );

    var regularPath = document.getElementById("gauge-regular");
    var extraPath = document.getElementById("gauge-extra");
    if (regularPath) {
      regularPath.style.strokeDasharray = regularPercent + " 101";
      regularPath.style.strokeDashoffset = "0";
      regularPath.style.opacity = regularPercent > 0 ? "1" : "0";
    }
    if (extraPath) {
      extraPath.style.strokeDasharray = extraPercent + " 101";
      extraPath.style.strokeDashoffset = "0";
      extraPath.style.opacity = extraPercent > 0 ? "1" : "0";
    }

    setText("worked-time", secondsToClock(total));
    if (formatDateKey(selectedDate) === zonedDateKey(now) && punches.length) {
      setText("selected-day-total", secondsToClock(total));
      var liveDayData = dayRecordData(selectedDate);
      var liveGoalChip = dayGoalChipData(liveDayData);
      setText("selected-day-goal-chip-label", liveGoalChip.label);
      setText("selected-day-goal-chip-value", liveGoalChip.value);
      setText("selected-day-overtime-chip-value", liveGoalChip.overtime);
      var selectedGoalChip = document.getElementById(
        "selected-day-goal-chip",
      );
      if (selectedGoalChip) {
        selectedGoalChip.className =
          "day-goal-chip " + liveGoalChip.statusClass;
      }
      var selectedCard = document.getElementById("selected-day-card");
      var selectedProgress = document.getElementById(
        "selected-day-goal-progress",
      );
      var selectedExtraProgress = document.getElementById(
        "selected-day-extra-progress",
      );
      var selectedProgressBar = selectedProgress
        ? selectedProgress.parentElement
        : null;
      var selectedPercent =
        Math.round((total / goalSeconds) * 1000) / 10;
      var selectedRegularWidth =
        overtime > 0
          ? (goalSeconds / total) * 100
          : Math.min(100, selectedPercent);
      var selectedExtraWidth =
        overtime > 0
          ? (overtime / total) * 100
          : liveGoalChip.statusClass === "is-early"
            ? Math.max(0, 100 - selectedRegularWidth)
            : 0;
      var selectedExit = document.querySelector(
        ".day-punch-timeline-item.is-end",
      );
      var selectedFinalConnector = document.querySelector(
        ".day-punch-timeline-item:nth-last-child(2)",
      );
      setText(
        "selected-day-goal-percent",
        String(selectedPercent).replace(".", ",") + "%",
      );
      if (selectedProgress) {
        selectedProgress.style.width = selectedRegularWidth + "%";
      }
      if (selectedExtraProgress) {
        selectedExtraProgress.style.left = selectedRegularWidth + "%";
        selectedExtraProgress.style.width = selectedExtraWidth + "%";
      }
      if (selectedProgressBar) {
        selectedProgressBar.setAttribute("aria-valuenow", selectedPercent);
        selectedProgressBar.setAttribute(
          "aria-valuemax",
          Math.max(100, Math.ceil(selectedPercent)),
        );
        selectedProgressBar.setAttribute(
          "aria-valuetext",
          String(selectedPercent).replace(".", ",") + "% da meta diária",
        );
      }
      if (selectedCard) {
        selectedCard.classList.toggle("is-overtime", overtime > 0);
        selectedCard.classList.toggle(
          "is-early",
          liveGoalChip.statusClass === "is-early",
        );
        selectedCard.classList.toggle(
          "is-finalized-overtime",
          overtime > 0 && liveDayData.complete,
        );
      }
      if (selectedExit) {
        selectedExit.classList.toggle(
          "is-overtime-exit",
          overtime > 0 && selectedExit.classList.contains("is-recorded"),
        );
      }
      if (selectedFinalConnector) {
        selectedFinalConnector.classList.toggle(
          "is-overtime-connector",
          overtime > 0 &&
            selectedFinalConnector.classList.contains("has-connector"),
        );
      }
    }

    var gauge = document.getElementById("hours-gauge");
    if (gauge) {
      gauge.setAttribute(
        "aria-label",
          secondsToClock(total) +
          " trabalhadas hoje. Meta de " +
          goalShortLabel() +
          "." +
          (overtime > 0 ? " Hora extra de " + secondsToClock(overtime) + "." : ""),
      );
    }
  }

  function setText(id, value) {
    var element = document.getElementById(id);
    if (element) element.textContent = value;
  }

  function startUndoCountdown() {
    if (!undoExpiresAt || Date.now() >= undoExpiresAt) return;
    updateUndoCountdown();
    undoTimer = window.setInterval(updateUndoCountdown, 100);
  }

  function updateUndoCountdown() {
    var remaining = Math.max(0, undoExpiresAt - Date.now());
    var countdown = document.getElementById("undo-countdown");
    var button = document.getElementById("punch-button");
    var elapsedPercent =
      (1 - remaining / UNDO_WINDOW_MS) * 100;
    if (countdown) countdown.textContent = "00:" + String(Math.ceil(remaining / 1000)).padStart(2, "0");
    if (button) {
      button.style.setProperty(
        "--undo-progress",
        Math.min(100, Math.max(0, elapsedPercent)) + "%",
      );
    }
    if (remaining <= 0) {
      undoExpiresAt = 0;
      if (undoTimer) window.clearInterval(undoTimer);
      undoTimer = null;
      if (button) {
        button.classList.remove("undo-journey-action");
        button.dataset.action = "register-punch";
        button.style.removeProperty("--undo-progress");
        button.disabled = punches.length >= 4;
        button.innerHTML =
          '<span class="journey-action-label">' +
          escapeHTML(ACTION_LABELS[punches.length]) +
          "</span>";
      }
    }
  }

  function refreshDashboardPreservingScroll() {
    var scrollY = window.scrollY;
    stopTimers();
    renderDashboard(currentRoute());
    window.requestAnimationFrame(function () {
      window.scrollTo({ top: scrollY, left: 0, behavior: "auto" });
    });
  }

  async function registerPunch() {
    if (punches.length >= 4) {
      announce("Sua jornada de hoje já foi encerrada.");
      return;
    }
    var button = document.getElementById("punch-button");
    if (button) {
      button.disabled = true;
      button.textContent = "Registrando...";
    }
    try {
      var response = await window.PontoPlusApi.createPunch();
      var punch = normalizePunch(response.punch);
      punches.push(punch);
      syncTodayHistory();
      undoExpiresAt = punch.at.getTime() + UNDO_WINDOW_MS;
      dataMessage = "";
      announce(
        PUNCH_LABELS[punches.length - 1] +
          " registrada às " +
          formatShortTime(punch.at) +
          ".",
      );
      refreshDashboardPreservingScroll();
    } catch (error) {
      if (handleApiError(error)) refreshDashboardPreservingScroll();
    }
  }

  async function undoPunch() {
    if (!punches.length || Date.now() >= undoExpiresAt) return;
    var lastPunch = punches[punches.length - 1];
    var button = document.getElementById("punch-button");
    if (button) button.disabled = true;
    try {
      await window.PontoPlusApi.deletePunch(lastPunch.id);
      punches.pop();
      syncTodayHistory();
      undoExpiresAt = 0;
      dataMessage = "";
      announce("A última batida foi desfeita.");
      refreshDashboardPreservingScroll();
    } catch (error) {
      if (error && error.code === "undo_window_expired") {
        undoExpiresAt = 0;
      }
      if (handleApiError(error)) refreshDashboardPreservingScroll();
    }
  }

  function toggleTheme() {
    var current = document.documentElement.dataset.theme;
    var next = current === "dark" ? "light" : "dark";
    sessionAppTheme = next;
    document.documentElement.dataset.theme = next;
    localStorage.setItem("ponto-plus-theme", next);
    document.querySelectorAll('[data-action="toggle-theme"]').forEach(function (button) {
      button.setAttribute("aria-label", "Ativar tema " + (next === "dark" ? "claro" : "escuro"));
    });
    announce("Tema " + (next === "dark" ? "escuro" : "claro") + " ativado.");
  }

  function logout() {
    window.PontoPlusApi.clearToken();
    localStorage.removeItem(USER_STORAGE_KEY);
    // Remove chaves da fase de protótipo para não manter uma sessão simulada.
    localStorage.removeItem("ponto-plus-demo-auth");
    sessionStorage.removeItem("ponto-plus-demo-auth");
    localStorage.removeItem("ponto-plus-demo-user");
    sessionAppTheme = null;
    punches = [];
    punchesByMonth = {};
    loadingMonths = {};
    dataMessage = "";
    undoExpiresAt = 0;
    announce("Sessão encerrada.");
    routeTo("#/login");
  }

  function openForgotPassword() {
    var dialog = document.getElementById("forgot-dialog");
    var loginEmail = document.getElementById("login-email");
    var forgotEmail = document.getElementById("forgot-email");
    if (!dialog) return;
    if (forgotEmail && loginEmail && loginEmail.value.trim()) {
      forgotEmail.value = loginEmail.value.trim();
    }
    if (forgotEmail) setFieldError(forgotEmail, "");
    var success = document.getElementById("forgot-success");
    if (success) success.classList.remove("is-visible");
    if (typeof dialog.showModal === "function") {
      dialog.showModal();
    } else {
      dialog.setAttribute("open", "");
    }
    if (forgotEmail) window.setTimeout(function () { forgotEmail.focus(); }, 40);
  }

  function closeForgotPassword() {
    var dialog = document.getElementById("forgot-dialog");
    if (!dialog) return;
    if (typeof dialog.close === "function") {
      dialog.close();
    } else {
      dialog.removeAttribute("open");
    }
  }

  function togglePassword(button) {
    var input = document.getElementById(button.dataset.target);
    if (!input) return;
    var show = input.type === "password";
    input.type = show ? "text" : "password";
    button.textContent = show ? "Ocultar" : "Mostrar";
    button.setAttribute("aria-label", (show ? "Ocultar" : "Mostrar") + " senha");
    input.focus();
  }

  function setFieldError(input, message) {
    var error = document.getElementById(input.id + "-error");
    input.setAttribute("aria-invalid", message ? "true" : "false");
    if (error) error.textContent = message || "";
  }

  function validateEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  }

  function showFormMessage(id, message) {
    var element = document.getElementById(id);
    if (!element) return;
    element.textContent = message || "";
    element.classList.toggle("is-visible", Boolean(message));
    if (message) element.focus();
  }

  function setFormLoading(form, loading, loadingLabel) {
    form.setAttribute("aria-busy", loading ? "true" : "false");
    Array.from(form.elements).forEach(function (element) {
      element.disabled = loading;
    });
    var submit = form.querySelector('[type="submit"]');
    if (!submit) return;
    if (!submit.dataset.defaultLabel) {
      submit.dataset.defaultLabel = submit.textContent;
    }
    submit.textContent = loading
      ? loadingLabel
      : submit.dataset.defaultLabel;
  }

  function bindLoginForm() {
    var form = document.getElementById("login-form");
    if (!form) return;
    form.addEventListener("submit", async function (event) {
      event.preventDefault();
      var email = form.elements.email;
      var password = form.elements.password;
      var emailError = !email.value.trim()
        ? "Informe seu e-mail."
        : !validateEmail(email.value.trim())
          ? "Digite um e-mail válido."
          : "";
      var passwordError = password.value.length < 6 ? "A senha deve ter pelo menos 6 caracteres." : "";
      setFieldError(email, emailError);
      setFieldError(password, passwordError);
      if (emailError || passwordError) {
        (emailError ? email : password).focus();
        return;
      }
      showFormMessage("login-message", "");
      var remember = form.elements.remember.checked;
      setFormLoading(form, true, "Entrando...");
      try {
        var response = await window.PontoPlusApi.login({
          email: email.value.trim().toLowerCase(),
          password: password.value,
        });
        window.PontoPlusApi.saveToken(response.token, remember);
        setCurrentUser(response.user);
        if (remember) {
          localStorage.setItem("ponto-plus-remember-email", user.email);
        } else {
          localStorage.removeItem("ponto-plus-remember-email");
        }
        await loadInitialData();
        if (!isAuthenticated()) return;
        sessionAppTheme = timeBasedTheme();
        announce("Login realizado com sucesso.");
        routeTo("#/dashboard");
      } catch (error) {
        showFormMessage(
          "login-message",
          error.message || "Não foi possível entrar.",
        );
      } finally {
        setFormLoading(form, false, "Entrando...");
      }
    });
  }

  function bindForgotForm() {
    var dialog = document.getElementById("forgot-dialog");
    var form = document.getElementById("forgot-form");
    if (!dialog || !form) return;
    dialog.addEventListener("click", function (event) {
      if (event.target === dialog) closeForgotPassword();
    });
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      var email = form.elements.email;
      var error = !email.value.trim()
        ? "Informe seu e-mail."
        : !validateEmail(email.value.trim())
          ? "Digite um e-mail válido."
          : "";
      setFieldError(email, error);
      if (error) {
        email.focus();
        return;
      }
      var success = document.getElementById("forgot-success");
      if (success) success.classList.add("is-visible");
      announce("Instruções simuladas enviadas com sucesso.");
      window.setTimeout(closeForgotPassword, 1500);
    });
  }

  function bindRegisterForm() {
    var form = document.getElementById("register-form");
    if (!form) return;
    form.addEventListener("submit", async function (event) {
      event.preventDefault();
      var name = form.elements.name;
      var email = form.elements.email;
      var password = form.elements.password;
      var nameError = name.value.trim().length < 2 ? "Informe seu nome." : "";
      var emailError = !email.value.trim()
        ? "Informe seu e-mail."
        : !validateEmail(email.value.trim())
          ? "Digite um e-mail válido."
          : "";
      var passwordError = password.value.length < 6 ? "Use pelo menos 6 caracteres." : "";
      setFieldError(name, nameError);
      setFieldError(email, emailError);
      setFieldError(password, passwordError);
      if (nameError || emailError || passwordError) {
        (nameError ? name : emailError ? email : password).focus();
        return;
      }
      showFormMessage("register-message", "");
      setFormLoading(form, true, "Criando conta...");
      try {
        var response = await window.PontoPlusApi.register({
          name: name.value.trim(),
          email: email.value.trim().toLowerCase(),
          password: password.value,
        });
        window.PontoPlusApi.saveToken(response.token, false);
        setCurrentUser(response.user);
        await loadInitialData();
        if (!isAuthenticated()) return;
        sessionAppTheme = timeBasedTheme();
        announce("Conta criada com sucesso.");
        routeTo("#/dashboard");
      } catch (error) {
        showFormMessage(
          "register-message",
          error.message || "Não foi possível criar a conta.",
        );
      } finally {
        setFormLoading(form, false, "Criando conta...");
      }
    });
  }

  function bindProfileForm() {
    var form = document.getElementById("profile-form");
    if (!form) return;
    form.addEventListener("submit", async function (event) {
      event.preventDefault();
      var name = form.elements.name;
      var goal = form.elements.goal;
      var goalParts = goal.value.split(":").map(Number);
      var parsedGoalMinutes =
        goalParts.length === 2 && goalParts.every(Number.isFinite)
          ? goalParts[0] * 60 + goalParts[1]
          : 0;
      var nameError = name.value.trim().length < 2 ? "Informe seu nome." : "";
      var goalError =
        parsedGoalMinutes < 1 || parsedGoalMinutes > 1439
          ? "Informe uma meta entre 00:01 e 23:59."
          : "";
      setFieldError(name, nameError);
      setFieldError(goal, goalError);
      if (nameError || goalError) {
        (nameError ? name : goal).focus();
        return;
      }
      showFormMessage("profile-message", "");
      setFormLoading(form, true, "Salvando...");
      try {
        var response = await window.PontoPlusApi.updateProfile(
          name.value.trim(),
        );
        setCurrentUser(response.user);
        dailyGoalMinutes = parsedGoalMinutes;
        localStorage.setItem(
          "ponto-plus-daily-goal-minutes",
          String(dailyGoalMinutes),
        );
        var banner = document.getElementById("profile-success");
        if (banner) banner.classList.add("is-visible");
        announce("Configurações atualizadas com sucesso.");
        window.setTimeout(function () {
          if (currentRoute() === "#/perfil") renderProfile();
        }, 900);
      } catch (error) {
        if (handleApiError(error)) {
          showFormMessage(
            "profile-message",
            error.message || "Não foi possível salvar as configurações.",
          );
        }
      } finally {
        setFormLoading(form, false, "Salvando...");
      }
    });
  }

  async function selectDate(value) {
    var parts = value.split("-").map(Number);
    preservedScrollY = window.scrollY;
    selectedDate = new Date(parts[0], parts[1] - 1, parts[2]);
    displayedMonth = new Date(parts[0], parts[1] - 1, 1);
    try {
      await loadDateRange(
        new Date(parts[0], parts[1] - 1, parts[2] - 3),
        new Date(parts[0], parts[1] - 1, parts[2] + 3),
      );
      dataMessage = "";
    } catch (error) {
      if (!handleApiError(error)) return;
    }
    render();
  }

  async function changeMonth(delta) {
    preservedScrollY = window.scrollY;
    displayedMonth = new Date(displayedMonth.getFullYear(), displayedMonth.getMonth() + delta, 1);
    selectedDate = new Date(displayedMonth.getFullYear(), displayedMonth.getMonth(), 1);
    try {
      await loadDateRange(
        new Date(selectedDate.getFullYear(), selectedDate.getMonth(), -2),
        new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 4),
      );
      dataMessage = "";
    } catch (error) {
      if (!handleApiError(error)) return;
    }
    render();
  }

  function setHistoryRangePanel(open) {
    var panel = document.getElementById("history-range-panel");
    var trigger = document.querySelector(
      '[data-action="toggle-history-range"]',
    );
    if (!panel || !trigger) return;
    if (open) {
      historyDraftStart = new Date(historyRangeStart);
      historyDraftEnd = new Date(historyRangeEnd);
      historyPickerMonth = new Date(
        historyRangeEnd.getFullYear(),
        historyRangeEnd.getMonth(),
        1,
      );
      renderHistoryPickerCalendar();
      showHistoryRangeError("");
    }
    panel.hidden = !open;
    trigger.setAttribute("aria-expanded", open ? "true" : "false");
  }

  function showHistoryRangeError(message) {
    var error = document.getElementById("history-range-error");
    if (error) error.textContent = message;
  }

  function renderHistoryPickerCalendar() {
    var calendar = document.getElementById("history-picker-calendar");
    if (calendar) calendar.innerHTML = historyPickerCalendarMarkup();
  }

  async function applyHistoryRange() {
    if (!historyDraftStart || !historyDraftEnd) {
      showHistoryRangeError("Escolha as datas inicial e final.");
      return;
    }
    var rangeLength = historyRangeLength(
      historyDraftStart,
      historyDraftEnd,
    );
    if (rangeLength > 31) {
      showHistoryRangeError("O período pode ter no máximo 31 dias.");
      return;
    }
    historyRangeStart = new Date(historyDraftStart);
    historyRangeEnd = new Date(historyDraftEnd);
    preservedScrollY = window.scrollY;
    try {
      await loadDateRange(historyRangeStart, historyRangeEnd);
      dataMessage = "";
    } catch (error) {
      if (!handleApiError(error)) return;
    }
    announce(
      "Histórico atualizado para um período de " +
        rangeLength +
        (rangeLength === 1 ? " dia." : " dias."),
    );
    render();
  }

  function selectHistoryDate(value) {
    var date = parseDateKey(value);
    if (!historyDraftStart || historyDraftEnd) {
      historyDraftStart = date;
      historyDraftEnd = null;
      showHistoryRangeError("");
      renderHistoryPickerCalendar();
      return;
    }
    if (formatDateKey(date) < formatDateKey(historyDraftStart)) {
      if (historyRangeLength(date, historyDraftStart) > 31) {
        showHistoryRangeError("O período pode ter no máximo 31 dias.");
        return;
      }
      historyDraftEnd = new Date(historyDraftStart);
      historyDraftStart = date;
      showHistoryRangeError("");
      renderHistoryPickerCalendar();
      return;
    }
    if (historyRangeLength(historyDraftStart, date) > 31) {
      showHistoryRangeError("O período pode ter no máximo 31 dias.");
      return;
    }
    historyDraftEnd = date;
    showHistoryRangeError("");
    renderHistoryPickerCalendar();
  }

  function changeHistoryPickerMonth(delta) {
    var nextMonth = new Date(
      historyPickerMonth.getFullYear(),
      historyPickerMonth.getMonth() + delta,
      1,
    );
    var currentMonth = new Date(
      new Date().getFullYear(),
      new Date().getMonth(),
      1,
    );
    var earliestMonth = new Date(
      currentMonth.getFullYear(),
      currentMonth.getMonth() - 35,
      1,
    );
    if (nextMonth > currentMonth || nextMonth < earliestMonth) return;
    historyPickerMonth = nextMonth;
    renderHistoryPickerCalendar();
  }

  function selectHistoryPickerMonth(value) {
    if (!value) return;
    var parts = value.split("-").map(Number);
    historyPickerMonth = new Date(parts[0], parts[1] - 1, 1);
    renderHistoryPickerCalendar();
  }

  async function resetHistoryToLastSevenDays() {
    historyDraftEnd = new Date();
    historyDraftStart = new Date(
      historyDraftEnd.getFullYear(),
      historyDraftEnd.getMonth(),
      historyDraftEnd.getDate() - 6,
    );
    historyPickerMonth = new Date(
      historyDraftEnd.getFullYear(),
      historyDraftEnd.getMonth(),
      1,
    );
    historyRangeStart = new Date(historyDraftStart);
    historyRangeEnd = new Date(historyDraftEnd);
    preservedScrollY = window.scrollY;
    try {
      await loadDateRange(historyRangeStart, historyRangeEnd);
      dataMessage = "";
    } catch (error) {
      if (!handleApiError(error)) return;
    }
    announce("Histórico atualizado para os últimos sete dias.");
    render();
  }

  document.addEventListener("click", function (event) {
    var isInsideHistoryRange = Boolean(
      event.target.closest(".history-range-control"),
    );
    var control = event.target.closest("[data-action]");
    if (control) {
      var action = control.dataset.action;
      if (action === "toggle-theme") toggleTheme();
      if (action === "notifications") announce("Você não tem novas notificações.");
      if (action === "logout") logout();
      if (action === "forgot-password") openForgotPassword();
      if (action === "close-forgot") closeForgotPassword();
      if (action === "toggle-password") togglePassword(control);
      if (action === "register-punch") registerPunch();
      if (action === "undo-punch") undoPunch();
      if (action === "select-date") selectDate(control.dataset.date);
      if (action === "previous-month") changeMonth(-1);
      if (action === "next-month") changeMonth(1);
      if (action === "toggle-history-range") {
        setHistoryRangePanel(
          control.getAttribute("aria-expanded") !== "true",
        );
      }
      if (action === "apply-history-range") applyHistoryRange();
      if (action === "history-last-seven") resetHistoryToLastSevenDays();
      if (action === "select-history-date") {
        selectHistoryDate(control.dataset.date);
      }
      if (action === "previous-history-month") {
        changeHistoryPickerMonth(-1);
      }
      if (action === "next-history-month") {
        changeHistoryPickerMonth(1);
      }
    }
    if (!isInsideHistoryRange) {
      setHistoryRangePanel(false);
    }
  });

  document.addEventListener("change", function (event) {
    if (event.target.id === "history-picker-month") {
      selectHistoryPickerMonth(event.target.value);
    }
  });

  window.addEventListener("hashchange", render);
  window.addEventListener("beforeunload", stopTimers);

  async function bootstrap() {
    // Uma sessão persistida só é aceita depois de ser validada pela API.
    if (isAuthenticated()) {
      try {
        var response = await window.PontoPlusApi.getProfile();
        setCurrentUser(response.user);
        await loadInitialData();
      } catch (error) {
        handleApiError(error);
        if (!isAuthenticated()) {
          localStorage.removeItem(USER_STORAGE_KEY);
          if (currentRoute() !== "#/login" && currentRoute() !== "#/cadastro") {
            window.location.hash = "#/login";
          }
        }
      }
    }
    render();
  }

  bootstrap();
})();
