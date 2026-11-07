// Puts the iPhone app in a Simulator with the made-up demo batch, for README screenshots:
// builds it, installs it, seeds feed.json (and placeholder "signed in" cookies, so the
// dashboard shows its signed-in layout), sets a clean status bar and launches it.
//
//   bun run media:ios [-- "iPhone 17 Pro"]       # needs Xcode and xcodegen
//
// Then take screenshots with `xcrun simctl io booted screenshot <file>.png`.
// Nothing here touches a real device or a real account.
import {execFileSync} from 'node:child_process';
import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {demoState} from './demo.mjs';

const device = process.argv[2] || 'iPhone 17 Pro';
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, {stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', ...opts});

// Boot (if needed) and show the Simulator.
try { run('xcrun', ['simctl', 'boot', device]); } catch { /* already booted */ }
run('open', ['-a', 'Simulator']);
run('xcrun', ['simctl', 'bootstatus', device, '-b']);

// Build for the Simulator (no signing team needed).
run('xcodegen', ['generate'], {cwd: 'ios'});
const derived = 'ios/build/sim';
run('xcodebuild', ['-project', 'ios/Dreamscroll.xcodeproj', '-scheme', 'Dreamscroll', '-configuration', 'Debug',
  '-destination', `platform=iOS Simulator,name=${device}`, '-derivedDataPath', derived, 'CODE_SIGNING_ALLOWED=NO', 'build']);
const app = join(derived, 'Build/Products/Debug-iphonesimulator/Dreamscroll.app');
const bundleId = run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', join(app, 'Info.plist')]).trim();
try { run('xcrun', ['simctl', 'terminate', device, bundleId]); } catch { /* not running */ }
run('xcrun', ['simctl', 'install', device, app]);

// Seed the app's data container.
const container = run('xcrun', ['simctl', 'get_app_container', device, bundleId, 'data']).trim();
const support = join(container, 'Library/Application Support');
mkdirSync(support, {recursive: true});
const {startedAt, endsAt, tweets} = demoState();
const day = new Date().toISOString().slice(0, 10);
writeFileSync(join(support, 'feed.json'), JSON.stringify({
  snapshot: {startedAt, endsAt, tweets: Buffer.from(JSON.stringify(tweets)).toString('base64')},
  budget: {day, usedMs: 0}, highWater: 0, pendingSnapshot: false, snapshotRefused: false, pendingSpendMs: 0,
}));
// Placeholder session cookies (not real sessions) in CookieVault's binary plist format.
const expires = new Date(Date.now() + 30 * 86400_000);
const cookies = [['auth_token', '.x.com'], ['sessionid', '.instagram.com']].map(([Name, Domain]) => ({Name, Value: 'demo', Domain, Path: '/', Secure: 'TRUE', Expires: expires}));
writeFileSync(join(support, 'sessions.plist'), plistXML(cookies));
run('plutil', ['-convert', 'binary1', join(support, 'sessions.plist')]);

// A clean status bar, then launch.
run('xcrun', ['simctl', 'status_bar', device, 'override', '--time', '9:41', '--batteryState', 'charged', '--batteryLevel', '100', '--wifiBars', '3', '--cellularBars', '4']);
run('xcrun', ['simctl', 'launch', '--terminate-running-process', device, bundleId]);
console.log(`${bundleId} is running on ${device} with the demo batch.`);

function plistXML(records) {
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const value = v => v instanceof Date ? `<date>${v.toISOString().replace(/\.\d+Z$/, 'Z')}</date>` : `<string>${esc(v)}</string>`;
  const dicts = records.map(r => `<dict>${Object.entries(r).map(([k, v]) => `<key>${esc(k)}</key>${value(v)}`).join('')}</dict>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><array>${dicts}</array></plist>`;
}
