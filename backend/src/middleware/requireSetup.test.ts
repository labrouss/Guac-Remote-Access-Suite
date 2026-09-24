import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => ({ one: vi.fn() }));
vi.mock('../db', () => ({ db: dbMock }));

import { requireSetupComplete } from './requireSetup';

/**
 * Simulates a request as Express would actually present it when this
 * middleware is invoked from a specific app.use(mountPrefix, ...) call —
 * req.path has the mount prefix STRIPPED, req.originalUrl does not. This
 * distinction is exactly what caused a real bug (see requireSetup.ts's own
 * comment): using req.path here meant /api/setup/status, mounted under
 * app.use('/api/setup', ...), was evaluated with req.path === '/status',
 * incorrectly triggering the "setup not complete" block on the one route
 * whose entire job is reporting that status. These tests exercise all
 * three real mount points from app.ts, not just one, since a bug like
 * this can easily look fixed for the mount you happened to test and still
 * be broken for the others.
 */
function fakeRequest(originalUrl: string, pathAsExpressWouldStripIt: string) {
  return { originalUrl, path: pathAsExpressWouldStripIt } as any;
}

function fakeResponse() {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('requireSetupComplete', () => {
  describe('when setup is NOT complete', () => {
    beforeEach(() => {
      dbMock.one.mockResolvedValue({ setup_completed: false });
    });

    it('allows /api/setup/status through — mounted under app.use("/api/setup", ...), so req.path is stripped to "/status"', async () => {
      const req = fakeRequest('/api/setup/status', '/status');
      const res = fakeResponse();
      const next = vi.fn();

      await requireSetupComplete(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    });

    it('allows /api/setup/admin through the same way', async () => {
      const req = fakeRequest('/api/setup/admin', '/admin');
      const res = fakeResponse();
      const next = vi.fn();

      await requireSetupComplete(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
    });

    it('blocks a normal /api/* route with 423, mounted under app.use("/api", ...), req.path stripped to "/admin/users"', async () => {
      const req = fakeRequest('/api/admin/users', '/admin/users');
      const res = fakeResponse();
      const next = vi.fn();

      await requireSetupComplete(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(423);
      expect(res.json).toHaveBeenCalledWith({ error: 'setup_required', redirect: '/setup' });
    });

    it('blocks /proxy/* routes too, mounted under app.use("/proxy", ...), req.path stripped to "/some-bookmark-id"', async () => {
      const req = fakeRequest('/proxy/some-bookmark-id', '/some-bookmark-id');
      const res = fakeResponse();
      const next = vi.fn();

      await requireSetupComplete(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(423);
    });

    it('ignores a query string when checking the path prefix', async () => {
      const req = fakeRequest('/api/setup/status?foo=bar', '/status?foo=bar');
      const res = fakeResponse();
      const next = vi.fn();

      await requireSetupComplete(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
    });
  });

  describe('when setup IS complete', () => {
    beforeEach(() => {
      dbMock.one.mockResolvedValue({ setup_completed: true });
    });

    it('EXEMPTS /api/setup/status from the 410 block — this is the one route that must stay reachable forever', async () => {
      const req = fakeRequest('/api/setup/status', '/status');
      const res = fakeResponse();
      const next = vi.fn();

      await requireSetupComplete(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    });

    it('still blocks every OTHER /api/setup/* route with 410, mounted under app.use("/api/setup", ...)', async () => {
      const req = fakeRequest('/api/setup/admin', '/admin');
      const res = fakeResponse();
      const next = vi.fn();

      await requireSetupComplete(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(410);
      expect(res.json).toHaveBeenCalledWith({ error: 'setup_already_completed' });
    });

    it('the /api/setup/status exemption ignores a query string too', async () => {
      const req = fakeRequest('/api/setup/status?foo=bar', '/status?foo=bar');
      const res = fakeResponse();
      const next = vi.fn();

      await requireSetupComplete(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    });

    it('allows a normal /api/* route through', async () => {
      const req = fakeRequest('/api/admin/users', '/admin/users');
      const res = fakeResponse();
      const next = vi.fn();

      await requireSetupComplete(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    });

    it('allows /proxy/* routes through', async () => {
      const req = fakeRequest('/proxy/some-bookmark-id', '/some-bookmark-id');
      const res = fakeResponse();
      const next = vi.fn();

      await requireSetupComplete(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
    });
  });
});
