# === Build Stage ===
# Node 22 LTS (B 요구사항 >=22.12). 테스트는 CI/CD 워크플로에서 이미지 빌드 전에 실행한다.
FROM node:22.23.4-alpine3.24@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS build
WORKDIR /app
COPY package*.json ./
RUN HUSKY=0 npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

# === Run Stage ===
FROM node:22.23.4-alpine3.24@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package*.json ./

# 트레이스만 OTLP HTTP로 Alloy에 보낸다. 메트릭은 prom-client(9464, 비공개), 로그는 Promtail 담당.
# 롤백: 런타임에 OTEL_SDK_DISABLED=true 를 주면 SDK가 시작하지 않는다.
# 샘플링 기본값은 SDK가 환경으로 정한다(production .1, 그 외 1). 운영 값은 배포 스크립트가 주입한다.
ENV DEPLOYMENT_ENVIRONMENT=development \
    OTEL_SERVICE_NAME=gwangsan-chat \
    OTEL_EXPORTER_OTLP_ENDPOINT=http://alloy:4318

# 9464(메트릭)는 컨테이너 내부 전용이며 EXPOSE/publish 하지 않는다.
EXPOSE 3000
# SDK는 Nest/http/ioredis 보다 먼저 로드되어야 한다.
CMD ["node", "--require", "./dist/src/instrumentation.js", "dist/src/main.js"]
