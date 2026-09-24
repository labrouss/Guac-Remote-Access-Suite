import { describe, it, expect, afterEach } from 'vitest';
import net from 'net';
import { testTcpReachability } from './connections';

/**
 * Tests against a genuinely real TCP server/closed port, not a mocked
 * `net.Socket` — this function's entire job is reporting real network
 * behavior accurately, so a mock that just asserts "the right methods
 * were called" wouldn't actually prove it works, matching this project's
 * established preference for testing against reality where practical
 * (the same reasoning already used for the JWT/crypto and connection
 * tests elsewhere in this codebase).
 */
describe('testTcpReachability', () => {
  let server: net.Server | null = null;

  afterEach(() => {
    server?.close();
    server = null;
  });

  it('reports reachable for a real, listening TCP server', async () => {
    server = net.createServer();
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;

    const result = await testTcpReachability('127.0.0.1', port);

    expect(result.reachable).toBe(true);
  });

  it('reports not reachable for a genuinely closed port', async () => {
    // Bind a server, grab its port, then immediately close it — the OS
    // won't have anything listening there anymore, giving a real
    // "connection refused" rather than a hypothetical one.
    const probe = net.createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = (probe.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const result = await testTcpReachability('127.0.0.1', port);

    expect(result.reachable).toBe(false);
    expect(result.message.length).toBeGreaterThan(0);
  });

  it('reports not reachable for a hostname that cannot resolve at all', async () => {
    const result = await testTcpReachability('this-host-genuinely-does-not-exist.invalid', 12345);

    expect(result.reachable).toBe(false);
    expect(result.message.length).toBeGreaterThan(0);
  });
});
