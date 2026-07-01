-- ============================================================================
-- 03-invoices_payment_methods.sql  —  DRAFT  —  [Stripe] [flag]
-- (TENANT DATA, posture A)  OD-5: spec NOW, build behind Stripe + a feature
-- flag; USD authoritative until international GTM. Stripe is the billing-record
-- source of truth — `invoices` here is a LOCAL MIRROR for in-app receipts/
-- history, reconciled from Stripe invoice.* webhooks. Never the system of record
-- for money owed (that is Stripe). Hand-authored migration only.
-- ============================================================================

CREATE TABLE invoices (
  id                  uuid        PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id           uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subscription_id     uuid        REFERENCES subscriptions(id) ON DELETE SET NULL,  -- NULL = one-off pack purchase
  purchase_id         uuid        REFERENCES purchases(id)     ON DELETE SET NULL,  -- links a top-up receipt
  stripe_invoice_id   varchar(255) UNIQUE,                       -- Stripe invoice id (dedupe + recon)
  number              varchar(50),                               -- human invoice number (from Stripe)
  status              varchar(20) NOT NULL DEFAULT 'draft',
  currency            char(3)     NOT NULL DEFAULT 'USD',
  subtotal_cents      integer     NOT NULL DEFAULT 0,
  tax_cents           integer     NOT NULL DEFAULT 0,
  total_cents         integer     NOT NULL DEFAULT 0,
  amount_paid_cents   integer     NOT NULL DEFAULT 0,
  hosted_invoice_url  text,                                      -- Stripe-hosted PDF/receipt link
  issued_at           timestamptz,
  paid_at             timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT invoices_status_enum CHECK (
    status IN ('draft','open','paid','void','uncollectible','refunded')
  ),
  CONSTRAINT invoices_amounts_nonneg CHECK (
    subtotal_cents >= 0 AND tax_cents >= 0 AND total_cents >= 0 AND amount_paid_cents >= 0
  )
);

CREATE INDEX idx_invoices_tenant_issued
  ON invoices (tenant_id, issued_at DESC);

-- ============================================================================
-- invoice_line_items  —  immutable snapshot lines (append-only)
-- [Stripe] [flag]  Each line snapshots WHAT was billed (pack/plan/credits) at
-- the price THEN — never re-priced. Mirrors Stripe invoice line items.
-- ============================================================================
CREATE TABLE invoice_line_items (
  id                  uuid        PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id           uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  invoice_id          uuid        NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  kind                varchar(20) NOT NULL,                      -- credit_pack | plan | proration | tax | discount | credit
  description         text        NOT NULL,
  credit_pack_key     text,                                      -- snapshot, not FK (pack may be retired)
  plan_template_key   text,                                      -- snapshot
  credits             integer,                                   -- credits this line conferred (NULL for non-credit lines)
  quantity            integer     NOT NULL DEFAULT 1,
  unit_amount_cents   integer     NOT NULL DEFAULT 0,            -- price THEN (immutable)
  amount_cents        integer     NOT NULL DEFAULT 0,
  currency            char(3)     NOT NULL DEFAULT 'USD',
  stripe_line_item_id varchar(255),
  created_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT invoice_line_kind_enum CHECK (
    kind IN ('credit_pack','plan','proration','tax','discount','credit')
  )
);

CREATE INDEX idx_invoice_line_items_invoice
  ON invoice_line_items (invoice_id, id);

-- ============================================================================
-- payment_methods  —  reference to a Stripe PaymentMethod (NO raw PAN/card data)
-- [Stripe]  (TENANT DATA)  Security: store ONLY the Stripe token + safe display
-- fields (brand, last4, exp). NEVER store card numbers/CVV — PCI scope stays in
-- Stripe (security has final say).
-- ============================================================================
CREATE TABLE payment_methods (
  id                       uuid        PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id                uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  stripe_payment_method_id varchar(255) NOT NULL UNIQUE,
  type                     varchar(20) NOT NULL DEFAULT 'card',   -- card | bank_account | link
  brand                    varchar(30),                           -- display only
  last4                    varchar(4),                            -- display only
  exp_month                integer,
  exp_year                 integer,
  is_default               boolean     NOT NULL DEFAULT false,
  created_at               timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT payment_methods_type_enum CHECK (type IN ('card','bank_account','link'))
);

-- One default payment method per tenant.
CREATE UNIQUE INDEX uniq_payment_methods_tenant_default
  ON payment_methods (tenant_id) WHERE is_default = true;

CREATE INDEX idx_payment_methods_tenant
  ON payment_methods (tenant_id, id);

-- ── RLS (posture A) ── all three carry tenant_id; tenant-isolated; the billing
-- hub reads them under the tenant predicate. WRITES are Stripe-webhook driven
-- (invoices, line items) or workspace-admin-gated (payment_methods setup-intent
-- flow, OD-8). invoice_line_items append-only (block_mutations trigger).
