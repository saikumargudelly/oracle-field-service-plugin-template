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
  if (!window.OFSC_TS_STORAGE_1) {
    window.OFSC_TS_STORAGE_1 = {
      /**
       * Reads a value from localStorage
       * @param {string} key - Storage key
       * @returns {Promise<string>} Value from storage or empty string if not found or blocked
       */
      getValue: function(key) {
        return new Promise((resolve) => {
          try {
            const value = localStorage.getItem(key) || "";
            resolve(value);
          } catch (e) {
            console.warn(`[OFSC Storage Warning] LocalStorage read blocked/failed for key ${key}.`, e);
            resolve("");
          }
        });
      },

      /**
       * Writes a value to localStorage
       * @param {string} key - Storage key
       * @param {string} value - Value to store
       * @returns {Promise<boolean>} True if write successful
       */
      setValue: function(key, value) {
        return new Promise((resolve) => {
          try {
            localStorage.setItem(key, value);
            resolve(true);
          } catch (e) {
            console.warn(`[OFSC Storage Warning] LocalStorage write blocked/failed for key ${key}.`, e);
            resolve(false);
          }
        });
      },

      /**
       * Removes a value from localStorage
       * @param {string} key - Storage key
       * @returns {Promise<boolean>} True if remove successful
       */
      removeValue: function(key) {
        return new Promise((resolve) => {
          try {
            localStorage.removeItem(key);
            resolve(true);
          } catch (e) {
            console.warn(`[OFSC Storage Warning] LocalStorage remove blocked/failed for key ${key}.`, e);
            resolve(false);
          }
        });
      },
    };
  }
})();

