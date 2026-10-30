# ADR-005: Resiliência em Falhas de Infraestrutura, Shutdown e Backoff

## Status
Aprovado

## Contexto
A Seção 3 e a Seção 10 do `README.md` estabelecem premissas realistas de sistemas distribuídos:
> *"PostgreSQL e SQS podem ficar temporariamente indisponíveis."*
> *"O processo pode morrer antes ou depois do commit."*
> *"Eventos podem ser publicados mais de uma vez."*
> *"Distinguir erros de negócio (terminal, ack), transitórios (retry com backoff) e permanentes (DLQ)."*

Em um ambiente de alta concorrência com múltiplas instâncias no Docker Compose/Kubernetes, quedas momentâneas de rede ou reinicializações de pods (*rolling updates*) não podem:
1. Causar duplicação de saldo;
2. Deixar mensagens presas na fila em deadlock;
3. Fazer o processo cair em loop sem tentar se reconectar (*crash loops* descontrolados);
4. Perder mensagens do Transactional Outbox.

---

## Decisão

Adotamos uma estratégia formal de **Resiliência em Três Níveis**:

### 1. Política de Retry com Exponential Backoff & Jitter
Para falhas transitórias de infraestrutura (timeout do banco, lock timeout transitório, indisponibilidade temporária de rede com o LocalStack SQS):
- **Algoritmo de Espera:**
  ```text
t_wait = min(t_max, t_base * 2^attempt) ± jitter
```
- O **Jitter aleatório** (variação de ±20%) é mandatório para evitar o fenômeno da *Thundering Herd* (onde dezenas de instâncias ou workers tentam reconectar exatamente no mesmo milissegundo, derrubando o banco recém-recuperado).
- **Parâmetros:**
  - `t_base = 100 ms`
  - `t_max = 30 s`
  - `maxAttempts = 5` para o worker de Outbox antes de registrar alerta crítico de lag.

### 2. Recuperação Pós-Crash no Consumidor SQS (At-Least-Once Delivery)
- O consumidor opera sob **Commit Before ACK**:
  - Cenário A: O processo morre **antes do commit** do PostgreSQL -> a transação sofre rollback automático no banco. O SQS aguarda o `VisibilityTimeout` expirar e entrega a mensagem para outra instância viva. Saldo não foi afetado.
  - Cenário B: O processo morre **depois do commit e antes do ACK** -> o saldo foi alterado e o registro na tabela `inbox_messages` foi comitado atomicamente. Quando a mensagem volta pelo SQS, a nova instância consulta o Inbox, detecta `isProcessed() === true`, emite o `DeleteMessage` imediatamente e **não reprocessa a carteira**.

### 3. Graceful Shutdown Coordenado (`SIGTERM` / `SIGINT`)
Quando o container recebe sinal de parada do orquestrador:
1. **Fase 1 (Deregistration):** O endpoint `/health/ready` passa imediatamente a retornar **HTTP 503**, fazendo o balanceador de carga parar de enviar novas requisições HTTP.
2. **Fase 2 (Drenagem do SQS):** O loop de polling do SQS Consumer é desativado (`isPolling = false`). Nenhuma nova chamada `ReceiveMessage` é realizada.
3. **Fase 3 (Conclusão Transacional):** Concede-se uma janela de graça de até **10 segundos** para que os workers concluam os commits ativos e os acks correspondentes.
4. **Fase 4 (Fechamento de Recursos):** O MikroORM fecha o pool de conexões do PostgreSQL de forma ordenada (`orm.close()`).

---

## Consequências
- **Positivas:**
  - Resiliência comprovada contra crashes e quedas de rede.
  - Zero duplicação financeira em caso de reinicialização abrupta de instâncias.
  - Ausência de picos de sobrecarga no banco após indisponibilidade temporária.
- **Negativas/Mitigações:**
  - Em crashes severos pós-commit, a mensagem fica indisponível até o timeout de visibilidade do SQS (configurado em 15s) antes de ser limpa pelo Inbox.

