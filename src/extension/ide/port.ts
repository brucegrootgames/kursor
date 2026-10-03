/**
 * Random free-port selection on 127.0.0.1 in the CLI's expected range (10000-65535).
 * Pure Node module (no `vscode` import) so it can be unit-tested.
 */
import * as net from 'node:net';

export const PORT_MIN = 10000;
export const PORT_MAX = 65535;
export const LOOPBACK_HOST = '127.0.0.1';

/** Uniform random port in [PORT_MIN, PORT_MAX]. */
export function randomPort(random: () => number = Math.random): number {
  const span = PORT_MAX - PORT_MIN + 1;
  const r = Math.min(Math.max(random(), 0), 1 - Number.EPSILON);
  return PORT_MIN + Math.floor(r * span);
}

/** Tries to bind a throw-away TCP server to `host:port`; resolves false on any error. */
export function isPortFree(port: number, host: string = LOOPBACK_HOST): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.unref();
    let settled = false;
    const done = (free: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(free);
    };
    probe.once('error', () => done(false));
    probe.once('listening', () => {
      probe.close(() => done(true));
    });
    try {
      probe.listen({ port, host, exclusive: true });
    } catch {
      done(false);
    }
  });
}

export interface FindFreePortOptions {
  /** Maximum random candidates to probe (default 50, like the reference implementation). */
  attempts?: number;
  /** Probe override (tests). */
  isFree?: (port: number) => Promise<boolean>;
  /** RNG override (tests). */
  random?: () => number;
}

export async function findFreePort(options: FindFreePortOptions = {}): Promise<number> {
  const attempts = Math.max(1, options.attempts ?? 50);
  const isFree = options.isFree ?? isPortFree;
  const tried = new Set<number>();
  for (let i = 0; i < attempts; i++) {
    const port = randomPort(options.random);
    if (tried.has(port)) continue;
    tried.add(port);
    if (await isFree(port)) return port;
  }
  throw new Error(`No free port found in ${PORT_MIN}-${PORT_MAX} after ${attempts} attempts`);
}

/** True for IPv4/IPv6 loopback addresses as reported by `socket.remoteAddress`. */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  if (address === '::1') return true;
  const v4 = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
  return v4.startsWith('127.');
}
