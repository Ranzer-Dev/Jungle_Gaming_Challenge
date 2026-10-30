# Estratégia de Migrations Versionadas e Reversíveis (PostgreSQL)

Este documento especifica a estratégia e os padrões de **Migrations Versionadas e Reversíveis** no **Distributed Wagering Processor**, em conformidade com a Seção 4 ("Stack Obrigatória") e Seção 13 do `README.md`.

---

## 1. Princípios Fundamentais

1. **Versionamento Estrito & Determinístico:** Toda migração possui um timestamp único e sequencial (ex: `Migration20261030080000_InitWageringSchema.ts`), gerenciada através do MikroORM Migrator CLI.
2. **Reversibilidade Obrigatória (Two-Way Migrations):** Para cada método `up()` (aplicação), existe um método `down()` rigoroso que desfaz exatamente a alteração, permitindo rollback limpo de schema sem deixar resíduos.
3. **Idempotência & Transacionalidade:** Migrações rodam dentro de transações DDL do PostgreSQL (`BEGIN ... COMMIT`). Se uma instrução falhar, o schema sofre rollback completo.
4. **Execução Automática na Inicialização:** O container da aplicação (ou um container de job de inicialização) executa `mikro-orm migration:up` antes de abrir a porta HTTP ou iniciar os workers SQS.

---

## 2. Mapa Sequencial de Migrações

### Migração 01: `InitCoreSchema` (Tabelas Base e Constraints Físicas)
- Criação das tabelas: `wallets`, `wager_transactions`, `wallet_ledger_entries`, `inbox_messages`, `outbox_messages`.
- **Constraints Físicas Obrigatórias:**
  - `wallets`:
    - `CONSTRAINT uk_wallet_player_currency UNIQUE (player_id, currency)`
    - `CONSTRAINT chk_wallet_balance_non_negative CHECK (balance_amount >= 0)`
  - `wager_transactions`:
    - `CONSTRAINT uk_wager_tx_provider_external UNIQUE (provider_id, external_transaction_id)`
    - `CONSTRAINT uk_wager_tx_idempotency_key UNIQUE (idempotency_key)`
  - `inbox_messages`:
    - `PRIMARY KEY (consumer_name, message_id)`
  - `wallet_ledger_entries`:
    - `CONSTRAINT chk_ledger_balance_math CHECK ((direction = 'CREDIT' AND balance_after_amount = balance_before_amount + amount) OR (direction = 'DEBIT' AND balance_after_amount = balance_before_amount - amount))`

### Migração 02: `AddLedgerImmutabilityTrigger` (Proteção Ativa do Ledger)
- Criação da função plpgsql `trg_prevent_ledger_mutation()`.
- Criação do trigger `trg_ledger_immutable` bloqueando fisicamente `UPDATE` e `DELETE` em `wallet_ledger_entries`.
- **Método `down()`:** `DROP TRIGGER trg_ledger_immutable ON wallet_ledger_entries; DROP FUNCTION trg_prevent_ledger_mutation;`.

### Migração 03: `AddPerformanceIndexes` (Índices para Hot Wallets e Polling SKIP LOCKED)
- Índice parcial para o Transactional Outbox:
  ```sql
  CREATE INDEX idx_outbox_pending ON outbox_messages (published_at, next_attempt_at, occurred_at ASC) 
  WHERE published_at IS NULL;
  ```
- Índice para resolução de referências fora de ordem:
  ```sql
  CREATE INDEX idx_wager_tx_pending_reference ON wager_transactions (status, created_at ASC) 
  WHERE status = 'PENDING_REFERENCE';
  ```
- Índice para busca de referência externa:
  ```sql
  CREATE INDEX idx_wager_tx_provider_reference ON wager_transactions (provider_id, external_transaction_id);
  ```
- Índice para paginação de ledger estável por keyset (cursor):
  ```sql
  CREATE INDEX idx_ledger_wallet_cursor ON wallet_ledger_entries (wallet_id, created_at DESC, id DESC);
  ```

---

## 3. Teste Automatizado de Reversibilidade

Na suíte de testes de integração (`bun test:integration`), existe um teste específico que valida a reversibilidade das migrações:
1. Executa todas as migrações: `migrator.up()`.
2. Valida a criação das tabelas e constraints.
3. Executa o rollback total: `migrator.down({ to: 0 })`.
4. Valida que o schema voltou ao estado limpo original sem erros de chave estrangeira ou dependências presas.
5. Re-executa `migrator.up()`.

