/*!
 * Hello OFSC - Developer Reference Demo Plugin
 * Demonstrates a clean, decoupled, and secure implementation of the OFSC plugin lifecycle.
 * Designed as a starter template for developers to customize for production requirements.
 */

"use strict";

(function() {
  window.OfscPlugin = function() {
    // State and Configurations
    this.tag = "TEST_HELLO_OFSC";
    this.storage = null;
    this.openParams = null;
    this.securedData = null;
    this.applications = {};
    this._cachedTokens = {};
    
    // UI and Network State
    this.isOnline = navigator.onLine;
    this._isLoading = false;
    this._formData = {};
    
    // Internal API Request Mapping & Limits
    this._pendingRequests = new Map();
    this._apiTimeout = 30000; // 30 seconds timeout for sync calls
    this._retryCount = 0;
    this._maxRetries = 3;
    this._sessionTimeout = null;
    this._inactivityTimeout = 15 * 60 * 1000; // 15 minutes session timeout
    this._activityLog = [];

    /**
     * Bootstraps the plugin.
     * Sets up event listeners and sends the 'ready' signal to Oracle Field Service.
     */
    this.init = function(pluginName) {
      this.tag = pluginName;
      this.storage = window.OFSC_TS_STORAGE_1;
      this._logActivity("init", "Plugin template initialized");
      
      // Network Status Listeners
      window.addEventListener("online", this._handleOnline.bind(this), false);
      window.addEventListener("offline", this._handleOffline.bind(this), false);
      
      // OFSC Message Listener
      window.addEventListener("message", this._messageListener.bind(this), false);
      
      // Inactivity / Session Timeout Listeners
      document.addEventListener("mousemove", this._resetSessionTimeout.bind(this), false);
      document.addEventListener("keypress", this._resetSessionTimeout.bind(this), false);
      
      // Restore previously saved form state (Offline support)
      this._restoreFormData();
      
      // Send standard 'ready' signal.
      // OFSC will respond with either 'init' (if sendInitData is true) or 'open'.
      this._sendPostMessage({
        apiVersion: 1,
        method: "ready",
        sendInitData: true,
        showHeader: true,
        enableBackButton: true,
      });
    };

    /**
     * Message Listener (Receiver)
     * Handles incoming postMessages from OFSC Core Application.
     */
    this._messageListener = async function(event) {
      // SECURITY: Validate that the sender is the expected parent window origin
      const expectedOrigin = this._getOrigin(document.referrer);
      
      // NOTE FOR DEVELOPERS: In local development, referrer/origin might be empty or local, 
      // so this template logs a warning rather than blocking. For production, you MUST 
      // uncomment the return statement to enforce strict origin verification.
      if (expectedOrigin && event.origin !== expectedOrigin) {
        console.warn(`[OFSC Security Warning] Ignored message from untrusted origin: ${event.origin}. Expected: ${expectedOrigin}`);
        // return; // ENFORCE IN PRODUCTION
      }
      
      try {
        // Parse incoming message data
        const data = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
        if (!data || !data.method) return;
        
        const id = data.callId || data.method;
        
        // 1. Resolve pending synchronous requests (e.g. callProcedureResult)
        if (this._pendingRequests.has(id)) {
          const { resolve, reject, timeoutId } = this._pendingRequests.get(id);
          clearTimeout(timeoutId);
          this._pendingRequests.delete(id);
          
          if (data.method === "error" || data.status === "error") {
            reject(data);
          } else {
            // For callProcedure, return the resultData
            resolve(data.method === "callProcedureResult" ? data.resultData : data);
          }
          return;
        }
        
        // 2. Dispatch standalone lifecycle events from OFSC
        switch (data.method) {
          case "init":
            await this._handleInit(data);
            break;
            
          case "open":
            await this._handleOpen(data);
            break;
            
          case "error":
            console.error("Received error message from OFSC:", data);
            this.showToast(`OFSC Error: ${data.error?.message || "Unknown error"}`, 5000, "error");
            break;
            
          default:
            console.warn(`Unhandled method received from OFSC: ${data.method}`);
        }
      } catch (err) {
        console.error("Message parsing or handler execution error:", err);
      }
    };

    /**
     * Handles the 'init' lifecycle message from OFSC.
     * Stores configuration metadata and signals completion by sending 'initEnd'.
     */
    this._handleInit = async function(data) {
      this._logActivity("init", "Received init configuration");
      await this._storeMetadata(data);
      
      // Send 'initEnd' to signal that configuration has been received.
      // OFSC will destroy this hidden iframe immediately after receiving this.
      this._sendPostMessage({
        apiVersion: 1,
        method: "initEnd"
      });
      this._logActivity("init", "Sent initEnd acknowledgment");
    };

    /**
     * Handles the 'open' lifecycle message from OFSC.
     * Extracts open parameters, starts the loading waterfall, and renders the UI.
     */
    this._handleOpen = async function(data) {
      this._logActivity("open", "Plugin opened by user");
      this.openParams = data.openParams;
      this.securedData = data.securedData;
      
      try {
        this._logActivity("waterfall", "Loading configuration metadata");
        await this._loadApplicationConfig();
        
        this._logActivity("waterfall", "Requesting tokens for configured applications");
        const appKeys = Object.keys(this.applications || {});
        // Fetch all tokens in parallel using Promise.all
        await Promise.all(
          appKeys.map(key => this._getAccessToken(key).catch(err => {
            console.warn(`Failed to fetch token for application key '${key}':`, err.message);
          }))
        );
        
        this._logActivity("waterfall", "Rendering user interface");
        this._renderUI();
        
        this._resetSessionTimeout();
      } catch (error) {
        this._logActivity("error", `Open waterfall failed: ${error.message}`);
        console.error("Open waterfall error:", error);
        this.showToast(`Load error: ${error.message}`, 4000, "error");
        this._renderUI();
      }
    };

    /**
     * Sends a synchronous message to OFSC and returns a Promise.
     * Used for messages that expect a corresponding result (e.g. callProcedure -> callProcedureResult).
     */
    this._sendSyncMessage = function(data) {
      const id = data.callId || data.method;
      
      return new Promise((resolve, reject) => {
        // Set request timeout to prevent hanging the UI
        const timeoutId = setTimeout(() => {
          if (this._pendingRequests.has(id)) {
            this._pendingRequests.delete(id);
            reject(new Error(`Sync request for '${data.method}' timed out after ${this._apiTimeout / 1000}s`));
          }
        }, this._apiTimeout);

        this._pendingRequests.set(id, { resolve, reject, timeoutId });

        try {
          this._sendPostMessage(data);
        } catch (err) {
          clearTimeout(timeoutId);
          this._pendingRequests.delete(id);
          reject(err);
        }
      });
    };

    /**
     * Sends a postMessage payload to the parent OFSC window.
     */
    this._sendPostMessage = function(data) {
      const origin = this._getOrigin(document.referrer) || "*";
      
      // SECURITY WARNING: In production, do not use "*" as targetOrigin.
      // Explicitly define your expected Oracle Cloud origin domain.
      parent.postMessage(JSON.stringify(data), origin);
    };

    /**
     * Helper to extract the origin (scheme + host + port) from a URL.
     */
    this._getOrigin = function(url) {
      if (!url) return null;
      try {
        const urlObj = new URL(url);
        return urlObj.origin;
      } catch (e) {
        return null;
      }
    };

    /**
     * Generates a unique cryptographically secure Call ID.
     */
    this._generateCallId = function() {
      return btoa(String.fromCharCode.apply(
        null, window.crypto.getRandomValues(new Uint8Array(16))
      ));
    };

    /**
     * Stores config metadata received during the 'init' phase.
     */
    this._storeMetadata = async function(data) {
      const version = data.securedData?.version || "1";
      const key = `${this.tag}_metadata`;
      
      await this.storage.setValue(
        key,
        JSON.stringify({ version, data })
      );
    };

    /**
     * Retrieves application config details from stored metadata.
     */
    this._loadApplicationConfig = async function() {
      const metadataStr = await this.storage.getValue(`${this.tag}_metadata`);
      if (!metadataStr) throw new Error("Metadata not configured. Perform initialization first.");
      
      const config = JSON.parse(metadataStr);
      const apps = config.data?.applications;

      if (!apps || Object.keys(apps).length === 0) {
        throw new Error("No applications found in metadata configuration.");
      }

      // Store all discovered applications (OFS, OIC, CX, SCM, ERP, etc.)
      this.applications = apps;
    };

    /**
     * Standard implementation of token retrieval via OFSC callProcedure.
     */
    this._getAccessToken = async function(appKey) {
      const key = appKey || Object.keys(this.applications)[0];
      if (!key) return null;
      if (this._cachedTokens[key]) return this._cachedTokens[key];

      const authData = await this._sendSyncMessage({
        apiVersion: 1,
        method: "callProcedure",
        callId: this._generateCallId(),
        procedure: "getAccessToken",
        params: { applicationKey: key },
      });

      if (!authData?.token) throw new Error(`Failed to retrieve access token for application: ${key}`);

      this._cachedTokens[key] = authData.token;
      return authData.token;
    };

    /**
     * Triggers the native device barcode scanner via the OFSC native mobile wrapper.
     */
    this.scanBarcode = async function() {
      // Check if barcode scanning is allowed by the host environment
      if (this.openParams && !this.openParams.allowedProcedures?.scanBarcode) {
        throw new Error("Barcode scanner is not supported or allowed in this environment.");
      }

      return await this._sendSyncMessage({
        apiVersion: 1,
        method: "callProcedure",
        callId: this._generateCallId(),
        procedure: "scanBarcode"
      });
    };


    /**
     * Centralized REST API Wrapper (supports Bearer Auth, timeout, and exponential backoff)
     */
     this.callApi = async function({
       url,
       method = "GET",
       data = null,
       retry = true,
       appKey
     }) {
       const key = appKey || Object.keys(this.applications)[0];
       try {
         this.showLoader();
         this._retryCount = 0;
 
         const makeRequest = async () => {
           method = method.toUpperCase();
           const config = {
             method,
             headers: { "Content-Type": "application/json" },
             signal: AbortSignal.timeout(this._apiTimeout),
           };
 
           const token = key ? this._cachedTokens[key] : null;
           if (token) {
             config.headers["Authorization"] = `Bearer ${token}`;
           }
 
           if (data && ["POST", "PATCH", "PUT"].includes(method)) {
             config.body = JSON.stringify(data);
           }
 
           let response = await fetch(url, config);
 
           // Handle Token Expiration (401 Unauthorized recovery)
           if (response.status === 401 && retry && key) {
             this._logActivity("auth", `Token expired for ${key} (401). Refreshing token...`);
             delete this._cachedTokens[key];
             await this._getAccessToken(key);
             return makeRequest(); // Retry request with new token
           }

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
          }

          return await response.json();
        };

        // Retry Loop with Exponential Backoff
        for (let attempt = 0; attempt < this._maxRetries; attempt++) {
          try {
            const result = await makeRequest();
            this._logActivity("api", `${method} ${url} - Success`);
            this.hideLoader();
            return result;
          } catch (error) {
            this._retryCount = attempt + 1;
            
            // Fail fast on client errors (4xx)
            if (error.message.includes("HTTP 4")) throw error;

            if (attempt < this._maxRetries - 1) {
              const delayMs = Math.pow(2, attempt) * 1000;
              this._logActivity("retry", `Attempt ${attempt + 1} failed. Retrying in ${delayMs}ms...`);
              await new Promise(resolve => setTimeout(resolve, delayMs));
            } else {
              throw error;
            }
          }
        }
      } catch (error) {
        this._logActivity("error", `API Request failed: ${error.message}`);
        this.hideLoader();
        throw error;
      }
    };

    /**
     * UI Loader Utilities (Oracle Redwood Themed)
     */
    this.showLoader = function() {
      if (this._isLoading) return;
      this._isLoading = true;
      
      let loader = document.getElementById("loader");
      if (!loader) {
        loader = document.createElement("div");
        loader.id = "loader";
        loader.innerHTML = '<div class="loader-spinner"></div>';
        document.body.appendChild(loader);
      }
      
      loader.classList.add("loader-show");
      document.querySelectorAll(".btn").forEach(btn => btn.disabled = true);
    };

    this.hideLoader = function() {
      this._isLoading = false;
      const loader = document.getElementById("loader");
      if (loader) {
        loader.classList.remove("loader-show");
      }
      document.querySelectorAll(".btn").forEach(btn => btn.disabled = false);
    };

    /**
     * Basic Validation Helper
     */
    this._validateForm = function() {
      const errors = [];
      const submitBtn = document.getElementById("SubmitBtn");
      if (!submitBtn) errors.push("Submit button reference is missing from DOM");
      
      const formInputs = document.querySelectorAll("input[required]");
      formInputs.forEach(input => {
        if (!input.value || input.value.trim() === "") {
          errors.push(`${input.placeholder || input.name || "Field"} is required`);
        }
      });
      
      return errors;
    };

    /**
     * Session Timeout Management
     */
     this._resetSessionTimeout = function() {
       if (this._sessionTimeout) clearTimeout(this._sessionTimeout);
       
       this._sessionTimeout = setTimeout(() => {
         this._logActivity("session", "Session expired due to inactivity");
         this._cachedTokens = {}; // Clear all cached application tokens
         this.showToast("Your session has expired. Form progress saved locally.", "warning");
       }, this._inactivityTimeout);
     };

    /**
     * Local Form State Persistence (Offline support)
     */
    this._saveFormData = async function() {
      try {
        const formInputs = document.querySelectorAll("input, textarea, select");
        const data = {};
        
        formInputs.forEach(input => {
          if (input.id && input.id !== "SubmitBtn" && input.id !== "CancelBtn") {
            data[input.id] = input.value;
          }
        });
        
        const payload = {
          data,
          timestamp: new Date().toISOString(),
          version: 1
        };
        
        await this.storage.setValue(`${this.tag}_formstate`, JSON.stringify(payload));
        this._logActivity("persistence", "Saved current form state locally");
      } catch (error) {
        console.error("Local save error:", error);
      }
    };

    this._restoreFormData = async function() {
      try {
        const saved = await this.storage.getValue(`${this.tag}_formstate`);
        if (!saved) return;
        
        const payload = JSON.parse(saved);
        const savedTime = new Date(payload.timestamp);
        const now = new Date();
        const diffHours = (now - savedTime) / (1000 * 60 * 60);
        
        // Discard local state older than 24 hours
        if (diffHours > 24) {
          await this.storage.removeValue(`${this.tag}_formstate`);
          return;
        }
        
        Object.keys(payload.data).forEach(id => {
          const input = document.getElementById(id);
          if (input) input.value = payload.data[id];
        });
        
        this._logActivity("persistence", "Restored local form progress");
      } catch (error) {
        console.error("Local restore error:", error);
      }
    };

    /**
     * Local Activity Logging
     */
    this._logActivity = function(action, details) {
      const entry = {
        timestamp: new Date().toISOString(),
        action,
        details,
        status: "success"
      };
      
      this._activityLog.push(entry);
      if (this._activityLog.length > 100) this._activityLog.shift();
      
      if (this.storage) {
        this.storage.setValue(
          `${this.tag}_activitylog`,
          JSON.stringify(this._activityLog)
        ).catch(err => console.error("Activity log write failed:", err));
      }
    };

    /**
     * Renders UI Elements on successful Open
     */
    this._renderUI = function() {
      const statusDiv = document.getElementById("status");
      if (!statusDiv) return;

      statusDiv.innerHTML = `
        <div class="card">
          <div class="section">
            <h3>Status</h3>
            <div class="item">
              <span>Plugin ID:</span>
              <span>${this.tag}</span>
            </div>
            <div class="item">
              <span>Resource ID:</span>
              <span>${this.openParams?.resourceId || "Not Provided"}</span>
            </div>
            <div class="item">
              <span>Network State:</span>
              <span class="${this.isOnline ? 'ok' : 'warn'}">
                ${this.isOnline ? "🟢 Online" : "🔴 Offline"}
              </span>
            </div>
          </div>

          <div class="section">
            <h3>Discovered Applications</h3>
            ${Object.keys(this.applications || {}).map(key => {
              const app = this.applications[key];
              const isTokenCached = this._cachedTokens && this._cachedTokens[key];
              const tokenStatusText = isTokenCached ? "✓ Active" : "⚠ Pending";
              return `
                <div class="item">
                  <span>${key} (${app.type?.toUpperCase()}):</span>
                  <span class="${isTokenCached ? 'ok' : 'warn'}">${tokenStatusText}</span>
                </div>
              `;
            }).join("") || '<div class="item"><span>None Found</span></div>'}
          </div>

          <div class="section">
            <h3>Device Integration</h3>
            <div class="item" style="gap: 10px; align-items: stretch; display: flex;">
              <button id="ScanBtn" class="btn btn-primary" style="flex: 1; padding: 6px 12px; margin: 0; font-size: 12px;">Scan Code</button>
              <input type="text" id="BarcodeResult" placeholder="Result shows here" readonly style="flex: 2; margin: 0; padding: 6px; font-size: 12px;">
            </div>
          </div>

          <div class="actions">
            <button id="InfoBtn" class="btn">Show Host Config Details</button>
          </div>
        </div>
      `;

      // Show Config Details click listener
      document.getElementById("InfoBtn")?.addEventListener("click", () => {
        const appsInfo = Object.keys(this.applications || {})
          .map(key => `${key} (${this.applications[key].type?.toUpperCase()}):\n${this.applications[key].resourceUrl || "No URL"}`)
          .join("\n\n");
        this.showToast(
          `Discovered Apps:\n\n${appsInfo || "None"}\n\nHost Referrer: ${document.referrer || "None"}`,
          6000,
          "info"
        );
      });

      // Barcode Scanner click listener (utilizes native scanBarcode callProcedure)
      document.getElementById("ScanBtn")?.addEventListener("click", async () => {
        try {
          this._logActivity("barcode", "Triggering barcode scan procedure");
          this.showToast("Opening device scanner...", 1500, "info");
          
          const scanResult = await this.scanBarcode();
          this._logActivity("barcode", `Scan successful: ${scanResult?.value}`);
          
          const resultInput = document.getElementById("BarcodeResult");
          if (resultInput && scanResult) {
            resultInput.value = scanResult.value || scanResult.text || JSON.stringify(scanResult);
          }
          this.showToast("✓ Barcode scanned successfully", 2000, "success");
        } catch (error) {
          console.error("Barcode scan error:", error);
          this._logActivity("barcode_error", error.message);
          this.showToast(`Scan failed: ${error.message}`, 4000, "error");
        }
      });


      // Submit action: Sends the updated data back to OFSC and closes the plugin
      document.getElementById("SubmitBtn")?.addEventListener("click", async () => {
        try {
          if (!this.isOnline) {
            this.showToast("Cannot submit changes while offline", 3000, "warning");
            this._logActivity("submit", "Submission blocked: offline");
            return;
          }

          const validationErrors = this._validateForm();
          if (validationErrors.length > 0) {
            this.showToast(`Validation failed:\n${validationErrors.join("\n")}`, 4000, "warning");
            this._logActivity("validation", `${validationErrors.length} errors found`);
            return;
          }

          // Save current form progress locally
          await this._saveFormData();
          this.showLoader();
          this._logActivity("submit", "Submission initiated");

          // Simulate any pre-submission backend check (e.g. 1 second delay)
          await new Promise(resolve => setTimeout(resolve, 1000));

          this.hideLoader();
          this.showToast("✓ Success. Updating Oracle Field Service...", 2000, "success");
          this._logActivity("submit", "Sending close and update actions to OFSC");

          // Prepare property updates from form fields
          // Note: In OFSC, custom fields/properties are typically in UPPERCASE
          const formInputs = document.querySelectorAll("input, textarea, select");
          const propertiesToUpdate = {};
          formInputs.forEach(input => {
            if (input.id && input.id !== "SubmitBtn" && input.id !== "CancelBtn") {
              const ofscPropKey = input.id.toUpperCase();
              propertiesToUpdate[ofscPropKey] = input.value;
            }
          });

          // Post standard 'close' message with entity updates
          // This closes the iframe and updates the activity properties in OFSC
          this._sendPostMessage({
            apiVersion: 1,
            method: "close",
            backScreen: "default",
            actions: [
              {
                entity: "activity",
                action: "update",
                aid: this.openParams?.activeAid || this.openParams?.aid || "",
                properties: propertiesToUpdate
              }
            ]
          });
        } catch (error) {
          console.error("Submit error:", error);
          this.hideLoader();
          this.showToast(`Submission failed: ${error.message}`, 4000, "error");
          this._logActivity("error", `Submission failed: ${error.message}`);
        }
      });

      // Cancel/Close action: Closes the plugin without making any updates
      document.getElementById("CancelBtn")?.addEventListener("click", async () => {
        try {
          await this._saveFormData();
          
          this._sendPostMessage({
            apiVersion: 1,
            method: "close",
            backScreen: "default",
          });
        } catch (error) {
          console.error("Close error:", error);
          this._sendPostMessage({
            apiVersion: 1,
            method: "close",
            backScreen: "default",
          });
        }
      });
    };

    /**
     * UI Toast Notifications Helper
     */
    this.showToast = function(message, duration = 3000, type = "info") {
      const toast = document.createElement("div");
      toast.className = `toast toast-${type}`;
      toast.textContent = message;
      document.body.appendChild(toast);
      setTimeout(() => toast.classList.add("show"), 10);
      setTimeout(() => {
        toast.classList.remove("show");
        setTimeout(() => toast.remove(), 300);
      }, duration);
    };

    /**
     * Network Event Handlers
     */
    this._handleOnline = function() {
      this.isOnline = true;
      this.showToast("🟢 Connection restored. Back online.", 2000, "success");
      this._renderUI();
    };

    this._handleOffline = function() {
      this.isOnline = false;
      this.showToast("🔴 Connection lost. Operating in offline mode.", 3000, "warning");
      this._renderUI();
    };
  };

  // Auto-bootstrap plugin instance on window load
  window.addEventListener("load", function() {
    const plugin = new window.OfscPlugin();
    plugin.init("TEST_HELLO_OFSC");
  });
})();

