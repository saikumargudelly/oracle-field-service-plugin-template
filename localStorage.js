/**
 * Storage abstraction layer for OFSC plugin.
 * Provides a consistent asynchronous interface for reading/writing plugin data.
 * Assigned to the plugin instance in init(): this.storage = window.OFSC_TS_STORAGE_1
 * 
 * =====================================================================================
 * IMPORTANT ARCHITECTURAL NOTE FOR DEVELOPERS:
 * Oracle Field Service Cloud (OFSC) plugins are embedded in cross-origin iframes.
 * Under modern browser security rules (such as Safari's Intelligent Tracking Prevention (ITP)
 * and Chrome's third-party storage partitioning policies), direct access to `localStorage`
 * inside cross-origin iframes may be blocked or restricted depending on host configuration.
 * 
 * For a robust production-ready deployment:
 * 1. Check for iframe storage exceptions.
 * 2. Configure proper CORS headers and secure HTTPS cookies.
 * 3. If storage access is completely blocked, implement in-memory caching or fallback 
 *    procedures, or leverage the OFSC postMessage storage mechanism if available in your version.
 * =====================================================================================
 */
(function() {
  // In-memory fallback if localStorage is blocked by browser third-party iframe policies
  const memoryFallback = {};
  let storageAvailable = true;

  try {
    const testKey = "__ofsc_test__";
    window.localStorage.setItem(testKey, testKey);
    window.localStorage.removeItem(testKey);
  } catch (e) {
    storageAvailable = false;
    console.warn("[OFS Storage] LocalStorage is unavailable or restricted in this iframe. Using in-memory fallback.");
  }

  const storageService = {
    /**
     * Checks if persistent browser storage is available.
     * @returns {boolean}
     */
    isAvailable: function() {
      return storageAvailable;
    },

    /**
     * Reads a value from storage (or in-memory fallback).
     * @param {string} key - Storage key
     * @returns {Promise<string>} Value from storage or empty string if not found
     */
    getValue: function(key) {
      return new Promise((resolve) => {
        if (!storageAvailable) {
          resolve(memoryFallback[key] || "");
          return;
        }
        try {
          const value = window.localStorage.getItem(key) || "";
          resolve(value);
        } catch (e) {
          console.warn(`[OFS Storage] Read failed for key "${key}", falling back to memory:`, e.message);
          resolve(memoryFallback[key] || "");
        }
      });
    },

    /**
     * Writes a value to storage (or in-memory fallback).
     * NOTE: Never store OAuth access tokens, passwords, or sensitive PII here!
     * @param {string} key - Storage key
     * @param {string} value - String value to store
     * @returns {Promise<boolean>} True if write was successful
     */
    setValue: function(key, value) {
      return new Promise((resolve) => {
        // Keep in-memory cache synchronized as a safety net
        memoryFallback[key] = String(value);

        if (!storageAvailable) {
          resolve(true);
          return;
        }
        try {
          window.localStorage.setItem(key, String(value));
          resolve(true);
        } catch (e) {
          console.warn(`[OFS Storage] Write failed for key "${key}", stored in memory only:`, e.message);
          resolve(false);
        }
      });
    },

    /**
     * Removes a value from storage and in-memory cache.
     * @param {string} key - Storage key
     * @returns {Promise<boolean>} True if remove was successful
     */
    removeValue: function(key) {
      return new Promise((resolve) => {
        delete memoryFallback[key];

        if (!storageAvailable) {
          resolve(true);
          return;
        }
        try {
          window.localStorage.removeItem(key);
          resolve(true);
        } catch (e) {
          console.warn(`[OFS Storage] Remove failed for key "${key}":`, e.message);
          resolve(false);
        }
      });
    }
  };

  // Provide both the standard name and the legacy name for backward compatibility
  window.OfscStorage = storageService;
  window.OFSC_TS_STORAGE_1 = storageService;

  // Support Node.js test environment if module is defined
  if (typeof module !== "undefined" && module.exports) {
    module.exports = storageService;
  }
})();


