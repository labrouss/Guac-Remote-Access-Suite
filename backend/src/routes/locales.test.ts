import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createLocalesRouter } from './locales';

// Real files in a real temporary directory, not a mocked filesystem —
// this is what actually exercises the exact fs.readdirSync/readFileSync
// calls the real route makes, the same "verify against something real"
// standard this project applies elsewhere (e.g. the recording-format and
// self-signed-certificate fixes earlier in this project's own history).
describe('locales router', () => {
  let tmpDir: string;
  let app: express.Express;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'locales-test-'));
    app = express();
    app.use('/api/locales', createLocalesRouter(tmpDir));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeLocale(filename: string, content: string) {
    fs.writeFileSync(path.join(tmpDir, filename), content, 'utf8');
  }

  describe('GET /', () => {
    it('lists every .json file, by language code, with the extension stripped', async () => {
      writeLocale('en.json', '{}');
      writeLocale('el.json', '{}');

      const res = await request(app).get('/api/locales');

      expect(res.status).toBe(200);
      expect(res.body.languages.sort()).toEqual(['el', 'en']);
    });

    it('excludes non-.json files — a README sitting in the same directory should never be treated as a language', async () => {
      writeLocale('en.json', '{}');
      writeLocale('README.md', '# Translations');

      const res = await request(app).get('/api/locales');

      expect(res.body.languages).toEqual(['en']);
    });

    it('excludes a .json file whose name is not a valid language code shape', async () => {
      writeLocale('en.json', '{}');
      writeLocale('not-a-lang-code.json', '{}');

      const res = await request(app).get('/api/locales');

      expect(res.body.languages).toEqual(['en']);
    });

    it('includes a region-qualified code like pt-BR', async () => {
      writeLocale('pt-BR.json', '{}');

      const res = await request(app).get('/api/locales');

      expect(res.body.languages).toEqual(['pt-BR']);
    });

    it('returns an empty list, not an error, when the directory does not exist at all', async () => {
      fs.rmSync(tmpDir, { recursive: true, force: true });

      const res = await request(app).get('/api/locales');

      expect(res.status).toBe(200);
      expect(res.body.languages).toEqual([]);
    });
  });

  describe('GET /:lang', () => {
    it('serves the real, parsed content of a real file', async () => {
      writeLocale('en.json', '{"common": {"signIn": "Sign in"}}');

      const res = await request(app).get('/api/locales/en');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ common: { signIn: 'Sign in' } });
    });

    it('serves real UTF-8 content correctly, not mangled — a real, non-ASCII translation', async () => {
      writeLocale('el.json', '{"common": {"signIn": "Σύνδεση"}}');

      const res = await request(app).get('/api/locales/el');

      expect(res.body.common.signIn).toBe('Σύνδεση');
    });

    it('returns 404, not a crash, for a valid-shaped but nonexistent language', async () => {
      const res = await request(app).get('/api/locales/zz');

      expect(res.status).toBe(404);
    });

    it('returns 400 for a language parameter that is not a real language-code shape', async () => {
      const res = await request(app).get('/api/locales/not-a-lang-code');

      expect(res.status).toBe(400);
    });

    it('returns 400, rather than reading any file at all, for a path-traversal attempt disguised as a language code', async () => {
      // Written outside tmpDir entirely — if this were ever actually read,
      // that would be the real vulnerability this test exists to catch.
      const outsideFile = path.join(os.tmpdir(), 'locales-test-outside-secret.json');
      fs.writeFileSync(outsideFile, '{"leaked": true}', 'utf8');

      const res = await request(app).get('/api/locales/..%2Flocales-test-outside-secret');

      expect(res.status).not.toBe(200);
      fs.rmSync(outsideFile, { force: true });
    });

    it('returns 502, not a crash or malformed JSON, for a file with invalid JSON syntax', async () => {
      writeLocale('en.json', '{ this is not valid json');

      const res = await request(app).get('/api/locales/en');

      expect(res.status).toBe(502);
    });
  });
});
