import { execFile } from 'child_process';
import { createServer, IncomingMessage, Server } from 'http';
import { AddressInfo } from 'net';
import { join } from 'path';

/**
 * 실제 사전 로드 경로를 별도 프로세스에서 띄워 OTLP 로 무엇이 나가는지 수집한다.
 * (같은 Jest 프로세스에서는 http 가 이미 로드돼 있어 계측 순서를 검증할 수 없다.)
 */
const CHILD_SCRIPT = `
const { shutdownTelemetry } = require('./src/instrumentation');
const http = require('http');
const { logs } = require('@opentelemetry/api-logs');
http.get(process.env.TARGET + '/probe?token=supersecret&imageIds=1', (res) => {
  res.resume();
  res.on('end', async () => {
    logs.getLogger('t').emit({ body: 'log-body' });
    await shutdownTelemetry();
  });
});
`;

interface Received {
  path: string;
  body: string;
}

function runChild(env: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ['-r', 'ts-node/register/transpile-only', '-e', CHILD_SCRIPT],
      {
        cwd: join(__dirname, '..'),
        env: { ...process.env, ...env },
        timeout: 20000,
      },
      (error, _stdout, stderr) =>
        error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve(),
    );
  });
}

describe('instrumentation preload', () => {
  let collector: Server;
  let received: Received[];
  let baseUrl: string;

  beforeAll(async () => {
    collector = createServer((req: IncomingMessage, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        received.push({ path: req.url ?? '', body });
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
      });
    });
    await new Promise<void>((r) => collector.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${(collector.address() as AddressInfo).port}`;
  });

  beforeEach(() => (received = []));

  afterAll(() => new Promise<void>((r) => collector.close(() => r())));

  const baseEnv = () => ({
    TARGET: baseUrl,
    OTEL_EXPORTER_OTLP_ENDPOINT: baseUrl,
    // SDK 기본값이라면 메트릭/로그 exporter 를 켜는 설정. 코드가 이를 무시해야 한다.
    OTEL_METRICS_EXPORTER: 'otlp',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_TRACES_SAMPLER_ARG: '1',
    OTEL_SDK_DISABLED: 'false',
  });

  it('트레이스만 OTLP 로 내보내고 메트릭·로그 exporter 는 env 로도 켜지지 않는다', async () => {
    await runChild(baseEnv());

    const paths = received.map((r) => r.path);
    expect(paths).toContain('/v1/traces');
    expect(paths).not.toContain('/v1/metrics');
    expect(paths).not.toContain('/v1/logs');
  }, 30000);

  it('http 를 사전 로드 이후에 불러와도 계측되고, span 에 URL 쿼리 값이 남지 않는다', async () => {
    await runChild(baseEnv());

    const traces = received.filter((r) => r.path === '/v1/traces');
    const exported = traces.map((r) => r.body).join('\n');
    expect(exported).toContain('"gwangsan-chat"');
    expect(exported).toContain('deployment.environment.name');
    expect(exported).toContain('/probe');
    expect(exported).not.toContain('supersecret');
    expect(exported).not.toContain('token=');
  }, 30000);

  it('OTEL_SDK_DISABLED=true 이면 아무것도 내보내지 않는다(롤백)', async () => {
    await runChild({ ...baseEnv(), OTEL_SDK_DISABLED: 'true' });

    expect(received.map((r) => r.path)).toEqual([
      '/probe?token=supersecret&imageIds=1',
    ]);
  }, 30000);
});
