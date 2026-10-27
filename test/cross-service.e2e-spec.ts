/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- Tempo/OTLP/Prometheus 응답은 형식 없는 JSON 이다. */
import { io, Socket } from 'socket.io-client';
import * as jwt from 'jsonwebtoken';
import Redis from 'ioredis';
import * as fs from 'fs';
import * as path from 'path';
import * as request from 'supertest';
import { execFileSync } from 'child_process';
import { randomBytes } from 'crypto';
import {
  GenericContainer,
  StartedTestContainer,
  StartedNetwork,
  Wait,
  Network,
} from 'testcontainers';

/*
 * 실제 런타임 그대로 띄운 교차 서비스 관측성 검증.
 * Socket.IO(Node 22 컨테이너, preload 엔트리포인트) → Redis Stream → Spring(OTel Java agent)
 * → MariaDB 커밋, 그리고 Alloy(테스트 config) → Tempo 3.1.1 로 내보낸 실제 span 을 조회한다.
 * traceparent 필드만 보고 span 연결을 주장하지 않는다. 모든 백엔드는 합성·격리 컨테이너다.
 */

const JWT_SECRET = 'cross-service-test-secret-at-least-32-bytes';
const API_DIR =
  process.env.API_DIR ??
  path.resolve(
    __dirname,
    '../../../Gwangsan-Server/obs-integration_api-20261027',
  );
const SPRING_JAR =
  process.env.SPRING_JAR_PATH ??
  path.join(API_DIR, 'build/libs/gwangsan-0.0.1-SNAPSHOT.jar');
const OTEL_AGENT = process.env.OTEL_JAVAAGENT_PATH ?? '';
const CHAT_DIR = process.env.CHAT_DIR ?? path.resolve(__dirname, '..');
const CHAT_CMD = (
  process.env.CHAT_CMD ??
  'node --require ./dist/src/instrumentation.js dist/src/main.js'
).split(' ');
const MONITORING_DIR = path.join(API_DIR, 'deploy/monitoring');
const EVIDENCE_DIR =
  process.env.E2E_EVIDENCE_DIR ??
  path.join(
    API_DIR,
    '.omo/evidence',
    `cross-service-${new Date().toISOString().replace(/[:.]/g, '-')}`,
  );
const GROUP = 'chat-message-persistors';
const RETRY_MAX = 5; // application-test.yml chat.stream.retryMax
const DLQ_KEY = 'chat:dlq:messages';
const RUN = randomBytes(4).toString('hex');

type Span = {
  service: string;
  name: string;
  kind: string;
  traceId: string;
  spanId: string;
  parentSpanId: string;
  status: string;
  startNs: bigint;
  endNs: bigint;
  links: { traceId: string; spanId: string }[];
  raw: unknown;
};

const evidence: Record<string, unknown> = { run: RUN, cases: {} };
const secrets = new Set<string>(); // 로그·span 어디에도 나오면 안 되는 값

function sh(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8' }).trim();
}

function hostPort(c: StartedTestContainer, port: number): number {
  // docker start 후 임시 포트가 바뀔 수 있어 매번 조회한다.
  const out = sh(['port', c.getId(), `${port}/tcp`]).split('\n')[0];
  return Number(out.slice(out.lastIndexOf(':') + 1));
}

function hex(id: unknown): string {
  if (typeof id !== 'string' || id === '') return '';
  return /^[0-9a-f]+$/.test(id) && (id.length === 32 || id.length === 16)
    ? id
    : Buffer.from(id, 'base64').toString('hex');
}

function kindOf(k: unknown): string {
  const names = [
    'UNSPECIFIED',
    'INTERNAL',
    'SERVER',
    'CLIENT',
    'PRODUCER',
    'CONSUMER',
  ];
  if (typeof k === 'number') return names[k] ?? String(k);
  return (typeof k === 'string' ? k : '').replace('SPAN_KIND_', '');
}

function flatten(json: any): Span[] {
  const rs =
    json?.trace?.resourceSpans ?? json?.resourceSpans ?? json?.batches ?? [];
  const spans: Span[] = [];
  for (const r of rs) {
    const service =
      r.resource?.attributes?.find((a: any) => a.key === 'service.name')?.value
        ?.stringValue ?? '';
    for (const ss of r.scopeSpans ?? r.instrumentationLibrarySpans ?? []) {
      for (const s of ss.spans ?? []) {
        spans.push({
          service,
          name: s.name,
          kind: kindOf(s.kind),
          traceId: hex(s.traceId),
          spanId: hex(s.spanId),
          parentSpanId: hex(s.parentSpanId),
          status: String(s.status?.code ?? ''),
          startNs: BigInt(s.startTimeUnixNano ?? 0),
          endNs: BigInt(s.endTimeUnixNano ?? 0),
          links: (s.links ?? []).map((l: any) => ({
            traceId: hex(l.traceId),
            spanId: hex(l.spanId),
          })),
          raw: s,
        });
      }
    }
  }
  return spans;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function until<T>(
  what: string,
  fn: () => Promise<T | undefined>,
  timeoutMs: number,
  intervalMs = 250,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v !== undefined) return v;
    } catch (e) {
      last = e;
    }
    await sleep(intervalMs);
  }
  throw new Error(
    `timeout waiting for ${what}${last instanceof Error ? `: ${last.message}` : ''}`,
  );
}

function parseTraceparent(tp: string | undefined) {
  const m = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/.exec(tp ?? '');
  return m ? { traceId: m[1], spanId: m[2] } : undefined;
}

/** Prometheus text 에서 이름·라벨 조건이 맞는 시계열 합. 시계열이 하나도 없으면 undefined. */
function metric(
  text: string,
  name: string,
  labels: Record<string, string> = {},
): number | undefined {
  let sum: number | undefined;
  for (const line of text.split('\n')) {
    if (line.startsWith('#')) continue;
    const m = /^([a-zA-Z_:][\w:]*)(\{([^}]*)\})?\s+(\S+)/.exec(line);
    if (!m || m[1] !== name) continue;
    const ls = Object.fromEntries(
      [...(m[3] ?? '').matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)].map((x) => [
        x[1],
        x[2],
      ]),
    );
    if (Object.entries(labels).some(([k, v]) => ls[k] !== v)) continue;
    sum = (sum ?? 0) + Number(m[4]);
  }
  return sum;
}

describe('Cross-Service observability E2E (Socket.IO → Redis Stream → Spring → MariaDB, Tempo)', () => {
  let network: StartedNetwork;
  let redisC: StartedTestContainer;
  let mariadbC: StartedTestContainer;
  let tempoC: StartedTestContainer;
  let alloyC: StartedTestContainer;
  let apiC: StartedTestContainer;
  let chatC: StartedTestContainer;
  let redis: Redis;
  const sockets: Socket[] = [];

  const tempoUrl = () => `http://127.0.0.1:${hostPort(tempoC, 3200)}`;
  const springUrl = () => `http://127.0.0.1:${hostPort(apiC, 8080)}`;
  const apiMetrics = async () =>
    (
      await fetch(
        `http://127.0.0.1:${hostPort(apiC, 9091)}/actuator/prometheus`,
      )
    ).text();
  const chatMetrics = async () =>
    (await fetch(`http://127.0.0.1:${hostPort(chatC, 9464)}/metrics`)).text();

  async function sql(query: string): Promise<string> {
    const r = await mariadbC.exec([
      'mariadb',
      '-uroot',
      '-ppassword',
      'gwangsan_db',
      '-N',
      '-B',
      '-e',
      query,
    ]);
    if (r.exitCode !== 0) throw new Error(r.output);
    return r.stdout.trim();
  }

  const rowCount = async (messageId: string) =>
    Number(
      await sql(
        `SELECT COUNT(*) FROM tbl_chat_message WHERE message_id=${messageId}`,
      ),
    );

  async function waitRow(messageId: string, timeoutMs = 20000) {
    return until(
      `row ${messageId}`,
      async () => ((await rowCount(messageId)) === 1 ? true : undefined),
      timeoutMs,
    );
  }

  async function streamRecord(roomId: number, messageId: string) {
    const entries = (await redis.xrange(
      `chat:room:${roomId}:messages`,
      '-',
      '+',
    )) as [string, string[]][];
    for (const [id, kv] of entries) {
      const f: Record<string, string> = {};
      for (let i = 0; i < kv.length; i += 2) f[kv[i]] = kv[i + 1];
      if (f.messageId === messageId) return { id, fields: f };
    }
    return undefined;
  }

  async function pendingIds(roomId: number): Promise<string[]> {
    const p = (await redis.xpending(
      `chat:room:${roomId}:messages`,
      GROUP,
      '-',
      '+',
      100,
    )) as [string][];
    return p.map((x) => x[0]);
  }

  async function trace(
    traceId: string,
    ready: (s: Span[]) => boolean,
    timeoutMs = 30000,
  ): Promise<Span[]> {
    let lastSpans: Span[] = [];
    try {
      return await until(
        `trace ${traceId}`,
        async () => {
          const r = await fetch(`${tempoUrl()}/api/v2/traces/${traceId}`);
          if (!r.ok) return undefined;
          const body = await r.text();
          lastSpans = flatten(JSON.parse(body));
          if (!ready(lastSpans)) return undefined;
          fs.mkdirSync(path.join(EVIDENCE_DIR, 'traces'), { recursive: true });
          fs.writeFileSync(
            path.join(EVIDENCE_DIR, 'traces', `${traceId}.json`),
            body,
          );
          return lastSpans;
        },
        timeoutMs,
        1000,
      );
    } catch (e) {
      throw new Error(
        `${String(e)}; spans seen=${JSON.stringify(lastSpans.map((s) => [s.service, s.kind, s.name, s.parentSpanId]))}`,
      );
    }
  }

  const consumerSpans = (spans: Span[]) =>
    spans.filter((s) => s.service === 'gwangsan-api' && s.kind === 'CONSUMER');

  function descendants(spans: Span[], root: Span): Span[] {
    const out: Span[] = [];
    const queue = [root.spanId];
    while (queue.length) {
      const id = queue.shift();
      for (const s of spans.filter((x) => x.parentSpanId === id)) {
        out.push(s);
        queue.push(s.spanId);
      }
    }
    return out;
  }

  const isInsertIntoMessages = (s: Span) =>
    /insert/i.test(s.name) ||
    /insert\s+into\s+tbl_chat_message/i.test(JSON.stringify(s.raw));

  function makeToken(sub: string): string {
    const t = jwt.sign({ sub }, JWT_SECRET, { expiresIn: '1h' });
    secrets.add(t);
    secrets.add(sub);
    return t;
  }

  async function connect(sub: string, memberId: number): Promise<Socket> {
    await redis.set(
      `auth:cache:${sub}`,
      JSON.stringify({ memberId, nickname: `n${memberId}` }),
      'EX',
      3600,
    );
    const token = makeToken(sub);
    const socket = await new Promise<Socket>((resolve, reject) => {
      const s = io(`http://127.0.0.1:${hostPort(chatC, 3000)}/api/chat`, {
        auth: { token: `Bearer ${token}` },
        transports: ['websocket'],
        reconnection: false,
      });
      const timer = setTimeout(
        () => reject(new Error('connect timeout')),
        10000,
      );
      s.on('connect', () => (clearTimeout(timer), resolve(s)));
      s.on('connect_error', (err) => (clearTimeout(timer), reject(err)));
    });
    sockets.push(socket);
    return socket;
  }

  /** 여러 메시지를 한꺼번에 emit 하고 content 로 echo 를 짝짓는다. 반환: content→{messageId, echoMs}. */
  function sendBurst(
    socket: Socket,
    roomId: number,
    contents: string[],
    extra: Record<string, unknown> = {},
  ): Promise<Map<string, { messageId: string; echoMs: number; payload: any }>> {
    const started = new Map<string, number>();
    const got = new Map<
      string,
      { messageId: string; echoMs: number; payload: any }
    >();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => (
          cleanup(),
          reject(new Error(`echo timeout ${got.size}/${contents.length}`))
        ),
        10000,
      );
      const onMsg = (v: any) => {
        if (!v?.isMine || !started.has(v.content ?? '')) return;
        const key = v.content ?? '';
        got.set(key, {
          messageId: String(v.messageId),
          echoMs: Date.now() - started.get(key)!,
          payload: v,
        });
        if (got.size === contents.length) {
          cleanup();
          resolve(got);
        }
      };
      const onErr = (e: unknown) => (
        cleanup(),
        reject(new Error(`socket error ${JSON.stringify(e)}`))
      );
      const cleanup = () => {
        clearTimeout(timer);
        socket.off('receiveMessage', onMsg);
        socket.off('error', onErr);
      };
      socket.on('receiveMessage', onMsg);
      socket.on('error', onErr);
      for (const content of contents) {
        started.set(content, Date.now());
        socket.emit('sendMessage', {
          roomId,
          content,
          imageIds: [],
          messageType: 'TEXT',
          ...extra,
        });
      }
    });
  }

  const canary = (tag: string) => {
    const c = `canary-${tag}-${RUN}-${randomBytes(3).toString('hex')}`;
    secrets.add(c);
    return c;
  };

  const traceparent = () => {
    const t = randomBytes(16).toString('hex');
    const s = randomBytes(8).toString('hex');
    return { traceId: t, spanId: s, value: `00-${t}-${s}-01` };
  };

  async function xaddSynthetic(
    roomId: number,
    senderId: number,
    content: string,
    extra: Record<string, string> = {},
  ) {
    const messageId = String(
      BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000)),
    );
    const fields: Record<string, string> = {
      messageId,
      roomId: String(roomId),
      senderId: String(senderId),
      content,
      messageType: 'TEXT',
      imageIds: '[]',
      createdAt: String(Date.now()),
      ...extra,
    };
    await redis.xadd(
      `chat:room:${roomId}:messages`,
      '*',
      ...Object.entries(fields).flat(),
    );
    return messageId;
  }

  function jsonLogs(c: StartedTestContainer): any[] {
    return execFileSync('sh', ['-c', `docker logs ${c.getId()} 2>&1`], {
      encoding: 'utf8',
      maxBuffer: 64 << 20,
    })
      .split('\n')
      .flatMap((l) => {
        try {
          const v = JSON.parse(l);
          return v && typeof v === 'object' ? [v] : [];
        } catch {
          return [];
        }
      });
  }

  const allLogs = (c: StartedTestContainer) =>
    execFileSync('sh', ['-c', `docker logs ${c.getId()} 2>&1`], {
      encoding: 'utf8',
      maxBuffer: 64 << 20,
    });

  function record(name: string, data: Record<string, unknown>) {
    (evidence.cases as Record<string, unknown>)[name] = data;
  }

  async function waitApiReady() {
    await until(
      'spring health',
      async () => {
        const r = await fetch(
          `http://127.0.0.1:${hostPort(apiC, 9091)}/actuator/health`,
        );
        return r.ok ? true : undefined;
      },
      180000,
      1000,
    );
  }

  beforeAll(async () => {
    if (!OTEL_AGENT || !fs.existsSync(OTEL_AGENT))
      throw new Error(
        'OTEL_JAVAAGENT_PATH must point to the pinned OpenTelemetry Java agent jar',
      );
    if (!fs.existsSync(SPRING_JAR))
      throw new Error(`missing SPRING_JAR_PATH ${SPRING_JAR}`);
    if (!fs.existsSync(path.join(CHAT_DIR, 'dist/src/main.js')))
      throw new Error('chat dist missing: run npm run build');
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

    network = await new Network().start();
    [redisC, mariadbC, tempoC] = await Promise.all([
      new GenericContainer('redis:7-alpine')
        .withNetwork(network)
        .withNetworkAliases('redis')
        .withExposedPorts(6379)
        .start(),
      new GenericContainer('mariadb:11')
        .withNetwork(network)
        .withNetworkAliases('mariadb')
        .withEnvironment({
          MYSQL_ROOT_PASSWORD: 'password',
          MYSQL_DATABASE: 'gwangsan_db',
        })
        .withExposedPorts(3306)
        .withWaitStrategy(Wait.forLogMessage(/ready for connections/, 2))
        .start(),
      new GenericContainer('grafana/tempo:3.1.1')
        .withNetwork(network)
        .withNetworkAliases('tempo')
        .withBindMounts([
          {
            source: path.join(MONITORING_DIR, 'tempo.yml'),
            target: '/etc/tempo/tempo.yml',
            mode: 'ro',
          },
        ])
        .withCommand(['-config.file=/etc/tempo/tempo.yml', '-target=all'])
        .withExposedPorts(3200)
        .withWaitStrategy(
          Wait.forHttp('/ready', 3200).withStartupTimeout(120000),
        )
        .start(),
    ]);
    alloyC = await new GenericContainer('grafana/alloy:v1.21.2')
      .withNetwork(network)
      .withNetworkAliases('alloy')
      .withEnvironment({ TEMPO_TUNNEL_ENDPOINT: 'http://tempo:4318' })
      .withBindMounts([
        {
          source: path.join(MONITORING_DIR, 'tests/alloy-test.alloy'),
          target: '/etc/alloy/config.alloy',
          mode: 'ro',
        },
      ])
      .withCommand(['run', '/etc/alloy/config.alloy'])
      .withExposedPorts(4318)
      .start();

    apiC = await new GenericContainer('eclipse-temurin:21-jre-alpine')
      .withNetwork(network)
      .withNetworkAliases('api')
      .withBindMounts([
        { source: SPRING_JAR, target: '/app/app.jar', mode: 'ro' },
        {
          source: OTEL_AGENT,
          target: '/app/opentelemetry-javaagent.jar',
          mode: 'ro',
        },
      ])
      .withCommand([
        'java',
        '-javaagent:/app/opentelemetry-javaagent.jar',
        '-jar',
        '/app/app.jar',
      ])
      .withEnvironment({
        SPRING_PROFILES_ACTIVE: 'test',
        REDIS_HOST: 'redis',
        REDIS_PORT: '6379',
        JWT_ACCESS_SECRET: JWT_SECRET,
        RDB_HOST: 'mariadb',
        RDB_PORT: '3306',
        RDB_SCHEMA: 'gwangsan_db',
        DB_USER: 'root',
        DB_PASSWORD: 'password',
        INSTANCE_ID: 'api-e2e',
        MANAGEMENT_SERVER_PORT: '9091', // test 프로필의 port 0 을 고정 포트로 덮는다
        // test 프로필의 ddl-auto=create 는 재기동 때 스키마를 지운다. kill/restart 시나리오용으로 유지한다.
        SPRING_JPA_HIBERNATE_DDL_AUTO: 'update',
        CHAT_STREAM_CLAIMIDLEMS: '3000',
        // Dockerfile 과 같은 trace-only 설정. 테스트만 100% 샘플링·짧은 배치 지연.
        OTEL_SERVICE_NAME: 'gwangsan-api',
        OTEL_RESOURCE_ATTRIBUTES: 'deployment.environment.name=test',
        OTEL_TRACES_EXPORTER: 'otlp',
        OTEL_METRICS_EXPORTER: 'none',
        OTEL_LOGS_EXPORTER: 'none',
        OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://alloy:4318',
        OTEL_PROPAGATORS: 'tracecontext,baggage',
        OTEL_TRACES_SAMPLER: 'parentbased_traceidratio',
        OTEL_TRACES_SAMPLER_ARG: '1.0',
        OTEL_BSP_SCHEDULE_DELAY: '200',
        // 릴리스 env 와 같게: Lettuce 자동 span 은 Redis 키(JWT 블랙리스트)를 db.statement 로 내보낸다.
        OTEL_INSTRUMENTATION_LETTUCE_ENABLED: 'false',
      })
      .withExposedPorts(8080, 9091)
      .withWaitStrategy(
        Wait.forLogMessage(/Started GwangsanApplication/, 1).withStartupTimeout(
          240000,
        ),
      )
      .start();

    await sql(`
      INSERT INTO tbl_member (member_id, name, nickname, password, phone_number, role, member_status, joined_at) VALUES
        (1,'A','A','unused','cross-${RUN}-1','ROLE_USER','ACTIVE',NOW()),
        (2,'B','B','unused','cross-${RUN}-2','ROLE_USER','ACTIVE',NOW()),
        (3,'C','C','unused','cross-${RUN}-3','ROLE_USER','ACTIVE',NOW()),
        (4,'D','D','unused','cross-${RUN}-4','ROLE_USER','ACTIVE',NOW());
      INSERT INTO tbl_product (product_id, title, description, gwangsan, member_id, type, mode, status, created_at, updated_at)
        VALUES (1,'Fixture','Fixture',0,2,'OBJECT','GIVER','ONGOING',NOW(),NOW());
      INSERT INTO tbl_chat_room (room_id, created_at, is_active, buyer_id, seller_id, product_id) VALUES
        (1,NOW(),TRUE,1,2,1),(2,NOW(),TRUE,3,2,1),(3,NOW(),TRUE,4,2,1),(4,NOW(),TRUE,1,2,1);
      INSERT INTO tbl_image (image_id, image_url, created_at) VALUES
        (11,'https://images.example/cross-11.jpg',NOW()),(12,'https://images.example/cross-12.jpg',NOW());
    `);

    chatC = await new GenericContainer('node:22-alpine')
      .withNetwork(network)
      .withNetworkAliases('chat')
      .withBindMounts([{ source: CHAT_DIR, target: '/app', mode: 'ro' }])
      .withWorkingDir('/app')
      // 앱 디렉터리는 읽기 전용이다. winston 파일 로거가 쓰는 logs/ 만 쓰기 가능하게 둔다.
      .withTmpFs({ '/app/logs': 'rw' })
      .withCommand(CHAT_CMD)
      .withEnvironment({
        PORT: '3000',
        REDIS_HOST: 'redis',
        REDIS_PORT: '6379',
        SPRING_SERVER_URL: 'http://api:8080',
        JWT_ACCESS_SECRET: JWT_SECRET,
        INTERNAL_API_SECRET: 'cross-service-internal-test-secret',
        OTEL_SERVICE_NAME: 'gwangsan-chat',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://alloy:4318',
        OTEL_BSP_SCHEDULE_DELAY: '200',
        DEPLOYMENT_ENVIRONMENT: 'test',
        METRICS_PORT: '9464',
        METRICS_HOST: '0.0.0.0',
      })
      .withExposedPorts(3000, 9464)
      .withWaitStrategy(Wait.forListeningPorts().withStartupTimeout(60000))
      .start();

    redis = new Redis({ host: '127.0.0.1', port: hostPort(redisC, 6379) });
    evidence.images = sh([
      'inspect',
      '--format',
      '{{.Config.Image}} {{.Image}}',
      redisC.getId(),
      mariadbC.getId(),
      tempoC.getId(),
      alloyC.getId(),
      apiC.getId(),
      chatC.getId(),
    ]);
    evidence.nodeVersion = (
      await chatC.exec(['node', '--version'])
    ).output.trim();
  }, 420000);

  afterAll(async () => {
    try {
      for (const s of sockets) s.disconnect();
      if (apiC)
        fs.writeFileSync(path.join(EVIDENCE_DIR, 'api.log'), allLogs(apiC));
      if (chatC)
        fs.writeFileSync(path.join(EVIDENCE_DIR, 'chat.log'), allLogs(chatC));
      if (alloyC)
        fs.writeFileSync(path.join(EVIDENCE_DIR, 'alloy.log'), allLogs(alloyC));
      if (apiC)
        fs.writeFileSync(
          path.join(EVIDENCE_DIR, 'metrics-api-final.txt'),
          await apiMetrics().catch((e) => String(e)),
        );
      if (chatC)
        fs.writeFileSync(
          path.join(EVIDENCE_DIR, 'metrics-chat-final.txt'),
          await chatMetrics().catch((e) => String(e)),
        );
      fs.writeFileSync(
        path.join(EVIDENCE_DIR, 'summary.json'),
        JSON.stringify(evidence, null, 2),
      );
    } finally {
      await redis?.quit();
      for (const c of [chatC, apiC, alloyC, tempoC, mariadbC, redisC])
        await c?.stop().catch(() => undefined);
      await network?.stop().catch(() => undefined);
    }
  }, 120000);

  it('TEXT/IMAGE: echo, committed row, linked Socket→Redis→Spring→JDBC spans, metrics, safe JSON logs', async () => {
    const apiBefore = await apiMetrics();
    const chatBefore = await chatMetrics();
    const socket = await connect(`cross-${RUN}-1`, 1);
    const text = canary('text');
    const textSent = await sendBurst(socket, 1, [text]);
    const img = await new Promise<any>((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error('image echo timeout')),
        10000,
      );
      socket.once('receiveMessage', (v) => (clearTimeout(t), resolve(v)));
      socket.emit('sendMessage', {
        roomId: 1,
        content: null,
        imageIds: [11, 12],
        messageType: 'IMAGE',
      });
    });
    expect(img.images).toEqual([
      { imageId: 11, imageUrl: 'https://images.example/cross-11.jpg' },
      { imageId: 12, imageUrl: 'https://images.example/cross-12.jpg' },
    ]);
    const textId = textSent.get(text)!.messageId;
    const imgId = String(img.messageId);
    await waitRow(textId);
    await waitRow(imgId);
    expect(
      await sql(
        `SELECT GROUP_CONCAT(image_id ORDER BY image_id) FROM tbl_chat_message_image WHERE message_id=${imgId}`,
      ),
    ).toBe('11,12');

    const cases: Record<string, unknown> = {};
    for (const [messageId, kind] of [
      [textId, 'TEXT'],
      [imgId, 'IMAGE'],
    ]) {
      const rec = await streamRecord(1, messageId);
      const tp = parseTraceparent(rec?.fields.traceparent);
      expect(tp).toBeDefined();
      const spans = await trace(
        tp!.traceId,
        (s) =>
          consumerSpans(s).length >= 1 &&
          s.some((x) => x.service === 'gwangsan-chat') &&
          descendants(s, consumerSpans(s)[0]).some(isInsertIntoMessages),
      );
      const consumers = consumerSpans(spans);
      expect(consumers).toHaveLength(1); // 전달 1회 = CONSUMER span 1개
      const consumer = consumers[0];
      const chatSpanIds = new Set(
        spans.filter((s) => s.service === 'gwangsan-chat').map((s) => s.spanId),
      );
      // 소비 span 은 Redis 로 전파된 producer 측 chat span 의 자식(또는 링크)이어야 한다.
      expect(
        chatSpanIds.has(consumer.parentSpanId) ||
          consumer.links.some((l) => chatSpanIds.has(l.spanId)),
      ).toBe(true);
      expect(consumer.parentSpanId || consumer.links[0]?.spanId).toBe(
        tp!.spanId,
      );
      // Node ioredis XADD span 이 남아 있어야 한다(Java Lettuce 만 끈다)
      expect(
        spans.some(
          (s) =>
            s.service === 'gwangsan-chat' &&
            s.kind === 'CLIENT' &&
            /xadd/i.test(s.name),
        ),
      ).toBe(true);
      // Socket.IO 이벤트당 짧은 root span 1개 (연결 수명 span 아님)
      const roots = spans.filter(
        (s) => s.service === 'gwangsan-chat' && !s.parentSpanId,
      );
      expect(roots).toHaveLength(1);
      expect(Number(roots[0].endNs - roots[0].startNs) / 1e9).toBeLessThan(10);
      // assertSendable HTTP 호출이 Spring SERVER span 으로 이어졌는지
      expect(
        spans.some((s) => s.service === 'gwangsan-api' && s.kind === 'SERVER'),
      ).toBe(true);
      cases[kind] = {
        messageId: 'redacted',
        traceId: tp!.traceId,
        spans: spans.map((s) => `${s.service}:${s.kind}:${s.name}`),
      };
    }

    const apiAfter = await until(
      'api persist metrics',
      async () => {
        const t = await apiMetrics();
        return (metric(t, 'gwangsan_chat_publish_to_commit_seconds_count') ??
          0) >=
          (metric(apiBefore, 'gwangsan_chat_publish_to_commit_seconds_count') ??
            0) +
            2
          ? t
          : undefined;
      },
      10000,
    );
    const chatAfter = await chatMetrics();
    const delta = (
      a: string,
      b: string,
      n: string,
      l: Record<string, string> = {},
    ) => (metric(b, n, l) ?? 0) - (metric(a, n, l) ?? 0);
    expect(
      delta(apiBefore, apiAfter, 'gwangsan_chat_persist_attempts_total'),
    ).toBeGreaterThanOrEqual(2);
    expect(
      delta(
        apiBefore,
        apiAfter,
        'gwangsan_chat_persist_duration_seconds_count',
      ),
    ).toBeGreaterThanOrEqual(2);
    expect(
      delta(apiBefore, apiAfter, 'gwangsan_chat_ack_total'),
    ).toBeGreaterThanOrEqual(2);
    expect(
      delta(chatBefore, chatAfter, 'gwangsan_chat_events_total'),
    ).toBeGreaterThanOrEqual(2);
    expect(
      delta(
        chatBefore,
        chatAfter,
        'gwangsan_chat_publish_duration_seconds_count',
      ),
    ).toBeGreaterThanOrEqual(2);
    expect(
      metric(chatAfter, 'gwangsan_chat_connections'),
    ).toBeGreaterThanOrEqual(1);
    for (const name of [
      'gwangsan_chat_publish_to_commit_seconds_bucket',
      'gwangsan_chat_persist_duration_seconds_bucket',
    ]) {
      expect(apiAfter).toMatch(new RegExp(`${name}\\{[^}]*le="0.005"`));
      expect(apiAfter).toMatch(new RegExp(`${name}\\{[^}]*le="60.0?"`));
    }
    // 동적 ID 가 라벨로 새지 않는다
    for (const t of [apiAfter, chatAfter])
      for (const line of t.split('\n').filter((l) => l.startsWith('gwangsan_')))
        expect(line).not.toMatch(/(room|member|message|trace|user)_?id=/i);

    // 히스토리 조회로 비즈니스 결과 확인
    const res = await request(springUrl())
      .get('/api/chat/1')
      .set('Authorization', `Bearer ${makeToken(`cross-${RUN}-1`)}`)
      .expect(200);
    expect(res.text).toContain(text);

    // JSON 로그: chat 발행 로그가 같은 trace_id 를 가진다
    const textTrace = (cases.TEXT as any).traceId as string;
    const chatJson = jsonLogs(chatC);
    expect(chatJson.length).toBeGreaterThan(0);
    const linked = chatJson.filter((l) => l.trace_id === textTrace);
    expect(linked.length).toBeGreaterThanOrEqual(1);
    for (const l of linked) {
      expect(l).toEqual(
        expect.objectContaining({
          timestamp: expect.anything(),
          level: expect.anything(),
          message: expect.anything(),
        }),
      );
      expect(l.span_id).toMatch(/^[0-9a-f]{16}$/);
    }
    const apiJson = jsonLogs(apiC);
    expect(apiJson.length).toBeGreaterThan(0);
    for (const l of apiJson.slice(-20))
      expect(l).toEqual(
        expect.objectContaining({
          timestamp: expect.anything(),
          level: expect.anything(),
          message: expect.anything(),
        }),
      );
    record('happyPath', cases);
  }, 120000);

  it('legacy / missing / invalid trace metadata never changes business outcome or ACK', async () => {
    const variants: Record<string, Record<string, string>> = {
      legacyNoFields: {},
      invalidTraceparent: { traceparent: '00-zzzz-not-a-trace-01' },
      allZeroTraceparent: {
        traceparent: `00-${'0'.repeat(32)}-${'0'.repeat(16)}-01`,
      },
      invalidTracestate: {
        traceparent: traceparent().value,
        tracestate: '=,,bad==',
      },
      oversizedTraceparent: { traceparent: 'x'.repeat(4096) },
    };
    const ids: Record<string, string> = {};
    for (const [k, extra] of Object.entries(variants))
      ids[k] = await xaddSynthetic(1, 1, canary(k), extra);
    for (const id of Object.values(ids)) await waitRow(id);
    await until(
      'ack',
      async () => ((await pendingIds(1)).length === 0 ? true : undefined),
      10000,
    );
    expect(await redis.xlen(DLQ_KEY).catch(() => 0)).toBe(0);
    record('legacyMetadata', {
      variants: Object.keys(variants),
      committed: true,
      pendingAfter: 0,
    });
  }, 60000);

  it('malformed payload goes to DLQ once, is ACKed and its body never reaches logs', async () => {
    const before = await apiMetrics();
    const body = canary('malformed');
    const id = String(Date.now());
    await redis.xadd(
      'chat:room:1:messages',
      '*',
      'messageId',
      id,
      'roomId',
      '1',
      'senderId',
      '1',
      'content',
      body,
      'messageType',
      'TEXT',
    );
    const entry = await until(
      'dlq entry',
      async () => {
        const all = (await redis.xrange(DLQ_KEY, '-', '+')) as [
          string,
          string[],
        ][];
        return all.find(([, kv]) => kv.join(' ').includes(id));
      },
      15000,
    );
    await until(
      'ack',
      async () => ((await pendingIds(1)).length === 0 ? true : undefined),
      10000,
    );
    expect(await rowCount(id)).toBe(0);
    const after = await until(
      'dlq metric',
      async () => {
        const t = await apiMetrics();
        return (metric(t, 'gwangsan_chat_dlq_total') ?? 0) >
          (metric(before, 'gwangsan_chat_dlq_total') ?? 0)
          ? t
          : undefined;
      },
      10000,
    );
    expect(allLogs(apiC)).not.toContain(body);
    record('malformed', {
      dlqEntry: entry[0],
      dlqDelta:
        (metric(after, 'gwangsan_chat_dlq_total') ?? 0) -
        (metric(before, 'gwangsan_chat_dlq_total') ?? 0),
    });
    await redis.del(DLQ_KEY);
  }, 60000);

  it('concurrent sockets/rooms keep one consumer span per message in its own trace (no context bleed)', async () => {
    const plan: [string, number, number][] = [
      [`cross-${RUN}-1`, 1, 1],
      [`cross-${RUN}-3`, 3, 2],
      [`cross-${RUN}-4`, 4, 3],
    ];
    const results = await Promise.all(
      plan.map(async ([sub, memberId, roomId]) => {
        const s = await connect(sub, memberId);
        const contents = Array.from({ length: 6 }, (_, i) =>
          canary(`conc${roomId}x${i}`),
        );
        const got = await sendBurst(s, roomId, contents);
        return [...got.values()].map((v) => ({
          roomId,
          messageId: v.messageId,
          echoMs: v.echoMs,
        }));
      }),
    );
    const msgs = results.flat();
    for (const m of msgs) await waitRow(m.messageId);
    const traceIds = new Set<string>();
    for (const m of msgs) {
      const tp = parseTraceparent(
        (await streamRecord(m.roomId, m.messageId))?.fields.traceparent,
      )!;
      expect(tp).toBeDefined();
      traceIds.add(tp.traceId);
      const spans = await trace(
        tp.traceId,
        (s) => consumerSpans(s).length >= 1,
      );
      expect(consumerSpans(spans)).toHaveLength(1);
      expect(consumerSpans(spans)[0].parentSpanId).toBe(tp.spanId);
    }
    expect(traceIds.size).toBe(msgs.length);
    record('concurrency', {
      messages: msgs.length,
      distinctTraces: traceIds.size,
      echoMs: msgs.map((m) => m.echoMs),
    });
  }, 180000);

  it('DB delay: echo is not blocked, commit latency excludes the unfinished message until it commits', async () => {
    const socket = await connect(`cross-${RUN}-1`, 1);
    const before = await apiMetrics();
    const count = (t: string) =>
      metric(t, 'gwangsan_chat_publish_to_commit_seconds_count') ?? 0;
    const sum = (t: string) =>
      metric(t, 'gwangsan_chat_publish_to_commit_seconds_sum') ?? 0;
    const lockSeconds = 6;
    const lockStart = Date.now();
    const lock = mariadbC.exec([
      'mariadb',
      '-uroot',
      '-ppassword',
      'gwangsan_db',
      '-e',
      `LOCK TABLES tbl_chat_message WRITE, tbl_chat_message_image WRITE; SELECT SLEEP(${lockSeconds}); UNLOCK TABLES;`,
    ]);
    await sleep(1000);
    const content = canary('dbdelay');
    const sent = (await sendBurst(socket, 1, [content])).get(content)!;
    expect(sent.echoMs).toBeLessThan(3000);
    await sleep(1500);
    // 잠긴 테이블을 조회하면 이 테스트도 잠금 해제까지 기다리게 된다. Redis·메트릭만 잠금 중에 본다.
    const pendingDuring = await pendingIds(1);
    const during = await apiMetrics();
    expect(Date.now() - lockStart).toBeLessThan((lockSeconds - 0.5) * 1000); // 아직 잠금 중에 관측
    expect(pendingDuring.length).toBeGreaterThanOrEqual(1); // 전달됐지만 미ACK = 미완료
    expect(count(during)).toBe(count(before)); // 미완료 메시지는 성공 지연 히스토그램에 없다
    await lock;
    await waitRow(sent.messageId);
    const after = await until(
      'commit histogram',
      async () => {
        const t = await apiMetrics();
        return count(t) === count(before) + 1 ? t : undefined;
      },
      10000,
    );
    const observed = sum(after) - sum(before);
    expect(observed).toBeGreaterThanOrEqual(lockSeconds - 1 - 1.5 - 1); // lock 잔여 시간 이상
    record('dbDelay', {
      echoMs: sent.echoMs,
      pendingDuring: pendingDuring.length,
      histogramCountDuring: count(during) - count(before),
      observedCommitLatencySeconds: observed,
      streamGaugesDuring: {
        pending: metric(during, 'gwangsan_stream_pending'),
        unread: metric(during, 'gwangsan_stream_unread'),
        complete: metric(during, 'gwangsan_stream_snapshot_complete'),
      },
    });
  }, 60000);

  it('transient DB failure retries then DLQs, every attempt is a CONSUMER span in the original trace', async () => {
    const socket = await connect(`cross-${RUN}-1`, 1);
    const before = await apiMetrics();
    await sql('RENAME TABLE tbl_chat_message TO tbl_chat_message_off');
    let messageId = '';
    try {
      const content = canary('retry');
      messageId = (await sendBurst(socket, 1, [content])).get(
        content,
      )!.messageId;
      await until(
        'dlq',
        async () => {
          const all = (await redis.xrange(DLQ_KEY, '-', '+')) as [
            string,
            string[],
          ][];
          return all.find(([, kv]) => kv.join(' ').includes(messageId));
        },
        30000,
      );
    } finally {
      await sql('RENAME TABLE tbl_chat_message_off TO tbl_chat_message');
    }
    const tp = parseTraceparent(
      (await streamRecord(1, messageId))?.fields.traceparent,
    )!;
    const dlq = (
      (await redis.xrange(DLQ_KEY, '-', '+')) as [string, string[]][]
    ).find(([, kv]) => kv.join(' ').includes(messageId))!;
    const dlqFields: Record<string, string> = {};
    for (let i = 0; i < dlq[1].length; i += 2)
      dlqFields[dlq[1][i]] = dlq[1][i + 1];
    const payload = JSON.parse(dlqFields.payload ?? '{}');
    expect(
      parseTraceparent(payload.traceparent ?? dlqFields.traceparent)?.traceId,
    ).toBe(tp.traceId);
    const spans = await trace(
      tp.traceId,
      (s) => consumerSpans(s).length >= RETRY_MAX + 1,
      40000,
    );
    const consumers = consumerSpans(spans);
    expect(consumers).toHaveLength(RETRY_MAX + 1);
    expect(
      consumers.every(
        (c) => c.status === 'STATUS_CODE_ERROR' || c.status === '2',
      ),
    ).toBe(true);
    const after = await until(
      'retry metrics',
      async () => {
        const t = await apiMetrics();
        return (metric(t, 'gwangsan_chat_dlq_total') ?? 0) >
          (metric(before, 'gwangsan_chat_dlq_total') ?? 0)
          ? t
          : undefined;
      },
      10000,
    );
    expect(
      (metric(after, 'gwangsan_chat_retry_total') ?? 0) -
        (metric(before, 'gwangsan_chat_retry_total') ?? 0),
    ).toBe(RETRY_MAX);
    expect(await rowCount(messageId)).toBe(0); // 비즈니스 결과: DLQ, 저장 안 됨
    const errLogs = jsonLogs(apiC).filter((l) => l.trace_id === tp.traceId);
    expect(errLogs.length).toBeGreaterThanOrEqual(1);
    record('retryDlq', {
      traceId: tp.traceId,
      consumerSpans: consumers.length,
      retryDelta:
        (metric(after, 'gwangsan_chat_retry_total') ?? 0) -
        (metric(before, 'gwangsan_chat_retry_total') ?? 0),
      linkedErrorLogs: errLogs.length,
    });
    await redis.del(DLQ_KEY);
  }, 120000);

  it('collector outage and Tempo stall never fail sends or commits; traces resume afterwards', async () => {
    const socket = await connect(`cross-${RUN}-1`, 1);
    sh(['stop', '-t', '1', alloyC.getId()]);
    const down = Array.from({ length: 3 }, () => canary('alloydown'));
    const downSent = await sendBurst(socket, 1, down);
    for (const v of downSent.values()) {
      expect(v.echoMs).toBeLessThan(3000);
      await waitRow(v.messageId);
    }
    sh(['start', alloyC.getId()]);
    sh(['pause', tempoC.getId()]);
    const stall = Array.from({ length: 2 }, () => canary('tempostall'));
    const stallSent = await sendBurst(socket, 1, stall);
    for (const v of stallSent.values()) {
      expect(v.echoMs).toBeLessThan(3000);
      await waitRow(v.messageId);
    }
    await sleep(8000);
    sh(['unpause', tempoC.getId()]);
    // Tempo 가 멈춰 있던 동안의 span 은 Alloy 재시도 큐로 늦게라도 도착해야 한다
    const stalledTrace = parseTraceparent(
      (await streamRecord(1, [...stallSent.values()][0].messageId))?.fields
        .traceparent,
    )!;
    await trace(
      stalledTrace.traceId,
      (s) => consumerSpans(s).length === 1,
      90000,
    );
    const after = canary('recovered');
    const afterSent = (await sendBurst(socket, 1, [after])).get(after)!;
    await waitRow(afterSent.messageId);
    const tp = parseTraceparent(
      (await streamRecord(1, afterSent.messageId))?.fields.traceparent,
    )!;
    await trace(tp.traceId, (s) => consumerSpans(s).length === 1, 60000);
    record('exporterOutage', {
      alloyDownEchoMs: [...downSent.values()].map((v) => v.echoMs),
      tempoStallEchoMs: [...stallSent.values()].map((v) => v.echoMs),
      tempoStallTraceDeliveredAfterUnpause: true,
      recoveredTraceId: tp.traceId,
    });
  }, 240000);

  it('consumer kill mid-commit + backlog + foreign pending entry: reclaimed exactly once with original context', async () => {
    const socket = await connect(`cross-${RUN}-1`, 1);
    // 다른(죽은) 소비자에게 전달됐지만 ACK 되지 않은 항목
    const foreign = traceparent();
    const foreignKey = 'chat:room:4:messages';
    await redis
      .xgroup('CREATE', foreignKey, GROUP, '$', 'MKSTREAM')
      .catch(() => undefined);
    const foreignId = String(Date.now()) + '7';
    const foreignFields = [
      'messageId',
      foreignId,
      'roomId',
      '4',
      'senderId',
      '1',
      'content',
      canary('foreign'),
      'messageType',
      'TEXT',
      'imageIds',
      '[]',
      'createdAt',
      String(Date.now()),
      'traceparent',
      foreign.value,
    ];
    await redis
      .multi()
      .xadd(foreignKey, '*', ...foreignFields)
      .xreadgroup(
        'GROUP',
        GROUP,
        'dead-consumer',
        'COUNT',
        1,
        'STREAMS',
        foreignKey,
        '>',
      )
      .exec();
    expect(await redis.xpending(foreignKey, GROUP, '-', '+', 10)).toHaveLength(
      1,
    );

    // 커밋 중인 소비자를 SIGKILL
    const lock = mariadbC.exec([
      'mariadb',
      '-uroot',
      '-ppassword',
      'gwangsan_db',
      '-e',
      'LOCK TABLES tbl_chat_message WRITE, tbl_chat_message_image WRITE; SELECT SLEEP(8); UNLOCK TABLES;',
    ]);
    await sleep(1000);
    const inflight = canary('inflight');
    const inflightId = (await sendBurst(socket, 1, [inflight])).get(
      inflight,
    )!.messageId;
    await until(
      'delivered',
      async () => ((await pendingIds(1)).length >= 1 ? true : undefined),
      5000,
    );
    sh(['kill', apiC.getId()]);
    // 소비자 정지 중 backlog (Spring 이 꺼져 있으면 Socket 발행 전 검증 HTTP 가 실패하므로 producer 를 합성)
    const backlog: { id: string; tp: ReturnType<typeof traceparent> }[] = [];
    for (let i = 0; i < 3; i++) {
      const tp = traceparent();
      backlog.push({
        id: await xaddSynthetic(1, 1, canary(`backlog${i}`), {
          traceparent: tp.value,
        }),
        tp,
      });
    }
    await lock;
    expect(await rowCount(inflightId)).toBe(0);
    const t0 = Date.now();
    sh(['start', apiC.getId()]);
    await waitApiReady();
    for (const b of backlog) await waitRow(b.id, 60000);
    await waitRow(inflightId, 90000);
    await waitRow(foreignId, 90000);
    const reclaimSeconds = (Date.now() - t0) / 1000;
    for (const id of [inflightId, foreignId, ...backlog.map((b) => b.id)])
      expect(await rowCount(id)).toBe(1);
    await until(
      'no pending',
      async () =>
        (await pendingIds(1)).length === 0 &&
        (await redis.xpending(foreignKey, GROUP, '-', '+', 10)).length === 0
          ? true
          : undefined,
      15000,
    );

    const inflightTp = parseTraceparent(
      (await streamRecord(1, inflightId))?.fields.traceparent,
    )!;
    for (const [traceId, parent] of [
      [inflightTp.traceId, inflightTp.spanId],
      [foreign.traceId, foreign.spanId],
      ...backlog.map((b) => [b.tp.traceId, b.tp.spanId]),
    ]) {
      const spans = await trace(
        traceId,
        (s) => consumerSpans(s).length >= 1,
        40000,
      );
      // kill 된 시도의 span 은 내보내지지 못할 수 있으므로 성공 시도가 원래 컨텍스트의 자식인지만 본다
      expect(consumerSpans(spans).every((c) => c.parentSpanId === parent)).toBe(
        true,
      );
    }
    record('killRestartReclaim', {
      reclaimSecondsAfterStart: reclaimSeconds,
      backlog: backlog.length,
      exactlyOnce: true,
    });
  }, 300000);

  it('stream snapshot gauges are fresh, explicit about completeness, and never fabricate unread', async () => {
    const t = await until(
      'fresh snapshot',
      async () => {
        const m = await apiMetrics();
        const ts = metric(m, 'gwangsan_stream_snapshot_timestamp_seconds');
        return ts !== undefined && Date.now() / 1000 - ts < 120 ? m : undefined;
      },
      90000,
      2000,
    );
    fs.writeFileSync(path.join(EVIDENCE_DIR, 'metrics-api-snapshot.txt'), t);
    // 그룹(rooms/retry)마다 따로 판정한다. 합산하면 complete 가 0/1 이 아니다.
    const groups = [
      ...t.matchAll(
        /^gwangsan_stream_snapshot_complete\{[^}]*group="([^"]+)"/gm,
      ),
    ].map((m) => m[1]);
    expect(groups.length).toBeGreaterThanOrEqual(1);
    const perGroup: Record<string, unknown> = {};
    for (const group of groups) {
      const g = { group };
      const complete = metric(t, 'gwangsan_stream_snapshot_complete', g);
      const unread = metric(t, 'gwangsan_stream_unread', g);
      expect([0, 1]).toContain(complete);
      expect([0, 1]).toContain(
        metric(t, 'gwangsan_stream_snapshot_success', g),
      );
      // 불완전한 스냅샷의 unread 는 0 이 아니라 NaN(또는 없음)이어야 한다
      if (complete === 0)
        expect(unread === undefined || Number.isNaN(unread)).toBe(true);
      perGroup[group] = {
        complete,
        success: metric(t, 'gwangsan_stream_snapshot_success', g),
        unread: unread ?? 'absent',
        pending: metric(t, 'gwangsan_stream_pending', g),
        ageSeconds:
          Date.now() / 1000 -
          (metric(t, 'gwangsan_stream_snapshot_timestamp_seconds', g) ?? 0),
      };
    }
    record('streamGauges', perGroup);
  }, 120000);

  it('privacy: no chat bodies, tokens or phone numbers in any service log or exported span', () => {
    const corpus = [allLogs(apiC), allLogs(chatC)];
    const traceDir = path.join(EVIDENCE_DIR, 'traces');
    if (fs.existsSync(traceDir))
      for (const f of fs.readdirSync(traceDir))
        corpus.push(fs.readFileSync(path.join(traceDir, f), 'utf8'));
    const leaks = [...secrets].filter((s) => corpus.some((c) => c.includes(s)));
    // Redis 키를 db.statement 로 싣는 Java Lettuce 자동 span 은 꺼져 있어야 한다
    const traceFiles = corpus.slice(2);
    expect(traceFiles.length).toBeGreaterThan(0);
    expect(
      traceFiles.filter((c) => c.includes('io.opentelemetry.lettuce')),
    ).toEqual([]);
    expect(corpus.filter((c) => /eyJ[\w-]+\.[\w-]+\.[\w-]+/.test(c))).toEqual(
      [],
    );
    record('privacy', {
      secretsChecked: secrets.size,
      filesChecked: corpus.length,
      leaks: leaks.length,
    });
    expect(leaks.map((l) => l.replace(/^(.{6}).*$/, '$1…'))).toEqual([]);
  });
});
