import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { measureDownload } from '../speedtest.js';

const script = fileURLToPath(new URL('../speedtest.js', import.meta.url));

async function startServer(t, handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { timeout: 5000 });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('CLI fully reads ten chunked responses sequentially and calculates totals', async (t) => {
  let requests = 0;
  let active = 0;
  let maxActive = 0;
  const url = await startServer(t, (_request, response) => {
    requests += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    response.once('finish', () => { active -= 1; });
    response.write(Buffer.alloc(requests * 1024));
    setTimeout(() => response.end(Buffer.alloc(128)), 30);
  });

  const { code, stdout, stderr } = await runCli([url]);
  assert.equal(code, 0, stderr);
  assert.equal(stderr, '');
  assert.equal(requests, 10);
  assert.equal(maxActive, 1);

  const rows = [...stdout.matchAll(/Запрос (\d+)\/10: ([\d.]+) мс, (\d+) байт/g)];
  assert.equal(rows.length, 10);
  rows.forEach((row, index) => {
    assert.equal(Number(row[1]), index + 1);
    assert.ok(Number(row[2]) >= 20, 'Time must include the delayed response body');
    assert.equal(Number(row[3]), (index + 1) * 1024 + 128);
  });

  const expectedBytes = 55 * 1024 + 10 * 128;
  const totalMs = rows.reduce((sum, row) => sum + Number(row[2]), 0);
  const averageMs = Number(stdout.match(/Среднее время запроса: ([\d.]+)/)[1]);
  const speed = Number(stdout.match(/Скорость скачивания: ([\d.]+)/)[1]);
  assert.match(stdout, new RegExp(`Всего скачано: ${expectedBytes} байт`));
  assert.ok(Math.abs(averageMs - totalMs / 10) <= 0.02);
  assert.ok(Math.abs(speed - expectedBytes / 1024 ** 2 / (totalMs / 1000)) <= 0.01);
});

test('counts compressed body bytes without decompressing', async (t) => {
  const body = gzipSync(Buffer.alloc(100_000, 'a'));
  let acceptEncoding;
  const url = await startServer(t, (request, response) => {
    acceptEncoding = request.headers['accept-encoding'];
    response.writeHead(200, { 'Content-Encoding': 'gzip', 'Content-Length': body.length });
    response.end(body);
  });
  const result = await measureDownload(url);
  assert.equal(acceptEncoding, 'identity');
  assert.equal(result.bytes, body.length);
});

test('follows relative redirects and counts only the final response body', async (t) => {
  const visited = [];
  const url = await startServer(t, (request, response) => {
    visited.push(request.url);
    if (request.url === '/file') {
      response.end('download');
    } else {
      response.writeHead(Number(request.url.slice(1)), { Location: '/file' });
      response.end('redirect body');
    }
  });
  for (const status of [301, 302, 303, 307, 308]) {
    const { bytes } = await measureDownload(`${url}/${status}`);
    assert.equal(bytes, Buffer.byteLength('download'));
  }
  assert.deepEqual(visited, [301, 302, 303, 307, 308].flatMap((status) => [`/${status}`, '/file']));
});

test('rejects redirect loops and redirects without Location', async (t) => {
  let loopRequests = 0;
  const url = await startServer(t, (request, response) => {
    if (request.url === '/loop') {
      loopRequests += 1;
      response.writeHead(302, { Location: '/loop' });
    } else {
      response.writeHead(302);
    }
    response.end();
  });
  await assert.rejects(measureDownload(`${url}/loop`), /лимит перенаправлений/);
  assert.equal(loopRequests, 6);
  await assert.rejects(measureDownload(`${url}/missing`), /без заголовка Location/);
});

test('CLI stops at an HTTP error and omits incomplete final statistics', async (t) => {
  let requests = 0;
  const url = await startServer(t, (_request, response) => {
    requests += 1;
    response.writeHead(requests === 3 ? 404 : 200);
    response.end('body');
  });
  const { code, stdout, stderr } = await runCli([url]);
  assert.equal(code, 1);
  assert.equal(requests, 3);
  assert.match(stderr, /Запрос 3\/10: Сервер вернул HTTP 404/);
  assert.doesNotMatch(stdout, /Среднее время|Всего скачано|Скорость скачивания/);
});

test('rejects a truncated response instead of reporting a partial download', async (t) => {
  const url = await startServer(t, (_request, response) => {
    response.writeHead(200, { 'Content-Length': 1000 });
    response.write('incomplete', () => response.destroy());
  });
  await assert.rejects(
    measureDownload(url, { timeoutMs: 1000 }),
    (error) => !/Превышено время ожидания/.test(error.message),
  );
});

test('timeout covers both waiting for headers and reading the response body', async (t) => {
  const url = await startServer(t, (request, response) => {
    if (request.url === '/body') {
      response.writeHead(200);
      response.write('unfinished');
    }
  });
  for (const path of ['/headers', '/body']) {
    await assert.rejects(measureDownload(`${url}${path}`, { timeoutMs: 50 }), /Превышено время ожидания/);
  }
});

test('handles empty response bodies', async (t) => {
  const url = await startServer(t, (_request, response) => {
    response.writeHead(204);
    response.end();
  });
  const { code, stdout, stderr } = await runCli([url]);
  assert.equal(code, 0, stderr);
  assert.match(stdout, /Всего скачано: 0 байт/);
  assert.match(stdout, /Скорость скачивания: 0\.00 МиБ\/с/);
});

test('validates CLI arguments and provides help', async () => {
  for (const args of [[], ['invalid-url'], ['ftp://example.com/file'], ['http://example.com', 'extra']]) {
    const { code, stdout, stderr } = await runCli(args);
    assert.equal(code, 1);
    assert.equal(stdout, '');
    assert.match(stderr, /Ошибка:/);
  }
  const { code, stdout, stderr } = await runCli(['--help']);
  assert.equal(code, 0);
  assert.match(stdout, /Использование:/);
  assert.equal(stderr, '');
});
