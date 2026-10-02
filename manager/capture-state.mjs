import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';

const profileDir = process.argv[2];
const output = process.argv[3];
if (!profileDir || !output) process.exit(2);

const context = await chromium.launchPersistentContext(profileDir, {
  channel: 'chrome',
  headless: true,
  viewport: { width: 1280, height: 800 },
});
try {
  await context.storageState({ path: output, indexedDB: true });
  fs.chmodSync(output, 0o600);
  console.log(JSON.stringify({ status: 'completed', output }));
} finally {
  await context.close();
}
