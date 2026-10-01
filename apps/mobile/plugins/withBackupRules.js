/**
 * The app's own Android backup rules: what Auto Backup and device-to-device
 * transfer carry, stated by the app rather than inherited from a module.
 *
 * `allowBackup` is true because the library and history are the user's own
 * record, and losing them on a new phone is the loss backup exists to prevent.
 * They live in AsyncStorage, which on Android is the `RKStorage` SQLite
 * database (the `database` domain); the settings record is there too. The one
 * secret, the access token, is in expo-secure-store, which keeps it in a
 * SharedPreferences file of its own, `SecureStore.xml`, encrypted under an
 * Android Keystore key that never leaves the device. A restored copy of that
 * file is ciphertext no other device can open and a read of it rejects, so the
 * file is excluded here and the token is typed in again on a new phone - as it
 * is on iOS, where the keychain class is THIS_DEVICE_ONLY.
 *
 * Why the app writes these rather than listing expo-secure-store's: its plugin
 * ships rules that include `sharedpref` alone, and Android's rule is that once
 * a rule file has an <include>, nothing else is backed up. Listing that plugin
 * therefore excluded the database - the library, history and settings - which
 * is the opposite of what allowBackup is on for. So the files are the app's,
 * the manifest points at them, and expo-secure-store's plugin is told not to
 * write its own (`configureAndroidBackup: false`), or it would warn at
 * prebuild that other rules are present and skip.
 *
 * Left out, by not including the `file` domain: `pending-clips`, the clips
 * waiting for the server (src/queue.ts, under the files directory). They are
 * transient uploads, and 25 MB is the whole backup quota.
 *
 * Two files because Android reads two: `fullBackupContent` on Android 11 and
 * lower, `dataExtractionRules` (cloud backup and device transfer, each its own
 * section) on 12 and higher. Writing them is a dangerous mod, since a res/xml
 * file is a file rather than a part of the config. It runs at prebuild and not
 * under `expo config --type introspect`, which is why the config test drives
 * it itself and parses what it wrote.
 */
const fs = require("fs");
const path = require("path");

const { AndroidConfig, withAndroidManifest, withDangerousMod } = require("expo/config-plugins");

/**
 * expo-secure-store's SharedPreferences file: SHARED_PREFERENCES_NAME in its
 * SecureStoreModule.kt, plus the .xml the platform gives every preferences
 * file. The config test reads the constant out of that source.
 */
const SECURE_STORE_FILE = "SecureStore.xml";

/** The rules, in the order they are written; every section carries the same set. */
const RULES = [
  { rule: "include", domain: "database", path: "." },
  { rule: "include", domain: "sharedpref", path: "." },
  { rule: "exclude", domain: "sharedpref", path: SECURE_STORE_FILE },
];

const BACKUP_RULES = "app/src/main/res/xml/backup_rules.xml";
const EXTRACTION_RULES = "app/src/main/res/xml/data_extraction_rules.xml";
const BACKUP_RULES_RESOURCE = "@xml/backup_rules";
const EXTRACTION_RULES_RESOURCE = "@xml/data_extraction_rules";

const ruleLines = (indent) => RULES.map((r) => `${indent}<${r.rule} domain="${r.domain}" path="${r.path}"/>`).join("\n");

const BACKUP_RULES_XML = `<?xml version="1.0" encoding="utf-8"?>
<!-- Written by plugins/withBackupRules.js at prebuild; change it there. Android 11 and lower. -->
<full-backup-content>
${ruleLines("  ")}
</full-backup-content>
`;

const EXTRACTION_RULES_XML = `<?xml version="1.0" encoding="utf-8"?>
<!-- Written by plugins/withBackupRules.js at prebuild; change it there. Android 12 and higher. -->
<data-extraction-rules>
  <cloud-backup>
${ruleLines("    ")}
  </cloud-backup>
  <device-transfer>
${ruleLines("    ")}
  </device-transfer>
</data-extraction-rules>
`;

/** Write both rule files under the Android project; returns their paths. */
function writeBackupRules(platformProjectRoot) {
  return [
    [BACKUP_RULES, BACKUP_RULES_XML],
    [EXTRACTION_RULES, EXTRACTION_RULES_XML],
  ].map(([relative, xml]) => {
    const file = path.join(platformProjectRoot, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, xml);
    return file;
  });
}

function withBackupRules(config) {
  config = withAndroidManifest(config, (cfg) => {
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(cfg.modResults);
    application.$["android:fullBackupContent"] = BACKUP_RULES_RESOURCE;
    application.$["android:dataExtractionRules"] = EXTRACTION_RULES_RESOURCE;
    return cfg;
  });
  return withDangerousMod(config, [
    "android",
    (cfg) => {
      writeBackupRules(cfg.modRequest.platformProjectRoot);
      return cfg;
    },
  ]);
}

module.exports = withBackupRules;
module.exports.RULES = RULES;
module.exports.SECURE_STORE_FILE = SECURE_STORE_FILE;
module.exports.BACKUP_RULES = BACKUP_RULES;
module.exports.EXTRACTION_RULES = EXTRACTION_RULES;
module.exports.BACKUP_RULES_RESOURCE = BACKUP_RULES_RESOURCE;
module.exports.EXTRACTION_RULES_RESOURCE = EXTRACTION_RULES_RESOURCE;
module.exports.BACKUP_RULES_XML = BACKUP_RULES_XML;
module.exports.EXTRACTION_RULES_XML = EXTRACTION_RULES_XML;
module.exports.writeBackupRules = writeBackupRules;
