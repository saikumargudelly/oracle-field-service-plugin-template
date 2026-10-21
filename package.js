/**
 * Simple Zero-Dependency Packaging Script for Oracle Field Service Plugins
 *
 * Creates 'plugin.zip' ready for upload to OFS Configuration -> Forms & Plugins.
 * Requirements:
 * - 'index.html' must be at the root of the ZIP file.
 * - Excludes test files, source control, node_modules, and OS metadata.
 *
 * Usage:
 *   node package.js
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");

const ROOT_DIR = __dirname;
const OUTPUT_ZIP = path.join(ROOT_DIR, "plugin.zip");

// Files required for the OFS plugin runtime
const DEPLOY_FILES = [
  "index.html",
  "plugin.js",
  "localStorage.js",
  "style.css"
];

console.log("📦 Packaging Oracle Field Service Plugin...");

// 1. Verify all deploy files exist
for (const file of DEPLOY_FILES) {
  const filePath = path.join(ROOT_DIR, file);
  if (!fs.existsSync(filePath)) {
    console.error(`❌ Error: Missing required deployment file "${file}"`);
    process.exit(1);
  }
}

// 2. Remove existing archive if present
if (fs.existsSync(OUTPUT_ZIP)) {
  fs.unlinkSync(OUTPUT_ZIP);
}

// 3. Create zip archive
try {
  // Use system zip utility
  const fileList = DEPLOY_FILES.join(" ");
  execSync(`zip -q -j "${OUTPUT_ZIP}" ${fileList}`, { cwd: ROOT_DIR });

  const stats = fs.statSync(OUTPUT_ZIP);
  console.log(`✅ Successfully created "${path.basename(OUTPUT_ZIP)}" (${(stats.size / 1024).toFixed(1)} KB)`);
  console.log("\nIncluded files (at archive root):");
  DEPLOY_FILES.forEach(f => console.log(`  - ${f}`));
  console.log("\nReady for upload in OFS Configuration -> Forms & Plugins -> Add Plugin (Plugin Archive).");
} catch (err) {
  console.error("❌ Failed to create zip using system command:", err.message);
  process.exit(1);
}
