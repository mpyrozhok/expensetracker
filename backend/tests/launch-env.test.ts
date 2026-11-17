import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * The README says: copy `backend/.env.example` to `backend/.env` and fill it in.
 * Nothing else in the runtime makes that true — there is no dotenv, and
 * `config.ts` reads `process.env` — so if the launch command stops passing
 * `--env-file-if-exists`, the file goes back to being decorative: the app starts
 * happily, reads nothing, and every provider quietly stays "not configured".
 * That is a silent failure with a multi-hour debugging session attached, so the
 * contract lives in a test instead of in a README sentence.
 */

const backendPackage = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
) as { scripts: Record<string, string> };

const dockerCmd = readFileSync(fileURLToPath(new URL('../../docker/Dockerfile', import.meta.url)), 'utf8');

const FLAG = '--env-file-if-exists';

const dir = mkdtempSync(join(tmpdir(), 'env-file-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Run node with an env file and print one variable back out. */
function probe(file: string, name: string, shellEnv: Record<string, string> = {}): string {
  const code = `console.log(process.env.${name} ?? 'unset')`;
  return execFileSync(process.execPath, [`--env-file-if-exists=${file}`, '-e', code], {
    encoding: 'utf8',
    env: { ...process.env, ...shellEnv },
  }).trim();
}

describe('launch environment', () => {
  it('loads .env in both the dev and the production launch command', () => {
    // `dev` runs through tsx, which forwards node flags; `start` runs the build.
    // Both must load the file, or the documented setup works in one mode only.
    expect(backendPackage.scripts.dev, 'backend dev script').toContain(FLAG);
    expect(backendPackage.scripts.start, 'backend start script').toContain(FLAG);
  });

  it('loads .env in the container image too', () => {
    expect(dockerCmd, 'Dockerfile CMD').toContain(FLAG);
  });

  it('reads values out of the file into the process environment', () => {
    const file = join(dir, 'loaded.env');
    writeFileSync(file, 'PROBE_FROM_FILE=file-wins-when-unset\n');

    expect(probe(file, 'PROBE_FROM_FILE')).toBe('file-wins-when-unset');
  });

  it('never lets the file overrule a real environment variable', () => {
    // The reason the file is safe to load unconditionally: an inline
    // DATABASE_PATH=…, a CI secret, or `docker run -e` all still win, so nobody
    // has to delete or edit a .env to run the app against something else.
    const file = join(dir, 'overrule.env');
    writeFileSync(file, 'PROBE_PRECEDENCE=from-file\n');

    expect(probe(file, 'PROBE_PRECEDENCE', { PROBE_PRECEDENCE: 'from-shell' })).toBe('from-shell');
  });

  it('starts unchanged when there is no .env at all', () => {
    // Production and CI have no .env; loading must not be a startup failure.
    const missing = join(dir, 'absent.env');

    expect(() => execFileSync(process.execPath, [`--env-file-if-exists=${missing}`, '-e', ''], { stdio: 'ignore' })).not.toThrow();
    expect(probe(missing, 'PROBE_NO_FILE')).toBe('unset');
  });
});
