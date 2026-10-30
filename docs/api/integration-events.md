# Contratos de Eventos de Integração (Integration Events)

<p align="center">
  <b>Distributed Wagering Processor — Hub de Documentação Técnica</b><br>
  <a href="../../README.md">README Principal</a> &nbsp;|&nbsp;
  <a href="../../ARCHITECTURE.md">Arquitetura (Staff)</a> &nbsp;|&nbsp;
  <a href="../REGRAS_DESAFIO.md">Regras do Desafio</a> &nbsp;|&nbsp;
  <a href="./sqs-consumer-contract.md">Contrato SQS</a> &nbsp;|&nbsp;
  <b>Eventos Outbox</b> &nbsp;|&nbsp;
  <a href="./http-status-mapping-matrix.md">Matriz HTTP</a> &nbsp;|&nbsp;
  <a href="../CHECKLIST_CONFORMANCE.md">Checklist de Auditoria</a>
</p>

---

Este documento estabelece a especificação formal dos **Eventos de Integração** publicados no broker **AWS SQS** através do padrão **Transactional Outbox**.

Na arquitetura da **Jungle Gaming**, estes eventos alimentam sistemas a jusante (*downstream*), incluindo CRM em tempo real, inteligência de comportamento do jogador (*player intelligence*), gamificação, afiliados e auditoria contábil.

---

## 1. Envelope Padrão de Integração (`IntegrationEvent<T>`)

Todo evento trafegado no SQS compartilha um envelope comum imutável, tipado e com rastreabilidade distribuída de ponta a ponta:

```json
{
  "eventId": "0192f298-345e-7e38-af88-e43f851a819d",
  "eventType": "WalletBalanceChanged",
  "aggregateId": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "correlationId": "req-9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
  "causationId": "msg-sqs-8821948",
  "occurredAt": "2026-10-29T21:50:00.000Z",
  "version": 1,
  "data": {}
}
```

### Definição dos Campos do Envelope:
- `eventId`: UUID v7 ou v4 único do evento gerado no momento do commit.
- `eventType`: Nome nominal do evento em PascalCase (ex: `WalletBalanceChanged`). O tipo e a versão são definidos em código, nunca como strings soltas.
- `aggregateId`: Identificador do Aggregate Root de origem (ex: `walletId` ou `transactionId`).
- `correlationId`: Identificador de correlação transversal originado na requisição HTTP ou na mensagem da fila original para rastreamento distribuído no ELK/Jaeger.
- `causationId` *(opcional)*: Identificador da mensagem ou comando causal direto que disparou esta emissão.
- `occurredAt`: Timestamp ISO-8601 em UTC estrito de quando a transação financeira foi confirmada no PostgreSQL.
- `version`: Inteiro incremental indicando a versão do esquema do evento (`1`).
- `data`: Payload semântico do evento. **Regra de Ouro:** Valores monetários no `data` são sempre serializados como `MoneyProps` (`{ "amount": "25.00", "currency": "BRL" }`), nunca objetos complexos de domínio.

---

## 2. Catálogo de Eventos Oficiais

### 2.1 `WalletBalanceChanged` (v1)
Emitido **estritamente quando há mutação de saldo** em uma carteira (operações `BET`, `WIN`, `REFUND`, `ROLLBACK` com impacto financeiro, ou `OPENING`).
*Nota: Operações `LOSS` e transações `REJECTED` **não** emitem este evento.*

```json
{
  "eventId": "0192f299-1a2b-7c3d-8e4f-5a6b7c8d9e0f",
  "eventType": "WalletBalanceChanged",
  "aggregateId": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "correlationId": "corr-123456",
  "occurredAt": "2026-10-29T22:00:00.000Z",
  "version": 1,
  "data": {
    "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "transactionId": "0192f298-345e-7e38-af88-e43f851a819d",
    "direction": "DEBIT",
    "money": { "amount": "25.00", "currency": "BRL" },
    "balanceBefore": { "amount": "100.00", "currency": "BRL" },
    "balanceAfter": { "amount": "75.00", "currency": "BRL" },
    "walletVersion": 2
  }
}
```

---

### 2.2 `WagerTransactionProcessed` (v1)
Emitido para **toda** transação que atingiu o estado terminal `PROCESSED` com sucesso, inclusive operações `LOSS` (necessárias para telemetria de jogo e analytics de RTP).

```json
{
  "eventId": "0192f299-2b3c-4d5e-6f7a-8b9c0d1e2f3a",
  "eventType": "WagerTransactionProcessed",
  "aggregateId": "0192f298-345e-7e38-af88-e43f851a819d",
  "correlationId": "corr-123456",
  "occurredAt": "2026-10-29T22:00:00.000Z",
  "version": 1,
  "data": {
    "transactionId": "0192f298-345e-7e38-af88-e43f851a819d",
    "providerId": "pragmatic-play",
    "externalTransactionId": "tx-external-9988",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
    "roundId": "round-4455",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" },
    "referenceExternalTransactionId": null,
    "processedAt": "2026-10-29T22:00:00.000Z"
  }
}
```

---

### 2.3 `WagerTransactionRejected` (v1)
Emitido quando uma aposta ou reversão é rejeitada por violação de regra de negócio (ex: saldo insuficiente, reversão inválida). Permite ao módulo de CRM e retenção engajar o jogador ou alertar suspeita de fraude.

```json
{
  "eventId": "0192f299-3c4d-5e6f-7a8b-9c0d1e2f3a4b",
  "eventType": "WagerTransactionRejected",
  "aggregateId": "0192f298-9999-7e38-af88-e43f851a819d",
  "correlationId": "corr-789012",
  "occurredAt": "2026-10-29T22:05:00.000Z",
  "version": 1,
  "data": {
    "transactionId": "0192f298-9999-7e38-af88-e43f851a819d",
    "providerId": "evolution",
    "externalTransactionId": "tx-ext-insufficient",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
    "roundId": "round-8877",
    "gameId": "crazy-time",
    "kind": "BET",
    "money": { "amount": "800.00", "currency": "BRL" },
    "failureCode": "INSUFFICIENT_FUNDS",
    "reason": "Wallet available balance is lower than the requested bet amount"
  }
}
```

---

### 2.4 `WagerTransactionPendingReference` (v1)
Emitido quando uma transação de estorno (`REFUND` ou `ROLLBACK`) é aceita e persistida, porém a transação referenciada ainda não foi encontrada no banco. Sinaliza a espera assíncrona ao broker.

```json
{
  "eventId": "0192f299-4d5e-6f7a-8b9c-0d1e2f3a4b5c",
  "eventType": "WagerTransactionPendingReference",
  "aggregateId": "0192f298-8888-7e38-af88-e43f851a819d",
  "correlationId": "corr-445566",
  "occurredAt": "2026-10-29T22:10:00.000Z",
  "version": 1,
  "data": {
    "transactionId": "0192f298-8888-7e38-af88-e43f851a819d",
    "providerId": "spribe",
    "externalTransactionId": "refund-tx-100",
    "referenceExternalTransactionId": "bet-tx-99",
    "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "roundId": "round-aviator-1",
    "kind": "REFUND",
    "money": { "amount": "50.00", "currency": "BRL" },
    "retryCount": 0,
    "nextRetryAt": "2026-10-29T22:10:30.000Z"
  }
}
```

