# Guia de Apresentação Técnica & Defesa de Arquitetura (Jungle Gaming)

Este documento foi preparado especificamente para você estudar antes da entrevista técnica com o time de engenharia da **Jungle Gaming**. Ele sintetiza as perguntas mais prováveis da banca avaliadora e a argumentação técnica de alto nível que você deve utilizar.

---

## 1. Concorrência e Isolamento

### Pergunta 1: *"Por que você escolheu Pessimistic Locking (`SELECT ... FOR UPDATE`) em vez de Optimistic Locking com campo `version` para a Wallet?"*
> **Sua Resposta:**
> "Em iGaming e plataformas de apostas, o comportamento dos jogadores é caracterizado por altíssima frequência de requisições na mesma carteira (por exemplo, jogos de crash ou slots rápidos onde ocorrem várias apostas em frações de segundo, ou requisições paralelas vindas de bots e retries de rede).
> 
> Se usássemos **Optimistic Locking**, sob uma carga de 50 requisições simultâneas para o mesmo jogador, 49 falhariam na primeira tentativa por colisão de versão. Isso exigiria uma tempestade de retries na aplicação, saturando a CPU e o pool de conexões do PostgreSQL com transações descartadas.
> 
> O **Pessimistic Locking (`SELECT ... FOR UPDATE`)** resolve isso com máxima eficiência: ele serializa a fila de apostas daquela carteira específica diretamente no motor do PostgreSQL. Como o lock é estritamente na linha daquela `wallet_id`, nenhuma outra carteira do sistema é afetada, e eliminamos 100% dos lost updates sem overhead de retries repetidos."

---

## 2. Idempotência e Tratamento de Conflito

### Pergunta 2: *"Como o sistema diferencia um replay idempotente de uma tentativa de fraude ou requisição concorrente?"*
> **Sua Resposta:**
> "Nós implementamos o algoritmo de **Hash Canônico**. 
> Quando uma requisição chega com um header `Idempotency-Key`:
> 1. Extraímos apenas os campos de negócio (removendo headers de transporte e metadados efêmeros).
> 2. Ordenamos alfabeticamente as chaves e geramos um JSON determinístico.
> 3. Calculamos o SHA-256 desse payload (`payloadHash`).
> 
> Se a mesma `Idempotency-Key` já existir no banco:
> - Se o `payloadHash` for idêntico: Trata-se de um **Replay Idempotente legítimo**. Retornamos exatamente a resposta persistida na época com `"idempotentReplay": true` e o saldo histórico observado.
> - Se o `payloadHash` for diferente: Trata-se de um **Conflito de Idempotência**. Rejeitamos com **HTTP 409 Conflict** (`IDEMPOTENCY_PAYLOAD_MISMATCH`), impedindo que alguém tente reaproveitar uma chave para alterar valores ou destinatários.
> 
> E caso duas requisições com a mesma chave cheguem exatamente no mesmo milissegundo, a constraint única no PostgreSQL (`UNIQUE(idempotency_key)`) atua como guardião físico, impedindo duas inserções."

---

## 3. Mensageria e Transactional Outbox

### Pergunta 3: *"Por que não publicar o evento no SQS direto no controller ou service logo após salvar no banco?"*
> **Sua Resposta:**
> "Porque isso violaria a Restrição Inviolável nº 4 do desafio e o princípio da consistência distribuída (antipattern Dual-Write). Se o banco confirmar o commit e a aplicação cair antes de enviar para o SQS, o evento é perdido para sempre. Pior: se publicarmos antes do commit e o banco der rollback, geramos um evento fantasma no broker.
> 
> Nós implementamos o **Transactional Outbox**: a gravação da carteira, do ledger, da transação e da tabela `outbox_messages` ocorre na **mesmíssima transação SQL**. O commit é atômico.
> 
> Em seguida, um worker desacoplado faz polling com **`SELECT ... FOR UPDATE SKIP LOCKED`**. Isso garante que múltiplas instâncias da nossa aplicação possam publicar eventos simultaneamente sem lock mútuo e sem duplicar trabalho. E só deletamos a mensagem ou marcamos como publicada após a confirmação do SQS."

---

## 4. Consistência e Auditoria Contábil

### Pergunta 4: *"Como você garante que o saldo materializado da carteira nunca divirja dos lançamentos do extrato?"*
> **Sua Resposta:**
> "Garantimos em três camadas de defesa:
> 1. **No Domínio:** A classe imutável `WalletLedgerEntry` valida na factory estática que `balanceAfter = balanceBefore ± amount`. Não existem métodos setters; o lançamento é imutável.
> 2. **No Schema do Banco:** Criamos uma `CHECK CONSTRAINT` no PostgreSQL que valida matematicamente a consistência entre saldo anterior, valor da operação e saldo posterior na tabela de ledger. Além disso, criamos a constraint `CHECK (balance_amount >= 0)` na tabela de carteiras para impedir matematicamente qualquer saldo negativo.
> 3. **Na Reconciliação:** Disponibilizamos o endpoint `POST /wallets/:walletId/reconciliation`, que calcula em tempo real o somatório $\sum \text{Créditos} - \sum \text{Débitos}$ do ledger e compara com o campo `balance_amount` da carteira, reportando qualquer anomalia sem acobertar divergências."

---

## 5. Mensagens Fora de Ordem e Resiliência

### Pergunta 5: *"O que acontece se um `REFUND` ou `ROLLBACK` chegar na fila antes da `BET` original?"*
> **Sua Resposta:**
> "Como a entrega em sistemas distribuídos é at-least-once e pode ocorrer fora de ordem, o sistema não rejeita nem descarta imediatamente a operação.
> 
> Quando o use case percebe que a referência externa não foi encontrada, ele persiste a transação com o status **`PENDING_REFERENCE`**. 
> Temos um worker agendado com backoff exponencial que reprocessa essas transações pendentes. Quando a `BET` finalmente é processada, a próxima iteração do worker resolve a dependência e aplica o estorno. Caso o TTL (15 minutos) expire sem que a referência apareça, a transação transiciona para o estado terminal `REJECTED` com o failure code `REFERENCE_NOT_FOUND`."

---

## 6. Autenticação e Segurança de Borda (Seção 2 do README)

### Pergunta 6: *"Por que vocês não criaram uma tabela de usuários com login e senha para a API?"*
> **Sua Resposta:**
> "Porque o `README.md` (Seção 2) proíbe expressamente autenticação artesanal em um serviço financeiro de agregação B2B. Provedores de jogos não são pessoas físicas preenchendo formulários; são sistemas corporativos integrando máquina-a-máquina.
> 
> Nossa arquitetura adota o **`ProviderIdentityPort`** seguindo Ports & Adapters (Hexagonal Architecture). O desenho para produção integra com um Identity Provider externo corporativo (como Keycloak ou Zitadel via OAuth2 Client Credentials com tokens JWT RS256 validados via JWKS). 
> 
> Além disso, implementamos **Defesa em Profundidade contra Provider Spoofing**: o `ProviderAuthGuard` garante que um token emitido para o `provider-a` nunca consiga submeter transações declarando `providerId: 'provider-b'`. As bordas são sanitizadas com `ValidationPipe (whitelist + forbidNonWhitelisted)` e rate limiting defensivo, sem poluir o domínio com regras de transporte."
