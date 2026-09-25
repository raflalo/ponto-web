/*
 * Cliente HTTP centralizado da API Ponto+.
 * Mantê-lo separado da interface evita espalhar URLs, cabeçalhos e tratamento
 * de sessão por toda a aplicação.
 */
(function () {
  "use strict";

  var API_BASE_URL = "http://127.0.0.1:5001/api";
  var TOKEN_KEY = "ponto-plus-access-token";

  function accessToken() {
    return localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY);
  }

  function saveToken(token, remember) {
    localStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(TOKEN_KEY);
    (remember ? localStorage : sessionStorage).setItem(TOKEN_KEY, token);
  }

  function clearToken() {
    localStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(TOKEN_KEY);
  }

  async function request(path, options) {
    var config = Object.assign({ method: "GET" }, options || {});
    var token = accessToken();
    config.headers = Object.assign(
      { Accept: "application/json" },
      config.body ? { "Content-Type": "application/json" } : {},
      token ? { Authorization: "Bearer " + token } : {},
      config.headers || {},
    );

    var response;
    var controller = new AbortController();
    var timeout = setTimeout(function () { controller.abort(); }, 10000);
    config.signal = controller.signal;
    try {
      try {
        response = await fetch(API_BASE_URL + path, config);
      } catch (connectionError) {
        throw new Error(connectionError.name === "AbortError"
          ? "A API demorou para responder. Tente novamente."
          : "Não foi possível conectar à API. Confirme se o back-end está em execução.");
      }
      var body = response.status === 204 ? null : await response.json().catch(function (parseError) {
        if (parseError.name === "AbortError") throw new Error("A API demorou para responder. Tente novamente.");
        if (response.ok) throw new Error("A API retornou uma resposta inválida. Tente novamente.");
        return null;
      });
      if (!response.ok) {
        var message =
          body && body.error && body.error.message
            ? body.error.message
            : "Não foi possível concluir a operação.";
        var error = new Error(message);
        error.status = response.status;
        error.code = body && body.error ? body.error.code : "request_failed";
        // A interface encerra somente a sessão à qual esta resposta pertence.
        error.requestToken = token;
        throw error;
      }
      return body;
    } finally {
      clearTimeout(timeout);
    }
  }

  window.PontoPlusApi = {
    accessToken: accessToken,
    saveToken: saveToken,
    clearToken: clearToken,
    tokenExpiresAt: function () {
      try {
        var payload = JSON.parse(atob(accessToken().split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
        return Number.isFinite(payload.exp) ? payload.exp * 1000 : null;
      } catch (_error) { return null; }
    },
    getHealth: function () { return request("/health"); },
    register: function (data) {
      return request("/auth/register", { method: "POST", body: JSON.stringify(data) });
    },
    login: function (data) {
      return request("/auth/login", { method: "POST", body: JSON.stringify(data) });
    },
    getProfile: function () {
      return request("/profile");
    },
    updateProfile: function (name, dailyGoalMinutes) {
      return request("/profile", { method: "PATCH", body: JSON.stringify({ name: name, daily_goal_minutes: dailyGoalMinutes }) });
    },
    getPunches: function (month) {
      return request("/punches?month=" + encodeURIComponent(month));
    },
    createPunch: function (revision, date) {
      return request("/punches", { method: "POST", body: JSON.stringify({ expected_revision: revision, expected_date: date }) });
    },
    deletePunch: function (punchId, revision) {
      var query = revision === undefined ? "" : "?expected_revision=" + encodeURIComponent(revision);
      return request("/punches/" + encodeURIComponent(punchId) + query, { method: "DELETE" });
    },
  };
})();
