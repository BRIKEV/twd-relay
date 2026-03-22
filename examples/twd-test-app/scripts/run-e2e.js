import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_DIR = path.resolve(__dirname, '..');
const CLI_PATH = path.resolve(PROJECT_DIR, '../../dist/cli.js');
const VITE_PORT = 5173;
const VITE_URL = `http://localhost:${VITE_PORT}`;
const POLL_INTERVAL = 500;
const VITE_TIMEOUT = 30_000;
const INIT_WAIT = 5_000;

// --- Helpers ---

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForServer(url, timeout) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await sleep(POLL_INTERVAL);
  }
  throw new Error(`Server at ${url} did not start within ${timeout}ms`);
}

function runCli(args = []) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [CLI_PATH, 'run', ...args], {
      stdio: 'inherit',
      cwd: PROJECT_DIR,
    });

    proc.on('close', (code) => {
      resolve(code);
    });

    proc.on('error', (err) => {
      reject(err);
    });
  });
}

// --- Main ---

let viteProc = null;
let browser = null;
let exitCode = 0;

try {
  // 1. Start Vite dev server
  console.log('Starting Vite dev server...');
  viteProc = spawn('npx', ['vite', '--host', 'localhost'], {
    cwd: PROJECT_DIR,
    stdio: 'pipe',
  });

  viteProc.stdout.on('data', (data) => {
    const line = data.toString().trim();
    if (line) console.log(`[vite] ${line}`);
  });

  viteProc.stderr.on('data', (data) => {
    const line = data.toString().trim();
    if (line) console.error(`[vite] ${line}`);
  });

  // 2. Wait for Vite to be ready
  console.log(`Waiting for Vite at ${VITE_URL}...`);
  await waitForServer(VITE_URL, VITE_TIMEOUT);
  console.log('Vite is ready.');

  // 3. Launch puppeteer and navigate
  console.log('Launching headless browser...');
  browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();
  await page.goto(VITE_URL, { waitUntil: 'networkidle0', timeout: 30_000 });

  // 4. Wait for twd-js to initialize
  console.log(`Waiting ${INIT_WAIT / 1000}s for twd-js to initialize...`);
  await sleep(INIT_WAIT);

  // 5. Pass 1: run all tests
  console.log('\n=== Pass 1: Run all tests ===\n');
  const code1 = await runCli();
  if (code1 !== 0) {
    console.error(`\nPass 1 FAILED (exit code ${code1})`);
    exitCode = 1;
  } else {
    console.log('\nPass 1 PASSED.\n');

    // Need to wait briefly between runs for relay lock to clear
    await sleep(1000);

    // 6. Pass 2: run filtered test
    console.log('=== Pass 2: Run filtered test (--test "clicks the button") ===\n');
    const code2 = await runCli(['--test', 'clicks the button']);
    if (code2 !== 0) {
      console.error(`\nPass 2 FAILED (exit code ${code2})`);
      exitCode = 1;
    } else {
      console.log('\nPass 2 PASSED.\n');
      console.log('All E2E passes succeeded!');
    }
  }

} catch (err) {
  console.error('E2E script error:', err.message);
  exitCode = 1;
} finally {
  // 7. Cleanup
  if (browser) {
    await browser.close().catch(() => {});
  }
  if (viteProc) {
    viteProc.kill('SIGTERM');
  }
}

process.exit(exitCode);
