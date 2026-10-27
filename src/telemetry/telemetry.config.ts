/**
 * 계측 설정 해석. 순수 함수만 두어 SDK 를 띄우지 않고도 테스트할 수 있게 한다.
 */
export const DEFAULT_SERVICE_NAME = 'gwangsan-chat';
export const DEFAULT_OTLP_TRACES_URL = 'http://alloy:4318/v1/traces';
const PRODUCTION_SAMPLE_RATIO = 0.1;

type Env = Record<string, string | undefined>;

export function resolveEnvironment(env: Env = process.env): string {
  const configured = env.DEPLOYMENT_ENVIRONMENT?.trim();
  if (configured) return configured;
  return env.NODE_ENV === 'production' ? 'production' : 'development';
}

export function resolveServiceName(env: Env = process.env): string {
  return env.OTEL_SERVICE_NAME?.trim() || DEFAULT_SERVICE_NAME;
}

/**
 * ParentBased(TraceIdRatio) 의 루트 비율. 운영 기본 0.1, 그 외 1.0.
 * 잘못된 값은 무시하고 기본값을 쓴다(계측 설정 실수로 기동이 막히면 안 된다).
 */
export function resolveSampleRatio(env: Env = process.env): number {
  const raw = env.OTEL_TRACES_SAMPLER_ARG?.trim();
  const parsed = raw ? Number(raw) : NaN;
  if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) return parsed;
  return resolveEnvironment(env) === 'production' ? PRODUCTION_SAMPLE_RATIO : 1;
}

/** OTLP 환경 변수가 없을 때만 alloy 기본 주소를 쓴다. undefined 면 exporter 가 env 를 읽는다. */
export function resolveTracesUrl(env: Env = process.env): string | undefined {
  if (env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || env.OTEL_EXPORTER_OTLP_ENDPOINT)
    return undefined;
  return DEFAULT_OTLP_TRACES_URL;
}

/** 'off' 이면 메트릭 리스너를 띄우지 않는다. 0 은 임의 포트(테스트용). */
export function resolveMetricsPort(env: Env = process.env): number | null {
  const raw = env.METRICS_PORT?.trim();
  if (raw === 'off') return null;
  if (!raw) return 9464;
  const port = Number(raw);
  return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : 9464;
}

/** HTTP 계측에서 제외할 요청: Socket.IO 전송 요청과 메트릭 스크레이프. */
export function isIgnoredIncomingPath(url: string | undefined): boolean {
  if (!url) return false;
  return url.startsWith('/socket.io/') || url.startsWith('/metrics');
}
