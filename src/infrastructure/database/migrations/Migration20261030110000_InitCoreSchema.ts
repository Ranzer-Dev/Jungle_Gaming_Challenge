import { Migration } from "@mikro-orm/migrations";

export class Migration20261030110000_InitCoreSchema extends Migration {
  override async up(): Promise<void> {
    // 1. Wallets
    this.addSql(`
      CREATE TABLE wallets (
        id UUID PRIMARY KEY,
        player_id VARCHAR(64) NOT NULL,
        currency VARCHAR(3) NOT NULL,
        balance_amount NUMERIC(18, 2) NOT NULL,
        version INT NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT uk_wallet_player_currency UNIQUE (player_id, currency),
        CONSTRAINT chk_wallet_balance_non_negative CHECK (balance_amount >= 0)
      );
    `);

    // 2. Wager Transactions
    this.addSql(`
      CREATE TABLE wager_transactions (
        id UUID PRIMARY KEY,
        provider_id VARCHAR(64) NOT NULL,
        external_transaction_id VARCHAR(128) NOT NULL,
        idempotency_key VARCHAR(256) NOT NULL,
        payload_hash VARCHAR(64) NOT NULL,
        wallet_id UUID NOT NULL REFERENCES wallets(id),
        player_id VARCHAR(64) NOT NULL,
        round_id VARCHAR(128) NOT NULL,
        game_id VARCHAR(128) NOT NULL,
        kind VARCHAR(20) NOT NULL,
        amount NUMERIC(18, 2) NOT NULL,
        reference_external_transaction_id VARCHAR(128),
        reference_transaction_id UUID REFERENCES wager_transactions(id),
        status VARCHAR(30) NOT NULL,
        failure_code VARCHAR(50),
        balance_at_processed_amount NUMERIC(18, 2),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        processed_at TIMESTAMPTZ,
        CONSTRAINT uk_wager_tx_provider_external UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT uk_wager_tx_idempotency_key UNIQUE (idempotency_key)
      );
      CREATE INDEX idx_wager_tx_wallet_id ON wager_transactions (wallet_id);
      CREATE INDEX idx_wager_tx_pending_ref ON wager_transactions (status, created_at ASC) WHERE status = 'PENDING_REFERENCE';
    `);

    // 3. Ledger Entries (Append-only)
    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id UUID PRIMARY KEY,
        wallet_id UUID NOT NULL REFERENCES wallets(id),
        transaction_id UUID NOT NULL REFERENCES wager_transactions(id),
        direction VARCHAR(10) NOT NULL,
        amount NUMERIC(18, 2) NOT NULL,
        balance_before_amount NUMERIC(18, 2) NOT NULL,
        balance_after_amount NUMERIC(18, 2) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT chk_ledger_balance_math CHECK (
          (direction = 'CREDIT' AND balance_after_amount = balance_before_amount + amount) OR
          (direction = 'DEBIT' AND balance_after_amount = balance_before_amount - amount)
        )
      );
      CREATE INDEX idx_ledger_wallet_cursor ON wallet_ledger_entries (wallet_id, created_at DESC, id DESC);
    `);

    // 4. Trigger de Imutabilidade Ativa do Ledger
    this.addSql(`
      CREATE OR REPLACE FUNCTION trg_prevent_ledger_mutation()
      RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'Ledger entries are strictly immutable. UPDATE and DELETE operations are forbidden.';
      END;
      $$ LANGUAGE plpgsql;

      CREATE TRIGGER trg_ledger_immutable
      BEFORE UPDATE OR DELETE ON wallet_ledger_entries
      FOR EACH ROW EXECUTE FUNCTION trg_prevent_ledger_mutation();
    `);

    // 5. Inbox
    this.addSql(`
      CREATE TABLE inbox_messages (
        message_id VARCHAR(128) NOT NULL,
        consumer_name VARCHAR(64) NOT NULL,
        payload_hash VARCHAR(64) NOT NULL,
        received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        processed_at TIMESTAMPTZ,
        PRIMARY KEY (consumer_name, message_id)
      );
    `);

    // 6. Outbox
    this.addSql(`
      CREATE TABLE outbox_messages (
        id UUID PRIMARY KEY,
        aggregate_id VARCHAR(128) NOT NULL,
        event_type VARCHAR(128) NOT NULL,
        payload JSONB NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL,
        attempts INT NOT NULL DEFAULT 0,
        next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        published_at TIMESTAMPTZ
      );
      CREATE INDEX idx_outbox_pending ON outbox_messages (published_at, next_attempt_at, occurred_at ASC) WHERE published_at IS NULL;
    `);
  }

  override async down(): Promise<void> {
    this.addSql("DROP TABLE IF EXISTS outbox_messages CASCADE;");
    this.addSql("DROP TABLE IF EXISTS inbox_messages CASCADE;");
    this.addSql("DROP TRIGGER IF EXISTS trg_ledger_immutable ON wallet_ledger_entries CASCADE;");
    this.addSql("DROP FUNCTION IF EXISTS trg_prevent_ledger_mutation CASCADE;");
    this.addSql("DROP TABLE IF EXISTS wallet_ledger_entries CASCADE;");
    this.addSql("DROP TABLE IF EXISTS wager_transactions CASCADE;");
    this.addSql("DROP TABLE IF EXISTS wallets CASCADE;");
  }
}
