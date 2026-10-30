# ADR-002: Publicação Confiável com Transactional Outbox e Deduplicação com Inbox

## Status
Aprovado

## Contexto
Em sistemas distribuídos orientados a eventos, uma operação de aposta deve persistir o débito financeiro e notificar os consumidores externos (broker SQS). 

Se aplicarmos o antipattern do **Dual-Write** (escrever no PostgreSQL e logo em seguida disparar mensagem no SQS sem transação coordenada):
1. Se a escrita no PostgreSQL falhar após o envio ao SQS: o evento foi emitido, mas o saldo não mudou (inconsistência gravíssima).
2. Se a publicação no SQS falhar após o commit do PostgreSQL: o saldo mudou, mas o resto da plataforma nunca soube (evento perdido).
3. Se a aplicação morrer entre o commit e o envio: evento perdido.

Além disso, como o SQS oferece entrega **at-least-once**, o consumidor pode receber a mesma mensagem repetidas vezes ou fora de ordem.

## Decisão
Implementamos a combinação dos padrões **Transactional Outbox** e **Transactional Inbox**, garantindo consistência eventual confiável com entrega at-least-once sem duplicação de efeitos.

### 1. Transactional Outbox (Lado Produtor)
- Toda alteração financeira persiste a `Wallet`, o `WalletLedgerEntry`, a `WagerTransaction` e a `OutboxMessage` **na mesmíssima transação SQL**.
- Um worker independente de background consulta mensagens pendentes na outbox utilizando a query:
  ```sql
  SELECT * FROM outbox_messages 
  WHERE published_at IS NULL AND next_attempt_at <= NOW() 
  ORDER BY occurred_at ASC 
  LIMIT 50 
  FOR UPDATE SKIP LOCKED;
  ```
- **Por que `FOR UPDATE SKIP LOCKED`?** Permite que **múltiplas instâncias** da aplicação publiquem eventos simultaneamente sem competir pela mesma mensagem e sem locks travando o worker vizinho.
- O evento só é considerado despachado após retorno de sucesso do AWS SQS, momento em que marcamos `published_at = NOW()`.
- Se o SQS estiver temporariamente indisponível, a mensagem permanece no banco e o campo `next_attempt_at` é recalculado com backoff exponencial.

### 2. Transactional Inbox (Lado Consumidor)
- Ao consumir do SQS, o worker verifica e insere na tabela `inbox_messages` com chave primária composta `(consumer_name, message_id)` dentro da transação SQL do caso de uso.
- Se a mensagem já tiver sido processada anteriormente por aquele consumidor, a transação reconhece o replay e descarta o reprocessamento com segurança.
- **Commit Before Ack:** O comando `DeleteMessage` do SQS só é emitido **após** o commit da transação no PostgreSQL. Caso o processo morra antes do ack, o SQS devolverá a mensagem para visibilidade e o inbox evitará duplicar o saldo.

## Alternativas Avaliadas e Rejeitadas

### 1. Dual-Write com SQS Direto no Controller
- **Por que foi rejeitada:** Viola a Restrição Inviolável nº 4 do desafio ("Não publicar eventos antes do commit da transação financeira"). Se o banco cair ou o processo morrer, eventos são fantasmas ou perdidos.

### 2. Change Data Capture (CDC) via Debezium / Kafka Connect
- **Por que foi rejeitada:** Excelente para arquiteturas de grande porte, porém adiciona dependência de Kafka, Zookeeper/KRaft e Debezium Engine, infringindo a exigência de simplicidade e stack prescrita (PostgreSQL + SQS + Docker Compose leve).

## Consequências
- **Positivas:**
  - Garantia de que nenhum evento financeiro é perdido caso o processo caia.
  - Concorrência perfeita entre múltiplos publicadores graças ao `SKIP LOCKED`.
  - Tolerância nativa a indisponibilidade temporária do SQS.
- **Negativas/Mitigações:**
  - Ligeiro delay entre a gravação do outbox e a publicação efetiva no broker (mitigado por polling frequente de 100ms ou trigger em memória).

