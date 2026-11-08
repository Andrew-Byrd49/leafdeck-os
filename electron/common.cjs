// Shared helpers for Leafdeck's main-process modules.
const { app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const userFile = (name) => path.join(app.getPath('userData'), name);

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(userFile(name), 'utf8'));
  } catch {
    return fallback;
  }
}
const writeJson = (name, value) => writeAtomic(userFile(name), JSON.stringify(value, null, 2));

/** Local, non-secret app settings (server address, permissions, browsing options…). */
const readConfig = () => readJson('config.json', {});
const writeConfig = (patch) => writeJson('config.json', { ...readConfig(), ...patch });

const isWebUrl = (u) => /^https?:\/\//i.test(u || '');

const hostOf = (u) => {
  try {
    return new URL(u).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
};

const originOf = (u) => {
  try {
    return new URL(u).origin;
  } catch {
    return '';
  }
};

/** Hosts that never get HTTPS upgrades or DNS filtering surprises: this machine and private networks. */
function isLocalHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  return (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h.endsWith('.local') ||
    h.endsWith('.test') ||
    h === '::1' ||
    /^127\./.test(h) ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    /^169\.254\./.test(h) ||
    !h.includes('.') // single-label intranet names
  );
}

module.exports = { userFile, writeAtomic, readJson, writeJson, readConfig, writeConfig, isWebUrl, hostOf, originOf, isLocalHost };
