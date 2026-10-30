# ADR-004: Modelo Relacional, Mapeamento do Value Object Money e Imutabilidade do Ledger

## Status
Aprovado

## Contexto
O desafio estabelece requisitos estritos de persistência e modelagem:
1. **MikroORM é o ORM preferencial**, devendo ser justificado no `ARCHITECTURE.md`.
2. O domínio não pode conter decorators de ORM (`@Entity`, `@Property`), preservando o DDD puro.
3. O Value Object `Money` deve ser mapeado com representação decimal exata (sem uso de floats).
4. O `version` da `Wallet` só pode incrementar quando o saldo muda.
5. A tabela `wallet_ledger_entries` deve ser estruturalmente imutável (append-only), com proibição de `UPDATE` e `DELETE`.
6. Validação das 5 invariantes de referência cruzada (`providerId`, `playerId`, `walletId`, `currency`, `roundId`) em `REFUND` e `ROLLBACK`.

---

## Decisão

### 1. MikroORM com `EntitySchema` e Custom Type `MoneyType`
Adotamos o **MikroORM 6.x** com a abordagem desacoplada:
- As entidades de domínio (`src/domain/`) contêm apenas TypeScript puro, Value Objects e métodos de negócio.
- O mapeamento ORM reside em `src/infrastructure/database/schemas/` através de instâncias de `EntitySchema`.
- Criamos um Custom Type nativo do MikroORM: `MoneyType` (estendendo `Type<Money, string>`), mapeando o `Money` para uma coluna PostgreSQL `NUMERIC(18, 2)` (ou colunas separadas de amount e currency), garantindo que a conversão entre string decimal exata e a classe `Money` ocorra de forma transparente no Unit of Work.

### 2. Imutabilidade do Ledger Enforced no PostgreSQL (Trigger de Proteção)
Para satisfazer a Restrição Inviolável nº 5 e a Seção 5/6 ("Imutabilidade Estrutural"), não confiamos apenas na ausência de métodos no código:
- Criamos uma trigger nativa no PostgreSQL que bloqueia fisicamente qualquer tentativa de mutação:
  ```sql
  CREATE OR REPLACE FUNCTION trg_prevent_ledger_mutation()
  RETURNS TRIGGER AS $$
  BEGIN
      RAISE EXCEPTION 'Ledger entries are strictly immutable. UPDATE and DELETE operations are forbidden.';
  END;
  $$ LANGUAGE plpgsql;

  CREATE TRIGGER trg_ledger_immutable
  BEFORE UPDATE OR DELETE ON wallet_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION trg_prevent_ledger_mutation();
  ```
- Isso garante que nem mesmo uma query acidental disparada por script de manutenção ou bug de ORM consiga violar a imutabilidade contábil.

### 3. Validação Estrita das 5 Invariantes de Referência
Na resolução de dependências de `REFUND` e `ROLLBACK`, a transação referenciada é validada contra 5 campos obrigatórios:
1. `reference.providerId === current.providerId`
2. `reference.playerId === current.playerId`
3. `reference.walletId === current.walletId`
4. `reference.currency === current.currency`
5. `reference.roundId === current.roundId`

Se qualquer um desses campos divergir:
- Se divergir de rodada: rejeita com `REFERENCE_ROUND_MISMATCH`.
- Se divergir de moeda: rejeita com `CURRENCY_MISMATCH`.
- Se divergir de jogador/provedor: rejeita com `INVALID_REFERENCE_KIND` ou `REFERENCE_NOT_FOUND`.

### 4. Controle Manual do Campo `version` da Wallet
O MikroORM suporta versionamento automático (`version: true`), porém a regra de negócio da Jungle Gaming (README Linha 209) exige:
> *"version inicia em 1 após a criação e incrementa **somente quando o saldo muda**."*

Se uma operação `LOSS` for registrada para a wallet, a transação da aposta é criada, mas a wallet não tem saldo alterado e, portanto, **`version` não incrementa**. Por isso, o incremento de `version` é gerenciado explicitamente pelos métodos de negócio `wallet.debit()` e `wallet.credit()`, e mapeado no MikroORM como inteiro regular, em vez de lock otimista global automático.

---

## Consequências
- **Positivas:**
  - Blindagem física absoluta do ledger no banco de dados.
  - Domínio 100% puro e desacoplado, sem poluição de decorators.
  - Conformidade estrita com o incremento condicional de versão.
  - Garantia de que estornos pertencem estritamente à mesma rodada e contexto do jogador.

