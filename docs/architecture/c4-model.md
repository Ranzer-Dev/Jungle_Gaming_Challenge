# Arquitetura do Sistema — Modelo C4

Este documento descreve a arquitetura do **Distributed Wagering Processor** utilizando os 3 primeiros níveis do **C4 Model** (Contexto, Containers e Componentes), facilitando o entendimento de fluxos e limites de responsabilidade.

---

## Nível 1: Diagrama de Contexto (System Context)

Mostra o sistema em relação aos atores externos, provedores de jogos e ecossistema de infraestrutura.

```mermaid
flowchart TD
    subgraph Atores Externos
        P[Game Provider / Provedor de Jogos<br/><i>Evolution, Pragmatic, Spribe</i>]
        U[Player / Jogador]
        BO[Backoffice / Compliance & Auditoria]
    end

    subgraph Nosso Sistema
        SYS["Distributed Wagering Processor<br/><b>(NestJS + Bun + PostgreSQL + SQS)</b><br/>Processamento financeiro de alta concorrência e reconciliação"]
    end

    subgraph Infraestrutura & Segurança Externa
        IDP[Identity Provider - IdP<br/><i>Keycloak / Zitadel / OIDC</i>]
    end

    P -- "Envia transações HTTP (POST /wagering/transactions)<br/>Idempotency-Key" --> SYS
    P -- "Publica apostas em filas de eventos (SQS FIFO)" --> SYS
    U -- "Cria carteira e consulta saldo" --> SYS
    BO -- "Audita extrato e executa reconciliação (/reconciliation)" --> SYS
    SYS -. "Valida identidade e claims" .-> IDP
```

---

## Nível 2: Diagrama de Containers

Mostra a decomposição em aplicações executáveis, bancos de dados e sistemas de mensageria rodando no ambiente Docker Compose.

```mermaid
flowchart TB
    subgraph Provedores
        PROV[Game Provider API]
    end

    subgraph Sistema Distribuído
        subgraph Cluster da Aplicação
            API1["NestJS App (Instância 1)<br/><i>HTTP API + Worker</i>"]
            API2["NestJS App (Instância 2)<br/><i>HTTP API + Worker</i>"]
            API3["NestJS App (Instância 3)<br/><i>HTTP API + Worker</i>"]
        end

        subgraph Camada de Dados
            PG[(PostgreSQL 16 Relational DB<br/><i>Wallets, Ledger, Transactions,<br/>Inbox & Outbox Tables</i>)]
        end

        subgraph Camada de Mensageria
            SQS_IN["AWS SQS: wager-transactions.fifo<br/><i>Fila de entrada de apostas</i>"]
            SQS_DLQ["AWS SQS: wager-transactions-dlq.fifo<br/><i>Dead-Letter Queue de falhas</i>"]
            SQS_OUT["AWS SQS: integration-events.fifo<br/><i>Fila de eventos de integração publicados</i>"]
        end
    end

    PROV -- "HTTP POST" --> API1
    PROV -- "HTTP POST" --> API2
    PROV -- "Enfileira mensagens" --> SQS_IN

    API1 -- "Consome (Polling com ACK pós-commit)" --> SQS_IN
    API2 -- "Consome (Polling com ACK pós-commit)" --> SQS_IN
    API3 -- "Consome (Polling com ACK pós-commit)" --> SQS_IN

    API1 -- "SELECT ... FOR UPDATE (Transacional)" --> PG
    API2 -- "SELECT ... FOR UPDATE (Transacional)" --> PG
    API3 -- "SELECT ... FOR UPDATE (Transacional)" --> PG

    API1 -- "Outbox Worker (SKIP LOCKED) publica" --> SQS_OUT
    API2 -- "Outbox Worker (SKIP LOCKED) publica" --> SQS_OUT

    API1 -. "Falha após retries máximos" .-> SQS_DLQ
```

---

## Nível 3: Diagrama de Componentes (Clean Architecture)

Decomposição dos componentes internos da aplicação NestJS.

```mermaid
flowchart LR
    subgraph Adaptadores de Entrada [Primary Adapters]
        HTTP_CTRL[Wagering Controller<br/>Wallets Controller]
        SQS_CONS[SQS Consumer Worker]
    end

    subgraph Casos de Uso [Application Layer]
        UC_WAGER[ProcessWagerTransactionUseCase]
        UC_WALLET[CreateWalletUseCase]
        UC_RECON[ReconcileWalletUseCase]
    end

    subgraph Núcleo de Domínio [Domain Layer]
        AGG_WALLET[Wallet Aggregate Root]
        ENT_TX[WagerTransaction]
        ENT_LEDGER[WalletLedgerEntry]
        VO_MONEY[Money Value Object]
    end

    subgraph Adaptadores de Saída [Secondary Adapters]
        ORM_REPO[MikroORM Unit of Work<br/>PostgreSQL Repositories]
        OUTBOX_PUB[Outbox Publisher Worker]
        SQS_CLIENT[AWS SQS Client]
    end

    HTTP_CTRL --> UC_WAGER
    SQS_CONS --> UC_WAGER
    HTTP_CTRL --> UC_WALLET
    HTTP_CTRL --> UC_RECON

    UC_WAGER --> AGG_WALLET
    UC_WAGER --> ENT_TX
    UC_WAGER --> ENT_LEDGER
    AGG_WALLET --> VO_MONEY

    UC_WAGER --> ORM_REPO
    OUTBOX_PUB --> ORM_REPO
    OUTBOX_PUB --> SQS_CLIENT
```

