import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('Homebridge starts and loads the PVPC platform', { timeout: 90000 }, async () => {
  const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  const fixtureDir = path.join(repoRoot, 'test', 'fixtures', 'hbConfig');
  const mockDataFile = path.join(repoRoot, 'test', 'fixtures', 'mock-pvpc-data.json');
  const runtimeDir = await mkdtemp(path.join(tmpdir(), 'pvpc-homebridge-smoke-'));
  await cp(fixtureDir, runtimeDir, { recursive: true });

  const homebridgeBin = path.join(repoRoot, 'node_modules', '.bin', 'homebridge');
  const configPath = path.join(runtimeDir, 'config.json');
  const configContents = JSON.parse(await readFile(configPath, 'utf8')) as { bridge: { port: number } };
  configContents.bridge.port = 55000 + Math.floor(Math.random() * 5000);
  await writeFile(configPath, JSON.stringify(configContents, null, 2), 'utf8');

  const child = spawn(homebridgeBin, ['-I', '-P', repoRoot, '-U', runtimeDir, '-D'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      TZ: 'Europe/Madrid',
      PVPC_MOCK_DATA_FILE: mockDataFile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  const exitPromise = new Promise<number | null>((resolve) => {
    child.once('exit', resolve);
  });
  const startupResult = await new Promise<'started'>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGINT');
      reject(new Error(`Homebridge smoke test timed out. Output:\n${output}`));
    }, 45000);

    const onData = (chunk: Buffer) => {
      output += chunk.toString();

      if (output.includes('PVPC Smoke') && output.includes('Initializing PVPC Smoke for zone PCB') && output.includes('Using mock PVPC data')) {
        clearTimeout(timer);
        resolve('started');
      }

      if (output.includes('ERROR LOADING PLUGIN') || output.includes('No plugin was found for the platform')) {
        clearTimeout(timer);
        reject(new Error(`Homebridge plugin failed to load. Output:\n${output}`));
      }
    };

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', code => {
      if (!output.includes('Initializing PVPC Smoke for zone PCB')) {
        clearTimeout(timer);
        reject(new Error(`Homebridge exited before plugin startup. Code: ${code}\n${output}`));
      }
    });
  });

  assert.equal(startupResult, 'started');

  child.kill('SIGINT');
  const exitCode = await exitPromise;

  assert.equal(output.includes('ERROR LOADING PLUGIN'), false);
  assert.equal(output.includes('No plugin was found for the platform'), false);
  assert.notEqual(exitCode, 1);
});
