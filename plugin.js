/*!
 * Oracle Field Service (OFS) - Beginner Developer Reference Template
 * 
 * Demonstrates:
 * 1. OFS Plugin Lifecycle: ready -> init -> initEnd -> open -> close
 * 2. Bi-directional postMessage communication & callProcedure RPC
 * 3. In-memory OAuth token caching for configured OFS applications
 * 4. Scoped form draft persistence (no cross-activity draft leaks)
 * 5. Device capabilities (native Barcode Scanning & HTML5 Geolocation)
 * 6. Secure coding (XSS sanitization, origin checking, no token leakage)
 * 7. Sample REST API caller using acquired Bearer tokens
 */
"use strict";

(function() {
  /**
   * Helper: Sanitizes a string for safe insertion into HTML.
   * Prevents Cross-Site Scripting (XSS) when displaying values from OFS or inputs.
   *
   * @param {*} str - Value to sanitize
   * @returns {string} HTML-escaped string
   */
  function escapeHtml(str) {
    if (str === null || str === undefined) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /**
   * Main OFS Plugin Controller Class
   */
  window.OfscPlugin = function() {
    // --- Plugin State ---
    this.tag = "TEST_HELLO_OFSC";      // Plugin label registered in OFS Configuration -> Forms & Plugins
    this.storage = null;               // Storage helper for form drafts
    this.openParams = null;            // Context passed by OFS (aid, resourceId, user, etc.)
    this.allowedProcedures = {};       // Capabilities allowed by OFS admin (e.g. scanBarcode)
    this.applications = {};            // External apps configured in OFS (e.g. OFS REST, OIC, ERP)
    
    // Security & Internal State
    this._targetOrigin = null;         // Validated origin of the OFS parent window
    this._cachedTokens = {};           // IN-MEMORY token cache (NEVER written to localStorage)
    this._pendingRequests = new Map(); // Tracks async callProcedure RPC requests by callId
    this._apiTimeout = 15000;          // Timeout in ms for callProcedure responses (prevents UI hanging)
    this._initialized = false;         // Guard against duplicate initialization
    this._isSubmitting = false;        // Guard against duplicate form submissions

    // =========================================================================
    // 1. BOOTSTRAP & LIFECYCLE
    // =========================================================================

    /**
     * Initializes the plugin. Call this once when the DOM or window has loaded.
     * @param {string} pluginName - The label of your plugin in OFS Configuration
     */
    this.init = function(pluginName) {
      if (this._initialized) {
        console.warn(`[OFS] Plugin already initialized with tag: ${this.tag}`);
        return;
      }
      this._initialized = true;
      this.tag = pluginName || "TEST_HELLO_OFSC";
      this.storage = window.OfscStorage || window.OFSC_TS_STORAGE_1;

      // Determine expected OFS origin from document.referrer or window.location.ancestorOrigins
      const expectedOrigin = this._resolveExpectedOrigin();
      this._targetOrigin = this._isTrustedOrigin(expectedOrigin) ? expectedOrigin : null;

      // Register postMessage listener for messages from OFS Core
      window.addEventListener("message", this._messageListener.bind(this), false);

      // Register static button and form listeners ONCE (prevents duplicate event firing)
      this._setupStaticListeners();

      // Network connection monitors
      window.addEventListener("online", () => {
        this.showToast("🟢 Connection restored", "success");
        this._renderUI();
      });
      window.addEventListener("offline", () => {
        this.showToast("🔴 Connection lost (offline mode)", "warning");
        this._renderUI();
      });

      // Send the initial "ready" message to OFS Core parent frame.
      // This tells OFS that the plugin is loaded and ready to receive "init" or "open".
      this._sendPostMessage({
        apiVersion: 1,
        method: "ready",
        sendInitData: true,       // Requests OFS to send plugin metadata/apps via "init"
        showHeader: true,         // Show native OFS navigation header
        enableBackButton: true    // Enable native back button in header
      });
    };

    /**
     * Central message listener for incoming window postMessage events.
     * Validates message structure, source window, origin, and routes to appropriate handler.
     */
    this._messageListener = async function(event) {
      // 1. Frame Source Security Check: When embedded in an iframe, verify the message originates from window.parent
      if (window.parent && window.parent !== window) {
        if (!event.source || event.source !== window.parent) {
          console.warn("[OFS Security Warning] Blocked message from unexpected source window (not window.parent).");
          return;
        }
      }

      // 2. Origin Security Check: Verify that the message came from a trusted OFS origin
      if (this._targetOrigin) {
        if (event.origin !== this._targetOrigin) {
          console.warn(`[OFS Security Warning] Blocked message from unauthorized origin: ${event.origin}`);
          return;
        }
      } else {
        // If targetOrigin was not available at init (e.g. strict webview), strictly verify domain before adopting
        if (!this._isTrustedOrigin(event.origin)) {
          console.error(`[OFS Security Error] Rejected message from untrusted origin: ${event.origin}`);
          return;
        }
        this._targetOrigin = event.origin;
      }

      let data;
      try {
        data = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
      } catch (err) {
        console.error("[OFS] Failed to parse incoming postMessage JSON:", err);
        return;
      }

      if (!data || typeof data !== "object" || !data.method) {
        return;
      }

      // 1. Check if this is a response to an ongoing callProcedure RPC (matches callId)
      const id = data.callId || data.method;
      if (this._pendingRequests.has(id)) {
        const { resolve, reject, timeoutId } = this._pendingRequests.get(id);
        clearTimeout(timeoutId);
        this._pendingRequests.delete(id);

        if (data.method === "error" || data.status === "error") {
          reject(new Error(data.error?.message || data.error || data.detail || `Procedure error: ${data.method}`));
        } else {
          // callProcedureResult returns data inside resultData
          resolve(data.method === "callProcedureResult" ? (data.resultData || data.result || data) : data);
        }
        return;
      }

      // 2. Handle standalone OFS lifecycle methods
      switch (data.method) {
        case "init":
          await this._handleInit(data);
          break;
        case "open":
          await this._handleOpen(data);
          break;
        case "error":
          console.error("[OFS Core Error]:", data.error || data);
          this.showToast(`OFS Error: ${data.error?.message || "Operation failed"}`, "error");
          break;
        default:
          console.info(`[OFS] Received unhandled message method: ${data.method}`);
      }
    };

    /**
     * Handles the OFS "init" lifecycle event.
     * OFS sends this in a hidden iframe to provide plugin metadata and configured applications.
     * The plugin must acknowledge completion by posting "initEnd".
     */
    this._handleInit = async function(data) {
      try {
        // Save metadata configuration so it can be restored when the plugin is visibly opened
        if (this.storage) {
          await this.storage.setValue(`${this.tag}_metadata`, JSON.stringify(data));
        }
        if (data.applications) {
          this.applications = data.applications;
        }
      } catch (err) {
        console.warn("[OFS] Error saving init metadata:", err.message);
      } finally {
        // Acknowledge initialization completion to OFS Core
        this._sendPostMessage({ apiVersion: 1, method: "initEnd" });
      }
    };

    /**
     * Handles the OFS "open" lifecycle event.
     * OFS sends this when the technician launches the plugin on a screen (e.g. Activity Details).
     */
    this._handleOpen = async function(data) {
      this.openParams = data.openParams || {};
      this.allowedProcedures = data.allowedProcedures || {};

      try {
        // Retrieve applications from storage or init payload
        if (this.storage) {
          const metadataStr = await this.storage.getValue(`${this.tag}_metadata`);
          if (metadataStr) {
            try {
              const parsed = JSON.parse(metadataStr);
              this.applications = parsed.applications || parsed.data?.applications || this.applications;
            } catch (jsonErr) {
              console.warn("[OFS] Corrupted metadata in storage, resetting:", jsonErr.message);
            }
          }
        }

        // Restore any previously auto-saved draft for THIS specific activity
        await this._restoreForm();

        // Optionally pre-fetch OAuth tokens in parallel for configured applications
        const appKeys = Object.keys(this.applications);
        if (appKeys.length > 0) {
          await Promise.all(
            appKeys.map(key => this._getAccessToken(key).catch(err => {
              console.warn(`[OFS Auth] Could not pre-fetch token for "${key}":`, err.message);
            }))
          );
        }
      } catch (error) {
        console.error("[OFS] Error during open phase:", error);
      } finally {
        this._renderUI();
      }
    };

    // =========================================================================
    // 2. PROCEDURE CALLS (RPC) & AUTHENTICATION
    // =========================================================================

    /**
     * Requests an OAuth JWT access token for a configured application from OFS.
     * Tokens are cached strictly in-memory during the session for security.
     *
     * @param {string} [appKey] - Key of the configured application in OFS
     * @returns {Promise<string>} The OAuth access token
     */
    this._getAccessToken = async function(appKey) {
      const key = appKey || Object.keys(this.applications)[0];
      if (!key) return null;

      // Return cached token if still present in memory
      if (this._cachedTokens[key]) {
        return this._cachedTokens[key];
      }

      const response = await this._sendSyncMessage({
        apiVersion: 1,
        method: "callProcedure",
        callId: this._generateCallId(),
        procedure: "getAccessToken",
        params: { applicationKey: key }
      });

      // Oracle returns token inside resultData.token (or resultData.accessToken)
      const token = response?.token || response?.accessToken || (typeof response === "string" ? response : null);
      if (!token) {
        throw new Error(`OFS returned empty access token for application "${key}".`);
      }

      this._cachedTokens[key] = token;
      return token;
    };

    /**
     * Demonstrates an authenticated REST API call using the retrieved OAuth Bearer token.
     * 
     * IMPORTANT ARCHITECTURAL & CORS DEPLOYMENT NOTE:
     * - Plugin Procedures (callProcedure) & Lifecycle (close): Run over postMessage; NOT subject to CORS.
     *   Updating activities, inventory, or resources is best achieved natively via the 'close' method.
     * - Direct REST API Calls (fetch): Direct HTTP requests executed in the plugin iframe;
     *   strictly enforced by browser Cross-Origin Resource Sharing (CORS).
     * 
     * Supported Deployment & CORS Configurations:
     * 1. Hosted Plugin Archive (.zip): Uploaded to OFS Configuration -> Forms & Plugins.
     *    OFS executes the archive inside an isolated, sandboxed iframe. Even though hosted on OFS
     *    infrastructure, the iframe executes under an isolated origin and does NOT automatically
     *    bypass browser CORS for direct REST calls.
     * 2. Externally Hosted Plugins (Standalone CDN/Server): Executed from your external web server.
     * 
     * For direct fetch() REST calls to succeed under EITHER deployment model:
     * - The target OFSC instance must have the plugin's origin explicitly allowed in
     *   Configuration -> Applications (CORS configuration for the registered application), OR
     * - The requests must be proxied through an integration middleware / API gateway
     *   (such as Oracle Integration Cloud - OIC) that provides appropriate CORS response headers.
     * Client-side JavaScript CANNOT bypass missing server CORS headers.
     *
     * @param {string} endpointUrl - Target REST URL (e.g. https://<instance>.fs.ocs.oraclecloud.com/rest/ofscCore/v1/activities/123)
     * @param {string} appKey - The application key configured in OFS
     * @param {Object} [options={}] - Fetch options (method, headers, body)
     * @returns {Promise<Object>} JSON response from the REST endpoint
     */
    this.callRestApi = async function(endpointUrl, appKey, options = {}) {
      const token = await this._getAccessToken(appKey);
      if (!token) {
        throw new Error(`Cannot execute REST API: No token for application "${appKey}".`);
      }

      const fetchOptions = {
        method: options.method || "GET",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Accept": "application/json",
          ...(options.headers || {})
        }
      };

      if (options.body) {
        fetchOptions.headers["Content-Type"] = "application/json";
        fetchOptions.body = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
      }

      const response = await fetch(endpointUrl, fetchOptions);
      if (!response.ok) {
        let errorDetails = "";
        try {
          const errBody = await response.json();
          errorDetails = errBody.detail || errBody.title || JSON.stringify(errBody);
        } catch (_) {
          errorDetails = response.statusText;
        }
        throw new Error(`REST API HTTP ${response.status}: ${errorDetails}`);
      }

      return await response.json();
    };

    /**
     * Invokes the native mobile barcode scanner via callProcedure.
     * Note: This only functions inside the native Oracle Field Service Mobile app
     * when 'scanBarcode' is enabled in Allowed Procedures.
     */
    this.scanBarcode = async function() {
      if (!this.allowedProcedures?.scanBarcode) {
        throw new Error("Barcode scanner is not enabled in Allowed Procedures for this plugin.");
      }

      return await this._sendSyncMessage({
        apiVersion: 1,
        method: "callProcedure",
        callId: this._generateCallId(),
        procedure: "scanBarcode"
      });
    };

    /**
     * Retrieves the technician's current geographic coordinates using standard HTML5 Geolocation.
     * @returns {Promise<{latitude: number, longitude: number, accuracy: number}>}
     */
    this.getLocation = function() {
      return new Promise((resolve, reject) => {
        if (!navigator.geolocation) {
          reject(new Error("Geolocation is not supported by this browser/device."));
          return;
        }

        navigator.geolocation.getCurrentPosition(
          (position) => {
            resolve({
              latitude: position.coords.latitude,
              longitude: position.coords.longitude,
              accuracy: position.coords.accuracy
            });
          },
          (error) => {
            let msg = "Unknown location error";
            switch (error.code) {
              case error.PERMISSION_DENIED:
                msg = "Location permission was denied by the user.";
                break;
              case error.POSITION_UNAVAILABLE:
                msg = "Location information is unavailable.";
                break;
              case error.TIMEOUT:
                msg = "Location request timed out.";
                break;
            }
            reject(new Error(msg));
          },
          { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
        );
      });
    };

    // =========================================================================
    // 3. LOW-LEVEL MESSAGING & ORIGIN RESOLUTION
    // =========================================================================

    /**
     * Sends an RPC message and waits for the matching response with a safety timeout.
     */
    this._sendSyncMessage = function(data) {
      const id = data.callId || data.method;
      return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          if (this._pendingRequests.has(id)) {
            this._pendingRequests.delete(id);
            this._setLoading(false);
            reject(new Error(`Timeout waiting for response to "${data.procedure || data.method}"`));
          }
        }, this._apiTimeout);

        this._pendingRequests.set(id, { resolve, reject, timeoutId });
        this._sendPostMessage(data);
      });
    };

    /**
     * Sends a postMessage to the parent OFS window.
     * Enforces targetOrigin security to prevent privileged data leaks.
     *
     * Note on 'ready' handshake wildcard:
     * When the plugin first boots in an iframe, document.referrer may be empty or stripped
     * by strict browser Referrer-Policy headers before any host message has arrived.
     * Per Oracle OFS Plugin Framework specifications, 'ready' contains zero sensitive data
     * (only protocol flags) and is the only message permitted to fall back to '*' to initiate
     * discovery. Once the host responds, the origin is validated against _isTrustedOrigin()
     * and strictly locked. All privileged dispatches (initEnd, callProcedure, close) require
     * a verified targetOrigin and are actively blocked otherwise.
     */
    this._sendPostMessage = function(data) {
      const isDiscovery = data && data.method === "ready";
      const targetOrigin = this._targetOrigin || (isDiscovery ? "*" : null);

      if (!targetOrigin) {
        console.error(`[OFS Security] Blocked privileged message dispatch (${data?.method || "unknown"}): parent origin is unverified.`);
        return;
      }

      if (targetOrigin === "*") {
        console.warn("[OFS Security] Initial 'ready' handshake sent with wildcard '*' origin. Target origin will lock upon first verified host message.");
      }

      if (window.parent && window.parent !== window) {
        window.parent.postMessage(JSON.stringify(data), targetOrigin);
      } else {
        console.info("[OFS Mock/Standalone] Outgoing message:", data);
      }
    };

    /**
     * Resolves the expected parent origin from document.referrer or ancestorOrigins.
     */
    this._resolveExpectedOrigin = function() {
      if (document.referrer) {
        try {
          return new URL(document.referrer).origin;
        } catch (_) {}
      }
      if (window.location.ancestorOrigins && window.location.ancestorOrigins[0]) {
        return window.location.ancestorOrigins[0];
      }
      return null;
    };

    /**
     * Validates if an origin belongs to Oracle Cloud or local development environments.
     * Enforces strict hostname boundaries and HTTPS protocol to prevent spoofing
     * (e.g. rejects 'oracle.com.attacker.example' or 'attacker-oracle.com').
     *
     * @param {string} origin - Origin URL (e.g. https://instance.etadirect.com)
     * @returns {boolean} True if origin is trusted
     */
    this._isTrustedOrigin = function(origin) {
      if (!origin || typeof origin !== "string") return false;
      try {
        const parsed = new URL(origin);
        const host = parsed.hostname.toLowerCase();
        const protocol = parsed.protocol.toLowerCase();

        // 1. Same-origin (e.g. plugin hosted on the same origin as the parent frame)
        if (window.location && window.location.origin && origin === window.location.origin) {
          return true;
        }

        // 2. Local development environments (HTTP allowed on localhost/loopback only)
        if ((protocol === "http:" || protocol === "https:") &&
            (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]")) {
          return true;
        }

        // 3. Oracle Cloud domains: Strictly require HTTPS and match exact domain or subdomains
        if (protocol === "https:") {
          const trustedDomains = ["etadirect.com", "oraclecloud.com", "oracle.com"];
          const isOracleDomain = trustedDomains.some(domain =>
            host === domain || host.endsWith("." + domain)
          );
          if (isOracleDomain) {
            return true;
          }
        }
      } catch (_) {}
      return false;
    };

    /**
     * Generates a cryptographically random callId for procedure correlation.
     */
    this._generateCallId = function() {
      if (window.crypto && window.crypto.getRandomValues) {
        const bytes = new Uint8Array(16);
        window.crypto.getRandomValues(bytes);
        return btoa(String.fromCharCode.apply(null, bytes));
      }
      return "call_" + Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
    };

    // =========================================================================
    // 4. FORM STATE PERSISTENCE (SCOPED DRAFTS)
    // =========================================================================

    /**
     * Computes a draft storage key scoped to the specific activity being viewed.
     * CRITICAL: Scoping prevents notes from Activity A leaking into Activity B!
     */
    this._getDraftKey = function() {
      const aid = this.openParams?.activeAid || this.openParams?.aid || "default";
      return `${this.tag}_draft_aid_${aid}`;
    };

    /**
     * Auto-saves input field values into local draft storage.
     */
    this._saveForm = async function() {
      if (!this.storage) return;

      const data = {};
      document.querySelectorAll("input, textarea, select").forEach(el => {
        // Exclude system buttons and read-only procedure output displays from draft persistence
        if (el.id && !["SubmitBtn", "CancelBtn", "DownloadZipBtn", "BarcodeResult", "LocationResult"].includes(el.id)) {
          data[el.id] = el.value;
        }
      });

      const key = this._getDraftKey();
      await this.storage.setValue(key, JSON.stringify(data));
    };

    /**
     * Restores auto-saved draft values for the currently opened activity.
     */
    this._restoreForm = async function() {
      if (!this.storage) return;

      try {
        const key = this._getDraftKey();
        const savedStr = await this.storage.getValue(key);
        if (!savedStr) return;

        const data = JSON.parse(savedStr);
        if (data && typeof data === "object") {
          Object.keys(data).forEach(id => {
            const el = document.getElementById(id);
            if (el) el.value = data[id];
          });
        }
      } catch (err) {
        console.warn("[OFS Storage] Error restoring draft:", err.message);
      }
    };

    /**
     * Clears the draft for the current activity after a successful submission.
     */
    this._clearDraft = async function() {
      if (!this.storage) return;
      const key = this._getDraftKey();
      await this.storage.removeValue(key);
    };

    // =========================================================================
    // 5. USER INTERFACE & SUBMISSION
    // =========================================================================

    /**
     * Registers static event listeners (Submit, Cancel, Input Auto-Save) ONCE.
     */
    this._setupStaticListeners = function() {
      // Auto-save draft whenever user types into an input/textarea
      document.addEventListener("input", () => this._saveForm());

      // Submit Button: Packages form fields into OFS "close" action and exits
      const submitBtn = document.getElementById("SubmitBtn");
      if (submitBtn) {
        submitBtn.addEventListener("click", () => this._handleSubmit());
      }

      // Close Button: Closes the plugin without making any property changes
      const cancelBtn = document.getElementById("CancelBtn");
      if (cancelBtn) {
        cancelBtn.addEventListener("click", () => {
          this._sendPostMessage({
            apiVersion: 1,
            method: "close",
            backScreen: "default"
          });
        });
      }
    };

    /**
     * Handles form submission to OFS Core.
     * Prevents duplicate clicks, packages properties, clears drafts, and sends "close".
     */
    this._handleSubmit = async function() {
      if (this._isSubmitting) return; // Prevent duplicate submissions
      this._isSubmitting = true;

      const submitBtn = document.getElementById("SubmitBtn");
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = "Submitting...";
      }

      this._setLoading(true);

      // Collect form fields to update on the OFS entity
      const propertiesToUpdate = {};
      document.querySelectorAll("input, textarea, select").forEach(input => {
        if (input.id && !["SubmitBtn", "CancelBtn", "DownloadZipBtn", "BarcodeResult", "LocationResult"].includes(input.id)) {
          // Map input element ID to uppercase OFS custom property name
          propertiesToUpdate[input.id.toUpperCase()] = input.value;
        }
      });

      // Clear the local draft now that data is submitted
      await this._clearDraft();

      // Send the documented OFS "close" message with activity update actions.
      // NOTE: This example updates an 'activity'. If your plugin runs on an inventory
      // or resource screen, change entity to 'inventory' or 'resource'.
      const activeAid = this.openParams?.activeAid || this.openParams?.aid || "";

      this._sendPostMessage({
        apiVersion: 1,
        method: "close",
        backScreen: "default",
        actions: [
          {
            entity: "activity",
            action: "update",
            aid: activeAid,
            properties: propertiesToUpdate
          }
        ]
      });
    };

    /**
     * Shows or hides the loading spinner overlay.
     */
    this._setLoading = function(isLoading) {
      const loader = document.getElementById("loader");
      if (loader) {
        if (isLoading) {
          loader.classList.add("loader-show");
        } else {
          loader.classList.remove("loader-show");
        }
      }
    };

    /**
     * Renders dynamic status, application tokens, and hardware controls.
     * Note: All untrusted values are escaped via escapeHtml() to eliminate XSS.
     */
    this._renderUI = function() {
      const statusDiv = document.getElementById("status");
      if (!statusDiv) return;

      const appKeys = Object.keys(this.applications);
      const appRows = appKeys.map(key => {
        const isCached = !!this._cachedTokens[key];
        const appType = this.applications[key]?.type ? escapeHtml(this.applications[key].type.toUpperCase()) : "OAUTH";
        return `
          <div class="item">
            <span>${escapeHtml(key)} (${appType}):</span>
            <span class="${isCached ? 'ok' : 'warn'}">${isCached ? "🟢 Ready" : "🟡 Pending"}</span>
          </div>
        `;
      }).join("") || '<div class="item"><span>None configured</span><span class="warn">None</span></div>';

      const resourceId = escapeHtml(this.openParams?.resourceId || "N/A");
      const activityId = escapeHtml(this.openParams?.activeAid || this.openParams?.aid || "N/A");
      const pluginTag = escapeHtml(this.tag);
      const isOnline = navigator.onLine;

      statusDiv.innerHTML = `
        <div class="card">
          <div class="section">
            <h3>Session Status</h3>
            <div class="item"><span>Plugin Label:</span><span>${pluginTag}</span></div>
            <div class="item"><span>Activity ID (aid):</span><span>${activityId}</span></div>
            <div class="item"><span>Resource ID:</span><span>${resourceId}</span></div>
            <div class="item"><span>Network:</span><span>${isOnline ? "🟢 Online" : "🔴 Offline"}</span></div>
          </div>
          <div class="section">
            <h3>Configured Applications (Tokens in Memory)</h3>
            ${appRows}
          </div>
          <div class="section">
            <h3>Native Hardware Capabilities</h3>
            <div class="item" style="gap: 10px; display: flex; margin-bottom: 8px;">
              <button id="ScanBtn" class="btn btn-primary" type="button" style="flex: 1; padding: 6px; margin: 0; font-size: 12px;">Scan Barcode</button>
              <input type="text" id="BarcodeResult" placeholder="Result will appear here" readonly style="flex: 2; margin: 0; padding: 6px; font-size: 12px;">
            </div>
            <div class="item" style="gap: 10px; display: flex;">
              <button id="LocBtn" class="btn btn-primary" type="button" style="flex: 1; padding: 6px; margin: 0; font-size: 12px;">Get GPS Location</button>
              <input type="text" id="LocationResult" placeholder="Latitude, Longitude" readonly style="flex: 2; margin: 0; padding: 6px; font-size: 12px;">
            </div>
          </div>
        </div>
      `;

      // Wire up dynamic hardware buttons created inside statusDiv
      const scanBtn = document.getElementById("ScanBtn");
      if (scanBtn) {
        scanBtn.addEventListener("click", async () => {
          this._setLoading(true);
          try {
            const result = await this.scanBarcode();
            const input = document.getElementById("BarcodeResult");

            // Handle cancellation per Oracle documentation (resultData.cancelled === true)
            if (result && (result.cancelled === true || result.cancelled === "true")) {
              this.showToast("Barcode scan cancelled", "info");
              return;
            }

            // Populate input from result.text (official Oracle documented field)
            if (result && typeof result.text === "string" && result.text.trim()) {
              if (input) {
                input.value = result.text.trim();
              }
              this.showToast(`Scanned: ${result.text.trim()}`, "success");
            } else {
              this.showToast("No barcode text detected in response", "warning");
            }
          } catch (error) {
            this.showToast(`Scan failed: ${error.message}`, "error");
          } finally {
            this._setLoading(false);
          }
        });
      }

      const locBtn = document.getElementById("LocBtn");
      if (locBtn) {
        locBtn.addEventListener("click", async () => {
          this._setLoading(true);
          try {
            const result = await this.getLocation();
            const input = document.getElementById("LocationResult");
            if (input && result) {
              input.value = `${result.latitude.toFixed(6)}, ${result.longitude.toFixed(6)} (±${Math.round(result.accuracy)}m)`;
              this.showToast("Location retrieved successfully", "success");
            }
          } catch (error) {
            this.showToast(`Location failed: ${error.message}`, "error");
          } finally {
            this._setLoading(false);
          }
        });
      }
    };

    /**
     * UI Toast Notification Helper using Redwood design tokens.
     */
    this.showToast = function(message, type = "info") {
      const toast = document.createElement("div");
      toast.className = `toast toast-${escapeHtml(type)}`;
      toast.textContent = message;
      document.body.appendChild(toast);

      setTimeout(() => toast.classList.add("show"), 10);
      setTimeout(() => {
        toast.classList.remove("show");
        setTimeout(() => toast.remove(), 300);
      }, 3500);
    };
  };

  // Support Node.js test environment if module is defined
  if (typeof module !== "undefined" && module.exports) {
    module.exports = window.OfscPlugin;
  }

  // Automatic browser bootstrap on page load
  if (typeof window !== "undefined") {
    window.addEventListener("load", function() {
      // In production, instantiate your plugin with the exact label configured in OFS
      const plugin = new window.OfscPlugin();
      plugin.init("TEST_HELLO_OFSC");
      window.currentPlugin = plugin; // Exposed for debugging in browser DevTools
    });
  }
})();

