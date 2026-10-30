# Matriz de Mapeamento de Status HTTP & Respostas da API

Este documento estabelece o mapeamento determinístico entre eventos do domínio e códigos de status HTTP no **Distributed Wagering Processor**, atendendo rigorosamente à exigência da Seção 9 do `README.md` (Linhas 508-509):

> *"A API precisa distinguir com clareza — e de forma consistente entre todos os endpoints — payload inválido, conflito de idempotência, rejeição por regra de negócio, aceite com processamento pendente e falha transitória de infraestrutura. Colapsar essas situações em um mesmo código obriga o provedor a interpretar mensagem de erro para decidir se pode reenviar."*

---

## 1. Matriz de Decisão HTTP por Categoria

| Categoria do Resultado | Código HTTP | `status` da Transação | Decisão Operacional do Provedor | Exemplos de Casos |
|---|---|---|---|---|
| **Criação com Sucesso** | **201 Created** | `PROCESSED` | Sucesso definitivo. Não reenviar. | Primeira aposta válida processada; Carteira criada. |
| **Replay Idempotente** | **200 OK** | `PROCESSED` / `REJECTED` | Sucesso definitivo. Transação já havia sido aplicada. `"idempotentReplay": true`. | Reenvio de request idêntico por timeout de rede anterior. |
| **Aceite com Dependência Pendente** | **202 Accepted** | `PENDING_REFERENCE` | Aguardar processamento assíncrono. **Não reenviar imediatamente**. | `REFUND` ou `ROLLBACK` recebido antes da `BET` original. O worker resolverá em background. |
| **Payload Inválido / Malformado** | **400 Bad Request** | Não criada | **Não reenviar o mesmo payload**. Corrigir os campos da requisição. | Formato de `amount` inválido (`"25.5"`, `NaN`), moeda inválida, JSON sintaticamente incorreto. |
| **Recurso Não Encontrado** | **404 Not Found** | Não criada | **Não reenviar**. Verificar identificadores. | `walletId` inexistente, transação não encontrada na consulta. |
| **Conflito de Idempotência / Unicidade** | **409 Conflict** | Não criada | **Ação Imediata:** Corrigir a `Idempotency-Key` ou payload. Suspeita de bug ou colisão. | Mesma `Idempotency-Key` enviada com montante diferente (`IDEMPOTENCY_PAYLOAD_MISMATCH`); Carteira duplicada (`WALLET_ALREADY_EXISTS`). |
| **Rejeição por Regra de Negócio** | **422 Unprocessable Entity** | `REJECTED` | **Não reenviar a mesma aposta**. Transação foi rejeitada de forma terminal e auditável. | Saldo insuficiente (`INSUFFICIENT_FUNDS`), estorno duplicado (`REFERENCE_ALREADY_REVERTED`), estorno causaria saldo negativo (`ROLLBACK_WOULD_CAUSE_NEGATIVE_BALANCE`). |
| **Falha Transitória de Infraestrutura** | **503 Service Unavailable** | Não comitada | **Reenviar com Exponential Backoff**. A transação sofreu rollback e pode ser processada quando o serviço se recuperar. | PostgreSQL momentaneamente fora do ar, timeout transitório de conexão no banco. |

---

## 2. Destaque Arquitetural: O Significado do HTTP 202 (`Accepted`)

Um erro clássico cometido por candidatos é responder **HTTP 422 (Erro)** ou **HTTP 200 (Sucesso Falso)** quando uma aposta chega fora de ordem.

- Se a API retornar **422** para um `REFUND` cuja `BET` ainda está a caminho pelo broker SQS, o provedor interpretará que o estorno foi recusado em definitivo e descartará a mensagem.
- Se retornar **200**, o provedor achará que o dinheiro já foi creditado, quando na verdade está aguardando a referência.
- **A Solução:** Responder formalmente **HTTP 202 Accepted** com status `PENDING_REFERENCE`:
  ```json
  {
    "transactionId": "0192f298-8888-7e38-af88-e43f851a819d",
    "status": "PENDING_REFERENCE",
    "balance": { "amount": "975.00", "currency": "BRL" },
    "idempotentReplay": false,
    "message": "Transaction accepted and pending reference resolution by background worker"
  }
  ```
  Isso comunica ao provedor que a mensagem foi recebida com segurança e que a Jungle Gaming está orquestrando a resolução em segundo plano.

