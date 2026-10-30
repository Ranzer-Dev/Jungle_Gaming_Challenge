# Checklist de Conformidade Estrita (README vs EXECUTION_PLAN)

<p align="center">
  <b>Distributed Wagering Processor — Hub de Documentação Técnica</b><br>
  <a href="../README.md">README Principal</a> &nbsp;|&nbsp;
  <a href="../ARCHITECTURE.md">Arquitetura (Staff)</a> &nbsp;|&nbsp;
  <a href="./REGRAS_DESAFIO.md">Regras do Desafio</a> &nbsp;|&nbsp;
  <a href="./api/sqs-consumer-contract.md">Contrato SQS</a> &nbsp;|&nbsp;
  <a href="./api/integration-events.md">Eventos Outbox</a> &nbsp;|&nbsp;
  <a href="./api/http-status-mapping-matrix.md">Matriz HTTP</a> &nbsp;|&nbsp;
  <b>Checklist de Auditoria</b>
</p>

---

Este documento registra a auditoria cruzada linha por linha entre cada uma das 14 seções do `README.md` da Jungle Gaming e a cobertura no plano mestre `EXECUTION_PLAN.md` e na documentação `docs/`.

---

| Seção do README | Requisito Principal | Status no Plano | Onde está documentado |
|---|---|---|---|
| **1. Visão Geral** | Serviço distribuído tolerante a duplicatas, fora de ordem e concorrência | [OK] 100% Contemplado | `EXECUTION_PLAN.md` (Seção 1 e 5) |
| **2. Autenticação** | Não pontua, proibido artesanal, desacoplado via porta | [OK] 100% Contemplado | `ADR-003`, `EXECUTION_PLAN.md` (Seção 8) |
| **3. Contexto do Domínio** | Ciclo `BET -> WIN/LOSS/REFUND/ROLLBACK`, at-least-once | [OK] 100% Contemplado | `docs/domain/ubiquitous-language.md` |
| **4. Stack Obrigatória** | Bun 1.x, TypeScript estrito, NestJS, Postgres, SQS, MikroORM | [OK] 100% Contemplado | `EXECUTION_PLAN.md` (Seções 1 e 4), `ADR-004` |
| **5. Restrições Invioláveis** | As 9 proibições eliminatórias (sem float, sem in-memory dedup, etc.) | [OK] 100% Contemplado | `AGENTS.md` (Seção 2), `EXECUTION_PLAN.md` (1.1) |
| **6.1 Money** | Escala 2 fixa, Decimal, imutável, rejeição de NaN/infinitos | [OK] 100% Contemplado | `EXECUTION_PLAN.md` (3.1), `docs/api/openapi.yaml` |
| **6.2 Wallet** | Unicidade player+moeda, saldo >= 0, version só sobe se saldo muda | [OK] 100% Contemplado | `EXECUTION_PLAN.md` (3.2), `ADR-004` |
| **6.3 WagerTransaction** | Estados terminais imutáveis, OPENING interno, hash canônico | [OK] 100% Contemplado | `docs/domain/canonical-payload-hashing.md` |
| **6.4 WalletLedgerEntry** | Append-only, balanceBefore ± amount = balanceAfter, trigger Postgres | [OK] 100% Contemplado | `ADR-004`, `EXECUTION_PLAN.md` (4.1) |
| **6.5 Inbox & Outbox** | Mesma transação SQL do UoW, polling com SKIP LOCKED | [OK] 100% Contemplado | `ADR-002`, `EXECUTION_PLAN.md` (5.3 e 6.1) |
| **7. Regras de Negócio** | As 5 invariantes da referência, perda sem saldo, estorno negativo | [OK] 100% Contemplado | `EXECUTION_PLAN.md` (3.3 e 9), `ADR-004` |
| **7.1 Fora de Ordem** | `PENDING_REFERENCE` com backoff exponencial e limite TTL | [OK] 100% Contemplado | `EXECUTION_PLAN.md` (6.2), `ADR-005` |
| **7.2 Códigos de Falha** | Taxonomia estável de FailureCode (400, 404, 409, 422) | [OK] 100% Contemplado | `docs/api/http-status-mapping-matrix.md` |
| **8. Concorrência** | Hot wallet, lock por walletId, 100 BRL vs 2x 80 BRL | [OK] 100% Contemplado | `ADR-001`, `EXECUTION_PLAN.md` (5.1 e 10.3) |
| **9. API HTTP** | Malha completa de endpoints, cursor opaco de ledger, reconciliação | [OK] 100% Contemplado | `docs/api/openapi.yaml`, `EXECUTION_PLAN.md` (7) |
| **10. Processamento SQS** | Consumo FIFO, MessageGroupId=walletId, Commit before ACK, SIGTERM | [OK] 100% Contemplado | `docs/api/sqs-consumer-contract.md`, `ADR-005` |
| **11. Transactional Outbox** | IntegrationEvent<T> tipado, publish pós-commit, múltiplos publishers | [OK] 100% Contemplado | `docs/api/integration-events.md`, `ADR-002` |
| **12. Observabilidade** | Logs JSON com correlationId sem vazamento, métricas Prometheus | [OK] 100% Contemplado | `docs/operations/observability-metrics.md` |
| **13. Testes Obrigatórios** | Unitários, Integração real (Docker), 8 cenários de concorrência | [OK] 100% Contemplado | `docs/testing/test-strategy.md`, `EXECUTION_PLAN.md` (10) |
| **14. Avaliação (100 pts)** | 0 mocks em concorrência, setup claro e teste de carga (diferencial) | [OK] 100% Contemplado | `EXECUTION_PLAN.md` (1.2 e 10.4), `docs/INTERVIEW_DEFENSE.md` |

