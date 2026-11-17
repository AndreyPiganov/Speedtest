import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const REQUEST_COUNT = 10;
const MEBIBYTE = 1024 ** 2;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const USAGE = 'Использование: node speedtest.js <http(s)://адрес>';

function parseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Укажите корректный URL с протоколом http:// или https://.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Поддерживаются только протоколы HTTP и HTTPS.');
  }
  return url;
}

function getResponse(url, signal) {
  const get = url.protocol === 'https:' ? httpsGet : httpGet;
  return new Promise((resolve, reject) => {
    get(url, {
      // Закрываем соединение после ответа, не оставляя его в общем keep-alive-пуле.
      agent: false,
      signal,
      headers: { 'Accept-Encoding': 'identity' },
    }, resolve).once('error', reject);
  });
}

export async function measureDownload(address, { timeoutMs = 60_000 } = {}) {
  let url = parseUrl(address);
  const controller = new AbortController();
  const startedAt = performance.now();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    for (let redirects = 0; ; redirects += 1) {
      const response = await getResponse(url, controller.signal);
      try {
        const isRedirect = REDIRECT_STATUSES.has(response.statusCode);
        if (isRedirect && redirects >= 5) {
          throw new Error('Превышен лимит перенаправлений (5).');
        }
        if (isRedirect && !response.headers.location) {
          throw new Error('Сервер вернул перенаправление без заголовка Location.');
        }
        if (!isRedirect && (response.statusCode < 200 || response.statusCode >= 300)) {
          throw new Error(`Сервер вернул HTTP ${response.statusCode}.`);
        }

        let bytes = 0;
        for await (const chunk of response) {
          bytes += chunk.length;
        }

        if (isRedirect) {
          url = parseUrl(new URL(response.headers.location, url));
          continue;
        }
        return { bytes, durationMs: performance.now() - startedAt };
      } finally {
        response.destroy();
      }
    }
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Превышено время ожидания (${timeoutMs / 1000} с).`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function main(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log(USAGE);
    return;
  }
  if (args.length !== 1) {
    throw new Error(USAGE);
  }
  const url = parseUrl(args[0]);
  let totalBytes = 0;
  let totalDurationMs = 0;

  for (let index = 1; index <= REQUEST_COUNT; index += 1) {
    let result;
    try {
      result = await measureDownload(url);
    } catch (error) {
      throw new Error(`Запрос ${index}/${REQUEST_COUNT}: ${error.message}`);
    }
    totalBytes += result.bytes;
    totalDurationMs += result.durationMs;
    console.log(`Запрос ${index}/${REQUEST_COUNT}: ${result.durationMs.toFixed(2)} мс, ${result.bytes} байт`);
  }

  const averageMs = totalDurationMs / REQUEST_COUNT;
  const speedMiBs = totalBytes / MEBIBYTE / (totalDurationMs / 1000);
  console.log(`\nСреднее время запроса: ${averageMs.toFixed(2)} мс`);
  console.log(`Всего скачано: ${totalBytes} байт (${(totalBytes / MEBIBYTE).toFixed(2)} МиБ)`);
  console.log(`Скорость скачивания: ${speedMiBs.toFixed(2)} МиБ/с`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`Ошибка: ${error.message}`);
    process.exitCode = 1;
  });
}
