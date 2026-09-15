/*
 * Cliente HTTP centralizado da API Ponto+.
 * Mantê-lo separado da interface evita espalhar URLs, cabeçalhos e tratamento
 * de sessão por toda a aplicação.
 */
(function () {
  "use strict";

  var API_BASE_URL = "http://127.0.0.1:5000/api";
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
    try {
      response = await fetch(API_BASE_URL + path, config);
    } catch (_error) {
      throw new Error("Não foi possível conectar à API. Confirme se o back-end está em execução.");
    }

    var body = response.status === 204 ? null : await response.json().catch(function () {
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
      if (response.status === 401) clearToken();
      throw error;
    }
    return body;
  }

  window.PontoPlusApi = {
    accessToken: accessToken,
    saveToken: saveToken,
    clearToken: clearToken,
    register: function (data) {
      return request("/auth/register", { method: "POST", body: JSON.stringify(data) });
    },
    login: function (data) {
      return request("/auth/login", { method: "POST", body: JSON.stringify(data) });
    },
    getProfile: function () {
      return request("/profile");
    },
    updateProfile: function (name) {
      return request("/profile", { method: "PATCH", body: JSON.stringify({ name: name }) });
    },
    getPunches: function (month) {
      return request("/punches?month=" + encodeURIComponent(month));
    },
    createPunch: function () {
      return request("/punches", { method: "POST" });
    },
    deletePunch: function (punchId) {
      return request("/punches/" + encodeURIComponent(punchId), { method: "DELETE" });
    },
  };
})();
