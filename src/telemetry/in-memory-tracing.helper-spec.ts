import { context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';

/** 단위 테스트용 실제 OTel 트레이서. SDK 사전 로드 없이 컨텍스트 전파를 검증한다. */
export function installInMemoryTracing(): {
  exporter: InMemorySpanExporter;
  uninstall: () => void;
} {
  const exporter = new InMemorySpanExporter();
  const contextManager = new AsyncLocalStorageContextManager().enable();
  context.setGlobalContextManager(contextManager);
  trace.setGlobalTracerProvider(
    new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    }),
  );
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  return {
    exporter,
    uninstall: () => {
      trace.disable();
      context.disable();
      propagation.disable();
    },
  };
}
