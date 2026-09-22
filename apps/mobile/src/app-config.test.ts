import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { inflateSync } from "node:zlib";

const require = createRequire(import.meta.url);
// .pathname rather than fileURLToPath: the DOM lib's URL type and Node's
// disagree under this tsconfig, and the path has nothing to decode.
const root = new URL("..", import.meta.url).pathname;

interface AdaptiveIcon {
  foregroundImage?: string;
  backgroundImage?: string;
  monochromeImage?: string;
  backgroundColor?: string;
}

interface AppConfig {
  expo: {
    orientation?: string;
    userInterfaceStyle?: string;
    backgroundColor?: string;
    splash?: unknown;
    web?: unknown;
    ios?: {
      supportsTablet?: boolean;
      userInterfaceStyle?: string;
      infoPlist?: Record<string, unknown>;
    };
    android?: {
      allowBackup?: boolean;
      predictiveBackGestureEnabled?: boolean;
      permissions?: string[];
      blockedPermissions?: string[];
      userInterfaceStyle?: string;
      adaptiveIcon?: AdaptiveIcon;
    };
    plugins?: unknown[];
  };
}

interface Manifest {
  manifest: {
    $: Record<string, string>;
    "uses-permission"?: Array<{ $: Record<string, string> }>;
    application?: Array<{ $: Record<string, string> }>;
  };
}

/** plugins/withBackupRules.js: the plugin function plus the names it exports for this test. */
interface BackupRulesPlugin {
  (config: Record<string, unknown>): {
    mods: { android: { dangerous: (c: Record<string, unknown>) => Promise<unknown> } };
  };
  BACKUP_RULES: string;
  EXTRACTION_RULES: string;
  BACKUP_RULES_RESOURCE: string;
  EXTRACTION_RULES_RESOURCE: string;
  SECURE_STORE_FILE: string;
}

/** An element as xml2js hands it back: attributes under $, children grouped by tag. */
interface XmlElement {
  $?: Record<string, string>;
  [tag: string]: unknown;
}

interface Introspected {
  _internal: {
    modResults: {
      android: { manifest: Manifest };
      ios: { infoPlist: Record<string, unknown> };
    };
  };
}

const appJson = require("../app.json") as AppConfig;
const pkg = require("../package.json") as { dependencies: Record<string, string> };
const bundled = require("expo/bundledNativeModules.json") as Record<string, string>;

const has = (o: object, key: string) => Object.prototype.hasOwnProperty.call(o, key);

const pluginOptions = (name: string): Record<string, unknown> => {
  const entry = appJson.expo.plugins?.find((p) => (Array.isArray(p) ? p[0] : p) === name);
  assert.ok(entry, `${name} must be in app.json's plugins`);
  return Array.isArray(entry) ? ((entry[1] as Record<string, unknown> | undefined) ?? {}) : {};
};

/**
 * What a prebuild would generate. `expo config --type introspect` runs the same
 * plugin chain, so this is the merged result rather than the app.json that
 * feeds it: the template's own permissions and the application attributes the
 * plugins default only exist here, and the only other place they show up is a
 * native build, which no other suite runs.
 */
const introspected = JSON.parse(
  execFileSync("node", [require.resolve("expo/bin/cli"), "config", "--type", "introspect", "--json"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, CI: "1", EXPO_NO_TELEMETRY: "1" },
    maxBuffer: 16 * 1024 * 1024,
  }),
) as Introspected;
const manifest = introspected._internal.modResults.android.manifest.manifest;
const application = manifest.application?.[0]?.$ ?? {};
const infoPlist = introspected._internal.modResults.ios.infoPlist;

/**
 * The native posture. The rule is that app.json states every key pinned here,
 * even at its default, so the file and this test say the same thing and a
 * template default drifting under a new SDK is a change reviewed here rather
 * than one nobody sees until a store build.
 */
describe("native posture", () => {
  it("configures the splash screen through the plugin, not the dead top-level block", () => {
    // SDK 57 removed the top-level `splash` block and expo-splash-screen's
    // plugin reads its props only, so a top-level block is silently ignored:
    // the build gets the template's white screen and nothing warns.
    assert.equal(has(appJson.expo, "splash"), false, "the top-level splash block has no reader on SDK 57");
    const splash = pluginOptions("expo-splash-screen");
    assert.equal(splash.image, "./assets/splash-icon.png");
    assert.equal(splash.imageWidth, 160);
    assert.equal(splash.backgroundColor, appJson.expo.backgroundColor, "the splash and the root view agree");
    assert.ok(existsSync(join(root, splash.image as string)), "the splash image exists");
    assert.equal(pkg.dependencies["expo-splash-screen"], bundled["expo-splash-screen"], "at the SDK's pin");
  });

  it("sets the interface style once and ships the module Android needs for it", () => {
    // The schema's own note: userInterfaceStyle "requires expo-system-ui be
    // installed in your project to work on Android". Without it the key is
    // honoured on iOS and silently ignored on the other platform.
    assert.equal(appJson.expo.userInterfaceStyle, "automatic");
    assert.equal(pkg.dependencies["expo-system-ui"], bundled["expo-system-ui"], "at the SDK's pin");
    // The top-level value applies to both platforms; a per-platform repeat is
    // one more place for the two to diverge, so neither restates it.
    assert.equal(appJson.expo.ios?.userInterfaceStyle, undefined);
    assert.equal(appJson.expo.android?.userInterfaceStyle, undefined);
    // ...and the one value reaches the platform: the plist iOS reads.
    assert.equal(infoPlist.UIUserInterfaceStyle, "Automatic");
    // expo-system-ui's own plugin is what writes the root view colour on iOS
    // (backgroundColor "requires expo-system-ui ... to work on iOS"), so its
    // presence in the merged plist is the module doing its job, not only
    // being listed. 0xFF0B0B10 is #0b0b10 with the alpha byte on top.
    assert.equal(appJson.expo.backgroundColor, "#0b0b10");
    assert.equal(infoPlist.RCTRootViewBackgroundColor, 0xff0b0b10);
  });

  it("carries no key SDK 57 stopped reading", () => {
    // `newArchEnabled` is gone from @expo/config-types@57's schema and nothing
    // in @expo/cli, config-plugins or prebuild-config reads it: the new
    // architecture is on regardless, and a key that reads as a switch is a
    // lie about what turning it off would do.
    assert.equal(has(appJson.expo, "newArchEnabled"), false);
    // `android.edgeToEdgeEnabled` is gone too, and this one prebuild warns
    // about, verbatim: "`edgeToEdgeEnabled` customization is no longer
    // available - Android 16 makes edge-to-edge mandatory. Remove the
    // `edgeToEdgeEnabled` entry from your app.json/app.config.js."
    assert.equal(has(appJson.expo.android ?? {}, "edgeToEdgeEnabled"), false);
  });

  it("pins the back gesture, the device family and the orientation explicitly", () => {
    // Predictive back is off by default on Android 13+; stated here so that
    // turning it on - which needs every screen to survive the system's own
    // back preview - is a deliberate change and not a template default that
    // moved. The manifest attribute is what the OS actually reads.
    assert.equal(appJson.expo.android?.predictiveBackGestureEnabled, false);
    assert.equal(application["android:enableOnBackInvokedCallback"], "false");
    // A phone camera app: the whole flow is pointing a handset at a TV, there
    // is no tablet layout, and an iPad-capable build is one App Review tests
    // on an iPad. `false` is also the default; explicit so it cannot drift.
    assert.equal(appJson.expo.ios?.supportsTablet, false);
    assert.equal(appJson.expo.orientation, "portrait");
    // No web target: CI exports Android only and the app records from a
    // camera, so a `web` block (and the `web.bundler` pin that goes with one)
    // would configure a bundle nothing builds or runs.
    assert.equal(appJson.expo.web, undefined);
  });

  it("keeps the user's own record in Android backup, and the token out of it", async () => {
    // allowBackup is explicit and true. The library and history are the
    // user's own record (`tvsham.library.v1` / `tvsham.history.v1` in
    // AsyncStorage, src/store.ts) and losing them on a new phone is the loss
    // Auto Backup exists to prevent. The one secret, the access token, is in
    // expo-secure-store, AES-encrypted under an Android Keystore key that
    // never leaves the device: a restored copy is ciphertext no other device
    // can open, so its file is excluded and the token is typed in again on a
    // new phone - as on iOS, where the "token storage" test pins the keychain
    // class that keeps it there.
    assert.equal(appJson.expo.android?.allowBackup, true);
    assert.equal(application["android:allowBackup"], "true");

    // The rules are the app's own (plugins/withBackupRules.js), not
    // expo-secure-store's: that plugin's file includes `sharedpref` alone,
    // and once a rule file has an <include> Android backs up nothing else -
    // so listing it, as 88f9d7e did, excluded the database and with it the
    // record this test is named for. It stays listed for its Face ID option
    // and is told not to write rules, or it warns and skips at prebuild.
    assert.ok(appJson.expo.plugins?.includes("./plugins/withBackupRules"), "the rules plugin is listed");
    assert.deepEqual(pluginOptions("expo-secure-store"), { faceIDPermission: false, configureAndroidBackup: false });
    assert.equal(has(infoPlist, "NSFaceIDUsageDescription"), false);
    const plugin = require("../plugins/withBackupRules.js") as BackupRulesPlugin;
    assert.equal(plugin.BACKUP_RULES_RESOURCE, "@xml/backup_rules");
    assert.equal(plugin.EXTRACTION_RULES_RESOURCE, "@xml/data_extraction_rules");
    assert.equal(application["android:fullBackupContent"], plugin.BACKUP_RULES_RESOURCE);
    assert.equal(application["android:dataExtractionRules"], plugin.EXTRACTION_RULES_RESOURCE);

    // The two names the rules rest on, read out of the modules' own sources
    // rather than remembered: AsyncStorage on Android is the RKStorage SQLite
    // database (the `database` domain), and expo-secure-store's preferences
    // file is SecureStore.xml. A rename in either module fails here rather
    // than quietly backing up the token or dropping the library.
    const asyncStorage = dirname(require.resolve("@react-native-async-storage/async-storage/package.json"));
    const supplier = readFileSync(
      join(asyncStorage, "android/src/main/java/com/reactnativecommunity/asyncstorage/ReactDatabaseSupplier.java"),
      "utf8",
    );
    assert.match(supplier, /extends SQLiteOpenHelper/);
    assert.match(supplier, /DATABASE_NAME = "RKStorage"/);
    const secureStore = dirname(require.resolve("expo-secure-store/package.json"));
    const module = readFileSync(join(secureStore, "android/src/main/java/expo/modules/securestore/SecureStoreModule.kt"), "utf8");
    const prefsName = /SHARED_PREFERENCES_NAME = "([^"]+)"/.exec(module)?.[1];
    assert.ok(prefsName, "expo-secure-store names its preferences file");
    assert.equal(plugin.SECURE_STORE_FILE, `${prefsName}.xml`);

    // What the files say. The mod that writes them is a dangerous mod, which
    // introspection does not run, so it is driven here against a temp dir
    // and its output parsed: the database and preferences in, the SecureStore
    // file out, in every section Android reads.
    const expected = [
      { rule: "include", domain: "database", path: "." },
      { rule: "include", domain: "sharedpref", path: "." },
      { rule: "exclude", domain: "sharedpref", path: "SecureStore.xml" },
    ];
    const { XML } = require("expo/config-plugins") as { XML: { parseXMLAsync(xml: string): Promise<unknown> } };
    const dir = mkdtempSync(join(tmpdir(), "tvsham-prebuild-"));
    try {
      const config = plugin({ name: "TVsham", slug: "tvsham" });
      assert.equal(typeof config.mods.android.dangerous, "function");
      await config.mods.android.dangerous({ ...config, modRequest: { platformProjectRoot: dir } });

      const backup = (await XML.parseXMLAsync(readFileSync(join(dir, plugin.BACKUP_RULES), "utf8"))) as Record<string, XmlElement>;
      assert.deepEqual(rulesOf(backup["full-backup-content"]), expected);

      const extraction = (await XML.parseXMLAsync(readFileSync(join(dir, plugin.EXTRACTION_RULES), "utf8"))) as Record<
        string,
        XmlElement
      >;
      const sections = extraction["data-extraction-rules"];
      assert.deepEqual(rulesOf(only(sections, "cloud-backup")), expected);
      assert.deepEqual(rulesOf(only(sections, "device-transfer")), expected);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ships network access, because the app uses it", () => {
    // This is the one app in the set with real network code: the server is
    // the user's own and everything the app does goes to it, and results open
    // in a browser. INTERNET therefore stays, and stays unblocked - the merged
    // manifest carries it without the `tools:node="remove"` a blocked
    // permission gets. Checked against the source rather than assumed.
    const api = readFileSync(join(root, "src/api.ts"), "utf8");
    const results = readFileSync(join(root, "src/results.tsx"), "utf8");
    assert.match(api, /\bfetch\(/, "src/api.ts talks to the server");
    assert.match(results, /openBrowserAsync|Linking\.openURL/, "src/results.tsx opens links");

    const internet = manifest["uses-permission"]?.find((p) => p.$["android:name"] === "android.permission.INTERNET");
    assert.ok(internet, "INTERNET is in the merged manifest");
    assert.notEqual(internet.$["tools:node"], "remove", "INTERNET must not be blocked");
    assert.ok(
      !appJson.expo.android?.blockedPermissions?.includes("android.permission.INTERNET"),
      "INTERNET must not be in blockedPermissions",
    );

    // The positive list is exactly what the recording flow needs...
    assert.deepEqual(appJson.expo.android?.permissions, [
      "android.permission.CAMERA",
      "android.permission.RECORD_AUDIO",
      "android.permission.READ_MEDIA_VIDEO",
    ]);
    // ...and every permission the merge adds on top of it is accounted for,
    // so the one a new module brings tomorrow is the one this catches.
    const accounted = [
      "android.permission.CAMERA", // expo-camera
      "android.permission.RECORD_AUDIO", // expo-camera, recordAudioAndroid
      "android.permission.READ_MEDIA_VIDEO", // expo-image-picker, screen recordings on Android 13+
      "android.permission.READ_EXTERNAL_STORAGE", // expo-image-picker, maxSdkVersion 32
      "android.permission.WRITE_EXTERNAL_STORAGE", // expo-image-picker, maxSdkVersion 32
      "android.permission.INTERNET", // src/api.ts
      "android.permission.VIBRATE", // expo-haptics
    ];
    const declared = (manifest["uses-permission"] ?? [])
      .filter((p) => p.$["tools:node"] !== "remove")
      .map((p) => p.$["android:name"]);
    assert.ok(declared.length > 0, "the introspection found a manifest at all");
    assert.deepEqual(
      declared.filter((name) => !accounted.includes(name ?? "")),
      [],
      "a permission nothing here accounts for",
    );
  });

  it("blocks the template's overlay permission, and nothing else", () => {
    // The React Native template's main manifest grants SYSTEM_ALERT_WINDOW
    // for the dev-menu overlay, so every app ships "display over other apps"
    // whether or not it ever draws over one. This app never does. The debug
    // source set re-declares it, so a development client loses nothing;
    // blockedPermissions is what takes it out of the release manifest, as a
    // tools:node="remove" the merger applies to every library manifest too.
    // INTERNET is deliberately not on this list - see the test above - so the
    // block is pinned as exactly this one entry.
    assert.deepEqual(appJson.expo.android?.blockedPermissions, ["android.permission.SYSTEM_ALERT_WINDOW"]);
    const overlay = manifest["uses-permission"]?.find(
      (p) => p.$["android:name"] === "android.permission.SYSTEM_ALERT_WINDOW",
    );
    assert.ok(overlay, "SYSTEM_ALERT_WINDOW is in the merge, and being removed");
    assert.equal(overlay.$["tools:node"], "remove");
  });

  it("keeps eas.json in the shared shape", () => {
    const eas = require("../eas.json") as {
      cli?: { version?: string; appVersionSource?: string };
      build?: Record<string, { developmentClient?: boolean; distribution?: string; autoIncrement?: boolean }>;
    };
    assert.equal(eas.cli?.version, ">= 16.0.0");
    assert.equal(eas.cli?.appVersionSource, "remote");
    assert.equal(eas.build?.development?.developmentClient, true);
    assert.equal(eas.build?.development?.distribution, "internal");
    assert.equal(eas.build?.preview?.distribution, "internal");
    assert.equal(eas.build?.production?.autoIncrement, true);
  });

  it("ships all three adaptive icon layers from the generator, at one size", () => {
    // Foreground, background and monochrome: the launcher composes the first
    // two and Android 13's themed icons tint the third. All come out of
    // scripts/make-icons.mjs, never drawn by hand, so the generator has to
    // name each one or a regeneration would drop it.
    const icon = appJson.expo.android?.adaptiveIcon ?? {};
    const generator = readFileSync(join(root, "scripts/make-icons.mjs"), "utf8");
    const layers = ["foregroundImage", "backgroundImage", "monochromeImage"] as const;
    const decoded = {} as Record<(typeof layers)[number], ReturnType<typeof decodePng>>;
    for (const layer of layers) {
      const file = icon[layer];
      assert.ok(file, `adaptiveIcon.${layer} is set`);
      assert.ok(existsSync(join(root, file)), `${file} exists`);
      assert.ok(generator.includes(file.replace("./assets/", "")), `make-icons.mjs writes ${file}`);
      decoded[layer] = decodePng(join(root, file));
    }
    // "Must have the same dimensions as foregroundImage" (the schema on
    // backgroundImage); prebuild refuses a background that does not.
    const { width, height } = decoded.foregroundImage;
    assert.equal(width, height, "the layers are square");
    for (const layer of layers) {
      assert.equal(decoded[layer].width, width, `${layer} width`);
      assert.equal(decoded[layer].height, height, `${layer} height`);
    }

    // The background is flat, opaque, and the app's own colour everywhere.
    assert.equal(icon.backgroundColor, appJson.expo.backgroundColor);
    const [r, g, b] = hexToRgb(icon.backgroundColor ?? "");
    const bg = decoded.backgroundImage.rgba;
    for (let i = 0; i < bg.length; i += 4) {
      if (bg[i] !== r || bg[i + 1] !== g || bg[i + 2] !== b || bg[i + 3] !== 255) {
        assert.fail(`background pixel ${i / 4} is not flat ${icon.backgroundColor}`);
      }
    }

    // The monochrome layer is white on transparent: the OS reads its alpha
    // and supplies the colour, so any colour of its own would be a mistake.
    const mono = decoded.monochromeImage.rgba;
    let opaque = 0;
    let transparent = 0;
    for (let i = 0; i < mono.length; i += 4) {
      const a = mono[i + 3] ?? 0;
      if (a === 0) transparent++;
      else {
        opaque++;
        if (mono[i] !== 255 || mono[i + 1] !== 255 || mono[i + 2] !== 255) {
          assert.fail(`monochrome pixel ${i / 4} is not white`);
        }
      }
    }
    assert.ok(opaque > 0, "the monochrome layer has a glyph");
    assert.ok(transparent > opaque, "the monochrome layer is mostly transparent, as a safe-zone glyph is");
  });
});

/** The children of one tag; xml2js groups them by tag and keeps document order within it. */
function children(element: XmlElement | undefined, tag: string): XmlElement[] {
  return (element?.[tag] as XmlElement[] | undefined) ?? [];
}

/** The one child of that tag, failing if there is not exactly one. */
function only(element: XmlElement | undefined, tag: string): XmlElement {
  const list = children(element, tag);
  assert.equal(list.length, 1, `exactly one <${tag}>`);
  return list[0] as XmlElement;
}

/** Every include and exclude in a section, includes first, as {rule, domain, path}. */
function rulesOf(section: XmlElement | undefined) {
  assert.ok(section, "the section exists");
  return (["include", "exclude"] as const).flatMap((rule) =>
    children(section, rule).map((r) => ({ rule, domain: r.$?.domain, path: r.$?.path })),
  );
}

/** Just enough PNG to read what the generator writes: 8-bit RGBA, unfiltered rows. */
function decodePng(file: string): { width: number; height: number; rgba: Buffer } {
  const buf = readFileSync(file);
  assert.equal(buf.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", `${file} is a PNG`);
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  assert.equal(buf[24], 8, `${file} is 8 bits per channel`);
  assert.equal(buf[25], 6, `${file} is RGBA`);
  const idat: Buffer[] = [];
  for (let off = 8; off < buf.length; ) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    if (type === "IDAT") idat.push(buf.subarray(off + 8, off + 8 + len));
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4 + 1;
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    assert.equal(raw[y * stride], 0, `${file} row ${y} is unfiltered, as the generator writes them`);
    raw.copy(rgba, y * width * 4, y * stride + 1, (y + 1) * stride);
  }
  return { width, height, rgba };
}

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  assert.ok(m, `${hex} is a six-digit hex colour`);
  return [parseInt(m[1] ?? "", 16), parseInt(m[2] ?? "", 16), parseInt(m[3] ?? "", 16)];
}

/**
 * The app's server is one the user runs themselves, usually on their own LAN,
 * where there is no certificate to be had - so it has to be reachable over
 * http://. Expo Go relaxes iOS App Transport Security and development on
 * Android is permissive, which is exactly the combination that works all the
 * way through development and then fails on the first release build. Both
 * platforms' policies are therefore declared here rather than inherited from
 * whatever a prebuild template happens to default to.
 */
describe("cleartext policy", () => {
  it("declares iOS App Transport Security for local networking", () => {
    const ats = appJson.expo.ios?.infoPlist?.NSAppTransportSecurity as
      | { NSAllowsLocalNetworking?: boolean; NSAllowsArbitraryLoads?: boolean }
      | undefined;
    assert.ok(ats, "app.json must declare NSAppTransportSecurity");
    assert.equal(ats.NSAllowsLocalNetworking, true);
    // Local networking only: ATS stays on for the public internet, which is
    // where the app refuses to send the token in the clear anyway.
    assert.notEqual(ats.NSAllowsArbitraryLoads, true);
  });

  // Android's is the wider of the two and cannot be narrowed: a
  // network-security-config permits cleartext per domain, and what this app
  // needs is private IPv4 literals, which a domain list cannot express. Pinned
  // here with that said out loud, rather than sitting next to the assertion
  // above looking like its equivalent.
  it("declares Android cleartext through the config plugin app.json applies", () => {
    assert.ok(
      appJson.expo.plugins?.includes("./plugins/withCleartextTraffic"),
      "the cleartext plugin must stay in the plugins list, or the mod never runs",
    );

    const plugin = require("../plugins/withCleartextTraffic.js") as (
      config: Record<string, unknown>,
    ) => { mods: { android: { manifest: (c: Record<string, unknown>) => Promise<{ modResults: Manifest }> } } };
    const configured = plugin({ name: "TVsham", slug: "tvsham" });
    const modResults: Manifest = {
      manifest: { $: {}, application: [{ $: { "android:name": ".MainApplication" } }] },
    };
    return configured.mods.android
      .manifest({ ...configured, modResults })
      .then((out) => {
        assert.equal(out.modResults.manifest.application?.[0]?.$["android:usesCleartextTraffic"], "true");
      });
  });

  it("reaches the merged manifest", () => {
    // The unit above drives the plugin alone; this is the plugin in the real
    // chain, where an ordering change or a removed plugins entry would lose it.
    assert.equal(application["android:usesCleartextTraffic"], "true");
  });
});

/**
 * store.ts imports AsyncStorage and expo-secure-store, so it cannot be loaded
 * here the way the pure modules are. The one thing worth pinning about it is a
 * single argument, which is readable from the source.
 */
describe("token storage", () => {
  const source = readFileSync(join(root, "src/store.ts"), "utf8");

  it("keeps the token off any device but this one", () => {
    // The keychain was chosen to keep the token out of device backups, and its
    // default accessibility class is in them: WHEN_UNLOCKED is included in an
    // encrypted backup and restored onto whatever device that backup is put
    // on. Only the THIS_DEVICE_ONLY classes stay here.
    assert.match(
      source,
      /keychainAccessible:\s*SecureStore\.WHEN_UNLOCKED_THIS_DEVICE_ONLY/,
      "the token's accessibility class must be declared, not defaulted",
    );
    const writes = source.match(/SecureStore\.setItemAsync\([^)]*\)/g) ?? [];
    assert.ok(writes.length > 0, "the token is still written to the keychain");
    for (const write of writes) {
      assert.match(write, /TOKEN_OPTIONS/, `every write must carry the option: ${write}`);
    }
  });
});
