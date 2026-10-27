// 의존성 없는 모듈로 둔다: OTel 사전 로드(instrumentation.ts)에서도 쓰므로 winston 등을 끌어오면 안 된다.
const MAX_MESSAGE_LENGTH = 300;

/** 에러 메시지에 섞여 들어올 수 있는 토큰·JWT·URL 쿼리·따옴표 속 입력값을 지우고 길이를 제한한다. */
export function sanitizeErrorMessage(message: string): string {
  const redacted = message
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(
      /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g,
      '[redacted-jwt]',
    )
    .replace(/\?[^\s'"]*/g, '?[redacted]')
    // JSON 파싱 에러 등은 입력 일부를 따옴표로 감싸 메시지에 싣는다.
    .replace(/"[^"]*"/g, '"[redacted]"');
  return redacted.length > MAX_MESSAGE_LENGTH
    ? `${redacted.slice(0, MAX_MESSAGE_LENGTH)}...`
    : redacted;
}
