/**
 * Unit and Integration Tests for Oracle Field Service Plugin Template
 * Built using Node.js native test runner (zero external dependencies).
 * Run with: node --test
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

// Create a lightweight mock DOM environment for Node testing
function createMockEnvironment(options = {}) {
  const outgoingMessages = [];
  const eventListeners = new Map();
  const elements = new Map();

  function addEventListener(type, fn) {
    if (!eventListeners.has(type)) eventListeners.set(type, []);
    eventListeners.get(type).push(fn);
  }

  function dispatchEvent(type, event) {
    if (type === "message" && event && event.source === undefined) {
      event.source = mockWindow.parent;
    }
    const handlers = eventListeners.get(type) || [];
    for (const fn of handlers) {
      fn(event);
    }
  }

  const mockStorageMap = new Map();
  const mockLocalStorage = {
    getItem: (key) => (options.storageThrows ? (() => { throw new Error("SecurityError: blocked"); })() : (mockStorageMap.get(key) || null)),
    setItem: (key, val) => {
      if (options.storageThrows) throw new Error("SecurityError: blocked");
      mockStorageMap.set(key, String(val));
    },
    removeItem: (key) => {
      if (options.storageThrows) throw new Error("SecurityError: blocked");
      mockStorageMap.delete(key);
    },
    clear: () => mockStorageMap.clear()
  };

  const mockParent = {
    postMessage: (msg, targetOrigin) => {
      const parsed = typeof msg === "string" ? JSON.parse(msg) : msg;
      outgoingMessages.push({ data: parsed, targetOrigin });
    }
  };

  const mockWindow = {
    addEventListener,
    removeEventListener: () => {},
    dispatchEvent,
    parent: null,
    localStorage: mockLocalStorage,
    location: {
      origin: "http://localhost:8080",
      ancestorOrigins: options.ancestorOrigins || ["https://test-tenant.etadirect.com"]
    },
    crypto: {
      getRandomValues: (arr) => {
        for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256);
        return arr;
      }
    }
  };
  mockWindow.parent = options.standalone ? mockWindow : (options.parent !== undefined ? options.parent : mockParent);

  const mockDocument = {
    referrer: options.referrer !== undefined ? options.referrer : "https://test-tenant.etadirect.com/screen.html",
    addEventListener,
    createElement: (tag) => ({
      tagName: tag.toUpperCase(),
      className: "",
      textContent: "",
      classList: { add: () => {}, remove: () => {} },
      remove: () => {}
    }),
    body: { appendChild: () => {} },
    getElementById: (id) => {
      if (!elements.has(id)) {
        elements.set(id, {
          id,
          value: "",
          disabled: false,
          textContent: "",
          innerHTML: "",
          classList: { add: () => {}, remove: () => {} },
          addEventListener: (type, fn) => addEventListener(`${id}_${type}`, fn),
          click: () => dispatchEvent(`${id}_click`, { type: "click" })
        });
      }
      return elements.get(id);
    },
    querySelectorAll: (selector) => {
      const result = [];
      elements.forEach((el) => result.push(el));
      return result;
    }
  };

  const mockNavigator = {
    onLine: true,
    geolocation: {
      getCurrentPosition: (success, error) => {
        if (options.geoError) {
          error({ code: 1, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 });
        } else {
          success({
            coords: { latitude: 37.7749, longitude: -122.4194, accuracy: 15 }
          });
        }
      }
    }
  };

  return {
    window: mockWindow,
    document: mockDocument,
    navigator: mockNavigator,
    outgoingMessages,
    elements,
    dispatchEvent,
    mockStorageMap
  };
}

// Helper to load fresh plugin instance with mock globals
function setupPlugin(envOptions = {}) {
  const env = createMockEnvironment(envOptions);
  global.window = env.window;
  global.document = env.document;
  Object.defineProperty(global, "navigator", {
    value: env.navigator,
    configurable: true,
    writable: true
  });
  global.parent = env.window.parent;
  global.localStorage = env.window.localStorage;
  global.btoa = (str) => Buffer.from(str, "binary").toString("base64");

  // Re-load storage and plugin modules
  delete require.cache[require.resolve("../localStorage.js")];
  delete require.cache[require.resolve("../plugin.js")];

  const storage = require("../localStorage.js");
  const OfscPlugin = require("../plugin.js");

  const plugin = new OfscPlugin();
  return { plugin, env, storage };
}

// =============================================================================
// TEST SUITE
// =============================================================================

test("Lifecycle: Plugin sends 'ready' on initialization with expected parameters", () => {
  const { plugin, env } = setupPlugin();
  plugin.init("TEST_PLUGIN");

  assert.equal(env.outgoingMessages.length, 1);
  const msg = env.outgoingMessages[0];
  assert.equal(msg.data.apiVersion, 1);
  assert.equal(msg.data.method, "ready");
  assert.equal(msg.data.sendInitData, true);
  assert.equal(msg.targetOrigin, "https://test-tenant.etadirect.com");
});

test("Lifecycle: Prevents duplicate initialization", () => {
  const { plugin, env } = setupPlugin();
  plugin.init("TEST_PLUGIN");
  plugin.init("TEST_PLUGIN_SECOND_CALL");

  // Only 1 ready message should have been dispatched
  assert.equal(env.outgoingMessages.length, 1);
});

test("Lifecycle: Responds to 'init' with 'initEnd'", async () => {
  const { plugin, env } = setupPlugin();
  plugin.init("TEST_PLUGIN");

  // Simulate OFS Core sending "init"
  await env.window.dispatchEvent("message", {
    origin: "https://test-tenant.etadirect.com",
    data: JSON.stringify({
      apiVersion: 1,
      method: "init",
      applications: {
        ofs_api: { type: "oauth" }
      }
    })
  });

  const lastMsg = env.outgoingMessages[env.outgoingMessages.length - 1];
  assert.equal(lastMsg.data.method, "initEnd");
  assert.equal(lastMsg.data.apiVersion, 1);
  assert.equal(plugin.applications.ofs_api.type, "oauth");
});

test("Security: Rejects messages from unauthorized origin", async () => {
  const { plugin, env } = setupPlugin();
  plugin.init("TEST_PLUGIN");

  const messagesBefore = env.outgoingMessages.length;

  // Dispatch message from malicious origin
  await env.window.dispatchEvent("message", {
    origin: "https://evil-attacker.com",
    data: JSON.stringify({ method: "init", applications: {} })
  });

  // No response should be generated
  assert.equal(env.outgoingMessages.length, messagesBefore);
});

test("Security: Safely handles non-JSON or malformed message data", async () => {
  const { plugin } = setupPlugin();
  plugin.init("TEST_PLUGIN");

  // Should not throw on invalid inputs
  assert.doesNotThrow(async () => {
    await global.window.dispatchEvent("message", {
      origin: "https://test-tenant.etadirect.com",
      data: "Not valid JSON {"
    });
    await global.window.dispatchEvent("message", {
      origin: "https://test-tenant.etadirect.com",
      data: null
    });
    await global.window.dispatchEvent("message", {
      origin: "https://test-tenant.etadirect.com",
      data: 12345
    });
  });
});

test("Procedures: callProcedure resolves on callProcedureResult", async () => {
  const { plugin, env } = setupPlugin();
  plugin.init("TEST_PLUGIN");
  plugin.allowedProcedures = { scanBarcode: true };

  const scanPromise = plugin.scanBarcode();

  // Find the callProcedure message
  const callMsg = env.outgoingMessages.find((m) => m.data.method === "callProcedure");
  assert.ok(callMsg, "callProcedure message must be dispatched");
  assert.equal(callMsg.data.procedure, "scanBarcode");
  const callId = callMsg.data.callId;

  // Simulate OFS replying with scan result
  await env.window.dispatchEvent("message", {
    origin: "https://test-tenant.etadirect.com",
    data: JSON.stringify({
      apiVersion: 1,
      method: "callProcedureResult",
      callId,
      resultData: { format: "QR_CODE", text: "SAMPLE-SN-12345" }
    })
  });

  const result = await scanPromise;
  assert.equal(result.text, "SAMPLE-SN-12345");
});

test("Procedures: callProcedure rejects on host error", async () => {
  const { plugin, env } = setupPlugin();
  plugin.init("TEST_PLUGIN");
  plugin.allowedProcedures = { scanBarcode: true };

  const scanPromise = plugin.scanBarcode();
  const callMsg = env.outgoingMessages.find((m) => m.data.method === "callProcedure");
  const callId = callMsg.data.callId;

  // Simulate OFS error response
  await env.window.dispatchEvent("message", {
    origin: "https://test-tenant.etadirect.com",
    data: JSON.stringify({
      apiVersion: 1,
      method: "error",
      callId,
      error: { message: "Camera permission denied" }
    })
  });

  await assert.rejects(scanPromise, /Camera permission denied/);
});

test("Procedures: callProcedure rejects on timeout", async () => {
  const { plugin } = setupPlugin();
  plugin.init("TEST_PLUGIN");
  plugin.allowedProcedures = { scanBarcode: true };
  plugin._apiTimeout = 50; // Set low timeout for test

  const scanPromise = plugin.scanBarcode();
  await assert.rejects(scanPromise, /Timeout waiting for response/);
});

test("Storage: Isolates drafts between different activities (no cross-activity draft leaks)", async () => {
  const { plugin, env } = setupPlugin();
  plugin.init("TEST_PLUGIN");

  const notesField = env.document.getElementById("activity_notes");

  // 1. Open Activity #101 and save a draft
  plugin.openParams = { aid: "101" };
  notesField.value = "Notes for activity 101";
  await plugin._saveForm();

  // 2. Clear field and open Activity #202 (should NOT have Activity #101's notes)
  notesField.value = "";
  plugin.openParams = { aid: "202" };
  await plugin._restoreForm();
  assert.equal(notesField.value, "", "Activity 202 must not inherit draft from Activity 101");

  // 3. Switch back to Activity #101 and restore
  plugin.openParams = { aid: "101" };
  await plugin._restoreForm();
  assert.equal(notesField.value, "Notes for activity 101", "Activity 101 draft must be restored");
});

test("Storage: Gracefully falls back to in-memory storage when localStorage is blocked", async () => {
  const { plugin } = setupPlugin({ storageThrows: true });
  plugin.init("TEST_PLUGIN");

  // Should succeed using memory fallback without throwing SecurityError
  await plugin.storage.setValue("test_key", "test_val");
  const val = await plugin.storage.getValue("test_key");
  assert.equal(val, "test_val");
});

test("Submissions: Prevents duplicate submissions and disables submit button", async () => {
  const { plugin, env } = setupPlugin();
  plugin.init("TEST_PLUGIN");
  plugin.openParams = { aid: "555" };

  const submitBtn = env.elements.get("SubmitBtn");

  // Call submit twice in parallel
  const firstSubmit = plugin._handleSubmit();
  const secondSubmit = plugin._handleSubmit();
  await Promise.all([firstSubmit, secondSubmit]);

  // Only ONE "close" message should be dispatched
  const closeMessages = env.outgoingMessages.filter((m) => m.data.method === "close");
  assert.equal(closeMessages.length, 1);
  assert.equal(submitBtn.disabled, true);
});

test("Security: Tokens are kept strictly in memory and never written to storage", async () => {
  const { plugin, env } = setupPlugin();
  plugin.init("TEST_PLUGIN");
  plugin.applications = { ofs_api: { type: "oauth" } };

  const tokenPromise = plugin._getAccessToken("ofs_api");
  const callMsg = env.outgoingMessages.find((m) => m.data.method === "callProcedure");

  await env.window.dispatchEvent("message", {
    origin: "https://test-tenant.etadirect.com",
    data: JSON.stringify({
      apiVersion: 1,
      method: "callProcedureResult",
      callId: callMsg.data.callId,
      resultData: { token: "secret_jwt_token_12345" }
    })
  });

  const token = await tokenPromise;
  assert.equal(token, "secret_jwt_token_12345");

  // Verify token is cached in memory
  assert.equal(plugin._cachedTokens["ofs_api"], "secret_jwt_token_12345");

  // Verify token is NOT written to localStorage
  env.mockStorageMap.forEach((storedVal) => {
    assert.ok(!storedVal.includes("secret_jwt_token_12345"), "Token must never exist in persistent storage");
  });
});

test("Security: Untrusted values in openParams/tag are escaped to prevent XSS", () => {
  const { plugin, env } = setupPlugin();
  plugin.tag = '<script>alert("xss")</script>';
  plugin.openParams = {
    aid: '101"><img src=x onerror=alert(1)>',
    resourceId: '<b onmouseover=alert(2)>tech</b>'
  };
  plugin.applications = {
    '<script>app</script>': { type: '<b>oauth</b>' }
  };

  plugin._renderUI();

  const statusDiv = env.elements.get("status");
  assert.ok(statusDiv.innerHTML.length > 0, "statusDiv must have rendered content");
  assert.ok(!statusDiv.innerHTML.includes("<script>"), "Must not contain unescaped <script> tag");
  assert.ok(!statusDiv.innerHTML.includes("<img src=x onerror=alert(1)>"), "Must not contain raw img payload");
  assert.ok(statusDiv.innerHTML.includes("&lt;script&gt;"), "Must contain escaped &lt;script&gt;");
});

test("REST Integration: callRestApi attaches Bearer header and handles HTTP errors", async () => {
  const { plugin } = setupPlugin();
  plugin.init("TEST_PLUGIN");
  plugin._cachedTokens["ofs_api"] = "mock_jwt_token";

  // Mock fetch
  let capturedUrl = "";
  let capturedHeaders = {};
  global.fetch = async (url, opts) => {
    capturedUrl = url;
    capturedHeaders = opts.headers;
    if (url.includes("error")) {
      return {
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        json: async () => ({ detail: "Invalid token" })
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ activityId: 1234, status: "started" })
    };
  };

  // Test successful call
  const data = await plugin.callRestApi("https://tenant.fs.ocs.oraclecloud.com/rest/ofscCore/v1/activities/1234", "ofs_api");
  assert.equal(data.activityId, 1234);
  assert.equal(capturedHeaders["Authorization"], "Bearer mock_jwt_token");

  // Test error handling
  await assert.rejects(
    plugin.callRestApi("https://tenant.fs.ocs.oraclecloud.com/rest/error", "ofs_api"),
    /REST API HTTP 401: Invalid token/
  );
});

test("Security: Blocks untrusted origin adoption when referrer is absent", async () => {
  // Set up environment with NO referrer and NO ancestorOrigins
  const { plugin, env } = setupPlugin({ referrer: null, ancestorOrigins: [] });
  plugin.init("TEST_PLUGIN");
  assert.equal(plugin._targetOrigin, null, "Target origin should be initially null");

  // Attacker attempts to send message to lock origin
  await env.window.dispatchEvent("message", {
    origin: "https://evil-attacker.com",
    data: JSON.stringify({ method: "init", applications: {} })
  });

  // Target origin must NOT be adopted from untrusted domain
  assert.equal(plugin._targetOrigin, null, "Untrusted origin must not be adopted as target origin");
});

test("Security: Blocks privileged postMessages when target origin is unverified", () => {
  const { plugin, env } = setupPlugin({ referrer: null, ancestorOrigins: [] });
  plugin.init("TEST_PLUGIN");
  plugin._targetOrigin = null;

  const messagesBefore = env.outgoingMessages.length;

  // Attempt to send privileged close message
  plugin._sendPostMessage({
    apiVersion: 1,
    method: "close",
    actions: [{ entity: "activity", action: "update", aid: "123", properties: { NOTES: "secret" } }]
  });

  // Privileged message must be blocked from sending with wildcard
  assert.equal(env.outgoingMessages.length, messagesBefore, "Privileged message must not be dispatched without verified origin");
});

test("Security: _isTrustedOrigin validates strict domain boundaries, protocol, and rejects spoofing", () => {
  const { plugin } = setupPlugin();
  plugin.init("TEST_PLUGIN");

  // Valid Oracle Cloud domains (must be HTTPS)
  assert.equal(plugin._isTrustedOrigin("https://tenant.etadirect.com"), true, "Should accept valid *.etadirect.com subdomain");
  assert.equal(plugin._isTrustedOrigin("https://tenant.fs.ocs.oraclecloud.com"), true, "Should accept valid *.oraclecloud.com subdomain");
  assert.equal(plugin._isTrustedOrigin("https://login.oracle.com"), true, "Should accept valid *.oracle.com subdomain");
  assert.equal(plugin._isTrustedOrigin("https://oracle.com"), true, "Should accept apex oracle.com");
  assert.equal(plugin._isTrustedOrigin("https://etadirect.com"), true, "Should accept apex etadirect.com");

  // Valid local development origins
  assert.equal(plugin._isTrustedOrigin("http://localhost:8080"), true, "Should accept localhost");
  assert.equal(plugin._isTrustedOrigin("http://127.0.0.1:3000"), true, "Should accept 127.0.0.1");

  // REJECT: Insecure HTTP protocol on Oracle Cloud domains
  assert.equal(plugin._isTrustedOrigin("http://tenant.etadirect.com"), false, "Must reject non-HTTPS Oracle Cloud origin");

  // REJECT: Trailing domain spoofing (e.g. oracle.com.attacker.example)
  assert.equal(plugin._isTrustedOrigin("https://oracle.com.attacker.example"), false, "Must reject trailing domain spoof");
  assert.equal(plugin._isTrustedOrigin("https://etadirect.com.evil.com"), false, "Must reject trailing domain spoof");

  // REJECT: Prefix lookalike spoofing (e.g. attacker-oracle.com)
  assert.equal(plugin._isTrustedOrigin("https://attacker-oracle.com"), false, "Must reject prefix lookalike");
  assert.equal(plugin._isTrustedOrigin("https://evil-etadirect.com"), false, "Must reject prefix lookalike");
  assert.equal(plugin._isTrustedOrigin("https://fakeoraclecloud.com"), false, "Must reject lookalike domain");

  // REJECT: Invalid inputs
  assert.equal(plugin._isTrustedOrigin(null), false, "Must reject null");
  assert.equal(plugin._isTrustedOrigin(""), false, "Must reject empty string");
  assert.equal(plugin._isTrustedOrigin("not-a-url"), false, "Must reject invalid URL");
});

test("Security: Validates event.source originates from window.parent and rejects wrong-window messages", async () => {
  const { plugin, env } = setupPlugin();
  plugin.init("TEST_PLUGIN");

  let receivedInit = false;
  plugin._handleInit = async () => { receivedInit = true; };

  // 1. Message from an unexpected/wrong window (e.g. child iframe, popup, sibling)
  const wrongWindow = { postMessage: () => {} };
  await env.window.dispatchEvent("message", {
    origin: "https://test-tenant.etadirect.com",
    source: wrongWindow,
    data: JSON.stringify({ method: "init" })
  });
  assert.equal(receivedInit, false, "Must reject message when event.source is not window.parent");

  // 2. Message from valid window.parent
  await env.window.dispatchEvent("message", {
    origin: "https://test-tenant.etadirect.com",
    source: env.window.parent,
    data: JSON.stringify({ method: "init" })
  });
  assert.equal(receivedInit, true, "Must accept message when event.source matches window.parent");
});

test("Security: Allows standalone mode execution when window.parent is self", async () => {
  const { plugin, env } = setupPlugin({ standalone: true, referrer: "http://localhost:8080" });
  plugin.init("TEST_PLUGIN");

  let receivedOpen = false;
  plugin._handleOpen = async () => { receivedOpen = true; };

  // In standalone mode (window.parent === window), message from self is accepted
  await env.window.dispatchEvent("message", {
    origin: "http://localhost:8080",
    source: env.window,
    data: JSON.stringify({ method: "open", openParams: { aid: "123" } })
  });
  assert.equal(receivedOpen, true, "Must process messages in standalone mode");
});

test("Hardware: scanBarcode handles successful scan and populates input from resultData.text", async () => {
  const { plugin, env } = setupPlugin();
  plugin.init("TEST_PLUGIN");
  plugin.allowedProcedures = { scanBarcode: true };

  const input = env.document.getElementById("BarcodeResult");
  input.value = "INITIAL_VAL";

  plugin._renderUI();
  const scanBtn = env.document.getElementById("ScanBtn");
  assert.ok(scanBtn, "ScanBtn element should exist");

  // Simulate procedure response with official Oracle documented payload
  plugin.scanBarcode = async () => {
    return {
      text: "PT9012308",
      format: "QR_CODE",
      cancelled: false
    };
  };

  await scanBtn.click();
  assert.equal(input.value, "PT9012308", "Input should be populated strictly with resultData.text");
});

test("Hardware: scanBarcode handles cancelled scan without modifying input value", async () => {
  const { plugin, env } = setupPlugin();
  plugin.init("TEST_PLUGIN");
  plugin.allowedProcedures = { scanBarcode: true };

  const input = env.document.getElementById("BarcodeResult");
  input.value = "EXISTING_VAL";

  plugin._renderUI();
  const scanBtn = env.document.getElementById("ScanBtn");

  // Simulate cancellation response per Oracle documentation (cancelled: true)
  plugin.scanBarcode = async () => {
    return {
      cancelled: true
    };
  };

  await scanBtn.click();
  assert.equal(input.value, "EXISTING_VAL", "Input must remain unchanged when user cancels scanning");
  assert.ok(!input.value.includes("cancelled"), "Must not serialize cancellation object into input");
});

test("Hardware: scanBarcode handles malformed or missing response data gracefully", async () => {
  const { plugin, env } = setupPlugin();
  plugin.init("TEST_PLUGIN");
  plugin.allowedProcedures = { scanBarcode: true };

  const input = env.document.getElementById("BarcodeResult");
  input.value = "EXISTING_VAL";

  plugin._renderUI();
  const scanBtn = env.document.getElementById("ScanBtn");

  // 1. Empty/null result
  plugin.scanBarcode = async () => null;
  await scanBtn.click();
  assert.equal(input.value, "EXISTING_VAL", "Input must remain unchanged on null result");

  // 2. Object with no text or empty text
  plugin.scanBarcode = async () => ({ format: "QR_CODE" });
  await scanBtn.click();
  assert.equal(input.value, "EXISTING_VAL", "Input must remain unchanged when text is missing");
});


