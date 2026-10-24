#!/usr/bin/env node

import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const patcher = await readFile(
  path.join(root, "port/tools/src/main/java/dev/gaius/tools/Minecraft262BrowserPatcher.java"),
  "utf8",
);
assert.match(
  patcher,
  /patchDownloadQueueBrowserCooperativeExecutor\(jar, root\)/,
  "26.2 patcher must invoke the DownloadQueue patch",
);
assert.match(
  patcher,
  /net\/minecraft\/server\/packs\/DownloadQueue/,
  "patch must target the 26.2 DownloadQueue class",
);
assert.match(
  patcher,
  /call\.name\.equals\("nonCriticalIoPool"\)/,
  "DownloadQueue patch must locate Util.nonCriticalIoPool",
);
assert.match(
  patcher,
  /"dev\/gaius\/browser\/BrowserCooperativeExecutor"[\s\S]{0,180}"defer"/,
  "DownloadQueue executor must be wrapped with BrowserCooperativeExecutor.defer",
);

const classPath = process.argv[2];
let bytecodeVerified = false;
if (classPath) {
  const bytes = await readFile(path.resolve(classPath));
  const text = bytes.toString("latin1");
  assert.match(
    text,
    /BrowserCooperativeExecutor/,
    "patched DownloadQueue.class must reference BrowserCooperativeExecutor",
  );
  assert.match(
    text,
    /nonCriticalIoPool/,
    "patched DownloadQueue.class must retain the nonCriticalIoPool call",
  );
  bytecodeVerified = true;
}

console.log(JSON.stringify({ok: true, sourceVerified: true, bytecodeVerified}));
