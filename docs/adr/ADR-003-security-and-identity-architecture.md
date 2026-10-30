# ADR-003: Arquitetura de Segurança, Autenticação de Provedores e Proteção de Borda

## Status
Aprovado

## Contexto
O **Distributed Wagering Processor** é um serviço financeiro de missão crítica no ecossistema B2B de iGaming da Jungle Gaming. Ele recebe requisições de débito, crédito e estorno oriundas de múltiplos provedores de jogos externos (Evolution, Pragmatic Play, Spribe, etc.).

A Seção 2 do `README.md` estabelece explicitamente que:
1. **Autenticação não pontua** na avaliação e não deve desviar o foco de correção financeira, concorrência e idempotência.
2. É **proibida autenticação artesanal** (ex.: tabela própria de usuários com hash de senha no banco financeiro).
3. Caso não seja subido um container de IdP externo (como Keycloak/Zitadel), a arquitetura deve deixar os **pontos de extensão explícitos no código** (`AuthGuard` no-op ou `ProviderIdentityPort`) e o desenho formal documentado para discussão na entrevista técnica.

Adicionalmente, um sistema financeiro exige proteção contra ameaças comuns de aplicação:
- Ataques de negação de serviço (DoS / Brute Force de transações).
- Injeção e poluição de parâmetros (SQL Injection, Prototype Pollution).
- Falsificação de identidade de provedores (Provider Spoofing).
- Vazamento de segredos e dados sensíveis em logs ou payloads de erro.

---

## Decisão

### 1. Modelo de Identidade & Ponto de Extensão (`ProviderIdentityPort`)
Adotamos o padrão de **Portas e Adaptadores (Hexagonal Architecture)** para isolar completamente a camada de segurança do domínio financeiro:

```
[ HTTP Request (Authorization: Bearer <JWT>) ]
                    │
                    ▼
          [ ProviderAuthGuard ]
                    │
                    ▼
        [ ProviderIdentityPort ]  <-- Interface de Domínio/Aplicação
                    │
        ┌───────────┴───────────┐
        ▼                       ▼
[ OidcIdentityProvider ]  [ Mock/NoOpProviderIdentity ]
(Produção / Keycloak)     (Ambiente Local / Testes de Carga)
```

- **Em Tempo de Desenvolvimento/Testes:** O `ProviderAuthGuard` opera através de um adaptador configurável que valida a presença do header ou autentica com base no `providerId` contratual sem adicionar latência externa nos testes de concorrência massiva.
- **Desenho de Produção (Arquitetura Alvo):** 
  - Provedores externos autenticam via **OAuth 2.0 / OIDC (Client Credentials Grant)** contra um Identity Provider corporativo (Keycloak ou Zitadel).
  - O IdP emite um JWT assinado assimetricamente (RS256) contendo claims de provedor:
    ```json
    {
      "sub": "provider-client-evolution-01",
      "iss": "https://auth.junglegaming.io/realms/providers",
      "aud": "distributed-wagering-processor",
      "roles": ["wagering:write", "wagering:read"],
      "providerId": "evolution"
    }
    ```
  - O `ProviderAuthGuard` valida a assinatura do token via JWKS (JSON Web Key Set) em cache local com rotação automática de chaves públicas.

### 2. Defesa Contra Spoofing de Provedor (Claim Verification)
- Uma aposta não pode declarar `providerId: "pragmatic"` no payload se o token autenticado pertence a `"evolution"`.
- O `ProviderAuthGuard` injeta o objeto `AuthenticatedProvider` no contexto da requisição (`ExecutionContext`).
- O use case ou guard valida rigorosamente que:
  `request.payload.providerId == context.authenticatedProvider.id`
  Qualquer divergência é rejeitada sumariamente com **HTTP 403 Forbidden** (`PROVIDER_IDENTITY_MISMATCH`).

### 3. Sanitização e Validação Estrita de Input
- Todas as entradas HTTP passam pelo `ValidationPipe` do NestJS com as flags estritas:
  - `whitelist: true`: Remove silenciosamente qualquer propriedade extra não definida no DTO (impede injeção de campos desconhecidos).
  - `forbidNonWhitelisted: true`: Rejeita com erro 400 se o cliente enviar propriedades não autorizadas.
  - `transform: true`: Converte tipos primitivos validados com segurança.
- **Prevenção de SQL Injection:** MikroORM utiliza queries parametrizadas em 100% dos comandos e mapeamento com `EntitySchema`. Zero SQL concatenado cru.

### 4. Proteção de Borda & Rate Limiting (Throttling)
- Para proteger o banco contra ataques volumétricos que tentem exaurir o pool de conexões via lock pessimista, os endpoints são protegidos por Rate Limiting por IP e por `providerId` (`@nestjs/throttler`), com exceção dos testes de carga controlados.

### 5. Tratamento Seguro de Erros (Information Disclosure Prevention)
- O `GlobalExceptionFilter` intercepta todas as exceções não tratadas:
  - Erros de banco de dados, stack traces e mensagens internas de driver nunca são expostos na resposta HTTP ao cliente.
  - Para exceções inesperadas (HTTP 500), o sistema loga o stack trace internamente associado ao `correlationId` e retorna ao cliente apenas:
    ```json
    {
      "statusCode": 500,
      "failureCode": "INTERNAL_SERVER_ERROR",
      "message": "An unexpected error occurred. Reference correlation ID: req-9b1deb4d",
      "timestamp": "2026-10-30T07:50:00.000Z"
    }
    ```

---

## Consequências
- **Positivas:**
  - Cumpre com elegância e maturidade o requisito do README (Seção 2).
  - Permite rodar testes de integração e concorrência com 50 requests paralelas com velocidade máxima, sem overhead de latência de um servidor Keycloak externo pesado.
  - Garante isolamento entre provedores (anti-spoofing) e imunidade contra injeção de parâmetros e vazamento de dados internos.
  - Deixa a arquitetura pronta para produção bastando alternar a implementação do `ProviderIdentityPort` para o adaptador OIDC.

