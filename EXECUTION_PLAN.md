# Technical Challenge: Distributed Wagering Processor — Plano Mestre de Execução & Arquitetura

Este documento estabelece o plano detalhado de ponta a ponta, os guardrails arquiteturais e a estratégia de implementação para o desafio da **Jungle Gaming**, visando nota máxima (100/100) na avaliação técnica e capacitação total do candidato para a defesa técnica na apresentação.

---

## 1. Mapeamento de Pontuação & Critérios Eliminatórios

### 1.1 Checklist Anti-Eliminação (Seção 5 e 14 do README)
Antes de qualquer linha de código, o sistema é blindado contra as 8 falhas eliminatórias:

- [ ] **Zero Primitivos para Dinheiro:** Proibido o uso de `number`, `float` ou `double` para valores monetários. Todo cálculo utiliza o Value Object `Money` apoiado em biblioteca de precisão arbitrária (`decimal.js`).
- [ ] **Sem Idempotência Efêmera:** Toda deduplicação é persistida no PostgreSQL via chaves únicas e tabela `inbox_messages`. Zero cache em memória como garantia final.
- [ ] **Não Confiar Cegamente no SQS FIFO:** O banco de dados PostgreSQL é a autoridade máxima e garante todas as invariantes via constraints e locks.
- [ ] **Atomicidade no Commit (Transactional Outbox):** Proibido publicar mensagens no broker antes do commit no banco. O evento só é despachado via worker do Outbox após confirmação do PostgreSQL.
- [ ] **Imutabilidade Estrutural do Ledger:** Lançamentos do ledger são append-only. Nenhuma instrução de `UPDATE` ou `DELETE` pode existir para `wallet_ledger_entries`.
- [ ] **Lock Granular por Wallet:** O lock de concorrência é estritamente delimitado por `wallet_id` (nunca lock global na tabela ou na aplicação).
- [ ] **Isolamento Concorrente ACID:** Proibido `read -> calculate -> update` sem controle de concorrência. Utilizaremos `SELECT ... FOR UPDATE` via MikroORM EntityManager.
- [ ] **Suporte a Múltiplas Instâncias Reais:** A aplicação deve ser testada e validada executando 3 ou mais instâncias simultâneas competindo pela mesma carteira.
- [ ] **Garantias no Schema do Banco:** Validações de não-negatividade (`CHECK balance_amount >= 0`) e unicidades compostas enforced nativamente no PostgreSQL.
- [ ] **Zero Mocks de Infra nos Testes Críticos:** Testes de integração e concorrência rodam contra instâncias reais de PostgreSQL e SQS no Docker.

### 1.2 Distribuição de Pontos (Total: 100)
- **Correção Financeira (20 pts):** `Money`, consistência de saldo, integridade do ledger, reversões exatas, reconciliação.
- **Concorrência (20 pts):** Concorrência em hot wallet, zero lost updates, suporte a múltiplas instâncias.
- **Idempotência (15 pts):** Deduplicação persistente, retorno idempotente de saldo histórico, rejeição por hash divergente.
- **Mensageria e Falhas (15 pts):** Inbox, Outbox, retry, DLQ, crash recovery pós-commit, graceful shutdown.
- **Modelagem e Arquitetura (10 pts):** DDD puro, factories estáticas, construtores privados, separação de camadas.
- **Testes (10 pts):** Testes unitários puros, integração real com containers, testes de corrida (50 requisições simultâneas).
- **Observabilidade (5 pts):** Logs estruturados em JSON com correlation ID, health checks (live/ready), métricas.
- **Documentação (5 pts):** `ARCHITECTURE.md` aprofundado com justificativa de trade-offs e `README.md` com setup claro.

---

## 2. Guardrails Arquiteturais & Padrões de Código

### 2.1 Princípios de Design (DDD & Clean Architecture)
```
[ Controllers / SQS Consumers ]  <-- Adaptadores Primários (Entrada)
             │
             ▼
    [ Application Services ]      <-- Casos de Uso (Orquestração, UoW, Locks)
             │
             ▼
    [ Domain Model / Aggregate ]  <-- Wallet, WagerTransaction, Ledger, Money (Puro)
             │
             ▼
[ MikroORM / SQS Client / Repo ] <-- Adaptadores Secundários (Saída)
```

1. **Domínio Agnóstico de Framework:** As entidades (`Wallet`, `WagerTransaction`, `WalletLedgerEntry`, `Money`) não herdam classes do NestJS, MikroORM ou decorators do framework. O ORM é mapeado externamente (via `EntitySchema`).
2. **Encapsulamento com Construtores Fechados:**
   - Construtores `private` / `protected`.
   - Criação de novas entidades via factories (`Wallet.open()`, `WagerTransaction.create()`, `WalletLedgerEntry.create()`).
   - Reconstituição do banco via factory estática `.rehydrate()`, que não dispara regras de validação de transição, apenas remonta o estado persistido.
   - Estado mutável protegido em campos privados expostos por getters — **zero setters públicos**.
3. **Máquina de Estados Explícita & Terminalidade:**
   - Estados: `PENDING`, `PENDING_REFERENCE`, `PROCESSED`, `REJECTED`, `FAILED`.
   - `PROCESSED`, `REJECTED` e `FAILED` são terminais. Chamar qualquer transição a partir de um estado terminal lança imediatamente `InvalidTransactionStateError`.

---

## 3. Especificação do Modelo de Domínio

### 3.1 Value Object: `Money`
- Representação interna: `Decimal` (escala 2 fixa, arredondamento half-even ou floor conforme regra bancária).
- Formato de entrada/saída (DTO): `{ amount: "25.00", currency: "BRL" }`.
- Métodos: `add()`, `subtract()`, `negate()`, `isZero()`, `isPositive()`, `isNegative()`, `isLessThan()`, `equals()`.
- Guardrails:
  - Lança `InvalidMoneyAmountError` para: `NaN`, strings não-numéricas, notação científica, mais de 2 casas decimais, valores negativos em contratos de entrada.
  - Lança `CurrencyMismatchError` se tentar operar moedas diferentes (ex.: `BRL` com `USD`).

### 3.2 Aggregate Root: `Wallet`
- Atributos: `id`, `playerId`, `currency`, `_balance` (Money), `_version` (number), `createdAt`, `_updatedAt`.
- Regras e Invariantes:
  - Unicidade de carteira por `(playerId, currency)`.
  - Saldo nunca negativo (`balance.isNegative() === false`).
  - `version` inicia em `1` na criação (`Wallet.open()`) e incrementa estritamente quando há mutação de saldo.
  - Métodos `debit(money, transactionId)` e `credit(money, transactionId)` que retornam a tupla com o novo saldo e a `WalletLedgerEntry` correspondente.

### 3.3 Entidade: `WagerTransaction`
- Tipos (`WagerTransactionKind`): `OPENING`, `BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`.
- Regras de Negócio:
  - `OPENING`: Crédito inicial na abertura da carteira (operação interna estritamente proibida em APIs externas ou filas).
  - `BET`: Débito imediato. Falha com `INSUFFICIENT_FUNDS` se saldo for inferior.
  - `WIN`: Crédito imediato. Pode vincular à `BET` da mesma rodada (`roundId`).
  - `LOSS`: Sem alteração de saldo, sem ledger. Registrado como auditável em `PROCESSED`.
  - `REFUND`: Crédito revertendo estritamente uma `BET` anterior em `PROCESSED`. Valor deve ser rigorosamente idêntico ao da referência (reversão parcial fora de escopo). Uma `BET` só pode ser estornada uma única vez por `REFUND`.
  - `ROLLBACK`: Inverte a operação de referência (`BET` gera crédito, `WIN` gera débito, `REFUND` gera débito). Se o rollback de um `WIN` fosse deixar o saldo negativo, a transação é rejeitada com `ROLLBACK_WOULD_CAUSE_NEGATIVE_BALANCE`. Uma referência só pode ser revertida uma única vez por `ROLLBACK`.
  - **As 5 Invariantes Cruzadas da Referência:** A referência externa em `REFUND`/`ROLLBACK` deve pertencer obrigatoriamente ao mesmo `providerId`, `playerId`, `walletId`, `currency` e `roundId`. Divergências geram `REFERENCE_ROUND_MISMATCH`, `CURRENCY_MISMATCH` ou `INVALID_REFERENCE_KIND`.
  - Referência Ausente: Se `referenceExternalTransactionId` não for encontrado, a transação não é descartada: é salva com status `PENDING_REFERENCE` para reprocessamento assíncrono.

### 3.4 Entidade Imutável: `WalletLedgerEntry`
- Atributos: `id`, `walletId`, `transactionId`, `direction` (`CREDIT` | `DEBIT`), `money`, `balanceBefore`, `balanceAfter`, `createdAt`.
- Guardrails:
  - 100% imutável: sem setters ou transições de estado.
  - Validação estrita na factory: `balanceBefore ± money === balanceAfter`.
  - Invariante global: Uma transação financeira gera no máximo 1 entrada de ledger por carteira. Operações `LOSS` ou transações `REJECTED` não geram ledger.

### 3.5 Entidades de Transporte & Confiabilidade: `InboxMessage` & `OutboxMessage`
- `InboxMessage`: chave primária composta `(consumerName, messageId)`. Garante que uma mensagem do SQS só seja processada uma vez por consumidor.
- `OutboxMessage`: `id`, `aggregateId`, `eventType`, `payload` (JSON estável com `MoneyProps`), `occurredAt`, `attempts`, `nextAttemptAt`, `publishedAt`.
- Envelope Abstrato: `IntegrationEvent<T>` tipado, com versão e serialização controlada.

---

## 4. Persistência, Schema PostgreSQL & Migrations

### 4.1 Schema & Constraints Físicas
```sql
-- Wallets
CREATE TABLE wallets (
    id UUID PRIMARY KEY,
    player_id VARCHAR(64) NOT NULL,
    currency VARCHAR(3) NOT NULL,
    balance_amount DECIMAL(18, 2) NOT NULL,
    version INT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uk_wallet_player_currency UNIQUE (player_id, currency),
    CONSTRAINT chk_wallet_balance_non_negative CHECK (balance_amount >= 0)
);

-- Wager Transactions
CREATE TABLE wager_transactions (
    id UUID PRIMARY KEY,
    provider_id VARCHAR(64) NOT NULL,
    external_transaction_id VARCHAR(128) NOT NULL,
    idempotency_key VARCHAR(256) NOT NULL,
    payload_hash VARCHAR(64) NOT NULL,
    wallet_id UUID NOT NULL REFERENCES wallets(id),
    player_id VARCHAR(64) NOT NULL,
    round_id VARCHAR(128) NOT NULL,
    game_id VARCHAR(128) NOT NULL,
    kind VARCHAR(20) NOT NULL,
    amount DECIMAL(18, 2) NOT NULL,
    currency VARCHAR(3) NOT NULL,
    reference_external_transaction_id VARCHAR(128),
    reference_transaction_id UUID REFERENCES wager_transactions(id),
    status VARCHAR(30) NOT NULL,
    failure_code VARCHAR(50),
    balance_at_processed_amount DECIMAL(18, 2),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ,
    CONSTRAINT uk_wager_tx_provider_external UNIQUE (provider_id, external_transaction_id),
    CONSTRAINT uk_wager_tx_idempotency_key UNIQUE (idempotency_key)
);

-- Ledger Entries (Append-only)
CREATE TABLE wallet_ledger_entries (
    id UUID PRIMARY KEY,
    wallet_id UUID NOT NULL REFERENCES wallets(id),
    transaction_id UUID NOT NULL REFERENCES wager_transactions(id),
    direction VARCHAR(10) NOT NULL,
    amount DECIMAL(18, 2) NOT NULL,
    currency VARCHAR(3) NOT NULL,
    balance_before_amount DECIMAL(18, 2) NOT NULL,
    balance_after_amount DECIMAL(18, 2) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_ledger_balance_math CHECK (
        (direction = 'CREDIT' AND balance_after_amount = balance_before_amount + amount) OR
        (direction = 'DEBIT' AND balance_after_amount = balance_before_amount - amount)
    )
);

-- Trigger de Imutabilidade Ativa do Ledger
CREATE OR REPLACE FUNCTION trg_prevent_ledger_mutation()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Ledger entries are strictly immutable. UPDATE and DELETE operations are forbidden.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_ledger_immutable
BEFORE UPDATE OR DELETE ON wallet_ledger_entries
FOR EACH ROW EXECUTE FUNCTION trg_prevent_ledger_mutation();

-- Inbox
CREATE TABLE inbox_messages (
    message_id VARCHAR(128) NOT NULL,
    consumer_name VARCHAR(64) NOT NULL,
    payload_hash VARCHAR(64) NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ,
    PRIMARY KEY (consumer_name, message_id)
);

-- Outbox
CREATE TABLE outbox_messages (
    id UUID PRIMARY KEY,
    aggregate_id VARCHAR(128) NOT NULL,
    event_type VARCHAR(128) NOT NULL,
    payload JSONB NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL,
    attempts INT NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    published_at TIMESTAMPTZ
);
CREATE INDEX idx_outbox_pending ON outbox_messages (published_at, next_attempt_at, occurred_at ASC) WHERE published_at IS NULL;
CREATE INDEX idx_wager_tx_pending_ref ON wager_transactions (status, created_at ASC) WHERE status = 'PENDING_REFERENCE';
CREATE INDEX idx_ledger_wallet_cursor ON wallet_ledger_entries (wallet_id, created_at DESC, id DESC);
```

---

## 5. Estratégia de Concorrência, Idempotência e Unidade de Trabalho

### 5.1 Concorrência em Hot Wallets
- **Estratégia:** **Pessimistic Write Lock (`SELECT ... FOR UPDATE`)**.
- **Justificativa para a Apresentação:** Em iGaming, um mesmo jogador ou bot pode disparar dezenas de apostas em milissegundos. Optimistic Locking com retry geraria alto descarte de transações (exceções de colisão de versão) e desperdício de CPU/banco. O `SELECT ... FOR UPDATE` serializa perfeitamente as operações apenas na linha daquela carteira específica (`WHERE id = :walletId`), sem travar outras carteiras do sistema.

### 5.2 Algoritmo de Idempotência Canônica & Race Conditions (Erro PostgreSQL 23505)
1. **Header Obrigatório:** `Idempotency-Key` (ex.: `provider-a:round-1:tx-100`).
2. **Geração do `payloadHash`:**
   - Extrai exclusivamente os campos de negócio: `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money.amount`, `money.currency`, `referenceExternalTransactionId`.
   - Ordena alfabeticamente as chaves e serializa em JSON canônico estável (RFC 8785).
   - Computa o SHA-256 em hex de 64 caracteres.
3. **Avaliação na Requisição:**
   - Se a chave já existe:
     - `payloadHash` idêntico: Retorna a resposta histórica da transação com `"idempotentReplay": true` e HTTP 200/201.
     - `payloadHash` divergente: Retorna **HTTP 409 Conflict** (`IDEMPOTENCY_PAYLOAD_MISMATCH`), sem aplicar nenhuma modificação.
4. **Resiliência a Race Conditions Extremas (Cenário de 50 Requests Simultâneos):**
   - Caso duas requisições com a mesma chave cheguem no mesmo milissegundo, a segunda colidirá na constraint única disparando o erro nativo do PostgreSQL `23505 (unique_violation)`.
   - O handler do use case captura explicitamente o erro `23505`, aguarda com backoff curto para a transação pioneira confirmar e recupera o registro persistido retornando o replay idempotente com sucesso (`HTTP 200`).

### 5.3 Ciclo Atômico do Caso de Uso (`ProcessWagerTransactionUseCase`)
Dentro de uma única transação SQL gerenciada pelo MikroORM `em.transactional()`:
1. Registra na Inbox (se a chamada veio de SQS) ou verifica idempotency key na tabela de transações.
2. Adquire lock pessimista na `Wallet` (`em.findOne(Wallet, walletId, { lockMode: LockMode.PESSIMISTIC_WRITE })`).
3. Avalia regra de negócio da operação (`BET`, `WIN`, `REFUND`, etc.):
   - Se saldo insuficiente -> marca transação como `REJECTED` com failure code apropriado. Enfileira evento `WagerTransactionRejected` na Outbox. Commit e retorna erro de negócio.
   - Se aprovada -> `wallet.debit()` ou `wallet.credit()`, gera `WalletLedgerEntry`, atualiza status da transação para `PROCESSED`, persiste o saldo resultante na transação.
   - Enfileira eventos `WagerTransactionProcessed` e `WalletBalanceChanged` na Outbox.
4. Faz o `commit` de todas as operações atomicamente.
5. Se for SQS: executa `DeleteMessage` somente **após** o commit.

---

## 6. Mensageria Assíncrona & Resiliência (SQS + Outbox)

### 6.1 Worker do Outbox (Publisher Concorrente Seguro)
- Polling periódico ou disparado por evento no worker do Outbox.
- Query com **`FOR UPDATE SKIP LOCKED`**:
  ```sql
  SELECT * FROM outbox_messages 
  WHERE published_at IS NULL AND next_attempt_at <= NOW() 
  ORDER BY occurred_at ASC 
  LIMIT 50 
  FOR UPDATE SKIP LOCKED;
  ```
- Isso permite que **3 ou mais instâncias** da aplicação publiquem eventos do Outbox simultaneamente sem jamais tentar publicar a mesma mensagem ao mesmo tempo.
- Envia para a fila SQS. Ao obter sucesso, marca `published_at = NOW()`. Em caso de erro, incrementa `attempts` e calcula backoff exponencial com jitter aleatório (`next_attempt_at`).

### 6.2 Worker de Reprocessamento de `PENDING_REFERENCE`
- Se uma transação dependente (`REFUND` ou `ROLLBACK`) chegar antes da `BET`, ela é salva em `PENDING_REFERENCE`.
- Um worker agendado pesquisa periodicamente transações em `PENDING_REFERENCE`.
- Tenta resolver a referência. Se encontrada e processada: transiciona e aplica.
- Se ultrapassar o limite de tentativas / TTL (15 minutos): transiciona para `REJECTED` com `REFERENCE_NOT_FOUND` e grava na Outbox.

### 6.3 Graceful Shutdown Coordenado no Consumo SQS (`SIGTERM`)
- Implementação de hooks do ciclo de vida NestJS (`beforeApplicationShutdown` / `onModuleDestroy`).
- Interrompe o polling de novas mensagens imediatamente (`isPolling = false`).
- Aguarda até 10 segundos mensagens ativas concluírem seu ciclo transacional (`commit + deleteMessage`) antes do processo morrer e fechar o pool do MikroORM.

---

## 7. Catálogo Completo de Endpoints HTTP & Status Mappings

O sistema implementa 100% da malha de endpoints prescrita na Seção 9 do README:
1. `POST /wallets` — Criação da carteira (com transação `OPENING` atômica se `initialBalance > 0`). Retorna 201 ou 409 (`WALLET_ALREADY_EXISTS`).
2. `GET /wallets/:walletId` — Consulta de saldo e versão da carteira. Retorna 200 ou 404.
3. `GET /wallets/:walletId/ledger?cursor=...&limit=50` — Extrato imutável com Keyset Pagination por cursor opaco base64 (`created_at + id`).
4. `POST /wagering/transactions` — Submissão de apostas com header `Idempotency-Key` obrigatório. Retorna 201 (novo), 200 (replay), 202 (pending_reference), 400 (bad format), 409 (conflict hash), 422 (business rejection).
5. `GET /wagering/transactions/:transactionId` — Consulta de transação por identificador interno UUID.
6. `GET /providers/:providerId/wagering/transactions/:externalTransactionId` — Consulta de transação por identificador externo do provedor.
7. `POST /wallets/:walletId/reconciliation` — Auditoria contábil e reconciliação entre saldo materializado e somatório do ledger (`storedBalance`, `calculatedBalance`, `difference`, `consistent`, `checkedEntries`).
8. `GET /health/live` & `GET /health/ready` — Probes de liveness e readiness sem autenticação.

---

## 8. Arquitetura de Segurança & Autenticação (Seção 2 do README)

- **Desacoplamento via Porta:** Implementação do `ProviderIdentityPort` e `ProviderAuthGuard`.
- **Prevenção de Autenticação Artesanal:** Zero tabela de usuários com senha no banco.
- **Defesa Contra Provider Spoofing:** Validação estrita de que o `providerId` contido no payload coincide com a identidade do chamador autenticado.
- **Sanitização de Borda:** `ValidationPipe` do NestJS configurado com `whitelist: true` e `forbidNonWhitelisted: true`.
- **Prevenção de Vazamento de Informações:** `GlobalExceptionFilter` mascarando erros 500 internos e associando-os a um `correlationId`.

---

## 9. Taxonomia Completa de Códigos de Falha (`FailureCode`) & Mapeamento HTTP

| FailureCode | Significado | Status HTTP |
|---|---|---|
| `INSUFFICIENT_FUNDS` | Saldo insuficiente para efetuar o débito da aposta | 422 Unprocessable Entity |
| `IDEMPOTENCY_PAYLOAD_MISMATCH` | Idempotency Key reutilizada com dados diferentes | 409 Conflict |
| `WALLET_NOT_FOUND` | Carteira informada não existe | 404 Not Found |
| `WALLET_ALREADY_EXISTS` | Carteira já existente para o par (playerId, currency) | 409 Conflict |
| `CURRENCY_MISMATCH` | Moeda da aposta difere da moeda da carteira | 422 Unprocessable Entity |
| `REFERENCE_NOT_FOUND` | Operação de estorno refere transação inexistente (após TTL) | 422 Unprocessable Entity |
| `REFERENCE_ALREADY_REVERTED` | A transação referenciada já foi estornada anteriormente | 422 Unprocessable Entity |
| `INVALID_REFERENCE_KIND` | O tipo da transação referenciada não é compatível com o estorno | 422 Unprocessable Entity |
| `REFERENCE_ROUND_MISMATCH` | A referência pertence a outra rodada ou jogo | 422 Unprocessable Entity |
| `ROLLBACK_WOULD_CAUSE_NEGATIVE_BALANCE` | Estorno de ganho causaria saldo negativo | 422 Unprocessable Entity |
| `INVALID_MONEY_AMOUNT` | Valor monetário inválido (negativo, mais de 2 casas, NaN) | 400 Bad Request |
| `INVALID_TRANSACTION_STATE` | Tentativa ilegal de transicionar estado terminal | 422 Unprocessable Entity |
| `PROVIDER_IDENTITY_MISMATCH` | Provedor autenticado difere do providerId do payload | 403 Forbidden |

---

## 10. Estratégia de Testes Automatizados & Diferencial de Carga

### 10.1 Testes Unitários (`bun test`)
- Validações completas de `Money`: arredondamento, escala, soma, subtração, rejeição de strings inválidas.
- Invariantes de `Wallet`: recusa de saldo negativo, incremento de versão condicional.
- Validações de `WalletLedgerEntry`: verificação matemática estrita de `balanceBefore ± amount == balanceAfter`.
- Cálculo de hash canônico determinístico com RFC 8785.

### 10.2 Testes de Integração com Infraestrutura Real (Docker)
- Setup conectando no PostgreSQL e LocalStack SQS reais do Docker Compose.
- Validação das constraints do banco e trigger de imutabilidade.
- Teste de reversibilidade total de migrações (`migrator.down({ to: 0 })`).
- Verificação de atomicidade do UoW: se a gravação do Outbox falhar, o saldo não pode mudar nem o ledger ser gravado.

### 10.3 Testes de Concorrência & Paralelismo Real (Os 8 Cenários da Seção 13)
1. **50 requisições simultâneas com a mesma aposta:** Exatamente 1 débito é aplicado, 49 recebem o replay idempotente; saldo e ledger finais íntegros.
2. **Disputa de Hot Wallet (Seção 8):** Saldo 100.00 BRL. Duas apostas de 80.00 BRL simultâneas em workers distintos. Exatamente 1 processa e 1 é rejeitada; saldo final 20.00 BRL e 1 único débito no ledger.
3. **Wallets Distintas em Paralelo:** Múltiplas wallets operando sem contenção mútua.
4. **Múltiplos Processos (≥ 3 instâncias):** Simulação de 3 workers competindo pela mesma fila e banco.
5. **Crash Simulation pós-commit antes do ACK:** Worker morre logo após commit; a mensagem volta da visibilidade e é descartada pelo Inbox sem duplicar saldo.
6. **Publishers Concorrentes de Outbox:** Dois processos rodando o loop de outbox simultaneamente; cada evento é enviado exatamente uma vez para o broker.
7. **Ordem Invertida:** `REFUND` chega antes da `BET`; validação do status `PENDING_REFERENCE` e posterior resolução pelo worker.
8. **Invariante Global:** Em todos os testes, assert obrigatório: `wallet.balance == SUM(credits) - SUM(debits)`.

### 10.4 Diferencial de Alta Performance: Teste de Carga (`bun run test:load`)
- Script de estresse com métricas de p50, p95, p99, throughput e outbox lag, enriquecendo o diferencial opcional da Seção 14.

---

## 11. Roteiro de Execução Passo a Passo

- [ ] **Passo 1:** Instalar Bun localmente e inicializar projeto NestJS estruturado.
- [ ] **Passo 2:** Configurar `docker-compose.yml` (PostgreSQL 16 com healthcheck + LocalStack com SQS FIFO).
- [ ] **Passo 3:** Implementar o núcleo de domínio (`Money`, `Wallet`, `WagerTransaction`, `WalletLedgerEntry`).
- [ ] **Passo 4:** Configurar MikroORM, migração inicial com todas as constraints, trigger de imutabilidade e custom types para `Money`.
- [ ] **Passo 5:** Implementar o caso de uso de processamento de transações com lock pessimista, hash canônico e tratamento de erro 23505.
- [ ] **Passo 6:** Implementar Inbox & Outbox Pattern com query `SKIP LOCKED` e backoff com jitter.
- [ ] **Passo 7:** Construir os controladores HTTP (`/wallets`, `/wagering/transactions`, `/reconciliation`, `/health`) e paginação por cursor do ledger.
- [ ] **Passo 8:** Implementar o SQS Consumer com ack pós-commit, graceful shutdown e worker de `PENDING_REFERENCE`.
- [ ] **Passo 9:** Implementar a suíte completa de testes (unitários, integração e concorrência com 50x paralelos).
- [ ] **Passo 10:** Implementar o script de teste de carga (`bun run test:load`) e redigir `ARCHITECTURE.md` cobrindo todas as justificativas.
