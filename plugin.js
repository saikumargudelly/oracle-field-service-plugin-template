/*!
 * Hello OFS - Developer Reference Template
 * Minimal boilerplate demonstrating the Oracle Field Service Plugin lifecycle.
 */
"use strict";

(function() {
  window.OfscPlugin = function() {
    this.tag = "TEST_HELLO_OFSC";
    this.storage = null;
    this.openParams = null;
    this.allowedProcedures = {};
    this.applications = {};
    this._cachedTokens = {};
    this._pendingRequests = new Map();
    this._apiTimeout = 30000;

    // Bootstrap: Listeners, ready signal, & offline restore
    this.init = function(pluginName) {
      this.tag = pluginName;
      this.storage = window.OFSC_TS_STORAGE_1;
      
      window.addEventListener("message", this._messageListener.bind(this), false);
      
      // Connection listeners
      window.addEventListener("online", () => {
        this.showToast("🟢 Connection restored", "success");
        this._renderUI();
      });
      window.addEventListener("offline", () => {
        this.showToast("🔴 Connection lost", "warning");
        this._renderUI();
      });
      
      // Auto-save form progress on input changes
      document.addEventListener("input", () => this._saveForm());
      this._restoreForm();
      
      this._sendPostMessage({
        apiVersion: 1,
        method: "ready",
        sendInitData: true,
        showHeader: true,
        enableBackButton: true,
      });
    };

    // Message Receiver & Dispatcher
    this._messageListener = async function(event) {
      const expectedOrigin = this._getOrigin(document.referrer);
      if (expectedOrigin && event.origin !== expectedOrigin) {
        console.warn(`[OFS Warning] Ignored message from: ${event.origin}`);
        return;
      }
      
      try {
        const data = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
        if (!data || !data.method) return;
        
        const id = data.callId || data.method;
        
        // Resolve pending synchronous requests (e.g. callProcedureResult)
        if (this._pendingRequests.has(id)) {
          const { resolve, reject, timeoutId } = this._pendingRequests.get(id);
          clearTimeout(timeoutId);
          this._pendingRequests.delete(id);
          
          if (data.method === "error" || data.status === "error") {
            reject(data);
          } else {
            resolve(data.method === "callProcedureResult" ? data.resultData : data);
          }
          return;
        }
        
        // Handle standalone lifecycle calls from OFS
        switch (data.method) {
          case "init":
            await this._handleInit(data);
            break;
          case "open":
            await this._handleOpen(data);
            break;
          case "error":
            console.error("OFS Error:", data.error);
            break;
        }
      } catch (err) {
        console.error("Message parsing error:", err);
      }
    };

    // Lifecycle: Init
    this._handleInit = async function(data) {
      await this.storage.setValue(`${this.tag}_metadata`, JSON.stringify({ data }));
      this._sendPostMessage({ apiVersion: 1, method: "initEnd" });
    };

    // Lifecycle: Open
    this._handleOpen = async function(data) {
      this.openParams = data.openParams;
      this.allowedProcedures = data.allowedProcedures || {};
      
      try {
        const metadataStr = await this.storage.getValue(`${this.tag}_metadata`);
        if (metadataStr) {
          this.applications = JSON.parse(metadataStr).data?.applications || {};
        }
        
        // Fetch OAuth tokens in parallel for all configured applications
        const appKeys = Object.keys(this.applications);
        await Promise.all(
          appKeys.map(key => this._getAccessToken(key).catch(err => {
            console.warn(`Failed token for ${key}:`, err.message);
          }))
        );
      } catch (error) {
        console.error("Open waterfall error:", error);
      } finally {
        this._renderUI();
      }
    };

    // Request OAuth Access Token
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

      if (!authData?.token) throw new Error("Failed to get token");
      this._cachedTokens[key] = authData.token;
      return authData.token;
    };

    // Trigger Mobile Device Barcode Scanner
    this.scanBarcode = async function() {
      if (!this.allowedProcedures?.scanBarcode) {
        throw new Error("Scanner not allowed in current OFS configuration.");
      }
      return await this._sendSyncMessage({
        apiVersion: 1,
        method: "callProcedure",
        callId: this._generateCallId(),
        procedure: "scanBarcode"
      });
    };

    // Get Device Geolocation Coordinates using HTML5 Geolocation API
    this.getLocation = function() {
      return new Promise((resolve, reject) => {
        if (!navigator.geolocation) {
          reject(new Error("Geolocation is not supported by this browser."));
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
                msg = "Location permission denied.";
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

    // Sync message helper (expects a reply, e.g. callProcedure)
    this._sendSyncMessage = function(data) {
      const id = data.callId || data.method;
      return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          if (this._pendingRequests.has(id)) {
            this._pendingRequests.delete(id);
            reject(new Error(`Timeout waiting for ${data.method}`));
          }
        }, this._apiTimeout);

        this._pendingRequests.set(id, { resolve, reject, timeoutId });
        this._sendPostMessage(data);
      });
    };

    // Low-level postMessage dispatcher
    this._sendPostMessage = function(data) {
      const origin = this._getOrigin(document.referrer) || "*";
      parent.postMessage(JSON.stringify(data), origin);
    };

    this._getOrigin = function(url) {
      if (!url) return null;
      try {
        return new URL(url).origin;
      } catch (e) {
        return null;
      }
    };

    this._generateCallId = function() {
      return btoa(String.fromCharCode.apply(
        null, window.crypto.getRandomValues(new Uint8Array(16))
      ));
    };

    // Form auto-save & restore helpers
    this._saveForm = function() {
      const data = {};
      document.querySelectorAll("input, textarea, select").forEach(el => {
        if (el.id && !["SubmitBtn", "CancelBtn", "BarcodeResult", "LocationResult"].includes(el.id)) {
          data[el.id] = el.value;
        }
      });
      localStorage.setItem(`${this.tag}_formstate`, JSON.stringify(data));
    };

    this._restoreForm = function() {
      try {
        const data = JSON.parse(localStorage.getItem(`${this.tag}_formstate`));
        if (data) {
          Object.keys(data).forEach(id => {
            const el = document.getElementById(id);
            if (el) el.value = data[id];
          });
        }
      } catch (e) {}
    };

    // Render User Interface
    this._renderUI = function() {
      const statusDiv = document.getElementById("status");
      if (!statusDiv) return;

      const appRows = Object.keys(this.applications).map(key => {
        const isCached = !!this._cachedTokens[key];
        return `
          <div class="item">
            <span>${key} (${this.applications[key].type?.toUpperCase()}):</span>
            <span class="${isCached ? 'ok' : 'warn'}">${isCached ? "🟢 Active" : "🔴 Pending"}</span>
          </div>
        `;
      }).join("") || '<div class="item"><span>None</span></div>';

      statusDiv.innerHTML = `
        <div class="card">
          <div class="section">
            <h3>Status</h3>
            <div class="item"><span>Plugin ID:</span><span>${this.tag}</span></div>
            <div class="item"><span>Resource:</span><span>${this.openParams?.resourceId || "N/A"}</span></div>
            <div class="item"><span>Network:</span><span>${navigator.onLine ? "🟢 Online" : "🔴 Offline"}</span></div>
          </div>
          <div class="section">
            <h3>Configured Applications</h3>
            ${appRows}
          </div>
          <div class="section">
            <h3>Device Capabilities</h3>
            <div class="item" style="gap: 10px; display: flex; margin-bottom: 8px;">
              <button id="ScanBtn" class="btn btn-primary" style="flex: 1; padding: 6px; margin: 0; font-size: 12px;">Scan Code</button>
              <input type="text" id="BarcodeResult" placeholder="Scan Result" readonly style="flex: 2; margin: 0; padding: 6px; font-size: 12px;">
            </div>
            <div class="item" style="gap: 10px; display: flex;">
              <button id="LocBtn" class="btn btn-primary" style="flex: 1; padding: 6px; margin: 0; font-size: 12px;">Get Location</button>
              <input type="text" id="LocationResult" placeholder="Latitude, Longitude" readonly style="flex: 2; margin: 0; padding: 6px; font-size: 12px;">
            </div>
          </div>
        </div>
      `;

      // Scan Button Click
      document.getElementById("ScanBtn")?.addEventListener("click", async () => {
        try {
          const result = await this.scanBarcode();
          const input = document.getElementById("BarcodeResult");
          if (input && result) {
            input.value = result.value || result.text || JSON.stringify(result);
          }
        } catch (error) {
          alert(`Scan failed: ${error.message}`);
        }
      });

      // Geolocation Button Click
      document.getElementById("LocBtn")?.addEventListener("click", async () => {
        try {
          const result = await this.getLocation();
          const input = document.getElementById("LocationResult");
          if (input && result) {
            input.value = `${result.latitude.toFixed(6)}, ${result.longitude.toFixed(6)} (±${Math.round(result.accuracy)}m)`;
          }
        } catch (error) {
          alert(`Location failed: ${error.message}`);
        }
      });

      // Submit: Update OFS and Close
      document.getElementById("SubmitBtn")?.addEventListener("click", () => {
        const propertiesToUpdate = {};
        document.querySelectorAll("input, textarea, select").forEach(input => {
          if (input.id && !["SubmitBtn", "CancelBtn", "BarcodeResult", "LocationResult"].includes(input.id)) {
            propertiesToUpdate[input.id.toUpperCase()] = input.value;
          }
        });

        this._sendPostMessage({
          apiVersion: 1,
          method: "close",
          backScreen: "default",
          actions: [{
            entity: "activity",
            action: "update",
            aid: this.openParams?.activeAid || this.openParams?.aid || "",
            properties: propertiesToUpdate
          }]
        });
      });

      // Cancel: Close without saving
      document.getElementById("CancelBtn")?.addEventListener("click", () => {
        this._sendPostMessage({
          apiVersion: 1,
          method: "close",
          backScreen: "default"
        });
      });
    };

    // UI Toast Notification Helper
    this.showToast = function(message, type = "info") {
      const toast = document.createElement("div");
      toast.className = `toast toast-${type}`;
      toast.textContent = message;
      document.body.appendChild(toast);
      setTimeout(() => toast.classList.add("show"), 10);
      setTimeout(() => {
        toast.classList.remove("show");
        setTimeout(() => toast.remove(), 300);
      }, 3000);
    };
  };

  window.addEventListener("load", function() {
    const plugin = new window.OfscPlugin();
    plugin.init("TEST_HELLO_OFSC");
  });
})();
