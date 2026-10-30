# AGENTS.md — Regras de Governança, Padrões Técnicos e Invariantes

Este documento é a diretriz mestre obrigatória para o agente de IA neste repositório. Toda alteração, design de código, refatoração e documentação deve obedecer estritamente aos princípios e guardrails aqui definidos.

---

## 1. Missão Principal

Construir o **Distributed Wagering Processor** para a **Jungle Gaming** com excelência técnica de nível Staff/Principal Engineer (100/100 na avaliação), garantindo:
1. **Correção financeira absoluta** e consistência estrita entre saldo materializado e ledger.
2. **Resiliência a concorrência extrema** (múltiplas instâncias, hot wallets, deduplicação em milissegundos).
3. **Domínio DDD Puro e Desacoplado** (sem anemic models, sem decorators de ORM no domínio).
4. **Capacitação total do desenvolvedor** para explicar e justificar com firmeza todas as decisões na apresentação técnica.

---

## 2. As 10 Leis Invioláveis (Zero Tolerância a Falhas Eliminatórias)

1. **PROIBIDO PRIMITIVOS PARA DINHEIRO:**
   - Nunca use `number`, `float` ou `double` para representar dinheiro.
   - Todo cálculo monetário deve passar exclusivamente pelo Value Object `Money` (imutável, escala fixa de 2 casas decimais, apoiado em biblioteca de precisão decimal exata como `decimal.js`).
   - No tráfego (DTOs/JSON) e na persistência: string decimal (ex: `"25.00"`).

2. **PROIBIDO IDEMPOTÊNCIA EM MEMÓRIA:**
   - Nenhuma garantia de unicidade ou deduplicação pode depender de cache local, Maps em memória ou Redis volátil.
   - Toda idempotência é garantida no **PostgreSQL** por constraints de unicidade (`UNIQUE(idempotency_key)`) e tabela `inbox_messages`.

3. **PROIBIDO CONFIANÇA CEGA EM SQS FIFO:**
   - SQS FIFO e deduplication ID do broker são apenas otimizações de transporte. O PostgreSQL é a fonte final e infalível da verdade.

4. **TRANSACTIONAL OUTBOX MANDATÓRIO (COMMIT BEFORE PUBLISH):**
   - É terminantemente proibido publicar eventos no SQS antes ou durante a transação financeira.
   - O evento de integração é gravado na tabela `outbox_messages` na mesma transação SQL da wallet e do ledger.
   - Um worker desacoplado publica no SQS após o commit com `SELECT ... FOR UPDATE SKIP LOCKED`.

5. **LEDGER 100% IMUTÁVEL (APPEND-ONLY):**
   - Lançamentos em `wallet_ledger_entries` nunca sofrem `UPDATE` ou `DELETE`.
   - Invariante estrita: `balance_after = balance_before ± amount` verificada tanto na factory quanto por `CHECK CONSTRAINT` no PostgreSQL.
   - Toda alteração de saldo gera exatamente 1 lançamento. Operações `LOSS` e transações `REJECTED` não movem saldo e não geram ledger.

6. **LOCK GRANULAR POR WALLET (PESSIMISTIC LOCKING):**
   - Proibido lock global na aplicação ou no banco.
   - A unidade de contenção é o `wallet_id`.
   - Utilizar `SELECT ... FOR UPDATE` via `EntityManager.transactional()` no MikroORM ao carregar a `Wallet`.

7. **SUPORTE A MÚLTIPLAS INSTÂNCIAS (HORIZONTALLY SCALABLE):**
   - O sistema deve operar corretamente com ≥ 3 instâncias simultâneas do serviço consumindo SQS e recebendo tráfego HTTP.
   - Zero estado compartilhado em memória de processo.

8. **SCHEMA-LEVEL CONSTRAINTS (DEFESA EM PROFUNDIDADE):**
   - As regras de negócio críticas devem ter espelho no schema do banco:
     - `CHECK (balance_amount >= 0)` na tabela `wallets`.
     - `UNIQUE(player_id, currency)` na tabela `wallets`.
     - `UNIQUE(provider_id, external_transaction_id)` na tabela `wager_transactions`.
     - `UNIQUE(idempotency_key)` na tabela `wager_transactions`.
     - `PRIMARY KEY (consumer_name, message_id)` na tabela `inbox_messages`.

9. **ZERO MOCKS NOS TESTES CRÍTICOS:**
   - Testes de integração e de concorrência rodam obrigatoriamente contra containers reais de PostgreSQL e LocalStack SQS.
   - Mocks são permitidos apenas em testes unitários puros de lógica de domínio.

10. **COMMIT BEFORE ACK NO SQS:**
    - O consumidor SQS só deleta a mensagem da fila (`DeleteMessage`) **após** o commit bem-sucedido no banco de dados.

---

## 3. Padrões de Modelagem de Domínio (DDD)

- **Construtores Fechados:** `private` ou `protected`.
- **Factories Estáticas Obrigatórias:**
  - `.create()` / `.open()`: instancia nova entidade com validação completa de regras de transição.
  - `.rehydrate()`: reconstitui entidade a partir do banco de dados sem reexecutar validações de transição.
- **Sem Modelos Anêmicos:** Propriedades privadas, leitura via getters sem setters públicos. Comportamento encapsulado nos métodos de negócio (ex: `wallet.debit()`, `transaction.markProcessed()`).
- **Domínio Desacoplado:** Classes de domínio não contêm decorators do TypeORM/MikroORM/NestJS. O mapeamento relacional deve residir na infraestrutura via `EntitySchema` do MikroORM.
- **Máquina de Estados de Transação:**
  - Estados: `PENDING`, `PENDING_REFERENCE`, `PROCESSED`, `REJECTED`, `FAILED`.
  - Estados terminais (`PROCESSED`, `REJECTED`, `FAILED`) não admitem nenhuma transição posterior. Qualquer tentativa lança `InvalidTransactionStateError`.

---

## 4. Idempotência e Tratamento de Conflitos

- **Cálculo do `payloadHash`:**
  - SHA-256 gerado a partir de um JSON canônico (chaves ordenadas lexicograficamente) dos campos estritos de negócio:
    `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money.amount`, `money.currency`, `referenceExternalTransactionId`.
- **Regra de Decisão:**
  - Mesma `Idempotency-Key` + mesmo `payloadHash` = **Replay Idempotente** (retorna a resposta original com `idempotentReplay: true` e saldo da época, HTTP 200/201).
  - Mesma `Idempotency-Key` + `payloadHash` divergente = **Conflito de Idempotência** (lança erro de domínio mapeado para **HTTP 409 Conflict**, sem alterar nada).
  - Race condition de requests idênticos em paralelo: a constraint única do PostgreSQL dispara erro `23505`; o handler deve capturar e tratar como replay idempotente após aguardar a transação pioneira confirmar.

---

## 5. Tratamento de Erros e Taxonomia de `FailureCode`

Toda rejeição por regra de negócio deve produzir um `failureCode` padronizado e auditável:
- `INSUFFICIENT_FUNDS` (422)
- `IDEMPOTENCY_PAYLOAD_MISMATCH` (409)
- `WALLET_NOT_FOUND` (404)
- `WALLET_ALREADY_EXISTS` (409)
- `CURRENCY_MISMATCH` (422)
- `REFERENCE_NOT_FOUND` (422)
- `REFERENCE_ALREADY_REVERTED` (422)
- `INVALID_REFERENCE_KIND` (422)
- `REFERENCE_ROUND_MISMATCH` (422)
- `ROLLBACK_WOULD_CAUSE_NEGATIVE_BALANCE` (422)
- `INVALID_MONEY_AMOUNT` (400)
- `INVALID_TRANSACTION_STATE` (422)
- `PROVIDER_IDENTITY_MISMATCH` (403)

---

## 6. Padrões de Qualidade de Código & Prevenção de Anti-Patterns (Clean Code, SOLID & DRY)

### 6.1 Princípios SOLID na Arquitetura
- **S — Single Responsibility Principle (SRP):** Cada classe e módulo possui uma única razão para mudar. A `Wallet` gerencia apenas regras de saldo; `WalletLedgerEntry` gerencia apenas o extrato imutável; Casos de Uso (`UseCases`) orquestram a unidade de trabalho sem regras de transporte.
- **O — Open/Closed Principle (OCP):** Aberto para extensão, fechado para modificação. O envelope `IntegrationEvent<T>` é abstrato; novos eventos são criados por extensão de subclasses tipadas, sem mutação no envelope base.
- **L — Liskov Substitution Principle (LSP):** O sistema opera orientado a contratos e portas (ex: `ProviderIdentityPort`); implementações reais e de teste (OIDC vs NoOp) são intercambiáveis sem quebrar o fluxo.
- **I — Interface Segregation Principle (ISP):** Interfaces coesas, granulares e específicas para cada necessidade de consumidor, evitando interfaces "gordas" e genéricas.
- **D — Dependency Inversion Principle (DIP):** O domínio e a aplicação nunca dependem de detalhes de infraestrutura. Dependências de persistência, mensageria e autenticação são injetadas estritamente através de abstrações/interfaces (Portas).

### 6.2 Princípio DRY Consciente (Business DRY vs Acidental Structural Duplication)
- **O DRY Aplica-se à Lógica de Conhecimento de Negócio:**
  - Centralização absoluta das regras financeiras e operações no Value Object `Money`.
  - Reutilização obrigatória do **mesmo Caso de Uso** (`ProcessWagerTransactionUseCase`) para a entrada HTTP e o consumidor SQS.
- **PROIBIDO DRY Acidental (Falso DRY Estrutural):**
  - O DRY **NUNCA** deve acoplar camadas com propósitos e ciclos de vida distintos só porque os campos "parecem iguais por coincidência".
  - **Exemplo Proibido:** Compartilhar o mesmo DTO da requisição HTTP (`ProcessTransactionRequest`) como contrato do evento de saída da Outbox (`IntegrationEventData`). Eles evoluem por razões diferentes e têm clientes diferentes.
  - A independência arquitetural e a clareza de limites (SRP) superam qualquer reaproveitamento ingênuo de interfaces entre camadas.

### 6.3 TypeScript Estrito & Tipagem Segura
- **Proibido `any` e Proibido `as unknown as ...`:** O código deve compilar em modo estrito (`noImplicitAny: true`, `strictNullChecks: true`).
- **Proibido Non-Null Assertions (`!`):** Nunca use `wallet!.balance` ou `tx!.id`. Trate sempre valores nulos ou indefinidos explicitamente com guard clauses defensivas (`if (!wallet) throw ...`).
- **Tipagem Estrita de Exceções:** Em blocos `catch`, declare `catch (error: unknown)` e use type guards seguros (`if (error instanceof DomainError)`).

### 6.4 Separação de Camadas & Limites Arquiteturais
- **Proibido Injeção de Repositório em Controllers:** Controllers HTTP orquestram exclusivamente chamando Casos de Uso (`UseCases`). Nenhuma regra transacional ou SQL reside nos controllers.
- **Proibido Vazamento de Entidades:** Nunca retorne instâncias diretas de entidades de domínio ou do MikroORM para respostas HTTP ou eventos de mensageria. Use sempre DTOs ou interfaces de resposta explícitas (Read Models).
- **Desacoplamento de Protocolo (Zero `HttpException` no Domínio):** O domínio e a aplicação lançam subclasses de `DomainError`. A camada de apresentação possui um `GlobalExceptionFilter` que traduz deterministamente erros de domínio para status HTTP e respostas JSON com `failureCode`.

### 6.5 Observabilidade & Logging Estruturado
- **Proibido `console.log()` ou `console.error()`:** Todo log é emitido via logger estruturado injetado do NestJS em formato JSON, contendo metadados de contexto (`correlationId`, `walletId`, `transactionId`).
- **Zero Vazamento de Dados Sensíveis:** Proibido logar payloads brutos que exponham segredos, tokens de autenticação ou dados confidenciais do jogador.

### 6.6 Tratamento de Tempo e Datas
- Todas as operações temporais devem utilizar **UTC** estrito. No PostgreSQL: `TIMESTAMPTZ`; nas respostas JSON e eventos: strings ISO-8601 (`YYYY-MM-DDTHH:mm:ss.sssZ`).
- Proibida manipulação ingênua de fusos horários locais.

### 6.7 Estrutura de Pastas e Nomenclatura
- Padrão **kebab-case** obrigatório para todos os nomes de arquivos:
  - `wallet.aggregate.ts`
  - `wager-transaction.entity.ts`
  - `wallet-ledger-entry.entity.ts`
  - `process-wager-transaction.use-case.ts`
  - `wager-transaction.controller.ts`
- Estrutura modular limpa:
  ```
  src/
  ├── domain/          # Entidades puras, Value Objects, Erros de domínio, Eventos (Zero dependências externas)
  ├── application/     # Casos de uso, DTOs de comando/consulta, Portas de repositórios e serviços
  ├── infrastructure/  # MikroORM schemas, Migrations, AWS SQS client, Adaptadores de persistência
  └── presentation/    # NestJS Controllers, SQS Consumers, Exception Filters, Interceptors
  ```

---

## 7. Protocolo Anti-Alucinação & Tomada de Decisão Compartilhada (Obrigatório)

Para garantir que o agente **nunca alucine**, **nunca invente regras por conta própria** e **nunca tome decisões arquiteturais sem a aprovação explícita do desenvolvedor**:

1. **PROIBIDO INVENTAR REGRAS OU SUPOSIÇÕES:**
   - O agente está terminantemente proibido de adicionar regras de negócio, campos de banco de dados, bibliotecas não homologadas ou alterar fluxos descritos no `README.md` sem consentimento prévio.
   - Toda implementação deve ter ancoragem explícita nas especificações da pasta `docs/` e no `README.md`.

2. **OBRIGATORIEDADE DE CONSULTA EM CASO DE AMBIGUIDADE:**
   - Sempre que surgir uma dúvida, lacuna ou mais de um caminho técnico possível (Caminho A vs Caminho B vs Caminho C):
     - **O agente DEVE PARAR a execução de código.**
     - **Apresentar com clareza os caminhos alternativos**, explicando os prós, os contras e o impacto arquitetural de cada um.
     - **Aguardar a decisão explícita do desenvolvedor** antes de prosseguir com qualquer alteração no código.

3. **VERIFICAÇÃO PASSO A PASSO (HUMAN-IN-THE-LOOP):**
   - Cada fase ou bloco de código deve ser explicado com transparência antes ou logo após a implementação.
   - Qualquer refatoração ou desvio de plano exige validação conjunta.
