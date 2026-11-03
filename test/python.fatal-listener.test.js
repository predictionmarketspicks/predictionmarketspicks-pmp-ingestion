// P0-D (site repo handoffs/ENGINE_OUTAGE_ALARMS_AND_OPEN_FIXES_2026-11-03.md): a
// FATAL program must take supervisord down so Fly restarts the machine, and the
// config must wire it. The listener SIGKILLs its PARENT, so it runs under a
// throwaway `sh` here — never directly under the test process.
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const LISTENER = fileURLToPath(new URL('../python/fatal_listener.py', import.meta.url));
const CONF = readFileSync(fileURLToPath(new URL('../python/supervisord.conf', import.meta.url)), 'utf8');

function event(name, payload) {
  return `ver:3.0 server:supervisor serial:1 pool:fatal-exit poolserial:1 eventname:${name} len:${Buffer.byteLength(payload)}\n${payload}`;
}

function runUnderSh(input) {
  return new Promise((resolve) => {
    const sh = spawn('sh', ['-c', `python3 "${LISTENER}"; sleep 5`], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    sh.stdout.on('data', (d) => { out += d; });
    sh.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => sh.kill('SIGTERM'), 3000);
    sh.on('exit', (code, signal) => { clearTimeout(t); resolve({ code, signal, out, err }); });
    sh.stdin.write(input);
  });
}

describe('fatal_listener.py', () => {
  it('SIGKILLs its parent on PROCESS_STATE_FATAL', async () => {
    const r = await runUnderSh(event('PROCESS_STATE_FATAL', 'processname:databento-sidecar groupname:databento-sidecar from_state:BACKOFF'));
    expect(r.signal).toBe('SIGKILL');
    expect(r.err).toMatch(/databento-sidecar is FATAL/);
  });

  it('acks any other event and leaves the parent alone', async () => {
    const r = await runUnderSh(event('PROCESS_STATE_RUNNING', 'processname:node-engine groupname:node-engine from_state:STARTING pid:1'));
    expect(r.signal).toBe('SIGTERM'); // only our timeout ended it
    expect(r.out).toContain('RESULT 2\nOK');
  });
});

describe('supervisord.conf', () => {
  it('wires the listener to PROCESS_STATE_FATAL and gives both programs startsecs', () => {
    expect(CONF).toMatch(/\[eventlistener:fatal-exit\][\s\S]*command=python3 python\/fatal_listener\.py[\s\S]*events=PROCESS_STATE_FATAL/);
    expect(CONF.match(/^startsecs=10$/gm)?.length).toBe(2);
    expect(CONF).not.toMatch(/the container exits if either is unrecoverable/);
  });
});
