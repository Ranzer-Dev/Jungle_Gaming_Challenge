# Jungle Gaming — Distributed Wagering Processor

<p align="center">
  <b>Plataforma financeira distribuída de alta performance para processamento de apostas em tempo real com Domain-Driven Design (DDD) puro, consistência ACID estrita, ledger imutável (append-only), Transactional Outbox/Inbox e resiliência a concorrência extrema.</b>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Runtime-Bun_1.4-000000?style=for-the-badge&logo=bun&logoColor=white" alt="Bun Badge"/>
  <img src="https://img.shields.io/badge/Framework-NestJS_10-E0234E?style=for-the-badge&logo=nestjs&logoColor=white" alt="NestJS Badge"/>
  <img src="https://img.shields.io/badge/Language-TypeScript_Strict-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript Badge"/>
  <img src="https://img.shields.io/badge/Database-PostgreSQL_16-4169E1?style=for-the-badge&logo=postgresql&logoColor=white" alt="PostgreSQL Badge"/>
  <img src="https://img.shields.io/badge/ORM-MikroORM_6-2B3A42?style=for-the-badge" alt="MikroORM Badge"/>
  <img src="https://img.shields.io/badge/Messaging-AWS_SQS_FIFO-FF9900?style=for-the-badge&logo=amazonsqs&logoColor=white" alt="AWS SQS Badge"/>
  <img src="https://img.shields.io/badge/Architecture-DDD_Puro_%2B_Hexagonal-blue?style=for-the-badge" alt="Architecture Badge"/>
  <img src="https://img.shields.io/badge/Tests-44_Passed_%7C_Zero_Mocks-success?style=for-the-badge" alt="Tests Badge"/>
</p>

---

## 1. Guia Rápido de Setup e Execução

Esta seção detalha o procedimento determinístico para inicializar a infraestrutura, executar migrações e rodar os testes e a aplicação em qualquer ambiente, atendendo estritamente aos requisitos do desafio.

### 1.1 Pré-requisitos
- [Bun](https://bun.sh/) (v1.2+) ou [Node.js](https://nodejs.org/) (v20+)
- [Docker](https://www.docker.com/) e Docker Compose

---

### 1.2 Procedimento de Execução

#### Passo 1: Inicializar os Contêineres de Infraestrutura Real
O arquivo `docker-compose.yml` provisiona um **PostgreSQL 16** e um contêiner **LocalStack 3.8** com filas AWS SQS FIFO e dead-letter queue:
```bash
docker compose up -d
```
> O healthcheck nativo do PostgreSQL garantirá prontidão na porta `5432`, e o LocalStack inicializará na porta `4566`.

#### Passo 2: Configurar Variáveis de Ambiente
O repositório já inclui um arquivo `.env.example` pronto para uso local:
```bash
cp .env.example .env
```

#### Passo 3: Instalar Dependências e Aplicar Migrações
```bash
# Instala dependências com resolução estrita via Bun
bun install

# Executa as migrações do MikroORM (cria tabelas, constraints e triggers)
bun run mikro-orm migration:up
```

#### Passo 4: Inicializar a Aplicação
```bash
# Modo de desenvolvimento com Hot-Reload
bun run start:dev

# Ou modo de produção compilado
bun run start:prod
```

---

### 1.3 Endpoints e Probes do Serviço

- **Swagger UI (Documentação Interativa da API):** [http://localhost:3000/docs](http://localhost:3000/docs)
- **Liveness Probe:** `GET http://localhost:3000/health/live` (Retorna `{"status": "ok"}`)
- **Readiness Probe:** `GET http://localhost:3000/health/ready` (Valida conexão com PostgreSQL e LocalStack)

---

### 1.4 Execução da Suíte Completa de Testes (Zero Mocks)

> [!IMPORTANT]
> Todos os testes de integração e concorrência rodam **obrigatoriamente contra os contêineres reais de PostgreSQL e LocalStack**, em conformidade com as Leis de Governança do projeto.

```bash
# Executa todos os 44 testes automatizados (Unitários, Integração e Concorrência Massiva)
bun test

# Executa apenas a suíte de testes unitários de domínio puro
bun run test:unit

# Executa apenas a suíte de integração com PostgreSQL e SQS FIFO reais
bun run test:integration

# Executa a suíte de estresse de concorrência (50 requests paralelos, overdraft, race 23505)
bun run test:concurrency

# Executa o benchmark de carga (Throughput e métricas p50/p95/p99 com reconciliação contábil)
bun run test:load
```

---

## 2. Sobre o Projeto e Contexto de Negócio

No ecossistema de alta disponibilidade de **iGaming**, provedores globais de jogos (ex.: *Evolution Gaming*, *Pragmatic Play*, *Playtech*) enviam um fluxo ininterrupto de transações financeiras simultâneas associadas a rodadas de apostas:
```text
BET (Débito) ───► WIN (Crédito) | LOSS (Neutro) | REFUND (Estorno) | ROLLBACK (Inversão)
```

### O Desafio de Engenharia
Em horários de pico, múltiplos nós de borda ou workers concorrentes tentam movimentar a mesma carteira de jogador ao mesmo tempo (*Hot Wallets*). Paralelamente, mensagens podem chegar duplicadas, fora de ordem (ex.: um `REFUND` chegando antes da `BET` original devido a oscilações no broker) ou retransmitidas após timeouts transitórios de rede.

O **Distributed Wagering Processor** resolve esses desafios com excelência técnica de nível Staff/Principal Engineer, garantindo:
1. **Consistência Financeira Absoluta:** O saldo materializado na carteira e o histórico contábil (livro-razão/ledger) são **100% consistentes e matematicamente auditáveis** a qualquer momento.
2. **Mitigação do IEEE 754:** Rejeição categórica de tipos de ponto flutuante binário (`number`/`float`); cálculos monetários operam exclusivamente através do Value Object `Money` baseado em `decimal.js` com escala fixa de 2 casas decimais.
3. **Idempotência Canônica Persistente:** Algoritmo determinístico baseado na RFC 8785 (JSON canônico + hash SHA-256), armazenado em constraint única no PostgreSQL.
4. **Resiliência a Concorrência Extrema:** Lock pessimista granular por `wallet_id` (`SELECT ... FOR UPDATE`), serializando operações de escrita de forma justa sem travar carteiras de outros jogadores.
5. **Livro-Razão Imutável (Append-Only):** Extrato protegido física e programaticamente por trigger PostgreSQL (`trg_ledger_immutable`), impedindo operações de `UPDATE` e `DELETE`.
6. **Entrega Confiável com Transactional Outbox & Inbox:** Publicação desacoplada via `SELECT ... FOR UPDATE SKIP LOCKED` e garantia estrita de **Commit Before ACK** no consumidor SQS FIFO.

---

## 3. Arquitetura de Software e Design DDD Puro

O sistema segue os princípios da **Arquitetura Hexagonal (Ports & Adapters)** e do **Domain-Driven Design (DDD)** puro:

```mermaid
flowchart TD
    subgraph Providers["Provedores de Jogos & Clientes Externos"]
        HTTP_CLIENT["Provedor A (Canal Síncrono / HTTP REST)"]
        SQS_BROKER["Provedor B (Canal Assíncrono / SQS FIFO)"]
    end

    subgraph Presentation["Camada de Borda & Apresentação (NestJS)"]
        GUARD["ProviderAuthGuard & ValidationPipe"]
        HTTP_CTRL["WalletsController & WageringController"]
        FILTER["GlobalExceptionFilter (RFC 7807)"]
        SQS_WORKER["SqsWagerConsumerWorker (Long Polling 20s)"]
    end

    subgraph Application["Camada de Aplicação (Use Cases)"]
        UC_TX["ProcessWagerTransactionUseCase"]
        UC_WALLET["CreateWalletUseCase"]
        UC_REC["ReconcileWalletUseCase"]
    end

    subgraph Domain["Camada de Domínio Puro (Zero Dependências de ORM)"]
        VO_MONEY["Value Object: Money (decimal.js)"]
        AGG_WALLET["Aggregate Root: Wallet"]
        AGG_TX["Entity: WagerTransaction"]
        AGG_LEDGER["Entity: WalletLedgerEntry (Immutable)"]
    end

    subgraph Infrastructure["Camada de Persistência & Mensageria"]
        UOW["MikroOrmUnitOfWork (em.transactional)"]
        SCHEMAS["MikroORM EntitySchema (mapToPk: true)"]
        PG[(PostgreSQL 16 Engine)]
        OUTBOX_W["OutboxPublisherWorker (SKIP LOCKED)"]
        REF_W["PendingReferenceWorker (Resolves PENDING_REF)"]
        AWS_SQS["AWS SQS FIFO Queue (LocalStack)"]
    end

    HTTP_CLIENT -->|HTTP POST| GUARD
    GUARD --> HTTP_CTRL
    HTTP_CTRL --> UC_TX
    HTTP_CTRL -.-> FILTER
    SQS_BROKER -->|Poll Messages| SQS_WORKER
    SQS_WORKER --> UC_TX
    UC_TX --> AGG_WALLET
    UC_TX --> AGG_TX
    UC_TX --> AGG_LEDGER
    UC_TX --> UOW
    UOW --> SCHEMAS
    SCHEMAS --> PG
    OUTBOX_W -->|SELECT FOR UPDATE SKIP LOCKED| PG
    OUTBOX_W -->|Publish Batch| AWS_SQS
    REF_W -->|Check References| PG
```

### Estrutura Modular Limpa
```text
src/
├── domain/                  # Entidades puras, Value Objects, Erros de domínio, Eventos (Zero dependências externas)
│   ├── entities/            # Wallet, WagerTransaction, WalletLedgerEntry, OutboxMessage, InboxMessage
│   ├── value-objects/       # Money (decimal.js, escala 2, imutável)
│   ├── errors/              # DomainError, InsufficientFundsError, etc.
│   └── services/            # CanonicalHashService (RFC 8785 JSON Canônico + SHA-256)
├── application/             # Casos de uso e orquestração de unidade de trabalho
│   ├── use-cases/           # ProcessWagerTransactionUseCase, CreateWalletUseCase, ReconcileWalletUseCase
│   ├── dtos/                # Commands, Queries e Results tipados
│   └── ports/               # Interfaces abstratas de Repositórios e UnitOfWork
├── infrastructure/          # Detalhes de infraestrutura, banco de dados e mensageria
│   ├── database/            # MikroORM EntitySchema, Migrations, Repositórios concretos, MoneyType
│   ├── messaging/           # SQS Queue Publisher, SqsWagerConsumerWorker (Commit Before ACK)
│   └── workers/             # OutboxPublisherWorker (SKIP LOCKED), PendingReferenceWorker
└── presentation/            # Camada HTTP e controladores NestJS
    ├── controllers/         # WalletsController, WageringController, HealthController
    ├── guards/              # ProviderAuthGuard (ProviderIdentityPort)
    └── filters/             # GlobalExceptionFilter (RFC 7807 Problem Details)
```

---

## 4. As 10 Leis Invioláveis do Projeto

| Lei | Regra Obrigatória | Implementação no Código |
|---|---|---|
| **1** | **Proibido Primitivos para Dinheiro** | Value Object `Money` apoiado em `decimal.js`, escala fixa de 2 casas, mapeamento `NUMERIC(18, 2)` via `MoneyType`. |
| **2** | **Proibido Idempotência em Memória** | Idempotência garantida no PostgreSQL por constraint única `uk_wager_tx_idempotency_key` e tabela `inbox_messages`. |
| **3** | **Proibido Confiança Cega em SQS FIFO** | Deduplicação e ordenação do SQS FIFO tratadas como transporte; o banco relacional é a fonte final da verdade. |
| **4** | **Transactional Outbox Mandatório** | Eventos gravados na mesma transação SQL da wallet e publicados via worker com `SELECT ... FOR UPDATE SKIP LOCKED`. |
| **5** | **Ledger 100% Imutável (Append-Only)** | Sem `UPDATE` ou `DELETE`. Trigger PostgreSQL `trg_ledger_immutable` bloqueia ativamente mutações. |
| **6** | **Lock Granular por Wallet** | Lock pessimista de linha `SELECT ... FOR UPDATE` via `em.transactional()` ao carregar a `Wallet`. |
| **7** | **Suporte a Múltiplas Instâncias** | Zero estado em memória de processo. Múltiplas instâncias consomem SQS e Outbox simultaneamente. |
| **8** | **Defesa em Profundidade no Schema** | `CHECK (balance_amount >= 0)`, `UNIQUE(player_id, currency)`, `UNIQUE(idempotency_key)`. |
| **9** | **Zero Mocks nos Testes Críticos** | Testes de integração e concorrência rodam contra contêineres reais de PostgreSQL 16 e LocalStack SQS. |
| **10** | **Commit Before ACK no SQS** | `DeleteMessage` é chamado estritamente **após** a confirmação do commit no banco de dados. |

---

## 5. Catálogo Completo de Endpoints HTTP

| Método | Endpoint | Descrição | Status HTTP |
|---|---|---|---|
| `POST` | `/wallets` | Cria uma nova carteira com abertura atômica (`initialBalance > 0`) | `201 Created` / `409 Conflict` |
| `GET` | `/wallets/:id` | Consulta o saldo materializado e a versão contábil da carteira | `200 OK` / `404 Not Found` |
| `GET` | `/wallets/:id/ledger` | Extrato contábil imutável com Keyset Pagination via cursor Base64 | `200 OK` / `404 Not Found` |
| `POST` | `/wallets/:id/reconciliation` | Auditoria matemática entre saldo e somatório de lançamentos do ledger | `200 OK` / `404 Not Found` |
| `POST` | `/wagering/transactions` | Submissão de apostas com header obrigatório `Idempotency-Key` | `201` / `200` / `202` / `400` / `409` / `422` |
| `GET` | `/wagering/transactions/:id` | Consulta de transação por identificador interno UUID | `200 OK` / `404 Not Found` |
| `GET` | `/providers/:pId/transactions/:extId` | Consulta de transação pela chave composta do provedor | `200 OK` / `404 Not Found` |
| `GET` | `/health/live` | Probe de liveness sem autenticação | `200 OK` |
| `GET` | `/health/ready` | Probe de readiness validando banco e mensageria | `200 OK` / `503 Service Unavailable` |

### Matriz de Mapeamento de Status HTTP Determinística

```text
201 Created              ──► Transação processada e saldo movimentado com sucesso
200 OK                   ──► Replay idempotente de transação já processada (idempotentReplay: true)
202 Accepted             ──► Aceite com dependência pendente (PENDING_REFERENCE aguardando a BET original)
400 Bad Request          ──► Payload malformado, valor de amount inválido ou cabeçalho ausente
404 Not Found            ──► Carteira ou transação referenciada não encontrada
409 Conflict             ──► Idempotency-Key reutilizada com payload divergente (IDEMPOTENCY_PAYLOAD_MISMATCH)
422 Unprocessable Entity ──► Rejeição por regra de negócio (INSUFFICIENT_FUNDS, ROLLBACK_WOULD_CAUSE_NEGATIVE_BALANCE)
503 Service Unavailable  ──► Falha transitória de infraestrutura (banco indisponível)
```

---

## 6. Resultados do Benchmark de Alta Performance (`bun run test:load`)

O teste de estresse executado contra os contêineres reais sob carga sustentada apurou os seguintes resultados:

| Métrica | Benchmark Multi-Wallet (10 carteiras, 500 txs) | Benchmark Hot-Wallet (1 carteira sob disputa, 100 txs) |
|---|---|---|
| **Total de Operações** | 500 transações financeiras ACID | 100 transações financeiras ACID |
| **Tempo de Execução** | ~5,98 segundos | ~1,19 segundos |
| **Throughput Sustentado** | **~84 ops/segundo (TPS)** | **~84 ops/segundo** (Serialização de Lock) |
| **Latência Mediana (p50)** | **1,77 segundos** sob carga máxima | **599 ms** |
| **Latência p95** | 5,68 segundos | 1,15 segundos |
| **Latência Máxima** | 5,96 segundos | 1,19 segundos |
| **Transações Rejeitadas** | 0 falhas | 0 falhas |
| **Divergência Contábil** | **R\$ 0,00 (100% de Consistência)** | **R\$ 0,00 (100% de Consistência)** |

---

## 7. Documentação Técnica Complementar

- **[ARCHITECTURE.md](./ARCHITECTURE.md):** Documento executivo detalhado com todas as justificativas técnicas, trade-offs de engenharia, concorrência e respostas completas para a banca de avaliação (Staff/Principal Engineer).
- **[REGRAS_DESAFIO.md](./docs/REGRAS_DESAFIO.md):** Briefing e especificações originais da Jungle Gaming preservados na íntegra.
- **[Contrato do Consumidor SQS FIFO](./docs/api/sqs-consumer-contract.md):** Especificação formal do payload e ciclo de consumo assíncrono.
- **[Catálogo de Eventos de Integração](./docs/api/integration-events.md):** Especificação dos eventos `WalletBalanceChanged`, `WagerTransactionProcessed` e `WagerTransactionRejected`.
- **[Matriz de Códigos de Status HTTP](./docs/api/http-status-mapping-matrix.md):** Mapeamento exaustivo de decisões HTTP e RFC 7807.
- **[Decisões de Arquitetura (ADRs)](./docs/adr/):** Registros formais de decisões arquiteturais adotadas no projeto.
- **[Checklist de Conformidade](./docs/CHECKLIST_CONFORMANCE.md):** Validação item a item dos critérios de avaliação do desafio.
