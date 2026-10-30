# Observabilidade, Métricas Prometheus & Logging Estruturado

Este documento estabelece os padrões e contratos operacionais de **Observabilidade** do **Distributed Wagering Processor**, em conformidade com as exigências da Seção 12 do desafio e a cultura de engenharia da **Jungle Gaming** (*"Evidence before assumption"*).

---

## 1. Métricas de Produção (Prometheus)

A aplicação expõe métricas em formato OpenMetrics/Prometheus no endpoint interno `GET /metrics`.

### 1.1 Tabela de Métricas Obrigatórias

| Métrica | Tipo | Labels | Descrição / Objetivo |
|---|---|---|---|
| `wagering_transactions_total` | Counter | `status`, `provider`, `kind` | Volume total de transações processadas agrupadas por status (`PROCESSED`, `REJECTED`, `PENDING_REFERENCE`, `FAILED`), provedor e tipo (`BET`, `WIN`, etc.). |
| `wagering_transaction_duration_seconds` | Histogram | `provider`, `kind`, `transport` | Latência fim a fim do processamento (buckets: 5ms, 10ms, 25ms, 50ms, 100ms, 250ms, 500ms, 1s, 2.5s). Labels diferenciam transporte (`http` vs `sqs`). |
| `wagering_idempotency_requests_total` | Counter | `result` | Monitora a eficácia da camada de idempotência. Labels: `new`, `replay_identical`, `conflict_mismatch`. |
| `wallet_lock_contention_wait_seconds` | Histogram | - | Tempo gasto pelas transações aguardando a liberação do lock pessimista (`SELECT ... FOR UPDATE`) na carteira. Indicador crítico de saturação de hot wallet. |
| `outbox_lag_seconds` | Gauge | - | Diferença temporal em segundos entre o `occurred_at` da mensagem mais antiga pendente no outbox e o `NOW()`. Alerta se o publisher estiver atrasado. |
| `outbox_published_messages_total` | Counter | `event_type`, `status` | Total de eventos publicados no broker SQS com sucesso (`success`) ou falha transitória (`retry`). |
| `sqs_consumer_messages_total` | Counter | `consumer`, `status` | Total de mensagens lidas da fila SQS com commit confirmado (`ack`), duplicata descartada pelo inbox (`duplicate`), ou erro. |
| `sqs_dlq_messages_total` | Counter | `consumer` | Total de mensagens enviadas para a Dead-Letter Queue após esgotamento de retries. Alerta severo de intervenção manual. |

---

## 2. Padrão de Logs Estruturados (JSON)

Todo log na aplicação é emitido em **formato JSON de linha única** (ndjson) diretamente no `stdout`, facilitando ingestão nativa por stacks como ELK (Elasticsearch/Logstash/Kibana) e Datadog.

### 2.1 Schema Obrigatório do Log

```json
{
  "timestamp": "2026-10-29T22:00:00.123Z",
  "level": "INFO",
  "service": "distributed-wagering-processor",
  "environment": "production",
  "context": "ProcessWagerTransactionUseCase",
  "correlationId": "req-9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
  "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "transactionId": "0192f298-345e-7e38-af88-e43f851a819d",
  "providerId": "pragmatic-play",
  "message": "Wager transaction processed successfully",
  "metadata": {
    "kind": "BET",
    "amount": "25.00",
    "currency": "BRL",
    "status": "PROCESSED",
    "lockWaitMs": 2.4,
    "durationMs": 14.1
  }
}
```

### 2.2 Regras Estritas de Blindagem de Dados:
1. **Zero Vazamento de PII e Segredos:** Nunca logar tokens JWT, headers de autorização, senhas ou dados cadastrais do jogador.
2. **Contexto Contínuo:** Se a requisição veio via HTTP, o `correlationId` é extraído do header `X-Correlation-Id` (ou gerado na entrada). Se veio de SQS, o `correlationId` é propagado a partir dos metadados da mensagem.

---

## 3. Contratos de Health Checks

Em conformidade com a Seção 9 do README, a aplicação possui dois endpoints de integridade que **não exigem autenticação**:

### 3.1 Liveness Probe (`GET /health/live`)
- **Objetivo:** Verifica se o processo Node/Bun e o event loop estão responsivos.
- **Resposta Sucesso (HTTP 200):**
  ```json
  { "status": "UP", "uptime": 3600 }
  ```
- Se o event loop travar ou o processo estiver em deadlock, o Kubernetes/Docker reinicia o container.

### 3.2 Readiness Probe (`GET /health/ready`)
- **Objetivo:** Verifica se a instância está apta a receber tráfego de apostas, testando conectividade física com:
  1. **PostgreSQL:** Executa `SELECT 1` com timeout curto (1s).
  2. **AWS SQS:** Valida conectividade com o endpoint do broker via LocalStack.
- **Resposta Sucesso (HTTP 200):**
  ```json
  {
    "status": "UP",
    "checks": {
      "database": { "status": "UP", "latencyMs": 1.2 },
      "sqs": { "status": "UP", "latencyMs": 3.8 }
    }
  }
  ```
- Se o banco de dados cair temporariamente, retorna **HTTP 503 Service Unavailable**, removendo o container do balanceador de carga HTTP até a recuperação.

