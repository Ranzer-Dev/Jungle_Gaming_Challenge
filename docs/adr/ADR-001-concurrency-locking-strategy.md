# ADR-001: Estratégia de Concorrência e Lock por Carteira

## Status
Aprovado

## Contexto
O **Distributed Wagering Processor** opera em um ambiente de alto rendimento no segmento de iGaming, onde múltiplos provedores de jogos e clientes disparam operações financeiras (`BET`, `WIN`, `REFUND`) simultaneamente. Uma mesma carteira de jogador ("hot wallet") pode sofrer dezenas de transações concorrentes por segundo.

O sistema deve garantir de forma inviolável:
1. **Prevenção de Lost Updates:** Nenhuma atualização de saldo pode ser sobrescrita por uma transação paralela.
2. **Saldo Não Negativo:** Uma carteira nunca pode ficar com saldo negativo em hipótese alguma.
3. **Escalabilidade Horizontal:** O mecanismo de lock deve funcionar perfeitamente quando 3 ou mais instâncias da aplicação estão rodando em paralelo.
4. **Isolamento de Carteiras:** O lock em uma carteira `A` não pode degradar nem bloquear as operações na carteira `B`.

## Decisão
Adotamos **Pessimistic Write Locking (`SELECT ... FOR UPDATE`)** no nível da linha da tabela `wallets` no PostgreSQL, gerenciado pela transação do MikroORM `em.transactional({ lockMode: LockMode.PESSIMISTIC_WRITE })`.

### Mecânica de Execução:
1. Ao receber uma transação para a `walletId`, a aplicação abre uma transação SQL e executa:
   ```sql
   SELECT * FROM wallets WHERE id = :walletId FOR UPDATE;
   ```
2. O PostgreSQL adquire um lock exclusivo na linha daquela carteira específica.
3. Qualquer outra transação concorrente destinada à mesma `walletId` aguarda a liberação do lock (ou atinge timeout se configurado).
4. O saldo atualizado é verificado na memória do aggregate `Wallet`, as regras de negócio são aplicadas, o ledger é gerado e o commit libera a linha para o próximo competidor.

## Alternativas Avaliadas e Rejeitadas

### 1. Optimistic Locking com Campo `version` e Retry
- **Como funcionaria:** Ler a carteira sem lock, calcular novo saldo e executar `UPDATE wallets SET balance = :new, version = version + 1 WHERE id = :id AND version = :oldVersion`. Se zero linhas afetadas, tentar novamente com retry exponencial.
- **Por que foi rejeitada:** Em cenários de hot wallet (ex: 50 requests simultâneas para o mesmo jogador em um jogo de crash/slots rápidos), o optimistic locking gera uma tempestade de colisões (49 requisições falham na primeira tentativa). O overhead de retry repetitivo satura a CPU da aplicação e o pool de conexões do banco de dados, degradando a latência p99. O lock pessimista serializa as 50 requests com fila ordenada pelo próprio motor de concorrência do PostgreSQL.

### 2. Lock Distribuído via Redis (Redlock)
- **Por que foi rejeitada:** Viola a Seção 5 do desafio ("Não usar cache em memória como garantia"). Adiciona um ponto único de falha e complexidade operacional desnecessária, já que o PostgreSQL já é a fonte autoritativa da transação financeira.

## Consequências
- **Positivas:**
  - Garantia ACID absoluta garantida pelo motor transacional do PostgreSQL.
  - Zero risco de saldo negativo por concorrência.
  - Independe do número de instâncias da aplicação em execução.
  - Granularidade fina: apenas a carteira em operação é bloqueada; todas as outras carteiras do sistema continuam operando em paralelo com throughput máximo.
- **Negativas/Mitigações:**
  - Transações na mesma carteira são serializadas (comportamento desejado e mandatório para consistência contábil).
  - Timeout de lock deve ser configurado no banco (`SET lock_timeout = '3s'`) para evitar contenção infinita em caso de falha de rede.

