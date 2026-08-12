-- ⚠ SNAPSHOT — NOT THE SOURCE OF TRUTH, AND CURRENTLY BEHIND main.
--
-- This file is a CONSOLIDATED DUMP of the schema as it stood at journal migration 0099. It is a
-- convenience for standing up a fresh Supabase project in one shot; it is NOT the schema of record.
-- The source of truth is packages/db/src/{schema,migrations,rls}, applied by applyMigrations.ts.
--
-- KNOWN DRIFT as of migration 0108 (do not apply this file and assume you are current):
--   • master_companies.technographics is declared BELOW but 0108 DROPS it (it was dead — no reader,
--     no writer; master_technology_adoptions is the real technographics store).
--   • master_companies.org_kind is MISSING (0108 adds it — a school is an organization).
--   • master_education is MISSING entirely (0108 creates it — the person→organization education edge).
--
-- To get a current database: apply this baseline, then run the journal migrations from 0100 onward
-- (applyMigrations.ts is idempotent and will do exactly that), or skip this file and let
-- applyMigrations.ts build from the numbered migrations alone. Regenerate this snapshot from a live
-- migrated database before trusting it again.

DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'leadwolf_app') THEN
    CREATE ROLE leadwolf_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'leadwolf_admin') THEN
    CREATE ROLE leadwolf_admin NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'leadwolf_er') THEN
    CREATE ROLE leadwolf_er NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'leadwolf_forge') THEN
    CREATE ROLE leadwolf_forge NOLOGIN;
  END IF;
END $$;
GRANT leadwolf_app TO postgres;
GRANT leadwolf_admin TO postgres;
GRANT leadwolf_er TO postgres;
GRANT leadwolf_forge TO postgres;
--
-- PostgreSQL database dump
--


-- Dumped from database version 16.13 (Ubuntu 16.13-0ubuntu0.24.04.1)
-- Dumped by pg_dump version 16.13 (Ubuntu 16.13-0ubuntu0.24.04.1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: drizzle; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA drizzle;


--
-- Name: forge; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA forge;


--
-- Name: citext; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;


--
-- Name: EXTENSION citext; Type: COMMENT; Schema: -; Owner: -
--



--
-- Name: pg_trgm; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;


--
-- Name: EXTENSION pg_trgm; Type: COMMENT; Schema: -; Owner: -
--



--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -; Owner: -
--



--
-- Name: audit_log_append_only(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.audit_log_append_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only (08 §5)';
END;
$$;


--
-- Name: billing_cycles_grant_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.billing_cycles_grant_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.granted_at IS NOT NULL THEN
    RAISE EXCEPTION 'a granted billing_cycle is immutable (ADR-0041)';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;


--
-- Name: credit_ledger_append_only(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.credit_ledger_append_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  -- ONE sanctioned mutation: the reveal_id FK's own ON DELETE SET NULL, fired when the DSAR delete fan-out
  -- purges contact_reveals (08 §4.2). The financial fields stay byte-identical — only the pointer to the
  -- erased reveal row nulls out. Everything else (any value edit, any DELETE) still raises.
  IF TG_OP = 'UPDATE'
     AND NEW.reveal_id IS NULL AND OLD.reveal_id IS NOT NULL
     AND (to_jsonb(NEW) - 'reveal_id') = (to_jsonb(OLD) - 'reveal_id') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'credit_ledger is append-only (ADR-0029)';
END;
$$;


--
-- Name: ensure_month_partitions(regclass, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ensure_month_partitions(target regclass, months_ahead integer DEFAULT 3) RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE
  parent_ns   text;
  parent_name text;
  part_name   text;
  month_start date;
  created     int := 0;
  i           int;
BEGIN
  IF months_ahead < 0 THEN
    RAISE EXCEPTION 'months_ahead must be >= 0, got %', months_ahead;
  END IF;

  SELECT n.nspname, c.relname INTO parent_ns, parent_name
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.oid = target;

  -- Refuse a plain table outright. Silently doing nothing here would let a half-finished conversion look
  -- maintained: the sweep would report success every day for a table that has no partitions at all.
  IF (SELECT relkind FROM pg_class WHERE oid = target) <> 'p' THEN
    RAISE EXCEPTION '% is not a partitioned table', target;
  END IF;

  FOR i IN 0..months_ahead LOOP
    month_start := date_trunc('month', CURRENT_DATE)::date + make_interval(months => i);
    part_name   := format('%s_%s', parent_name, to_char(month_start, 'YYYY_MM'));

    CONTINUE WHEN EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relname = part_name AND n.nspname = parent_ns
    );

    -- The bound is [month, next month) — half-open, so consecutive months cannot overlap and no timestamp
    -- falls between two partitions.
    EXECUTE format(
      'CREATE TABLE %I.%I PARTITION OF %I.%I FOR VALUES FROM (%L) TO (%L)',
      parent_ns, part_name, parent_ns, parent_name,
      month_start, (month_start + interval '1 month')::date
    );
    created := created + 1;
  END LOOP;

  RETURN created;
END;
$$;


--
-- Name: platform_audit_log_append_only(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.platform_audit_log_append_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'platform_audit_log is append-only (ADR-0032)';
END;
$$;


--
-- Name: provenance_event_append_only(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.provenance_event_append_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.source_record_id IS NULL AND OLD.source_record_id IS NOT NULL
     AND (to_jsonb(NEW) - 'source_record_id') = (to_jsonb(OLD) - 'source_record_id') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'provenance_event is append-only (08-architecture invariant 1)';
END;
$$;


--
-- Name: set_reveal_ownership(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_reveal_ownership() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE contacts
     SET is_revealed = TRUE,
         revealed_by_user_id = NEW.revealed_by_user_id,
         revealed_at = NEW.revealed_at
   WHERE id = NEW.contact_id AND is_revealed = FALSE;
  RETURN NEW;
END;
$$;


--
-- Name: set_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


--
-- Name: sync_last_activity(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_last_activity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE contacts c
     SET last_activity_at = agg.newest
    FROM (
      SELECT contact_id, max(occurred_at) AS newest
        FROM new_activities
       GROUP BY contact_id
    ) AS agg
   WHERE c.id = agg.contact_id
     AND (c.last_activity_at IS NULL OR c.last_activity_at < agg.newest);
  RETURN NULL; -- statement-level AFTER trigger: the return value is ignored
END;
$$;


--
-- Name: sync_priority_score(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_priority_score() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE contacts SET priority_score = NEW.composite_score WHERE id = NEW.contact_id;
  RETURN NEW;
END;
$$;


--
-- Name: uuid_generate_v7(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.uuid_generate_v7() RETURNS uuid
    LANGUAGE sql
    AS $$
  SELECT encode(
    set_bit(
      set_bit(
        overlay(uuid_send(gen_random_uuid())
          PLACING substring(int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3)
          FROM 1 FOR 6),
        52, 1),
      53, 1),
    'hex')::uuid;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: __drizzle_migrations; Type: TABLE; Schema: drizzle; Owner: -
--

CREATE TABLE drizzle.__drizzle_migrations (
    id integer NOT NULL,
    hash text NOT NULL,
    created_at bigint
);


--
-- Name: __drizzle_migrations_id_seq; Type: SEQUENCE; Schema: drizzle; Owner: -
--

CREATE SEQUENCE drizzle.__drizzle_migrations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: __drizzle_migrations_id_seq; Type: SEQUENCE OWNED BY; Schema: drizzle; Owner: -
--

ALTER SEQUENCE drizzle.__drizzle_migrations_id_seq OWNED BY drizzle.__drizzle_migrations.id;


--
-- Name: approval_requests; Type: TABLE; Schema: forge; Owner: -
--

CREATE TABLE forge.approval_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    op_class text NOT NULL,
    requested_by_user_id uuid NOT NULL,
    decided_by_user_id uuid,
    status text DEFAULT 'pending'::text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    executed_at timestamp with time zone,
    subject_ref text,
    CONSTRAINT approval_requests_four_eyes CHECK (((decided_by_user_id IS NULL) OR (decided_by_user_id <> requested_by_user_id)))
);


--
-- Name: capture_batches; Type: TABLE; Schema: forge; Owner: -
--

CREATE TABLE forge.capture_batches (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    source text NOT NULL,
    idempotency_key text NOT NULL,
    byte_size bigint DEFAULT 0 NOT NULL,
    status text DEFAULT 'received'::text NOT NULL,
    accepted_count integer DEFAULT 0 NOT NULL,
    duplicate_count integer DEFAULT 0 NOT NULL,
    rejected_count integer DEFAULT 0 NOT NULL,
    reject_histogram jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: contributor; Type: TABLE; Schema: forge; Owner: -
--

CREATE TABLE forge.contributor (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    channel text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    reputation numeric(4,3) DEFAULT 0.500 NOT NULL,
    first_contributed_at timestamp with time zone,
    last_contributed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT forge_contributor_channel_enum CHECK ((channel = ANY (ARRAY['extension'::text, 'crm_sync'::text, 'mailbox'::text, 'manual'::text, 'confirmation'::text]))),
    CONSTRAINT forge_contributor_reputation_range CHECK (((reputation >= (0)::numeric) AND (reputation <= (1)::numeric))),
    CONSTRAINT forge_contributor_status_enum CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text, 'revoked'::text, 'banned'::text])))
);


--
-- Name: contributor_consent; Type: TABLE; Schema: forge; Owner: -
--

CREATE TABLE forge.contributor_consent (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    contributor_id uuid NOT NULL,
    scope jsonb DEFAULT '{}'::jsonb NOT NULL,
    policy_version text NOT NULL,
    granted_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone
);


--
-- Name: extraction_candidates; Type: TABLE; Schema: forge; Owner: -
--

CREATE TABLE forge.extraction_candidates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    raw_capture_id uuid NOT NULL,
    path text NOT NULL,
    value jsonb,
    confidence numeric(4,3) NOT NULL,
    band text NOT NULL,
    grounded boolean NOT NULL,
    extract_schema_version text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT extraction_candidates_band CHECK ((band = ANY (ARRAY['auto'::text, 'review'::text, 'quarantine'::text])))
);


--
-- Name: extraction_runs; Type: TABLE; Schema: forge; Owner: -
--

CREATE TABLE forge.extraction_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    job_id text NOT NULL,
    target_tenant_id uuid,
    task text DEFAULT 'extract'::text NOT NULL,
    model text NOT NULL,
    outcome text NOT NULL,
    used_repair boolean DEFAULT false NOT NULL,
    extract_schema_version text,
    grounding_coverage numeric(4,3),
    judge_score numeric(4,3),
    confidence numeric(4,3),
    latency_ms integer,
    input_tokens integer,
    output_tokens integer,
    cached_tokens integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: forge_audit_log; Type: TABLE; Schema: forge; Owner: -
--

CREATE TABLE forge.forge_audit_log (
    seq bigint NOT NULL,
    action text NOT NULL,
    actor_kind text NOT NULL,
    actor_id text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    prev_hash text NOT NULL,
    row_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: forge_audit_log_seq_seq; Type: SEQUENCE; Schema: forge; Owner: -
--

CREATE SEQUENCE forge.forge_audit_log_seq_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: forge_audit_log_seq_seq; Type: SEQUENCE OWNED BY; Schema: forge; Owner: -
--

ALTER SEQUENCE forge.forge_audit_log_seq_seq OWNED BY forge.forge_audit_log.seq;


--
-- Name: master_id_map; Type: TABLE; Schema: forge; Owner: -
--

CREATE TABLE forge.master_id_map (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    forge_id uuid NOT NULL,
    master_id uuid,
    entity_kind text NOT NULL,
    content_hash text NOT NULL,
    synced_version integer DEFAULT 0 NOT NULL,
    reconciled_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: match_candidates; Type: TABLE; Schema: forge; Owner: -
--

CREATE TABLE forge.match_candidates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    left_ref uuid NOT NULL,
    right_ref uuid NOT NULL,
    block_key text NOT NULL,
    match_weight numeric(8,4),
    disposition text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: match_links; Type: TABLE; Schema: forge; Owner: -
--

CREATE TABLE forge.match_links (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    entity_type text NOT NULL,
    cluster_id uuid NOT NULL,
    source_ref uuid NOT NULL,
    match_probability numeric(4,3),
    match_weight numeric(8,4),
    match_method text DEFAULT 'fellegi_sunter'::text NOT NULL,
    is_duplicate_of uuid,
    review_status text DEFAULT 'auto'::text NOT NULL,
    resolved_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT match_links_review_status CHECK ((review_status = ANY (ARRAY['auto'::text, 'pending'::text, 'confirmed'::text, 'rejected'::text])))
);


--
-- Name: merge_log; Type: TABLE; Schema: forge; Owner: -
--

CREATE TABLE forge.merge_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    cluster_id uuid NOT NULL,
    decision text NOT NULL,
    survivorship jsonb DEFAULT '{}'::jsonb NOT NULL,
    match_weight numeric(8,4),
    decided_by_user_id uuid,
    reason text,
    reverses_merge_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: parsed_records; Type: TABLE; Schema: forge; Owner: -
--

CREATE TABLE forge.parsed_records (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    raw_capture_id uuid NOT NULL,
    parser_version_id uuid NOT NULL,
    entity_kind text DEFAULT 'person'::text NOT NULL,
    fields jsonb DEFAULT '[]'::jsonb NOT NULL,
    field_provenance jsonb DEFAULT '[]'::jsonb NOT NULL,
    parse_status text NOT NULL,
    parse_errors jsonb DEFAULT '[]'::jsonb NOT NULL,
    block_key text,
    email_blind_index text,
    phone_blind_index text,
    superseded boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT parsed_records_status CHECK ((parse_status = ANY (ARRAY['parsed'::text, 'partial'::text, 'failed'::text, 'quarantined'::text])))
);


--
-- Name: parser_versions; Type: TABLE; Schema: forge; Owner: -
--

CREATE TABLE forge.parser_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    parser_id uuid NOT NULL,
    version text NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    output_schema jsonb DEFAULT '{}'::jsonb NOT NULL,
    compatibility text,
    golden_fixture_ref text,
    supersedes_version_id uuid,
    published_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT parser_versions_status CHECK ((status = ANY (ARRAY['draft'::text, 'active'::text, 'deprecated'::text, 'retired'::text])))
);


--
-- Name: parsers; Type: TABLE; Schema: forge; Owner: -
--

CREATE TABLE forge.parsers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    source text NOT NULL,
    endpoint text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: quarantine; Type: TABLE; Schema: forge; Owner: -
--

CREATE TABLE forge.quarantine (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    raw_capture_id uuid NOT NULL,
    route text NOT NULL,
    reason text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: raw_captures; Type: TABLE; Schema: forge; Owner: -
--

CREATE TABLE forge.raw_captures (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    source text NOT NULL,
    endpoint text NOT NULL,
    schema_version text NOT NULL,
    content_hash text NOT NULL,
    content_type text DEFAULT 'application/json'::text NOT NULL,
    captured_by_user_id uuid,
    target_tenant_id uuid NOT NULL,
    target_workspace_id uuid,
    consent_snapshot jsonb DEFAULT '{}'::jsonb NOT NULL,
    payload_inline text,
    payload_ref text,
    byte_size bigint NOT NULL,
    is_gzipped boolean DEFAULT false NOT NULL,
    status text DEFAULT 'landed'::text NOT NULL,
    ingested_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT raw_captures_one_payload CHECK (((payload_inline IS NOT NULL) <> (payload_ref IS NOT NULL))),
    CONSTRAINT raw_captures_status CHECK ((status = ANY (ARRAY['landed'::text, 'parsed'::text, 'erased'::text])))
);


--
-- Name: review_tasks; Type: TABLE; Schema: forge; Owner: -
--

CREATE TABLE forge.review_tasks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    task_type text NOT NULL,
    subject_ref text NOT NULL,
    confidence numeric(4,3),
    priority integer DEFAULT 0 NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    assignee_user_id uuid,
    claimed_at timestamp with time zone,
    sla_due_at timestamp with time zone,
    is_honeypot boolean DEFAULT false NOT NULL,
    resolution text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: sync_outbox; Type: TABLE; Schema: forge; Owner: -
--

CREATE TABLE forge.sync_outbox (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_type text NOT NULL,
    aggregate_kind text DEFAULT 'verified_person'::text NOT NULL,
    forge_id uuid,
    version integer DEFAULT 1 NOT NULL,
    content_hash text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    available_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    dispatched_at timestamp with time zone
);


--
-- Name: sync_state; Type: TABLE; Schema: forge; Owner: -
--

CREATE TABLE forge.sync_state (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    entity_kind text NOT NULL,
    verified_id uuid NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: verified_record_events; Type: TABLE; Schema: forge; Owner: -
--

CREATE TABLE forge.verified_record_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    verified_id uuid NOT NULL,
    event_type text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    winning_source text,
    source_record_ref text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: verified_records; Type: TABLE; Schema: forge; Owner: -
--

CREATE TABLE forge.verified_records (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    content_hash text NOT NULL,
    entity_kind text NOT NULL,
    fields jsonb DEFAULT '{}'::jsonb NOT NULL,
    confidence numeric(4,3),
    review_status text DEFAULT 'verified'::text NOT NULL,
    email_blind_index text,
    email_enc bytea,
    phone_blind_index text,
    phone_enc bytea,
    is_suppressed boolean DEFAULT false NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    approved_by_user_id uuid,
    approval_request_id uuid,
    verified_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: account_domains; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account_domains (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    account_id uuid NOT NULL,
    domain public.citext NOT NULL,
    is_primary boolean DEFAULT false NOT NULL,
    source character varying(30) NOT NULL,
    source_import_id uuid,
    pinned boolean DEFAULT false NOT NULL,
    verified_at timestamp with time zone,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT account_domains_source_enum CHECK (((source)::text = ANY ((ARRAY['import'::character varying, 'enrichment'::character varying, 'manual'::character varying, 'master_suggestion'::character varying])::text[])))
);

ALTER TABLE ONLY public.account_domains FORCE ROW LEVEL SECURITY;


--
-- Name: account_holds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account_holds (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    kind text NOT NULL,
    reason text NOT NULL,
    placed_by_user_id uuid NOT NULL,
    placed_at timestamp with time zone DEFAULT now() NOT NULL,
    lifted_at timestamp with time zone,
    lifted_by_user_id uuid
);


--
-- Name: account_locations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account_locations (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    account_id uuid NOT NULL,
    type character varying(10) NOT NULL,
    line1 character varying(255),
    line2 character varying(255),
    city character varying(100),
    region character varying(100),
    postal_code character varying(20),
    country character(2),
    is_primary boolean DEFAULT false NOT NULL,
    source character varying(30) NOT NULL,
    pinned boolean DEFAULT false NOT NULL,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT account_locations_source_enum CHECK (((source)::text = ANY ((ARRAY['import'::character varying, 'enrichment'::character varying, 'manual'::character varying, 'master_suggestion'::character varying])::text[]))),
    CONSTRAINT account_locations_type_enum CHECK (((type)::text = ANY ((ARRAY['hq'::character varying, 'branch'::character varying, 'office'::character varying])::text[])))
);

ALTER TABLE ONLY public.account_locations FORCE ROW LEVEL SECURITY;


--
-- Name: accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.accounts (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    name character varying(255) NOT NULL,
    domain public.citext,
    linkedin_company_url character varying(500),
    sales_nav_account_url character varying(500),
    industry character varying(100),
    sub_industry character varying(100),
    employee_count integer,
    revenue_range character varying(50),
    hq_country character varying(100),
    hq_city character varying(100),
    icp_fit_score integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    custom_fields jsonb DEFAULT '{}'::jsonb NOT NULL,
    technologies jsonb DEFAULT '[]'::jsonb NOT NULL,
    funding_stage character varying(50),
    company_stage character varying(50),
    founded_year integer,
    master_company_id uuid,
    field_provenance jsonb DEFAULT '{}'::jsonb NOT NULL,
    parent_account_id uuid,
    root_account_id uuid,
    deleted_at timestamp with time zone,
    CONSTRAINT accounts_icp_fit_range CHECK (((icp_fit_score IS NULL) OR ((icp_fit_score >= 0) AND (icp_fit_score <= 100)))),
    CONSTRAINT accounts_parent_not_self CHECK (((parent_account_id IS NULL) OR (parent_account_id <> id)))
);

ALTER TABLE ONLY public.accounts FORCE ROW LEVEL SECURITY;


--
-- Name: activities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.activities (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    actor_user_id uuid,
    activity_type character varying(30) NOT NULL,
    channel character varying(20) NOT NULL,
    outcome character varying(20),
    note character varying(2000),
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT activities_channel_enum CHECK (((channel)::text = ANY ((ARRAY['email'::character varying, 'phone'::character varying, 'linkedin'::character varying, 'sales_navigator'::character varying, 'in-person'::character varying])::text[]))),
    CONSTRAINT activities_outcome_enum CHECK (((outcome IS NULL) OR ((outcome)::text = ANY ((ARRAY['connected'::character varying, 'voicemail'::character varying, 'no_answer'::character varying, 'positive'::character varying, 'negative'::character varying, 'neutral'::character varying])::text[])))),
    CONSTRAINT activities_type_enum CHECK (((activity_type)::text = ANY ((ARRAY['email_sent'::character varying, 'email_opened'::character varying, 'email_clicked'::character varying, 'email_replied'::character varying, 'call_made'::character varying, 'call_connected'::character varying, 'linkedin_message'::character varying, 'linkedin_connected'::character varying, 'sales_nav_inmail'::character varying, 'meeting_held'::character varying, 'note_added'::character varying])::text[])))
)
PARTITION BY RANGE (occurred_at);

ALTER TABLE ONLY public.activities FORCE ROW LEVEL SECURITY;


--
-- Name: activities_2026_08; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.activities_2026_08 (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    actor_user_id uuid,
    activity_type character varying(30) NOT NULL,
    channel character varying(20) NOT NULL,
    outcome character varying(20),
    note character varying(2000),
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT activities_channel_enum CHECK (((channel)::text = ANY ((ARRAY['email'::character varying, 'phone'::character varying, 'linkedin'::character varying, 'sales_navigator'::character varying, 'in-person'::character varying])::text[]))),
    CONSTRAINT activities_outcome_enum CHECK (((outcome IS NULL) OR ((outcome)::text = ANY ((ARRAY['connected'::character varying, 'voicemail'::character varying, 'no_answer'::character varying, 'positive'::character varying, 'negative'::character varying, 'neutral'::character varying])::text[])))),
    CONSTRAINT activities_type_enum CHECK (((activity_type)::text = ANY ((ARRAY['email_sent'::character varying, 'email_opened'::character varying, 'email_clicked'::character varying, 'email_replied'::character varying, 'call_made'::character varying, 'call_connected'::character varying, 'linkedin_message'::character varying, 'linkedin_connected'::character varying, 'sales_nav_inmail'::character varying, 'meeting_held'::character varying, 'note_added'::character varying])::text[])))
);


--
-- Name: activities_2026_09; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.activities_2026_09 (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    actor_user_id uuid,
    activity_type character varying(30) NOT NULL,
    channel character varying(20) NOT NULL,
    outcome character varying(20),
    note character varying(2000),
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT activities_channel_enum CHECK (((channel)::text = ANY ((ARRAY['email'::character varying, 'phone'::character varying, 'linkedin'::character varying, 'sales_navigator'::character varying, 'in-person'::character varying])::text[]))),
    CONSTRAINT activities_outcome_enum CHECK (((outcome IS NULL) OR ((outcome)::text = ANY ((ARRAY['connected'::character varying, 'voicemail'::character varying, 'no_answer'::character varying, 'positive'::character varying, 'negative'::character varying, 'neutral'::character varying])::text[])))),
    CONSTRAINT activities_type_enum CHECK (((activity_type)::text = ANY ((ARRAY['email_sent'::character varying, 'email_opened'::character varying, 'email_clicked'::character varying, 'email_replied'::character varying, 'call_made'::character varying, 'call_connected'::character varying, 'linkedin_message'::character varying, 'linkedin_connected'::character varying, 'sales_nav_inmail'::character varying, 'meeting_held'::character varying, 'note_added'::character varying])::text[])))
);


--
-- Name: activities_2026_10; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.activities_2026_10 (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    actor_user_id uuid,
    activity_type character varying(30) NOT NULL,
    channel character varying(20) NOT NULL,
    outcome character varying(20),
    note character varying(2000),
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT activities_channel_enum CHECK (((channel)::text = ANY ((ARRAY['email'::character varying, 'phone'::character varying, 'linkedin'::character varying, 'sales_navigator'::character varying, 'in-person'::character varying])::text[]))),
    CONSTRAINT activities_outcome_enum CHECK (((outcome IS NULL) OR ((outcome)::text = ANY ((ARRAY['connected'::character varying, 'voicemail'::character varying, 'no_answer'::character varying, 'positive'::character varying, 'negative'::character varying, 'neutral'::character varying])::text[])))),
    CONSTRAINT activities_type_enum CHECK (((activity_type)::text = ANY ((ARRAY['email_sent'::character varying, 'email_opened'::character varying, 'email_clicked'::character varying, 'email_replied'::character varying, 'call_made'::character varying, 'call_connected'::character varying, 'linkedin_message'::character varying, 'linkedin_connected'::character varying, 'sales_nav_inmail'::character varying, 'meeting_held'::character varying, 'note_added'::character varying])::text[])))
);


--
-- Name: activities_2026_11; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.activities_2026_11 (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    actor_user_id uuid,
    activity_type character varying(30) NOT NULL,
    channel character varying(20) NOT NULL,
    outcome character varying(20),
    note character varying(2000),
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT activities_channel_enum CHECK (((channel)::text = ANY ((ARRAY['email'::character varying, 'phone'::character varying, 'linkedin'::character varying, 'sales_navigator'::character varying, 'in-person'::character varying])::text[]))),
    CONSTRAINT activities_outcome_enum CHECK (((outcome IS NULL) OR ((outcome)::text = ANY ((ARRAY['connected'::character varying, 'voicemail'::character varying, 'no_answer'::character varying, 'positive'::character varying, 'negative'::character varying, 'neutral'::character varying])::text[])))),
    CONSTRAINT activities_type_enum CHECK (((activity_type)::text = ANY ((ARRAY['email_sent'::character varying, 'email_opened'::character varying, 'email_clicked'::character varying, 'email_replied'::character varying, 'call_made'::character varying, 'call_connected'::character varying, 'linkedin_message'::character varying, 'linkedin_connected'::character varying, 'sales_nav_inmail'::character varying, 'meeting_held'::character varying, 'note_added'::character varying])::text[])))
);


--
-- Name: activities_default; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.activities_default (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    actor_user_id uuid,
    activity_type character varying(30) NOT NULL,
    channel character varying(20) NOT NULL,
    outcome character varying(20),
    note character varying(2000),
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT activities_channel_enum CHECK (((channel)::text = ANY ((ARRAY['email'::character varying, 'phone'::character varying, 'linkedin'::character varying, 'sales_navigator'::character varying, 'in-person'::character varying])::text[]))),
    CONSTRAINT activities_outcome_enum CHECK (((outcome IS NULL) OR ((outcome)::text = ANY ((ARRAY['connected'::character varying, 'voicemail'::character varying, 'no_answer'::character varying, 'positive'::character varying, 'negative'::character varying, 'neutral'::character varying])::text[])))),
    CONSTRAINT activities_type_enum CHECK (((activity_type)::text = ANY ((ARRAY['email_sent'::character varying, 'email_opened'::character varying, 'email_clicked'::character varying, 'email_replied'::character varying, 'call_made'::character varying, 'call_connected'::character varying, 'linkedin_message'::character varying, 'linkedin_connected'::character varying, 'sales_nav_inmail'::character varying, 'meeting_held'::character varying, 'note_added'::character varying])::text[])))
);


--
-- Name: ai_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_requests (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    user_id uuid,
    task character varying(50) NOT NULL,
    model character varying(100),
    outcome character varying(30) NOT NULL,
    used_repair boolean DEFAULT false NOT NULL,
    latency_ms integer,
    input_tokens integer,
    output_tokens integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.ai_requests FORCE ROW LEVEL SECURITY;


--
-- Name: announcements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.announcements (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    title text NOT NULL,
    body text NOT NULL,
    level text DEFAULT 'info'::text NOT NULL,
    audience text DEFAULT 'all'::text NOT NULL,
    tenant_target uuid,
    starts_at timestamp with time zone,
    ends_at timestamp with time zone,
    active boolean DEFAULT true NOT NULL,
    created_by_user_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    type text DEFAULT 'general'::text NOT NULL
);


--
-- Name: approval_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.approval_requests (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    operation text NOT NULL,
    params jsonb DEFAULT '{}'::jsonb NOT NULL,
    target_tenant_id uuid,
    requested_by_user_id uuid NOT NULL,
    request_reason text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    decided_by_user_id uuid,
    decision_reason text,
    decided_at timestamp with time zone,
    expires_at timestamp with time zone NOT NULL,
    executed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_log (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid,
    actor_user_id uuid,
    action character varying(50) NOT NULL,
    entity_type character varying(50) NOT NULL,
    entity_id uuid,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    ip_address inet,
    user_agent character varying(500),
    origin_domain character varying(255),
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT audit_log_action_enum CHECK (((action)::text = ANY ((ARRAY['reveal'::character varying, 'reveal.blocked'::character varying, 'export'::character varying, 'send'::character varying, 'enroll'::character varying, 'unsubscribe'::character varying, 'suppression.add'::character varying, 'suppression.remove'::character varying, 'consent.record'::character varying, 'consent.withdraw'::character varying, 'dsar.access'::character varying, 'dsar.delete'::character varying, 'dsar.rectify'::character varying, 'member.add'::character varying, 'member.update'::character varying, 'member.remove'::character varying, 'apikey.use'::character varying, 'credit.adjust'::character varying, 'contact.create'::character varying, 'contact.update'::character varying, 'contact.delete'::character varying, 'account.create'::character varying, 'account.update'::character varying, 'account.delete'::character varying, 'list.create'::character varying, 'list.update'::character varying, 'list.delete'::character varying, 'sequence.create'::character varying, 'sequence.update'::character varying, 'sequence.delete'::character varying, 'template.create'::character varying, 'template.update'::character varying, 'template.delete'::character varying, 'settings.update'::character varying, 'automation.rule.create'::character varying, 'automation.rule.update'::character varying, 'automation.rule.delete'::character varying, 'custom_field.create'::character varying, 'custom_field.update'::character varying, 'custom_field.delete'::character varying, 'tag.create'::character varying, 'tag.update'::character varying, 'tag.delete'::character varying, 'tag.assign'::character varying, 'tag.unassign'::character varying, 'pipeline_stage.create'::character varying, 'pipeline_stage.update'::character varying, 'pipeline_stage.delete'::character varying, 'pipeline_stage.assign'::character varying, 'saved_search.create'::character varying, 'saved_search.update'::character varying, 'saved_search.delete'::character varying, 'automation.rule.enable'::character varying, 'automation.rule.disable'::character varying, 'automation.rule.run'::character varying, 'ai.config.update'::character varying, 'ai.draft.approve'::character varying, 'ai.draft.reject'::character varying, 'mailbox.connect'::character varying, 'mailbox.disconnect'::character varying, 'sending_domain.add'::character varying, 'sending_domain.verify'::character varying, 'login.success'::character varying, 'login.failure'::character varying, 'login.locked'::character varying, 'mfa.challenge'::character varying, 'mfa.success'::character varying, 'mfa.failure'::character varying, 'password.reset.request'::character varying, 'password.reset.complete'::character varying, 'sso.initiated'::character varying, 'sso.callback'::character varying, 'token.issued'::character varying, 'token.refresh'::character varying, 'token.revoke'::character varying, 'device.trusted'::character varying, 'device.revoked'::character varying, 'session.revoked'::character varying, 'code.issued'::character varying, 'code.exchanged'::character varying, 'signup'::character varying, 'oauth.link'::character varying, 'import.policy_updated'::character varying, 'import.committed'::character varying, 'import.cancelled'::character varying, 'import.retry_created'::character varying, 'import.template_saved'::character varying, 'import.artifact_downloaded'::character varying, 'import.av_infected'::character varying, 'import.draft_reaped'::character varying, 'channel_added'::character varying, 'channel_promoted'::character varying, 'channel_deleted'::character varying, 'channel_primary_demoted'::character varying, 'contact.merge'::character varying, 'crm.connect'::character varying, 'crm.disconnect'::character varying, 'crm.sync'::character varying, 'crm.mapping.update'::character varying, 'crm.erase'::character varying])::text[])))
);


--
-- Name: auth_allowed_origins; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_allowed_origins (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    scope character varying(12) NOT NULL,
    tenant_id uuid,
    origin character varying(255) NOT NULL,
    kind character varying(20) DEFAULT 'callback'::character varying NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT auth_allowed_origins_scope_consistency CHECK (((((scope)::text = 'platform'::text) AND (tenant_id IS NULL)) OR (((scope)::text = 'org'::text) AND (tenant_id IS NOT NULL)))),
    CONSTRAINT auth_allowed_origins_scope_enum CHECK (((scope)::text = ANY ((ARRAY['platform'::character varying, 'org'::character varying])::text[])))
);


--
-- Name: auth_email_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_email_tokens (
    token_hash character varying(255) NOT NULL,
    user_id uuid,
    email public.citext NOT NULL,
    purpose character varying(20) NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    ip_address text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: auth_policies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_policies (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    scope character varying(12) NOT NULL,
    tenant_id uuid,
    workspace_id uuid,
    key character varying(64) NOT NULL,
    value jsonb NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    updated_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT auth_policies_scope_consistency CHECK (((((scope)::text = 'platform'::text) AND (tenant_id IS NULL) AND (workspace_id IS NULL)) OR (((scope)::text = 'org'::text) AND (tenant_id IS NOT NULL) AND (workspace_id IS NULL)) OR (((scope)::text = 'workspace'::text) AND (tenant_id IS NOT NULL) AND (workspace_id IS NOT NULL)))),
    CONSTRAINT auth_policies_scope_enum CHECK (((scope)::text = ANY ((ARRAY['platform'::character varying, 'org'::character varying, 'workspace'::character varying])::text[])))
);


--
-- Name: billing_cycles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.billing_cycles (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    subscription_id uuid NOT NULL,
    period_start timestamp with time zone NOT NULL,
    period_end timestamp with time zone NOT NULL,
    grant_credits integer DEFAULT 0 NOT NULL,
    granted_at timestamp with time zone,
    grant_ledger_id uuid,
    rollover_credits integer DEFAULT 0 NOT NULL,
    invoice_id uuid,
    status character varying(20) DEFAULT 'open'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT billing_cycles_grant_nonneg CHECK (((grant_credits >= 0) AND (rollover_credits >= 0))),
    CONSTRAINT billing_cycles_status_enum CHECK (((status)::text = ANY ((ARRAY['open'::character varying, 'granted'::character varying, 'closed'::character varying, 'skipped'::character varying])::text[])))
);


--
-- Name: consent_records; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.consent_records (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    jurisdiction character varying(2) NOT NULL,
    lawful_basis character varying(50) NOT NULL,
    source character varying(255),
    valid_from timestamp with time zone DEFAULT now() NOT NULL,
    valid_until timestamp with time zone,
    withdrawn_at timestamp with time zone,
    recorded_by_user_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT consent_basis_enum CHECK (((lawful_basis)::text = ANY ((ARRAY['legitimate_interest'::character varying, 'consent'::character varying, 'contract'::character varying, 'public_record'::character varying])::text[])))
);

ALTER TABLE ONLY public.consent_records FORCE ROW LEVEL SECURITY;


--
-- Name: contact_emails; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contact_emails (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    value_enc bytea NOT NULL,
    blind_index bytea NOT NULL,
    email_domain public.citext NOT NULL,
    type character varying(20) DEFAULT 'other'::character varying NOT NULL,
    is_primary boolean DEFAULT false NOT NULL,
    status character varying(20) DEFAULT 'unverified'::character varying NOT NULL,
    confidence numeric(3,2),
    source character varying(50) NOT NULL,
    source_import_id uuid,
    pinned boolean DEFAULT false NOT NULL,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_verified_at timestamp with time zone,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT contact_emails_confidence_range CHECK (((confidence IS NULL) OR ((confidence >= (0)::numeric) AND (confidence <= (1)::numeric)))),
    CONSTRAINT contact_emails_status_enum CHECK (((status)::text = ANY ((ARRAY['unverified'::character varying, 'valid'::character varying, 'risky'::character varying, 'invalid'::character varying, 'catch_all'::character varying, 'unknown'::character varying])::text[]))),
    CONSTRAINT contact_emails_type_enum CHECK (((type)::text = ANY ((ARRAY['work'::character varying, 'personal'::character varying, 'other'::character varying])::text[])))
)
WITH (autovacuum_vacuum_scale_factor='0.01', autovacuum_vacuum_threshold='10000', autovacuum_vacuum_insert_scale_factor='0.01', autovacuum_vacuum_insert_threshold='100000', autovacuum_analyze_scale_factor='0.01', autovacuum_analyze_threshold='10000');

ALTER TABLE ONLY public.contact_emails FORCE ROW LEVEL SECURITY;


--
-- Name: contact_phones; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contact_phones (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    value_enc bytea NOT NULL,
    blind_index bytea NOT NULL,
    e164_enc bytea,
    e164_blind_index bytea,
    raw_original_enc bytea,
    country_hint character(2),
    extension character varying(16),
    line_type character varying(24),
    line_type_source character varying(20),
    type character varying(20) DEFAULT 'other'::character varying NOT NULL,
    is_primary boolean DEFAULT false NOT NULL,
    status character varying(50),
    confidence numeric(3,2),
    source character varying(50) NOT NULL,
    source_import_id uuid,
    pinned boolean DEFAULT false NOT NULL,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_verified_at timestamp with time zone,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT contact_phones_confidence_range CHECK (((confidence IS NULL) OR ((confidence >= (0)::numeric) AND (confidence <= (1)::numeric)))),
    CONSTRAINT contact_phones_line_type_enum CHECK (((line_type IS NULL) OR ((line_type)::text = ANY ((ARRAY['mobile'::character varying, 'landline'::character varying, 'fixed_voip'::character varying, 'non_fixed_voip'::character varying, 'voip'::character varying, 'toll_free'::character varying, 'premium_rate'::character varying, 'shared_cost'::character varying, 'personal'::character varying, 'pager'::character varying, 'uan'::character varying, 'voicemail'::character varying, 'fixed_line_or_mobile'::character varying, 'unknown'::character varying])::text[])))),
    CONSTRAINT contact_phones_line_type_source_enum CHECK (((line_type_source IS NULL) OR ((line_type_source)::text = ANY ((ARRAY['carrier_lookup'::character varying, 'libphonenumber'::character varying, 'provider'::character varying, 'import'::character varying])::text[])))),
    CONSTRAINT contact_phones_status_enum CHECK (((status IS NULL) OR ((status)::text = ANY ((ARRAY['direct'::character varying, 'mobile'::character varying, 'hq'::character varying, 'unknown'::character varying, 'valid'::character varying, 'invalid'::character varying])::text[])))),
    CONSTRAINT contact_phones_type_enum CHECK (((type)::text = ANY ((ARRAY['work'::character varying, 'personal'::character varying, 'mobile'::character varying, 'direct'::character varying, 'hq'::character varying, 'other'::character varying])::text[])))
)
WITH (autovacuum_vacuum_scale_factor='0.01', autovacuum_vacuum_threshold='10000', autovacuum_vacuum_insert_scale_factor='0.01', autovacuum_vacuum_insert_threshold='100000', autovacuum_analyze_scale_factor='0.01', autovacuum_analyze_threshold='10000');

ALTER TABLE ONLY public.contact_phones FORCE ROW LEVEL SECURITY;


--
-- Name: contact_reveals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contact_reveals (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    revealed_by_user_id uuid NOT NULL,
    reveal_type character varying(20) NOT NULL,
    data_source character varying(20) DEFAULT 'internal'::character varying NOT NULL,
    credits_consumed integer DEFAULT 1 NOT NULL,
    revealed_fields jsonb DEFAULT '{}'::jsonb NOT NULL,
    revealed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT contact_reveals_credits_nonneg CHECK ((credits_consumed >= 0)),
    CONSTRAINT contact_reveals_source_enum CHECK (((data_source)::text = ANY ((ARRAY['apollo'::character varying, 'zoominfo'::character varying, 'linkedin'::character varying, 'internal'::character varying])::text[]))),
    CONSTRAINT contact_reveals_type_enum CHECK (((reveal_type)::text = ANY ((ARRAY['email'::character varying, 'phone'::character varying, 'full_profile'::character varying])::text[])))
);

ALTER TABLE ONLY public.contact_reveals FORCE ROW LEVEL SECURITY;


--
-- Name: contacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contacts (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    account_id uuid,
    first_name character varying(100),
    last_name character varying(100),
    email_enc bytea,
    email_blind_index bytea,
    email_domain public.citext,
    email_status character varying(20) DEFAULT 'unverified'::character varying NOT NULL,
    linkedin_url character varying(500),
    linkedin_public_id character varying(255),
    sales_nav_profile_url character varying(500),
    sales_nav_lead_id character varying(255),
    job_title character varying(255),
    seniority_level character varying(50),
    department character varying(100),
    phone_enc bytea,
    phone_status character varying(50),
    location_country character varying(100),
    location_city character varying(100),
    priority_score integer,
    outreach_status character varying(50) DEFAULT 'new'::character varying NOT NULL,
    is_revealed boolean DEFAULT false NOT NULL,
    revealed_by_user_id uuid,
    revealed_at timestamp with time zone,
    jurisdiction character(2),
    region character(2) DEFAULT 'US'::bpchar NOT NULL,
    last_activity_at timestamp with time zone,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    pipeline_stage_id uuid,
    custom_fields jsonb DEFAULT '{}'::jsonb NOT NULL,
    owner_user_id uuid,
    duplicate_of_contact_id uuid,
    last_verified_at timestamp with time zone,
    master_person_id uuid,
    field_provenance jsonb DEFAULT '{}'::jsonb NOT NULL,
    phone_line_type character varying(20),
    merged_into_contact_id uuid,
    merged_at timestamp with time zone,
    external_id character varying(255),
    CONSTRAINT contacts_email_status_enum CHECK (((email_status)::text = ANY ((ARRAY['unverified'::character varying, 'valid'::character varying, 'risky'::character varying, 'invalid'::character varying, 'catch_all'::character varying, 'unknown'::character varying])::text[]))),
    CONSTRAINT contacts_outreach_status_enum CHECK (((outreach_status)::text = ANY ((ARRAY['new'::character varying, 'in_sequence'::character varying, 'replied'::character varying, 'meeting_booked'::character varying, 'disqualified'::character varying, 'nurture'::character varying, 'unsubscribed'::character varying])::text[]))),
    CONSTRAINT contacts_priority_range CHECK (((priority_score IS NULL) OR ((priority_score >= 0) AND (priority_score <= 100)))),
    CONSTRAINT contacts_reveal_at CHECK ((is_revealed = (revealed_at IS NOT NULL))),
    CONSTRAINT contacts_reveal_owner CHECK ((is_revealed = (revealed_by_user_id IS NOT NULL))),
    CONSTRAINT contacts_seniority_enum CHECK (((seniority_level IS NULL) OR ((seniority_level)::text = ANY ((ARRAY['c_suite'::character varying, 'vp'::character varying, 'director'::character varying, 'manager'::character varying, 'ic'::character varying, 'other'::character varying])::text[]))))
);

ALTER TABLE ONLY public.contacts FORCE ROW LEVEL SECURITY;


--
-- Name: contribution_exclusion; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contribution_exclusion (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    kind character varying(20) NOT NULL,
    domain public.citext,
    account_id uuid,
    contact_id uuid,
    note character varying(200),
    created_by_user_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT contribution_exclusion_kind_enum CHECK (((kind)::text = ANY ((ARRAY['domain'::character varying, 'account'::character varying, 'contact'::character varying])::text[]))),
    CONSTRAINT contribution_exclusion_target CHECK (((((kind)::text = 'domain'::text) AND (domain IS NOT NULL) AND (account_id IS NULL) AND (contact_id IS NULL)) OR (((kind)::text = 'account'::text) AND (account_id IS NOT NULL) AND (domain IS NULL) AND (contact_id IS NULL)) OR (((kind)::text = 'contact'::text) AND (contact_id IS NOT NULL) AND (domain IS NULL) AND (account_id IS NULL))))
);

ALTER TABLE ONLY public.contribution_exclusion FORCE ROW LEVEL SECURITY;


--
-- Name: contribution_policy; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contribution_policy (
    workspace_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    contribute_enabled boolean DEFAULT false NOT NULL,
    never_share_fields text[] DEFAULT '{}'::text[] NOT NULL,
    policy_version character varying(20) DEFAULT 'v1'::character varying NOT NULL,
    enabled_by_user_id uuid,
    enabled_at timestamp with time zone,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT contribution_policy_enabled_is_attributed CHECK (((contribute_enabled = false) OR ((enabled_by_user_id IS NOT NULL) AND (enabled_at IS NOT NULL))))
);

ALTER TABLE ONLY public.contribution_policy FORCE ROW LEVEL SECURITY;


--
-- Name: credit_ledger; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.credit_ledger (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid,
    entry_type character varying(20) NOT NULL,
    delta integer NOT NULL,
    balance_after integer,
    idempotency_key character varying(255) NOT NULL,
    reveal_id uuid,
    purchase_id uuid,
    actor_user_id uuid,
    reason character varying(255),
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT credit_ledger_delta_sign CHECK (((((entry_type)::text = ANY ((ARRAY['grant'::character varying, 'credit_back'::character varying, 'release'::character varying])::text[])) AND (delta >= 0)) OR (((entry_type)::text = ANY ((ARRAY['spend'::character varying, 'lease'::character varying, 'settle'::character varying])::text[])) AND (delta <= 0)) OR ((entry_type)::text = 'adjustment'::text))),
    CONSTRAINT credit_ledger_entry_type_enum CHECK (((entry_type)::text = ANY ((ARRAY['grant'::character varying, 'spend'::character varying, 'credit_back'::character varying, 'adjustment'::character varying, 'lease'::character varying, 'settle'::character varying, 'release'::character varying])::text[])))
);


--
-- Name: credit_packs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.credit_packs (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    key text NOT NULL,
    name text NOT NULL,
    credits integer NOT NULL,
    price_cents integer NOT NULL,
    active boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    stripe_price_id text
);


--
-- Name: crm_connections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_connections (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    owner_user_id uuid,
    provider character varying(20) NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    sync_mode character varying(20) DEFAULT 'shadow'::character varying NOT NULL,
    environment character varying(20) DEFAULT 'production'::character varying NOT NULL,
    external_account_id character varying(255),
    instance_url character varying(500),
    oauth_token_enc bytea,
    token_expires_at timestamp with time zone,
    scopes jsonb DEFAULT '[]'::jsonb NOT NULL,
    next_poll_at timestamp with time zone,
    last_error character varying(500),
    last_refresh_at timestamp with time zone,
    connected_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT crm_connections_env_enum CHECK (((environment)::text = ANY ((ARRAY['production'::character varying, 'sandbox'::character varying])::text[]))),
    CONSTRAINT crm_connections_mode_enum CHECK (((sync_mode)::text = ANY ((ARRAY['disabled'::character varying, 'shadow'::character varying, 'enforce'::character varying])::text[]))),
    CONSTRAINT crm_connections_provider_enum CHECK (((provider)::text = ANY ((ARRAY['salesforce'::character varying, 'hubspot'::character varying])::text[]))),
    CONSTRAINT crm_connections_status_enum CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'connected'::character varying, 'error'::character varying, 'paused'::character varying, 'disconnected'::character varying])::text[])))
);

ALTER TABLE ONLY public.crm_connections FORCE ROW LEVEL SECURITY;


--
-- Name: crm_field_mappings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_field_mappings (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    connection_id uuid NOT NULL,
    object_type character varying(20) NOT NULL,
    tp_field character varying(100) NOT NULL,
    crm_field character varying(255) NOT NULL,
    direction character varying(20) DEFAULT 'inbound'::character varying NOT NULL,
    authority character varying(20) DEFAULT 'crm'::character varying NOT NULL,
    conf_threshold numeric(4,3),
    transform character varying(40) DEFAULT 'passthrough'::character varying NOT NULL,
    transform_config jsonb DEFAULT '{}'::jsonb NOT NULL,
    is_required boolean DEFAULT false NOT NULL,
    is_dedup_key boolean DEFAULT false NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT crm_field_mappings_authority_enum CHECK (((authority)::text = ANY ((ARRAY['crm'::character varying, 'truepoint'::character varying])::text[]))),
    CONSTRAINT crm_field_mappings_direction_enum CHECK (((direction)::text = ANY ((ARRAY['inbound'::character varying, 'outbound'::character varying, 'bidirectional'::character varying, 'disabled'::character varying])::text[]))),
    CONSTRAINT crm_field_mappings_object_type_enum CHECK (((object_type)::text = ANY ((ARRAY['contact'::character varying, 'account'::character varying, 'lead'::character varying, 'deal'::character varying])::text[]))),
    CONSTRAINT crm_field_mappings_transform_enum CHECK (((transform)::text = ANY ((ARRAY['passthrough'::character varying, 'phone_e164'::character varying, 'lowercase'::character varying, 'seniority_map'::character varying, 'date_iso'::character varying, 'picklist_map'::character varying])::text[])))
);

ALTER TABLE ONLY public.crm_field_mappings FORCE ROW LEVEL SECURITY;


--
-- Name: crm_inbound_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_inbound_events (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    connection_id uuid NOT NULL,
    provider character varying(20) NOT NULL,
    object_type character varying(20) NOT NULL,
    crm_object_type character varying(40) NOT NULL,
    crm_record_id character varying(255) NOT NULL,
    provider_event_id character varying(255) NOT NULL,
    event_type character varying(60),
    source_tag character varying(120),
    process_status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    processed_at timestamp with time zone,
    CONSTRAINT crm_inbound_events_object_type_enum CHECK (((object_type)::text = ANY ((ARRAY['contact'::character varying, 'account'::character varying, 'lead'::character varying, 'deal'::character varying])::text[]))),
    CONSTRAINT crm_inbound_events_process_status_enum CHECK (((process_status)::text = ANY ((ARRAY['pending'::character varying, 'processed'::character varying, 'skipped'::character varying, 'failed'::character varying])::text[]))),
    CONSTRAINT crm_inbound_events_provider_enum CHECK (((provider)::text = ANY ((ARRAY['salesforce'::character varying, 'hubspot'::character varying])::text[])))
);

ALTER TABLE ONLY public.crm_inbound_events FORCE ROW LEVEL SECURITY;


--
-- Name: crm_oauth_states; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_oauth_states (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    owner_user_id uuid,
    provider character varying(20) NOT NULL,
    state character varying(255) NOT NULL,
    code_verifier_enc bytea,
    redirect_uri character varying(500),
    environment character varying(20) DEFAULT 'production'::character varying NOT NULL,
    scopes jsonb DEFAULT '[]'::jsonb NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT crm_oauth_states_env_enum CHECK (((environment)::text = ANY ((ARRAY['production'::character varying, 'sandbox'::character varying])::text[]))),
    CONSTRAINT crm_oauth_states_provider_enum CHECK (((provider)::text = ANY ((ARRAY['salesforce'::character varying, 'hubspot'::character varying])::text[])))
);

ALTER TABLE ONLY public.crm_oauth_states FORCE ROW LEVEL SECURITY;


--
-- Name: crm_object_contribution; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_object_contribution (
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    connection_id uuid NOT NULL,
    object_type character varying(20) NOT NULL,
    contribute_enabled boolean DEFAULT false NOT NULL,
    enabled_by_user_id uuid,
    enabled_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT crm_object_contribution_enabled_is_attributed CHECK (((contribute_enabled = false) OR ((enabled_by_user_id IS NOT NULL) AND (enabled_at IS NOT NULL)))),
    CONSTRAINT crm_object_contribution_object_enum CHECK (((object_type)::text = ANY ((ARRAY['contact'::character varying, 'account'::character varying, 'lead'::character varying, 'deal'::character varying])::text[])))
);

ALTER TABLE ONLY public.crm_object_contribution FORCE ROW LEVEL SECURITY;


--
-- Name: crm_record_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_record_links (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    connection_id uuid NOT NULL,
    tp_entity_type character varying(20) NOT NULL,
    contact_id uuid,
    account_id uuid,
    crm_object_type character varying(40) NOT NULL,
    crm_record_id character varying(255) NOT NULL,
    external_key character varying(255),
    last_synced_hash bytea,
    last_inbound_modstamp timestamp with time zone,
    last_inbound_at timestamp with time zone,
    last_outbound_at timestamp with time zone,
    link_status character varying(20) DEFAULT 'linked'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT crm_record_links_exactly_one CHECK ((num_nonnulls(contact_id, account_id) = 1)),
    CONSTRAINT crm_record_links_status_enum CHECK (((link_status)::text = ANY ((ARRAY['linked'::character varying, 'ambiguous'::character varying, 'broken'::character varying])::text[]))),
    CONSTRAINT crm_record_links_type_enum CHECK (((tp_entity_type)::text = ANY ((ARRAY['contact'::character varying, 'account'::character varying])::text[])))
);

ALTER TABLE ONLY public.crm_record_links FORCE ROW LEVEL SECURITY;


--
-- Name: crm_sync_conflicts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_sync_conflicts (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    connection_id uuid NOT NULL,
    record_link_id uuid,
    object_type character varying(20) NOT NULL,
    field character varying(100) NOT NULL,
    status character varying(20) DEFAULT 'open'::character varying NOT NULL,
    tp_value text,
    crm_value text,
    resolved_by_user_id uuid,
    resolved_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT crm_sync_conflicts_object_type_enum CHECK (((object_type)::text = ANY ((ARRAY['contact'::character varying, 'account'::character varying, 'lead'::character varying, 'deal'::character varying])::text[]))),
    CONSTRAINT crm_sync_conflicts_status_enum CHECK (((status)::text = ANY ((ARRAY['open'::character varying, 'resolved'::character varying, 'ignored'::character varying])::text[])))
);

ALTER TABLE ONLY public.crm_sync_conflicts FORCE ROW LEVEL SECURITY;


--
-- Name: crm_sync_dead_letter; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_sync_dead_letter (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    connection_id uuid NOT NULL,
    run_id uuid,
    queue character varying(40) NOT NULL,
    direction character varying(20),
    object_type character varying(20),
    crm_object_type character varying(40),
    crm_record_id character varying(255),
    tp_entity_id uuid,
    error_class character varying(30) NOT NULL,
    error_detail character varying(1000),
    attempts integer DEFAULT 0 NOT NULL,
    status character varying(20) DEFAULT 'open'::character varying NOT NULL,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT crm_sync_dead_letter_direction_enum CHECK (((direction IS NULL) OR ((direction)::text = ANY ((ARRAY['inbound'::character varying, 'outbound'::character varying])::text[])))),
    CONSTRAINT crm_sync_dead_letter_error_class_enum CHECK (((error_class)::text = ANY ((ARRAY['rate_limited'::character varying, 'auth'::character varying, 'validation'::character varying, 'conflict_unresolved'::character varying, 'transform'::character varying, 'not_found'::character varying, 'provider_5xx'::character varying, 'ssrf_blocked'::character varying, 'suppressed'::character varying, 'unknown'::character varying])::text[]))),
    CONSTRAINT crm_sync_dead_letter_object_type_enum CHECK (((object_type IS NULL) OR ((object_type)::text = ANY ((ARRAY['contact'::character varying, 'account'::character varying, 'lead'::character varying, 'deal'::character varying])::text[])))),
    CONSTRAINT crm_sync_dead_letter_status_enum CHECK (((status)::text = ANY ((ARRAY['open'::character varying, 'retrying'::character varying, 'resolved'::character varying, 'ignored'::character varying])::text[])))
);

ALTER TABLE ONLY public.crm_sync_dead_letter FORCE ROW LEVEL SECURITY;


--
-- Name: crm_sync_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_sync_runs (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    connection_id uuid NOT NULL,
    provider character varying(20) NOT NULL,
    object_type character varying(20) NOT NULL,
    direction character varying(20) NOT NULL,
    trigger character varying(20) NOT NULL,
    mode character varying(20) NOT NULL,
    status character varying(20) DEFAULT 'running'::character varying NOT NULL,
    records_seen integer DEFAULT 0 NOT NULL,
    records_created integer DEFAULT 0 NOT NULL,
    records_updated integer DEFAULT 0 NOT NULL,
    records_matched integer DEFAULT 0 NOT NULL,
    records_skipped integer DEFAULT 0 NOT NULL,
    records_conflicted integer DEFAULT 0 NOT NULL,
    records_failed integer DEFAULT 0 NOT NULL,
    api_calls integer DEFAULT 0 NOT NULL,
    rate_limited_ct integer DEFAULT 0 NOT NULL,
    rate_limit_remaining integer,
    watermark_before timestamp with time zone,
    watermark_after timestamp with time zone,
    window_start timestamp with time zone,
    window_end timestamp with time zone,
    sync_run_id uuid,
    failed_reason text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT crm_sync_runs_direction_enum CHECK (((direction)::text = ANY ((ARRAY['inbound'::character varying, 'outbound'::character varying])::text[]))),
    CONSTRAINT crm_sync_runs_mode_enum CHECK (((mode)::text = ANY ((ARRAY['disabled'::character varying, 'shadow'::character varying, 'enforce'::character varying])::text[]))),
    CONSTRAINT crm_sync_runs_object_type_enum CHECK (((object_type)::text = ANY ((ARRAY['contact'::character varying, 'account'::character varying, 'lead'::character varying, 'deal'::character varying])::text[]))),
    CONSTRAINT crm_sync_runs_provider_enum CHECK (((provider)::text = ANY ((ARRAY['salesforce'::character varying, 'hubspot'::character varying])::text[]))),
    CONSTRAINT crm_sync_runs_status_enum CHECK (((status)::text = ANY ((ARRAY['running'::character varying, 'completed'::character varying, 'partial'::character varying, 'failed'::character varying, 'cancelled'::character varying])::text[]))),
    CONSTRAINT crm_sync_runs_trigger_enum CHECK (((trigger)::text = ANY ((ARRAY['backfill'::character varying, 'scheduled'::character varying, 'webhook'::character varying, 'manual'::character varying, 'replay'::character varying, 'dsar'::character varying])::text[])))
);

ALTER TABLE ONLY public.crm_sync_runs FORCE ROW LEVEL SECURITY;


--
-- Name: crm_sync_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_sync_state (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    connection_id uuid NOT NULL,
    object_type character varying(20) NOT NULL,
    direction character varying(20) NOT NULL,
    watermark timestamp with time zone,
    replay_id character varying(255),
    backfill_status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    backfill_cursor character varying(512),
    last_run_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT crm_sync_state_backfill_status_enum CHECK (((backfill_status)::text = ANY ((ARRAY['pending'::character varying, 'running'::character varying, 'completed'::character varying])::text[]))),
    CONSTRAINT crm_sync_state_direction_enum CHECK (((direction)::text = ANY ((ARRAY['inbound'::character varying, 'outbound'::character varying])::text[]))),
    CONSTRAINT crm_sync_state_object_type_enum CHECK (((object_type)::text = ANY ((ARRAY['contact'::character varying, 'account'::character varying, 'lead'::character varying, 'deal'::character varying])::text[])))
);

ALTER TABLE ONLY public.crm_sync_state FORCE ROW LEVEL SECURITY;


--
-- Name: custom_field_definitions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.custom_field_definitions (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    entity character varying(20) NOT NULL,
    key character varying(64) NOT NULL,
    label character varying(120) NOT NULL,
    field_type character varying(20) NOT NULL,
    options jsonb,
    required boolean DEFAULT false NOT NULL,
    archived boolean DEFAULT false NOT NULL,
    ordering integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT custom_field_defs_entity_enum CHECK (((entity)::text = ANY ((ARRAY['contact'::character varying, 'account'::character varying])::text[]))),
    CONSTRAINT custom_field_defs_options_shape CHECK (((((field_type)::text = 'select'::text) AND (options IS NOT NULL) AND (jsonb_array_length(options) > 0)) OR (((field_type)::text <> 'select'::text) AND (options IS NULL)))),
    CONSTRAINT custom_field_defs_type_enum CHECK (((field_type)::text = ANY ((ARRAY['text'::character varying, 'number'::character varying, 'date'::character varying, 'select'::character varying, 'boolean'::character varying, 'url'::character varying])::text[])))
);

ALTER TABLE ONLY public.custom_field_definitions FORCE ROW LEVEL SECURITY;


--
-- Name: data_quality_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.data_quality_snapshots (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    metrics jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.data_quality_snapshots FORCE ROW LEVEL SECURITY;


--
-- Name: dsar_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dsar_requests (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    request_type character varying(20) NOT NULL,
    subject_email_enc bytea NOT NULL,
    subject_email_blind_index bytea NOT NULL,
    status character varying(30) DEFAULT 'received'::character varying NOT NULL,
    scope_report jsonb,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    verified_at timestamp with time zone,
    completed_at timestamp with time zone,
    due_at timestamp with time zone DEFAULT (now() + '72:00:00'::interval),
    CONSTRAINT dsar_status_enum CHECK (((status)::text = ANY ((ARRAY['received'::character varying, 'verifying'::character varying, 'processing'::character varying, 'completed'::character varying, 'rejected'::character varying])::text[]))),
    CONSTRAINT dsar_type_enum CHECK (((request_type)::text = ANY ((ARRAY['access'::character varying, 'delete'::character varying, 'rectify'::character varying])::text[])))
);

ALTER TABLE ONLY public.dsar_requests FORCE ROW LEVEL SECURITY;


--
-- Name: email_event; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_event (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    outreach_log_id uuid,
    contact_id uuid,
    message_id character varying(255),
    event_type character varying(20) NOT NULL,
    provider_event_id character varying(255),
    is_mpp_suspected boolean DEFAULT false NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT email_event_type_enum CHECK (((event_type)::text = ANY ((ARRAY['delivery'::character varying, 'open'::character varying, 'click'::character varying, 'bounce'::character varying, 'complaint'::character varying, 'unsubscribe'::character varying, 'reply'::character varying, 'auto_reply'::character varying])::text[])))
);

ALTER TABLE ONLY public.email_event FORCE ROW LEVEL SECURITY;


--
-- Name: email_message; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_message (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    thread_id uuid NOT NULL,
    mailbox_integration_id uuid,
    contact_id uuid,
    outreach_log_id uuid,
    direction character varying(10) NOT NULL,
    provider_message_id character varying(255),
    rfc822_message_id character varying(998),
    in_reply_to character varying(998),
    reference_ids text[],
    subject character varying(255),
    snippet character varying(280),
    from_addr public.citext NOT NULL,
    to_addrs text[],
    body_enc bytea,
    is_auto_reply boolean DEFAULT false NOT NULL,
    classification character varying(20) DEFAULT 'unknown'::character varying NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT email_message_classification_enum CHECK (((classification)::text = ANY ((ARRAY['human'::character varying, 'auto_reply'::character varying, 'ooo'::character varying, 'bounce'::character varying, 'unknown'::character varying])::text[]))),
    CONSTRAINT email_message_direction_enum CHECK (((direction)::text = ANY ((ARRAY['inbound'::character varying, 'outbound'::character varying])::text[])))
);

ALTER TABLE ONLY public.email_message FORCE ROW LEVEL SECURITY;


--
-- Name: email_template; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_template (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    owner_user_id uuid,
    name character varying(255) NOT NULL,
    channel character varying(20) DEFAULT 'email'::character varying NOT NULL,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    shared boolean DEFAULT false NOT NULL,
    current_version_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT email_template_channel_enum CHECK (((channel)::text = ANY ((ARRAY['email'::character varying, 'linkedin'::character varying])::text[]))),
    CONSTRAINT email_template_status_enum CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'archived'::character varying])::text[])))
);

ALTER TABLE ONLY public.email_template FORCE ROW LEVEL SECURITY;


--
-- Name: email_template_version; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_template_version (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    template_id uuid NOT NULL,
    version integer NOT NULL,
    subject character varying(255),
    body text NOT NULL,
    created_by_user_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.email_template_version FORCE ROW LEVEL SECURITY;


--
-- Name: email_thread; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_thread (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    contact_id uuid,
    owner_user_id uuid,
    mailbox_integration_id uuid,
    sequence_id uuid,
    provider_thread_id character varying(255),
    subject_normalized character varying(255),
    status character varying(20) DEFAULT 'open'::character varying NOT NULL,
    assignee_user_id uuid,
    last_message_at timestamp with time zone,
    message_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT email_thread_status_enum CHECK (((status)::text = ANY ((ARRAY['open'::character varying, 'snoozed'::character varying, 'done'::character varying])::text[])))
);

ALTER TABLE ONLY public.email_thread FORCE ROW LEVEL SECURITY;


--
-- Name: enrichment_job_chunks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.enrichment_job_chunks (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    job_id uuid NOT NULL,
    chunk_index integer NOT NULL,
    row_start integer NOT NULL,
    row_end integer NOT NULL,
    status character varying(30) DEFAULT 'queued'::character varying NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    processed_rows integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT enrichment_job_chunks_status_enum CHECK (((status)::text = ANY ((ARRAY['queued'::character varying, 'estimating'::character varying, 'awaiting_confirmation'::character varying, 'running'::character varying, 'paused'::character varying, 'completed'::character varying, 'failed'::character varying, 'cancelled'::character varying])::text[])))
);

ALTER TABLE ONLY public.enrichment_job_chunks FORCE ROW LEVEL SECURITY;


--
-- Name: enrichment_job_rows; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.enrichment_job_rows (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    job_id uuid NOT NULL,
    chunk_id uuid NOT NULL,
    row_index integer NOT NULL,
    workspace_id uuid NOT NULL,
    input jsonb DEFAULT '{}'::jsonb NOT NULL,
    match_method character varying(30) DEFAULT 'none'::character varying NOT NULL,
    match_outcome character varying(30) DEFAULT 'unmatched'::character varying NOT NULL,
    matched_contact_id uuid,
    matched_master_person_id uuid,
    match_confidence numeric(5,4),
    enriched_fields jsonb DEFAULT '{}'::jsonb NOT NULL,
    provider_source character varying(50),
    cost_micros bigint DEFAULT 0 NOT NULL,
    charged boolean DEFAULT false NOT NULL,
    email_status character varying(20) DEFAULT 'unverified'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT enrichment_job_rows_confidence_range CHECK (((match_confidence IS NULL) OR ((match_confidence >= (0)::numeric) AND (match_confidence <= (1)::numeric)))),
    CONSTRAINT enrichment_job_rows_email_status_enum CHECK (((email_status)::text = ANY ((ARRAY['unverified'::character varying, 'valid'::character varying, 'risky'::character varying, 'invalid'::character varying, 'catch_all'::character varying, 'unknown'::character varying])::text[]))),
    CONSTRAINT enrichment_job_rows_match_method_enum CHECK (((match_method)::text = ANY ((ARRAY['deterministic_email'::character varying, 'deterministic_linkedin'::character varying, 'deterministic_phone'::character varying, 'deterministic_domain'::character varying, 'fuzzy_name_company'::character varying, 'provider'::character varying, 'none'::character varying])::text[]))),
    CONSTRAINT enrichment_job_rows_match_outcome_enum CHECK (((match_outcome)::text = ANY ((ARRAY['matched_internal'::character varying, 'matched_provider'::character varying, 'unmatched'::character varying, 'suppressed'::character varying, 'error'::character varying])::text[])))
);

ALTER TABLE ONLY public.enrichment_job_rows FORCE ROW LEVEL SECURITY;


--
-- Name: enrichment_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.enrichment_jobs (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    created_by_user_id uuid,
    source_file character varying(1024) NOT NULL,
    source_name character varying(255) NOT NULL,
    status character varying(30) DEFAULT 'queued'::character varying NOT NULL,
    total_rows integer DEFAULT 0 NOT NULL,
    processed_rows integer DEFAULT 0 NOT NULL,
    matched_rows integer DEFAULT 0 NOT NULL,
    enriched_rows integer DEFAULT 0 NOT NULL,
    charged_rows integer DEFAULT 0 NOT NULL,
    credit_estimate_micros bigint,
    credit_spent_micros bigint DEFAULT 0 NOT NULL,
    column_mapping jsonb DEFAULT '{}'::jsonb NOT NULL,
    options jsonb DEFAULT '{}'::jsonb NOT NULL,
    idempotency_key character varying(255),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    failed_reason text,
    shared_with_workspace boolean DEFAULT false NOT NULL,
    CONSTRAINT enrichment_jobs_status_enum CHECK (((status)::text = ANY ((ARRAY['queued'::character varying, 'estimating'::character varying, 'awaiting_confirmation'::character varying, 'running'::character varying, 'paused'::character varying, 'completed'::character varying, 'failed'::character varying, 'cancelled'::character varying])::text[])))
);

ALTER TABLE ONLY public.enrichment_jobs FORCE ROW LEVEL SECURITY;


--
-- Name: enrichment_policy; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.enrichment_policy (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    triggers jsonb DEFAULT '[]'::jsonb NOT NULL,
    field_allowlist jsonb DEFAULT '[]'::jsonb NOT NULL,
    monthly_budget_micros bigint DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    lawful_basis character varying(30),
    CONSTRAINT enrichment_policy_lawful_basis_enum CHECK (((lawful_basis IS NULL) OR ((lawful_basis)::text = ANY ((ARRAY['legitimate_interest'::character varying, 'consent'::character varying, 'contract'::character varying, 'public_record'::character varying])::text[]))))
);

ALTER TABLE ONLY public.enrichment_policy FORCE ROW LEVEL SECURITY;


--
-- Name: entitlement; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.entitlement (
    tenant_id uuid NOT NULL,
    key character varying(50) NOT NULL,
    cap integer,
    period character varying(20),
    source character varying(20) NOT NULL,
    granted_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone,
    CONSTRAINT entitlement_cap_non_negative CHECK (((cap IS NULL) OR (cap >= 0))),
    CONSTRAINT entitlement_period_enum CHECK (((period IS NULL) OR ((period)::text = ANY ((ARRAY['month'::character varying, 'lifetime'::character varying])::text[])))),
    CONSTRAINT entitlement_source_enum CHECK (((source)::text = ANY ((ARRAY['plan'::character varying, 'community'::character varying, 'grant'::character varying, 'staff'::character varying])::text[])))
);

ALTER TABLE ONLY public.entitlement FORCE ROW LEVEL SECURITY;


--
-- Name: event_outbox; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.event_outbox (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    event_type character varying(60) NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    published_at timestamp with time zone,
    last_error character varying(500),
    CONSTRAINT event_outbox_status_enum CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'published'::character varying, 'failed'::character varying])::text[])))
);


--
-- Name: feature_flags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.feature_flags (
    key character varying(100) NOT NULL,
    description character varying(500),
    global_enabled boolean DEFAULT false NOT NULL,
    "default" boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.feature_flags FORCE ROW LEVEL SECURITY;


--
-- Name: idempotency_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.idempotency_keys (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    key character varying(255) NOT NULL,
    response_status integer NOT NULL,
    response_body jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.idempotency_keys FORCE ROW LEVEL SECURITY;


--
-- Name: impersonation_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.impersonation_sessions (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    staff_user_id uuid NOT NULL,
    target_tenant_id uuid NOT NULL,
    target_workspace_id uuid,
    target_user_id uuid,
    reason text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    ended_at timestamp with time zone,
    ip text
);


--
-- Name: import_job_chunks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.import_job_chunks (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    job_id uuid NOT NULL,
    chunk_index integer NOT NULL,
    row_start integer NOT NULL,
    row_end integer NOT NULL,
    status character varying(30) DEFAULT 'queued'::character varying NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    processed_rows integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT import_job_chunks_status_enum CHECK (((status)::text = ANY ((ARRAY['queued'::character varying, 'running'::character varying, 'paused'::character varying, 'completed'::character varying, 'partial'::character varying, 'failed'::character varying, 'cancelled'::character varying])::text[])))
);

ALTER TABLE ONLY public.import_job_chunks FORCE ROW LEVEL SECURITY;


--
-- Name: import_job_rows; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.import_job_rows (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    job_id uuid NOT NULL,
    chunk_id uuid NOT NULL,
    row_index integer NOT NULL,
    workspace_id uuid NOT NULL,
    input jsonb DEFAULT '{}'::jsonb NOT NULL,
    outcome character varying(20) DEFAULT 'unprocessed'::character varying NOT NULL,
    reject_reason text,
    created_contact_id uuid,
    updated_contact_id uuid,
    matched_contact_id uuid,
    source_import_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT import_job_rows_outcome_enum CHECK (((outcome)::text = ANY ((ARRAY['created'::character varying, 'matched'::character varying, 'duplicate'::character varying, 'skipped'::character varying, 'rejected'::character varying, 'unprocessed'::character varying])::text[])))
)
WITH (autovacuum_vacuum_scale_factor='0.01', autovacuum_vacuum_threshold='10000', autovacuum_vacuum_insert_scale_factor='0.01', autovacuum_vacuum_insert_threshold='100000', autovacuum_analyze_scale_factor='0.01', autovacuum_analyze_threshold='10000');

ALTER TABLE ONLY public.import_job_rows FORCE ROW LEVEL SECURITY;


--
-- Name: import_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.import_jobs (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    created_by_user_id uuid,
    source_file character varying(1024) NOT NULL,
    source_name character varying(255) NOT NULL,
    status character varying(30) DEFAULT 'queued'::character varying NOT NULL,
    file_size bigint,
    av_scan_status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    idempotency_key character varying(255),
    column_mapping jsonb DEFAULT '{}'::jsonb NOT NULL,
    conflict_policy character varying(20) DEFAULT 'skip'::character varying NOT NULL,
    target_list_id uuid,
    staging_table character varying(128),
    byte_offset bigint DEFAULT 0 NOT NULL,
    total_chunks integer DEFAULT 0 NOT NULL,
    completed_chunks integer DEFAULT 0 NOT NULL,
    rows_total integer DEFAULT 0 NOT NULL,
    rows_created integer DEFAULT 0 NOT NULL,
    rows_matched integer DEFAULT 0 NOT NULL,
    rows_duplicate integer DEFAULT 0 NOT NULL,
    rows_skipped integer DEFAULT 0 NOT NULL,
    rows_rejected integer DEFAULT 0 NOT NULL,
    rows_deduped integer DEFAULT 0 NOT NULL,
    rows_unprocessed integer DEFAULT 0 NOT NULL,
    rejected_artifact_key character varying(1024),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    failed_reason text,
    reject_histogram jsonb DEFAULT '{}'::jsonb NOT NULL,
    shared_with_workspace boolean DEFAULT false NOT NULL,
    processing_mode character varying(10),
    merge_mode character varying(20) DEFAULT 'create_and_update'::character varying NOT NULL,
    preserve_populated boolean DEFAULT false NOT NULL,
    parent_job_id uuid,
    source_filename character varying(255),
    mapping_template_id uuid,
    options jsonb DEFAULT '{}'::jsonb NOT NULL,
    preview_summary jsonb,
    CONSTRAINT import_jobs_av_scan_status_enum CHECK (((av_scan_status)::text = ANY ((ARRAY['pending'::character varying, 'clean'::character varying, 'infected'::character varying, 'skipped'::character varying])::text[]))),
    CONSTRAINT import_jobs_conflict_policy_enum CHECK (((conflict_policy)::text = ANY ((ARRAY['overwrite'::character varying, 'skip'::character varying, 'keep_both'::character varying])::text[]))),
    CONSTRAINT import_jobs_merge_mode_enum CHECK (((merge_mode)::text = ANY ((ARRAY['create_and_update'::character varying, 'create_only'::character varying, 'update_only'::character varying])::text[]))),
    CONSTRAINT import_jobs_processing_mode_enum CHECK (((processing_mode)::text = ANY ((ARRAY['fast'::character varying, 'copy'::character varying])::text[]))),
    CONSTRAINT import_jobs_status_enum CHECK (((status)::text = ANY ((ARRAY['queued'::character varying, 'validating'::character varying, 'staged'::character varying, 'running'::character varying, 'paused'::character varying, 'completed'::character varying, 'partial'::character varying, 'failed'::character varying, 'cancelled'::character varying, 'draft'::character varying, 'uploading'::character varying, 'deferred'::character varying])::text[])))
)
WITH (fillfactor='90');

ALTER TABLE ONLY public.import_jobs FORCE ROW LEVEL SECURITY;


--
-- Name: import_mapping_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.import_mapping_templates (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    name character varying(120) NOT NULL,
    mapping jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by_user_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    visibility character varying(10) DEFAULT 'workspace'::character varying NOT NULL,
    merge_mode character varying(20),
    preserve_populated boolean,
    options jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT import_mapping_templates_merge_mode_enum CHECK (((merge_mode)::text = ANY ((ARRAY['create_and_update'::character varying, 'create_only'::character varying, 'update_only'::character varying])::text[]))),
    CONSTRAINT import_mapping_templates_visibility_enum CHECK (((visibility)::text = ANY ((ARRAY['private'::character varying, 'workspace'::character varying])::text[])))
);

ALTER TABLE ONLY public.import_mapping_templates FORCE ROW LEVEL SECURITY;


--
-- Name: import_policy; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.import_policy (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    who_can_import character varying(10) DEFAULT 'member'::character varying NOT NULL,
    default_merge_mode character varying(20) DEFAULT 'create_and_update'::character varying NOT NULL,
    default_preserve_populated boolean DEFAULT false NOT NULL,
    updated_by_user_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    lawful_basis character varying(30),
    CONSTRAINT import_policy_default_merge_mode_enum CHECK (((default_merge_mode)::text = ANY ((ARRAY['create_and_update'::character varying, 'create_only'::character varying, 'update_only'::character varying])::text[]))),
    CONSTRAINT import_policy_lawful_basis_enum CHECK (((lawful_basis IS NULL) OR ((lawful_basis)::text = ANY ((ARRAY['legitimate_interest'::character varying, 'consent'::character varying, 'contract'::character varying, 'public_record'::character varying])::text[])))),
    CONSTRAINT import_policy_who_can_import_enum CHECK (((who_can_import)::text = ANY ((ARRAY['member'::character varying, 'admin'::character varying])::text[])))
);

ALTER TABLE ONLY public.import_policy FORCE ROW LEVEL SECURITY;


--
-- Name: intent_signals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.intent_signals (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    signal_type character varying(50) NOT NULL,
    signal_source character varying(50),
    detail character varying(500),
    weight integer DEFAULT 1 NOT NULL,
    detected_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT intent_signals_type_enum CHECK (((signal_type)::text = ANY ((ARRAY['job_change'::character varying, 'new_hire'::character varying, 'funding_round'::character varying, 'tech_install'::character varying, 'web_visit'::character varying, 'content_engagement'::character varying, 'keyword_search'::character varying, 'linkedin_activity'::character varying, 'sales_nav_view'::character varying])::text[]))),
    CONSTRAINT intent_signals_weight_range CHECK (((weight >= 1) AND (weight <= 10)))
);

ALTER TABLE ONLY public.intent_signals FORCE ROW LEVEL SECURITY;


--
-- Name: invitations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invitations (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid,
    email public.citext NOT NULL,
    role character varying(50) DEFAULT 'member'::character varying NOT NULL,
    is_tenant_owner boolean DEFAULT false NOT NULL,
    token_hash character varying(255) NOT NULL,
    invited_by_user_id uuid,
    expires_at timestamp with time zone NOT NULL,
    accepted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: jit_elevations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.jit_elevations (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    staff_user_id uuid NOT NULL,
    action text NOT NULL,
    reason text NOT NULL,
    target_tenant_id uuid,
    status text DEFAULT 'active'::text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    granted_at timestamp with time zone DEFAULT now() NOT NULL,
    consumed_at timestamp with time zone,
    approved_by_user_id uuid,
    ip text
);


--
-- Name: list_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.list_members (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    list_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    added_by_user_id uuid,
    added_at timestamp with time zone DEFAULT now() NOT NULL,
    added_via character varying(20) DEFAULT 'manual'::character varying NOT NULL,
    source_import_id uuid,
    CONSTRAINT list_members_added_via_enum CHECK (((added_via)::text = ANY ((ARRAY['search'::character varying, 'import'::character varying, 'manual'::character varying, 'api'::character varying])::text[])))
);

ALTER TABLE ONLY public.list_members FORCE ROW LEVEL SECURITY;


--
-- Name: lists; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lists (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    owner_user_id uuid NOT NULL,
    name character varying(120) NOT NULL,
    description character varying(500),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    list_kind character varying(20) DEFAULT 'static'::character varying NOT NULL,
    color character varying(30),
    icon character varying(40),
    tags jsonb DEFAULT '[]'::jsonb NOT NULL,
    notes text,
    source character varying(40),
    saved_search_id uuid,
    archived_at timestamp with time zone,
    deleted_at timestamp with time zone,
    CONSTRAINT lists_list_kind_enum CHECK (((list_kind)::text = ANY ((ARRAY['static'::character varying, 'dynamic'::character varying])::text[])))
);

ALTER TABLE ONLY public.lists FORCE ROW LEVEL SECURITY;


--
-- Name: mailbox_integration; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mailbox_integration (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    owner_user_id uuid,
    provider character varying(20) NOT NULL,
    address public.citext NOT NULL,
    sending_domain_id uuid,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    oauth_token_enc bytea,
    smtp_secret_enc bytea,
    last_error character varying(500),
    connected_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    oauth_expires_at timestamp with time zone,
    oauth_scopes text[],
    provider_account_id character varying(255),
    reauth_required boolean DEFAULT false NOT NULL,
    reauth_reason character varying(120),
    gmail_history_id character varying(255),
    CONSTRAINT mailbox_integration_provider_enum CHECK (((provider)::text = ANY ((ARRAY['google'::character varying, 'microsoft'::character varying, 'smtp'::character varying, 'ses'::character varying])::text[]))),
    CONSTRAINT mailbox_integration_status_enum CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'connected'::character varying, 'error'::character varying, 'disconnected'::character varying])::text[])))
);

ALTER TABLE ONLY public.mailbox_integration FORCE ROW LEVEL SECURITY;


--
-- Name: master_companies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.master_companies (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    primary_domain public.citext,
    alt_domains public.citext[] DEFAULT '{}'::public.citext[] NOT NULL,
    name character varying(255) NOT NULL,
    name_normalized public.citext,
    linkedin_company_id character varying(255),
    parent_company_id uuid,
    industry character varying(100),
    sub_industry character varying(100),
    employee_count integer,
    employee_band character varying(20),
    revenue_range character varying(50),
    technographics jsonb DEFAULT '{}'::jsonb NOT NULL,
    hq_country character varying(100),
    hq_city character varying(100),
    data_quality_score integer,
    region character(2),
    jurisdiction character(2),
    block_key character varying(255),
    field_provenance jsonb DEFAULT '{}'::jsonb NOT NULL,
    prov_hwm timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT master_companies_data_quality_range CHECK (((data_quality_score IS NULL) OR ((data_quality_score >= 0) AND (data_quality_score <= 100))))
);


--
-- Name: master_emails; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.master_emails (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    master_person_id uuid NOT NULL,
    email_enc bytea,
    email_blind_index bytea NOT NULL,
    email_domain public.citext,
    email_status character varying(20) DEFAULT 'unverified'::character varying NOT NULL,
    source_count integer DEFAULT 1 NOT NULL,
    last_verified_at timestamp with time zone,
    verification_source character varying(50),
    is_primary boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT master_emails_email_status_enum CHECK (((email_status)::text = ANY ((ARRAY['unverified'::character varying, 'valid'::character varying, 'risky'::character varying, 'invalid'::character varying, 'catch_all'::character varying, 'unknown'::character varying])::text[])))
);


--
-- Name: master_employment; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.master_employment (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    master_person_id uuid NOT NULL,
    master_company_id uuid NOT NULL,
    title character varying(255),
    department character varying(100),
    seniority_level character varying(50),
    is_current boolean DEFAULT true NOT NULL,
    is_primary boolean DEFAULT false NOT NULL,
    started_on date DEFAULT '-infinity'::date NOT NULL,
    ended_on date,
    asserting_source character varying(50),
    match_method character varying(20),
    confidence numeric(4,3),
    source_count integer DEFAULT 1 NOT NULL,
    observed_at timestamp with time zone,
    last_verified_at timestamp with time zone,
    field_provenance jsonb DEFAULT '{}'::jsonb NOT NULL,
    prov_hwm timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT master_employment_confidence_range CHECK (((confidence IS NULL) OR ((confidence >= (0)::numeric) AND (confidence <= (1)::numeric)))),
    CONSTRAINT master_employment_ended_after_started CHECK (((ended_on IS NULL) OR (ended_on >= started_on))),
    CONSTRAINT master_employment_primary_is_current CHECK (((is_primary = false) OR (is_current = true))),
    CONSTRAINT master_employment_seniority_enum CHECK (((seniority_level IS NULL) OR ((seniority_level)::text = ANY ((ARRAY['c_suite'::character varying, 'vp'::character varying, 'director'::character varying, 'manager'::character varying, 'ic'::character varying, 'other'::character varying])::text[]))))
);


--
-- Name: master_persons; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.master_persons (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    linkedin_public_id character varying(255),
    full_name character varying(255),
    first_name character varying(100),
    last_name character varying(100),
    current_company_id uuid,
    job_title character varying(255),
    seniority_level character varying(50),
    department character varying(100),
    location_country character varying(100),
    location_city character varying(100),
    has_email boolean DEFAULT false NOT NULL,
    has_phone boolean DEFAULT false NOT NULL,
    data_quality_score integer,
    is_suppressed boolean DEFAULT false NOT NULL,
    region character(2),
    jurisdiction character(2),
    block_key character varying(255),
    field_provenance jsonb DEFAULT '{}'::jsonb NOT NULL,
    prov_hwm timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    merged_into_person_id uuid,
    merged_at timestamp with time zone,
    CONSTRAINT master_persons_data_quality_range CHECK (((data_quality_score IS NULL) OR ((data_quality_score >= 0) AND (data_quality_score <= 100)))),
    CONSTRAINT master_persons_merge_not_self CHECK (((merged_into_person_id IS NULL) OR (merged_into_person_id <> id))),
    CONSTRAINT master_persons_seniority_enum CHECK (((seniority_level IS NULL) OR ((seniority_level)::text = ANY ((ARRAY['c_suite'::character varying, 'vp'::character varying, 'director'::character varying, 'manager'::character varying, 'ic'::character varying, 'other'::character varying])::text[]))))
);


--
-- Name: master_phones; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.master_phones (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    master_person_id uuid NOT NULL,
    phone_enc bytea,
    phone_blind_index bytea NOT NULL,
    line_type character varying(20),
    phone_status character varying(50),
    source_count integer DEFAULT 1 NOT NULL,
    last_verified_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: match_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.match_links (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    entity_type character varying(10) NOT NULL,
    cluster_id uuid NOT NULL,
    source_record_id uuid NOT NULL,
    match_probability numeric(4,3),
    match_method character varying(20) NOT NULL,
    is_duplicate_of uuid,
    review_status character varying(20) DEFAULT 'auto'::character varying NOT NULL,
    resolved_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT match_links_entity_type_enum CHECK (((entity_type)::text = ANY ((ARRAY['person'::character varying, 'company'::character varying])::text[]))),
    CONSTRAINT match_links_match_probability_range CHECK (((match_probability IS NULL) OR ((match_probability >= (0)::numeric) AND (match_probability <= (1)::numeric)))),
    CONSTRAINT match_links_review_status_enum CHECK (((review_status)::text = ANY ((ARRAY['auto'::character varying, 'pending'::character varying, 'confirmed'::character varying, 'rejected'::character varying])::text[])))
);


--
-- Name: notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notifications (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    user_id uuid NOT NULL,
    type character varying(50) NOT NULL,
    title text NOT NULL,
    body text,
    entity_type character varying(50),
    entity_id uuid,
    read_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: oauth_connect_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.oauth_connect_state (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    user_id uuid NOT NULL,
    provider character varying(20) NOT NULL,
    state_token character varying(80) NOT NULL,
    pkce_verifier_enc bytea NOT NULL,
    redirect_after character varying(500),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    CONSTRAINT oauth_connect_state_provider_enum CHECK (((provider)::text = ANY ((ARRAY['google'::character varying, 'microsoft'::character varying])::text[])))
);


--
-- Name: outreach_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.outreach_log (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    sequence_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    status character varying(20) DEFAULT 'enrolled'::character varying NOT NULL,
    current_step integer DEFAULT 0 NOT NULL,
    last_event_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_reply_at timestamp with time zone,
    CONSTRAINT outreach_log_status_enum CHECK (((status)::text = ANY ((ARRAY['enrolled'::character varying, 'active'::character varying, 'replied'::character varying, 'completed'::character varying, 'unsubscribed'::character varying, 'bounced'::character varying])::text[])))
);

ALTER TABLE ONLY public.outreach_log FORCE ROW LEVEL SECURITY;


--
-- Name: outreach_sequences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.outreach_sequences (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    name character varying(255) NOT NULL,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    from_address character varying(255),
    physical_address character varying(500),
    created_by_user_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT outreach_sequences_status_enum CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'paused'::character varying, 'archived'::character varying])::text[])))
);

ALTER TABLE ONLY public.outreach_sequences FORCE ROW LEVEL SECURITY;


--
-- Name: outreach_steps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.outreach_steps (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    sequence_id uuid NOT NULL,
    step_order integer NOT NULL,
    channel character varying(20) DEFAULT 'email'::character varying NOT NULL,
    delay_hours integer DEFAULT 0 NOT NULL,
    subject character varying(255),
    body character varying(5000) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT outreach_steps_channel_enum CHECK (((channel)::text = ANY ((ARRAY['email'::character varying, 'linkedin'::character varying])::text[]))),
    CONSTRAINT outreach_steps_delay_nonneg CHECK ((delay_hours >= 0))
);

ALTER TABLE ONLY public.outreach_steps FORCE ROW LEVEL SECURITY;


--
-- Name: pipeline_stages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pipeline_stages (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    name character varying(120) NOT NULL,
    ordering integer DEFAULT 0 NOT NULL,
    maps_to_status character varying(50) NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    archived boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pipeline_stages_maps_to_status_enum CHECK (((maps_to_status)::text = ANY ((ARRAY['new'::character varying, 'in_sequence'::character varying, 'replied'::character varying, 'meeting_booked'::character varying, 'disqualified'::character varying, 'nurture'::character varying, 'unsubscribed'::character varying])::text[])))
);

ALTER TABLE ONLY public.pipeline_stages FORCE ROW LEVEL SECURITY;


--
-- Name: plan_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.plan_templates (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    key text NOT NULL,
    name text NOT NULL,
    seat_limit integer NOT NULL,
    workspace_limit integer,
    monthly_credit_grant integer,
    features jsonb DEFAULT '{}'::jsonb NOT NULL,
    active boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    trial_bonus_credits integer,
    stripe_price_id text
);


--
-- Name: platform_audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_audit_log (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    actor_user_id uuid NOT NULL,
    action text NOT NULL,
    target_type text,
    target_id text,
    tenant_id uuid,
    workspace_id uuid,
    ip text,
    metadata jsonb,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL
)
PARTITION BY RANGE (occurred_at);


--
-- Name: platform_audit_log_2026_08; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_audit_log_2026_08 (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    actor_user_id uuid NOT NULL,
    action text NOT NULL,
    target_type text,
    target_id text,
    tenant_id uuid,
    workspace_id uuid,
    ip text,
    metadata jsonb,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: platform_audit_log_2026_09; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_audit_log_2026_09 (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    actor_user_id uuid NOT NULL,
    action text NOT NULL,
    target_type text,
    target_id text,
    tenant_id uuid,
    workspace_id uuid,
    ip text,
    metadata jsonb,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: platform_audit_log_2026_10; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_audit_log_2026_10 (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    actor_user_id uuid NOT NULL,
    action text NOT NULL,
    target_type text,
    target_id text,
    tenant_id uuid,
    workspace_id uuid,
    ip text,
    metadata jsonb,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: platform_audit_log_2026_11; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_audit_log_2026_11 (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    actor_user_id uuid NOT NULL,
    action text NOT NULL,
    target_type text,
    target_id text,
    tenant_id uuid,
    workspace_id uuid,
    ip text,
    metadata jsonb,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: platform_audit_log_default; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_audit_log_default (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    actor_user_id uuid NOT NULL,
    action text NOT NULL,
    target_type text,
    target_id text,
    tenant_id uuid,
    workspace_id uuid,
    ip text,
    metadata jsonb,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: platform_staff; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_staff (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    user_id uuid NOT NULL,
    staff_role character varying(50) NOT NULL,
    status character varying(50) DEFAULT 'active'::character varying NOT NULL,
    granted_by_user_id uuid,
    granted_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone,
    CONSTRAINT platform_staff_role_check CHECK (((staff_role)::text = ANY ((ARRAY['super_admin'::character varying, 'support'::character varying, 'billing_ops'::character varying, 'compliance_officer'::character varying, 'read_only'::character varying, 'data_ops'::character varying])::text[])))
);


--
-- Name: processed_sync_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.processed_sync_events (
    event_id uuid NOT NULL,
    content_hash bytea,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: projection_outbox; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.projection_outbox (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    entity_type character varying(10) NOT NULL,
    cluster_id uuid NOT NULL,
    reason character varying(30) NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    enqueued_at timestamp with time zone DEFAULT now() NOT NULL,
    processed_at timestamp with time zone
);


--
-- Name: provenance_event; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.provenance_event (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    entity_type character varying(20) NOT NULL,
    entity_id uuid NOT NULL,
    field character varying(50) NOT NULL,
    action character varying(20) NOT NULL,
    source_type character varying(30) NOT NULL,
    source_name character varying(50),
    method character varying(30),
    contributor_ref uuid,
    lawful_basis character varying(30) NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    confidence numeric(4,3),
    acceptance_state character varying(20) DEFAULT 'accepted'::character varying NOT NULL,
    source_record_id uuid,
    scope_ref uuid,
    observed_at timestamp with time zone,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT provenance_event_acceptance_enum CHECK (((acceptance_state)::text = ANY ((ARRAY['accepted'::character varying, 'pending'::character varying, 'rejected'::character varying, 'superseded'::character varying])::text[]))),
    CONSTRAINT provenance_event_action_enum CHECK (((action)::text = ANY ((ARRAY['assert'::character varying, 'confirm'::character varying, 'deny'::character varying, 'correct'::character varying, 'verify'::character varying, 'pin'::character varying, 'tombstone'::character varying, 'merge'::character varying])::text[]))),
    CONSTRAINT provenance_event_confidence_range CHECK (((confidence IS NULL) OR ((confidence >= (0)::numeric) AND (confidence <= (1)::numeric)))),
    CONSTRAINT provenance_event_entity_type_enum CHECK (((entity_type)::text = ANY ((ARRAY['person'::character varying, 'company'::character varying, 'employment'::character varying, 'email'::character varying, 'phone'::character varying, 'contact'::character varying, 'account'::character varying])::text[]))),
    CONSTRAINT provenance_event_lawful_basis_enum CHECK (((lawful_basis)::text = ANY ((ARRAY['legitimate_interest'::character varying, 'consent'::character varying, 'contract'::character varying, 'public_record'::character varying])::text[]))),
    CONSTRAINT provenance_event_scope_matches_layer CHECK (((((entity_type)::text = ANY ((ARRAY['contact'::character varying, 'account'::character varying])::text[])) AND (scope_ref IS NOT NULL)) OR (((entity_type)::text <> ALL ((ARRAY['contact'::character varying, 'account'::character varying])::text[])) AND (scope_ref IS NULL)))),
    CONSTRAINT provenance_event_source_type_enum CHECK (((source_type)::text = ANY ((ARRAY['provider'::character varying, 'import'::character varying, 'coop'::character varying, 'forge'::character varying, 'crawl'::character varying, 'user_edit'::character varying, 'reveal'::character varying, 'extension'::character varying, 'crm_sync'::character varying, 'mailbox'::character varying])::text[])))
)
PARTITION BY RANGE (recorded_at);


--
-- Name: provenance_event_2026_08; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.provenance_event_2026_08 (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    entity_type character varying(20) NOT NULL,
    entity_id uuid NOT NULL,
    field character varying(50) NOT NULL,
    action character varying(20) NOT NULL,
    source_type character varying(30) NOT NULL,
    source_name character varying(50),
    method character varying(30),
    contributor_ref uuid,
    lawful_basis character varying(30) NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    confidence numeric(4,3),
    acceptance_state character varying(20) DEFAULT 'accepted'::character varying NOT NULL,
    source_record_id uuid,
    scope_ref uuid,
    observed_at timestamp with time zone,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT provenance_event_acceptance_enum CHECK (((acceptance_state)::text = ANY ((ARRAY['accepted'::character varying, 'pending'::character varying, 'rejected'::character varying, 'superseded'::character varying])::text[]))),
    CONSTRAINT provenance_event_action_enum CHECK (((action)::text = ANY ((ARRAY['assert'::character varying, 'confirm'::character varying, 'deny'::character varying, 'correct'::character varying, 'verify'::character varying, 'pin'::character varying, 'tombstone'::character varying, 'merge'::character varying])::text[]))),
    CONSTRAINT provenance_event_confidence_range CHECK (((confidence IS NULL) OR ((confidence >= (0)::numeric) AND (confidence <= (1)::numeric)))),
    CONSTRAINT provenance_event_entity_type_enum CHECK (((entity_type)::text = ANY ((ARRAY['person'::character varying, 'company'::character varying, 'employment'::character varying, 'email'::character varying, 'phone'::character varying, 'contact'::character varying, 'account'::character varying])::text[]))),
    CONSTRAINT provenance_event_lawful_basis_enum CHECK (((lawful_basis)::text = ANY ((ARRAY['legitimate_interest'::character varying, 'consent'::character varying, 'contract'::character varying, 'public_record'::character varying])::text[]))),
    CONSTRAINT provenance_event_scope_matches_layer CHECK (((((entity_type)::text = ANY ((ARRAY['contact'::character varying, 'account'::character varying])::text[])) AND (scope_ref IS NOT NULL)) OR (((entity_type)::text <> ALL ((ARRAY['contact'::character varying, 'account'::character varying])::text[])) AND (scope_ref IS NULL)))),
    CONSTRAINT provenance_event_source_type_enum CHECK (((source_type)::text = ANY ((ARRAY['provider'::character varying, 'import'::character varying, 'coop'::character varying, 'forge'::character varying, 'crawl'::character varying, 'user_edit'::character varying, 'reveal'::character varying, 'extension'::character varying, 'crm_sync'::character varying, 'mailbox'::character varying])::text[])))
);


--
-- Name: provenance_event_2026_09; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.provenance_event_2026_09 (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    entity_type character varying(20) NOT NULL,
    entity_id uuid NOT NULL,
    field character varying(50) NOT NULL,
    action character varying(20) NOT NULL,
    source_type character varying(30) NOT NULL,
    source_name character varying(50),
    method character varying(30),
    contributor_ref uuid,
    lawful_basis character varying(30) NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    confidence numeric(4,3),
    acceptance_state character varying(20) DEFAULT 'accepted'::character varying NOT NULL,
    source_record_id uuid,
    scope_ref uuid,
    observed_at timestamp with time zone,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT provenance_event_acceptance_enum CHECK (((acceptance_state)::text = ANY ((ARRAY['accepted'::character varying, 'pending'::character varying, 'rejected'::character varying, 'superseded'::character varying])::text[]))),
    CONSTRAINT provenance_event_action_enum CHECK (((action)::text = ANY ((ARRAY['assert'::character varying, 'confirm'::character varying, 'deny'::character varying, 'correct'::character varying, 'verify'::character varying, 'pin'::character varying, 'tombstone'::character varying, 'merge'::character varying])::text[]))),
    CONSTRAINT provenance_event_confidence_range CHECK (((confidence IS NULL) OR ((confidence >= (0)::numeric) AND (confidence <= (1)::numeric)))),
    CONSTRAINT provenance_event_entity_type_enum CHECK (((entity_type)::text = ANY ((ARRAY['person'::character varying, 'company'::character varying, 'employment'::character varying, 'email'::character varying, 'phone'::character varying, 'contact'::character varying, 'account'::character varying])::text[]))),
    CONSTRAINT provenance_event_lawful_basis_enum CHECK (((lawful_basis)::text = ANY ((ARRAY['legitimate_interest'::character varying, 'consent'::character varying, 'contract'::character varying, 'public_record'::character varying])::text[]))),
    CONSTRAINT provenance_event_scope_matches_layer CHECK (((((entity_type)::text = ANY ((ARRAY['contact'::character varying, 'account'::character varying])::text[])) AND (scope_ref IS NOT NULL)) OR (((entity_type)::text <> ALL ((ARRAY['contact'::character varying, 'account'::character varying])::text[])) AND (scope_ref IS NULL)))),
    CONSTRAINT provenance_event_source_type_enum CHECK (((source_type)::text = ANY ((ARRAY['provider'::character varying, 'import'::character varying, 'coop'::character varying, 'forge'::character varying, 'crawl'::character varying, 'user_edit'::character varying, 'reveal'::character varying, 'extension'::character varying, 'crm_sync'::character varying, 'mailbox'::character varying])::text[])))
);


--
-- Name: provenance_event_2026_10; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.provenance_event_2026_10 (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    entity_type character varying(20) NOT NULL,
    entity_id uuid NOT NULL,
    field character varying(50) NOT NULL,
    action character varying(20) NOT NULL,
    source_type character varying(30) NOT NULL,
    source_name character varying(50),
    method character varying(30),
    contributor_ref uuid,
    lawful_basis character varying(30) NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    confidence numeric(4,3),
    acceptance_state character varying(20) DEFAULT 'accepted'::character varying NOT NULL,
    source_record_id uuid,
    scope_ref uuid,
    observed_at timestamp with time zone,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT provenance_event_acceptance_enum CHECK (((acceptance_state)::text = ANY ((ARRAY['accepted'::character varying, 'pending'::character varying, 'rejected'::character varying, 'superseded'::character varying])::text[]))),
    CONSTRAINT provenance_event_action_enum CHECK (((action)::text = ANY ((ARRAY['assert'::character varying, 'confirm'::character varying, 'deny'::character varying, 'correct'::character varying, 'verify'::character varying, 'pin'::character varying, 'tombstone'::character varying, 'merge'::character varying])::text[]))),
    CONSTRAINT provenance_event_confidence_range CHECK (((confidence IS NULL) OR ((confidence >= (0)::numeric) AND (confidence <= (1)::numeric)))),
    CONSTRAINT provenance_event_entity_type_enum CHECK (((entity_type)::text = ANY ((ARRAY['person'::character varying, 'company'::character varying, 'employment'::character varying, 'email'::character varying, 'phone'::character varying, 'contact'::character varying, 'account'::character varying])::text[]))),
    CONSTRAINT provenance_event_lawful_basis_enum CHECK (((lawful_basis)::text = ANY ((ARRAY['legitimate_interest'::character varying, 'consent'::character varying, 'contract'::character varying, 'public_record'::character varying])::text[]))),
    CONSTRAINT provenance_event_scope_matches_layer CHECK (((((entity_type)::text = ANY ((ARRAY['contact'::character varying, 'account'::character varying])::text[])) AND (scope_ref IS NOT NULL)) OR (((entity_type)::text <> ALL ((ARRAY['contact'::character varying, 'account'::character varying])::text[])) AND (scope_ref IS NULL)))),
    CONSTRAINT provenance_event_source_type_enum CHECK (((source_type)::text = ANY ((ARRAY['provider'::character varying, 'import'::character varying, 'coop'::character varying, 'forge'::character varying, 'crawl'::character varying, 'user_edit'::character varying, 'reveal'::character varying, 'extension'::character varying, 'crm_sync'::character varying, 'mailbox'::character varying])::text[])))
);


--
-- Name: provenance_event_2026_11; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.provenance_event_2026_11 (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    entity_type character varying(20) NOT NULL,
    entity_id uuid NOT NULL,
    field character varying(50) NOT NULL,
    action character varying(20) NOT NULL,
    source_type character varying(30) NOT NULL,
    source_name character varying(50),
    method character varying(30),
    contributor_ref uuid,
    lawful_basis character varying(30) NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    confidence numeric(4,3),
    acceptance_state character varying(20) DEFAULT 'accepted'::character varying NOT NULL,
    source_record_id uuid,
    scope_ref uuid,
    observed_at timestamp with time zone,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT provenance_event_acceptance_enum CHECK (((acceptance_state)::text = ANY ((ARRAY['accepted'::character varying, 'pending'::character varying, 'rejected'::character varying, 'superseded'::character varying])::text[]))),
    CONSTRAINT provenance_event_action_enum CHECK (((action)::text = ANY ((ARRAY['assert'::character varying, 'confirm'::character varying, 'deny'::character varying, 'correct'::character varying, 'verify'::character varying, 'pin'::character varying, 'tombstone'::character varying, 'merge'::character varying])::text[]))),
    CONSTRAINT provenance_event_confidence_range CHECK (((confidence IS NULL) OR ((confidence >= (0)::numeric) AND (confidence <= (1)::numeric)))),
    CONSTRAINT provenance_event_entity_type_enum CHECK (((entity_type)::text = ANY ((ARRAY['person'::character varying, 'company'::character varying, 'employment'::character varying, 'email'::character varying, 'phone'::character varying, 'contact'::character varying, 'account'::character varying])::text[]))),
    CONSTRAINT provenance_event_lawful_basis_enum CHECK (((lawful_basis)::text = ANY ((ARRAY['legitimate_interest'::character varying, 'consent'::character varying, 'contract'::character varying, 'public_record'::character varying])::text[]))),
    CONSTRAINT provenance_event_scope_matches_layer CHECK (((((entity_type)::text = ANY ((ARRAY['contact'::character varying, 'account'::character varying])::text[])) AND (scope_ref IS NOT NULL)) OR (((entity_type)::text <> ALL ((ARRAY['contact'::character varying, 'account'::character varying])::text[])) AND (scope_ref IS NULL)))),
    CONSTRAINT provenance_event_source_type_enum CHECK (((source_type)::text = ANY ((ARRAY['provider'::character varying, 'import'::character varying, 'coop'::character varying, 'forge'::character varying, 'crawl'::character varying, 'user_edit'::character varying, 'reveal'::character varying, 'extension'::character varying, 'crm_sync'::character varying, 'mailbox'::character varying])::text[])))
);


--
-- Name: provenance_event_default; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.provenance_event_default (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    entity_type character varying(20) NOT NULL,
    entity_id uuid NOT NULL,
    field character varying(50) NOT NULL,
    action character varying(20) NOT NULL,
    source_type character varying(30) NOT NULL,
    source_name character varying(50),
    method character varying(30),
    contributor_ref uuid,
    lawful_basis character varying(30) NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    confidence numeric(4,3),
    acceptance_state character varying(20) DEFAULT 'accepted'::character varying NOT NULL,
    source_record_id uuid,
    scope_ref uuid,
    observed_at timestamp with time zone,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT provenance_event_acceptance_enum CHECK (((acceptance_state)::text = ANY ((ARRAY['accepted'::character varying, 'pending'::character varying, 'rejected'::character varying, 'superseded'::character varying])::text[]))),
    CONSTRAINT provenance_event_action_enum CHECK (((action)::text = ANY ((ARRAY['assert'::character varying, 'confirm'::character varying, 'deny'::character varying, 'correct'::character varying, 'verify'::character varying, 'pin'::character varying, 'tombstone'::character varying, 'merge'::character varying])::text[]))),
    CONSTRAINT provenance_event_confidence_range CHECK (((confidence IS NULL) OR ((confidence >= (0)::numeric) AND (confidence <= (1)::numeric)))),
    CONSTRAINT provenance_event_entity_type_enum CHECK (((entity_type)::text = ANY ((ARRAY['person'::character varying, 'company'::character varying, 'employment'::character varying, 'email'::character varying, 'phone'::character varying, 'contact'::character varying, 'account'::character varying])::text[]))),
    CONSTRAINT provenance_event_lawful_basis_enum CHECK (((lawful_basis)::text = ANY ((ARRAY['legitimate_interest'::character varying, 'consent'::character varying, 'contract'::character varying, 'public_record'::character varying])::text[]))),
    CONSTRAINT provenance_event_scope_matches_layer CHECK (((((entity_type)::text = ANY ((ARRAY['contact'::character varying, 'account'::character varying])::text[])) AND (scope_ref IS NOT NULL)) OR (((entity_type)::text <> ALL ((ARRAY['contact'::character varying, 'account'::character varying])::text[])) AND (scope_ref IS NULL)))),
    CONSTRAINT provenance_event_source_type_enum CHECK (((source_type)::text = ANY ((ARRAY['provider'::character varying, 'import'::character varying, 'coop'::character varying, 'forge'::character varying, 'crawl'::character varying, 'user_edit'::character varying, 'reveal'::character varying, 'extension'::character varying, 'crm_sync'::character varying, 'mailbox'::character varying])::text[])))
);


--
-- Name: provider_calls; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.provider_calls (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    provider_name character varying(50) NOT NULL,
    request_hash bytea NOT NULL,
    status character varying(20) NOT NULL,
    cost_micros bigint DEFAULT 0 NOT NULL,
    cache_hit boolean DEFAULT false NOT NULL,
    response_payload jsonb,
    called_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT provider_calls_status_enum CHECK (((status)::text = ANY ((ARRAY['hit'::character varying, 'miss'::character varying, 'rate_limited'::character varying, 'error'::character varying])::text[])))
);

ALTER TABLE ONLY public.provider_calls FORCE ROW LEVEL SECURITY;


--
-- Name: provider_configs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.provider_configs (
    provider character varying(50) NOT NULL,
    label character varying(100) NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    rate_limit_per_min integer,
    monthly_budget_cents integer,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: purchases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.purchases (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    stripe_event_id character varying(255) NOT NULL,
    stripe_payment_intent_id character varying(255),
    credits integer NOT NULL,
    amount_cents integer,
    status character varying(20) DEFAULT 'completed'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT purchases_credits_positive CHECK ((credits > 0)),
    CONSTRAINT purchases_status_enum CHECK (((status)::text = ANY ((ARRAY['completed'::character varying, 'refunded'::character varying])::text[])))
);


--
-- Name: record_tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.record_tags (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    tag_id uuid NOT NULL,
    entity character varying(20) NOT NULL,
    record_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT record_tags_entity_enum CHECK (((entity)::text = ANY ((ARRAY['contact'::character varying, 'account'::character varying])::text[])))
);

ALTER TABLE ONLY public.record_tags FORCE ROW LEVEL SECURITY;


--
-- Name: retention_class_policies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.retention_class_policies (
    data_class character varying(50) NOT NULL,
    ttl_days integer,
    mode character varying(20) DEFAULT 'shadow'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT retention_class_policies_mode_enum CHECK (((mode)::text = ANY ((ARRAY['disabled'::character varying, 'shadow'::character varying, 'enforce'::character varying])::text[])))
);

ALTER TABLE ONLY public.retention_class_policies FORCE ROW LEVEL SECURITY;


--
-- Name: retention_policies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.retention_policies (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    entity text NOT NULL,
    field text,
    retention_days integer NOT NULL,
    reason text,
    active boolean DEFAULT true NOT NULL,
    created_by_user_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: retention_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.retention_runs (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    data_class character varying(50) NOT NULL,
    mode character varying(20) NOT NULL,
    candidate_count integer DEFAULT 0 NOT NULL,
    deleted_count integer DEFAULT 0 NOT NULL,
    cutoff timestamp with time zone,
    run_started_at timestamp with time zone NOT NULL,
    run_finished_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT retention_runs_mode_enum CHECK (((mode)::text = ANY ((ARRAY['disabled'::character varying, 'shadow'::character varying, 'enforce'::character varying])::text[])))
);

ALTER TABLE ONLY public.retention_runs FORCE ROW LEVEL SECURITY;


--
-- Name: reveal_job_rows; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reveal_job_rows (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    job_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    contact_id uuid,
    row_index integer NOT NULL,
    outcome character varying(20) DEFAULT 'queued'::character varying NOT NULL,
    credits_charged integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT reveal_job_rows_outcome_enum CHECK (((outcome)::text = ANY ((ARRAY['queued'::character varying, 'revealed'::character varying, 'already_owned'::character varying, 'suppressed'::character varying, 'insufficient'::character varying, 'error'::character varying])::text[])))
);

ALTER TABLE ONLY public.reveal_job_rows FORCE ROW LEVEL SECURITY;


--
-- Name: reveal_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reveal_jobs (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    created_by_user_id uuid,
    reveal_type character varying(20) NOT NULL,
    status character varying(30) DEFAULT 'queued'::character varying NOT NULL,
    total_contacts integer DEFAULT 0 NOT NULL,
    processed_contacts integer DEFAULT 0 NOT NULL,
    revealed_contacts integer DEFAULT 0 NOT NULL,
    already_owned_contacts integer DEFAULT 0 NOT NULL,
    suppressed_contacts integer DEFAULT 0 NOT NULL,
    failed_contacts integer DEFAULT 0 NOT NULL,
    credit_estimate integer DEFAULT 0 NOT NULL,
    credit_leased integer DEFAULT 0 NOT NULL,
    credit_leased_from_sub integer DEFAULT 0 NOT NULL,
    credit_spent integer DEFAULT 0 NOT NULL,
    result_key character varying(1024),
    idempotency_key character varying(255),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    failed_reason character varying(1024),
    shared_with_workspace boolean DEFAULT false NOT NULL,
    CONSTRAINT reveal_jobs_reveal_type_enum CHECK (((reveal_type)::text = ANY ((ARRAY['email'::character varying, 'phone'::character varying, 'full_profile'::character varying])::text[]))),
    CONSTRAINT reveal_jobs_status_enum CHECK (((status)::text = ANY ((ARRAY['queued'::character varying, 'estimating'::character varying, 'awaiting_confirmation'::character varying, 'running'::character varying, 'paused'::character varying, 'completed'::character varying, 'failed'::character varying, 'cancelled'::character varying])::text[])))
);

ALTER TABLE ONLY public.reveal_jobs FORCE ROW LEVEL SECURITY;


--
-- Name: sales_nav_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sales_nav_links (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    link_type character varying(30) NOT NULL,
    url character varying(500) NOT NULL,
    external_id character varying(255),
    contact_id uuid,
    account_id uuid,
    created_by_user_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    sales_nav_lead_id character varying(255),
    note text,
    labels text,
    captured_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sales_nav_links_type_enum CHECK (((link_type)::text = ANY ((ARRAY['profile'::character varying, 'account'::character varying, 'saved_search'::character varying, 'lead_list'::character varying, 'account_list'::character varying, 'inmail_thread'::character varying])::text[])))
);

ALTER TABLE ONLY public.sales_nav_links FORCE ROW LEVEL SECURITY;


--
-- Name: saved_searches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.saved_searches (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    owner_user_id uuid NOT NULL,
    name character varying(120) NOT NULL,
    filters jsonb NOT NULL,
    visibility character varying(20) DEFAULT 'private'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT saved_searches_visibility_enum CHECK (((visibility)::text = ANY ((ARRAY['private'::character varying, 'workspace'::character varying])::text[])))
);

ALTER TABLE ONLY public.saved_searches FORCE ROW LEVEL SECURITY;


--
-- Name: scheduled_imports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scheduled_imports (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    created_by_user_id uuid,
    name character varying(120) NOT NULL,
    source_name character varying(40) NOT NULL,
    source_object_key character varying(512) NOT NULL,
    source_filename character varying(255),
    mapping jsonb DEFAULT '{}'::jsonb NOT NULL,
    merge_mode character varying(20),
    preserve_populated boolean,
    target_list_id uuid,
    options jsonb DEFAULT '{}'::jsonb NOT NULL,
    cadence character varying(20) NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    disabled_reason character varying(20),
    consecutive_failures integer DEFAULT 0 NOT NULL,
    next_run_at timestamp with time zone NOT NULL,
    last_run_at timestamp with time zone,
    last_job_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT scheduled_imports_cadence_enum CHECK (((cadence)::text = ANY ((ARRAY['hourly'::character varying, 'daily'::character varying, 'weekly'::character varying])::text[]))),
    CONSTRAINT scheduled_imports_disabled_reason_enum CHECK (((disabled_reason)::text = ANY ((ARRAY['grant_lost'::character varying, 'max_failures'::character varying])::text[]))),
    CONSTRAINT scheduled_imports_merge_mode_enum CHECK (((merge_mode)::text = ANY ((ARRAY['create_and_update'::character varying, 'create_only'::character varying, 'update_only'::character varying])::text[])))
);

ALTER TABLE ONLY public.scheduled_imports FORCE ROW LEVEL SECURITY;


--
-- Name: scim_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scim_tokens (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    name character varying(100) NOT NULL,
    token_hash character varying(255) NOT NULL,
    created_by_user_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone,
    revoked_at timestamp with time zone
);

ALTER TABLE ONLY public.scim_tokens FORCE ROW LEVEL SECURITY;


--
-- Name: scores; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scores (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    icp_fit integer NOT NULL,
    intent_score integer NOT NULL,
    engagement_score integer NOT NULL,
    composite_score integer NOT NULL,
    score_breakdown jsonb DEFAULT '{}'::jsonb NOT NULL,
    scored_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT scores_ranges CHECK ((((icp_fit >= 0) AND (icp_fit <= 100)) AND ((intent_score >= 0) AND (intent_score <= 100)) AND ((engagement_score >= 0) AND (engagement_score <= 100)) AND ((composite_score >= 0) AND (composite_score <= 100))))
);

ALTER TABLE ONLY public.scores FORCE ROW LEVEL SECURITY;


--
-- Name: sending_domain; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sending_domain (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    domain public.citext NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    spf_state character varying(20) DEFAULT 'unverified'::character varying NOT NULL,
    dkim_state character varying(20) DEFAULT 'unverified'::character varying NOT NULL,
    dmarc_state character varying(20) DEFAULT 'unverified'::character varying NOT NULL,
    dkim_selector character varying(100),
    dkim_public_key character varying(2000),
    tracking_cname character varying(255),
    tracking_cname_state character varying(20) DEFAULT 'unverified'::character varying NOT NULL,
    region character varying(2) DEFAULT 'US'::character varying NOT NULL,
    verified_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sending_domain_auth_state_enum CHECK ((((spf_state)::text = ANY ((ARRAY['unverified'::character varying, 'pass'::character varying, 'fail'::character varying])::text[])) AND ((dkim_state)::text = ANY ((ARRAY['unverified'::character varying, 'pass'::character varying, 'fail'::character varying])::text[])) AND ((dmarc_state)::text = ANY ((ARRAY['unverified'::character varying, 'pass'::character varying, 'fail'::character varying])::text[])))),
    CONSTRAINT sending_domain_status_enum CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'verifying'::character varying, 'verified'::character varying, 'failed'::character varying])::text[])))
);

ALTER TABLE ONLY public.sending_domain FORCE ROW LEVEL SECURITY;


--
-- Name: source_imports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.source_imports (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    imported_by_user_id uuid,
    source_name character varying(50) NOT NULL,
    source_file character varying(255),
    raw_data jsonb DEFAULT '{}'::jsonb NOT NULL,
    content_hash bytea,
    imported_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT source_imports_source_name_enum CHECK (((source_name)::text = ANY ((ARRAY['apollo'::character varying, 'zoominfo'::character varying, 'linkedin'::character varying, 'sales_navigator'::character varying, 'hubspot'::character varying, 'salesforce'::character varying, 'clearbit'::character varying, 'manual'::character varying])::text[])))
)
WITH (autovacuum_vacuum_scale_factor='0.01', autovacuum_vacuum_threshold='10000', autovacuum_vacuum_insert_scale_factor='0.01', autovacuum_vacuum_insert_threshold='100000', autovacuum_analyze_scale_factor='0.01', autovacuum_analyze_threshold='10000');

ALTER TABLE ONLY public.source_imports FORCE ROW LEVEL SECURITY;


--
-- Name: source_records; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.source_records (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    source_name character varying(50) NOT NULL,
    content_hash bytea NOT NULL,
    raw_data jsonb NOT NULL,
    match_keys jsonb DEFAULT '{}'::jsonb NOT NULL,
    resolved_person_id uuid,
    resolved_company_id uuid,
    lawful_basis_snapshot jsonb,
    region character(2),
    ingested_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: stripe_customers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stripe_customers (
    tenant_id uuid NOT NULL,
    stripe_customer_id character varying(255) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: sub_processors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sub_processors (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    name text NOT NULL,
    purpose text NOT NULL,
    location text NOT NULL,
    dpa_url text,
    active boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_by_user_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subscriptions (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    plan_template_key text NOT NULL,
    stripe_subscription_id character varying(255),
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    term character varying(20) DEFAULT 'month_to_month'::character varying NOT NULL,
    auto_renew boolean DEFAULT false NOT NULL,
    current_period_start timestamp with time zone,
    current_period_end timestamp with time zone,
    cancel_at_period_end boolean DEFAULT false NOT NULL,
    canceled_at timestamp with time zone,
    currency character(3) DEFAULT 'USD'::bpchar NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT subscriptions_status_enum CHECK (((status)::text = ANY ((ARRAY['trialing'::character varying, 'active'::character varying, 'past_due'::character varying, 'canceled'::character varying, 'paused'::character varying, 'incomplete'::character varying])::text[]))),
    CONSTRAINT subscriptions_term_enum CHECK (((term)::text = ANY ((ARRAY['month_to_month'::character varying, 'annual'::character varying])::text[])))
);


--
-- Name: support_notes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.support_notes (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    staff_user_id uuid NOT NULL,
    body text NOT NULL,
    ticket_url text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: suppression_list; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.suppression_list (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    scope character varying(20) NOT NULL,
    tenant_id uuid,
    workspace_id uuid,
    match_type character varying(20) NOT NULL,
    email_blind_index bytea,
    domain public.citext,
    phone_blind_index bytea,
    contact_id uuid,
    reason character varying(255),
    created_by_user_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT suppression_match_enum CHECK (((match_type)::text = ANY ((ARRAY['email'::character varying, 'domain'::character varying, 'phone'::character varying, 'contact_id'::character varying])::text[]))),
    CONSTRAINT suppression_match_key_present CHECK (((((match_type)::text = 'email'::text) AND (email_blind_index IS NOT NULL)) OR (((match_type)::text = 'domain'::text) AND (domain IS NOT NULL)) OR (((match_type)::text = 'phone'::text) AND (phone_blind_index IS NOT NULL)) OR (((match_type)::text = 'contact_id'::text) AND (contact_id IS NOT NULL)))),
    CONSTRAINT suppression_scope_coherence CHECK (((((scope)::text = 'global'::text) AND (tenant_id IS NULL) AND (workspace_id IS NULL)) OR (((scope)::text = 'tenant'::text) AND (tenant_id IS NOT NULL) AND (workspace_id IS NULL)) OR (((scope)::text = 'workspace'::text) AND (tenant_id IS NOT NULL) AND (workspace_id IS NOT NULL)))),
    CONSTRAINT suppression_scope_enum CHECK (((scope)::text = ANY ((ARRAY['global'::character varying, 'tenant'::character varying, 'workspace'::character varying])::text[])))
);

ALTER TABLE ONLY public.suppression_list FORCE ROW LEVEL SECURITY;


--
-- Name: tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tags (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    name character varying(60) NOT NULL,
    color character varying(20) DEFAULT 'neutral'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tags_color_enum CHECK (((color)::text = ANY ((ARRAY['neutral'::character varying, 'accent'::character varying, 'success'::character varying, 'warning'::character varying, 'danger'::character varying, 'info'::character varying])::text[])))
);

ALTER TABLE ONLY public.tags FORCE ROW LEVEL SECURITY;


--
-- Name: team_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team_members (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    team_id uuid NOT NULL,
    user_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.team_members FORCE ROW LEVEL SECURITY;


--
-- Name: teams; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.teams (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    name character varying(120) NOT NULL,
    description character varying(500),
    created_by_user_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.teams FORCE ROW LEVEL SECURITY;


--
-- Name: tenant_auth_policies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenant_auth_policies (
    tenant_id uuid NOT NULL,
    mfa_enforcement character varying(10) DEFAULT 'optional'::character varying NOT NULL,
    allowed_methods jsonb DEFAULT '["password", "oauth", "magic_link", "sso", "passkey"]'::jsonb NOT NULL,
    disable_social boolean DEFAULT false NOT NULL,
    require_sso boolean DEFAULT false NOT NULL,
    ip_allowlist text[],
    session_timeout_seconds integer,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    idle_timeout_seconds integer,
    enforcement_enabled boolean DEFAULT false NOT NULL
);


--
-- Name: tenant_domains; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenant_domains (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    domain public.citext NOT NULL,
    verification_token character varying(255),
    dns_txt_record text,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    join_policy character varying(20) DEFAULT 'sso_only'::character varying NOT NULL,
    verified_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: tenant_feature_flags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenant_feature_flags (
    flag_key character varying(100) NOT NULL,
    tenant_id uuid NOT NULL,
    enabled boolean NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.tenant_feature_flags FORCE ROW LEVEL SECURITY;


--
-- Name: tenant_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenant_members (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    user_id uuid NOT NULL,
    is_tenant_owner boolean DEFAULT false NOT NULL,
    status character varying(50) DEFAULT 'active'::character varying NOT NULL,
    invited_by_user_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    org_role character varying(50) DEFAULT 'member'::character varying NOT NULL,
    last_workspace_id uuid,
    CONSTRAINT tenant_members_org_role_check CHECK (((org_role)::text = ANY ((ARRAY['owner'::character varying, 'billing_admin'::character varying, 'security_admin'::character varying, 'compliance_admin'::character varying, 'member'::character varying])::text[])))
);


--
-- Name: tenant_sso_configs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenant_sso_configs (
    tenant_id uuid NOT NULL,
    protocol character varying(10) DEFAULT 'saml'::character varying NOT NULL,
    provider character varying(50) NOT NULL,
    metadata_url text,
    metadata_xml text,
    oidc_issuer text,
    oidc_client_id character varying(255),
    oidc_client_secret_enc bytea,
    attribute_mapping jsonb DEFAULT '{}'::jsonb NOT NULL,
    jit_enabled boolean DEFAULT true NOT NULL,
    default_role character varying(50) DEFAULT 'member'::character varying NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    enforced boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: tenants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenants (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    name character varying(255) NOT NULL,
    slug public.citext NOT NULL,
    plan character varying(50) DEFAULT 'free'::character varying NOT NULL,
    seat_limit integer DEFAULT 1 NOT NULL,
    workspace_limit integer,
    reveal_credit_balance integer DEFAULT 0 NOT NULL,
    features jsonb DEFAULT '{}'::jsonb NOT NULL,
    status character varying(50) DEFAULT 'active'::character varying NOT NULL,
    region_default character varying(2) DEFAULT 'US'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    email_send_quota integer,
    email_send_used integer DEFAULT 0 NOT NULL,
    email_send_period_start timestamp with time zone DEFAULT now() NOT NULL,
    subscription_credit_balance integer DEFAULT 0 NOT NULL,
    suspension_reason character varying(20),
    CONSTRAINT tenants_credit_nonnegative CHECK ((reveal_credit_balance >= 0)),
    CONSTRAINT tenants_email_send_quota_nonneg CHECK (((email_send_used >= 0) AND ((email_send_quota IS NULL) OR (email_send_used <= email_send_quota)))),
    CONSTRAINT tenants_subscription_bucket CHECK (((subscription_credit_balance >= 0) AND (subscription_credit_balance <= reveal_credit_balance)))
);


--
-- Name: trusted_devices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trusted_devices (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    user_id uuid NOT NULL,
    fingerprint_hash character varying(255) NOT NULL,
    name character varying(255),
    last_ip text,
    last_geo character varying(100),
    trusted_until timestamp with time zone,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: usage_event; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.usage_event (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    user_id uuid,
    action character varying(50) NOT NULL,
    subject_type character varying(20),
    subject_id uuid,
    subject_fingerprint bytea,
    demanded_fields text[],
    quantity integer DEFAULT 1 NOT NULL,
    entitlement_key character varying(50),
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT usage_event_action_enum CHECK (((action)::text = ANY ((ARRAY['reveal'::character varying, 'reveal_miss'::character varying, 'search'::character varying, 'export'::character varying, 'verify'::character varying, 'save'::character varying, 'badge_impression'::character varying, 'enrich'::character varying])::text[]))),
    CONSTRAINT usage_event_miss_shape CHECK ((((action)::text <> 'reveal_miss'::text) OR ((subject_id IS NULL) AND (subject_fingerprint IS NOT NULL)))),
    CONSTRAINT usage_event_quantity_positive CHECK ((quantity > 0))
)
PARTITION BY RANGE (occurred_at);

ALTER TABLE ONLY public.usage_event FORCE ROW LEVEL SECURITY;


--
-- Name: usage_event_2026_08; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.usage_event_2026_08 (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    user_id uuid,
    action character varying(50) NOT NULL,
    subject_type character varying(20),
    subject_id uuid,
    subject_fingerprint bytea,
    demanded_fields text[],
    quantity integer DEFAULT 1 NOT NULL,
    entitlement_key character varying(50),
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT usage_event_action_enum CHECK (((action)::text = ANY ((ARRAY['reveal'::character varying, 'reveal_miss'::character varying, 'search'::character varying, 'export'::character varying, 'verify'::character varying, 'save'::character varying, 'badge_impression'::character varying, 'enrich'::character varying])::text[]))),
    CONSTRAINT usage_event_miss_shape CHECK ((((action)::text <> 'reveal_miss'::text) OR ((subject_id IS NULL) AND (subject_fingerprint IS NOT NULL)))),
    CONSTRAINT usage_event_quantity_positive CHECK ((quantity > 0))
);


--
-- Name: usage_event_2026_09; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.usage_event_2026_09 (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    user_id uuid,
    action character varying(50) NOT NULL,
    subject_type character varying(20),
    subject_id uuid,
    subject_fingerprint bytea,
    demanded_fields text[],
    quantity integer DEFAULT 1 NOT NULL,
    entitlement_key character varying(50),
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT usage_event_action_enum CHECK (((action)::text = ANY ((ARRAY['reveal'::character varying, 'reveal_miss'::character varying, 'search'::character varying, 'export'::character varying, 'verify'::character varying, 'save'::character varying, 'badge_impression'::character varying, 'enrich'::character varying])::text[]))),
    CONSTRAINT usage_event_miss_shape CHECK ((((action)::text <> 'reveal_miss'::text) OR ((subject_id IS NULL) AND (subject_fingerprint IS NOT NULL)))),
    CONSTRAINT usage_event_quantity_positive CHECK ((quantity > 0))
);


--
-- Name: usage_event_2026_10; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.usage_event_2026_10 (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    user_id uuid,
    action character varying(50) NOT NULL,
    subject_type character varying(20),
    subject_id uuid,
    subject_fingerprint bytea,
    demanded_fields text[],
    quantity integer DEFAULT 1 NOT NULL,
    entitlement_key character varying(50),
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT usage_event_action_enum CHECK (((action)::text = ANY ((ARRAY['reveal'::character varying, 'reveal_miss'::character varying, 'search'::character varying, 'export'::character varying, 'verify'::character varying, 'save'::character varying, 'badge_impression'::character varying, 'enrich'::character varying])::text[]))),
    CONSTRAINT usage_event_miss_shape CHECK ((((action)::text <> 'reveal_miss'::text) OR ((subject_id IS NULL) AND (subject_fingerprint IS NOT NULL)))),
    CONSTRAINT usage_event_quantity_positive CHECK ((quantity > 0))
);


--
-- Name: usage_event_2026_11; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.usage_event_2026_11 (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    user_id uuid,
    action character varying(50) NOT NULL,
    subject_type character varying(20),
    subject_id uuid,
    subject_fingerprint bytea,
    demanded_fields text[],
    quantity integer DEFAULT 1 NOT NULL,
    entitlement_key character varying(50),
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT usage_event_action_enum CHECK (((action)::text = ANY ((ARRAY['reveal'::character varying, 'reveal_miss'::character varying, 'search'::character varying, 'export'::character varying, 'verify'::character varying, 'save'::character varying, 'badge_impression'::character varying, 'enrich'::character varying])::text[]))),
    CONSTRAINT usage_event_miss_shape CHECK ((((action)::text <> 'reveal_miss'::text) OR ((subject_id IS NULL) AND (subject_fingerprint IS NOT NULL)))),
    CONSTRAINT usage_event_quantity_positive CHECK ((quantity > 0))
);


--
-- Name: usage_event_default; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.usage_event_default (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    user_id uuid,
    action character varying(50) NOT NULL,
    subject_type character varying(20),
    subject_id uuid,
    subject_fingerprint bytea,
    demanded_fields text[],
    quantity integer DEFAULT 1 NOT NULL,
    entitlement_key character varying(50),
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT usage_event_action_enum CHECK (((action)::text = ANY ((ARRAY['reveal'::character varying, 'reveal_miss'::character varying, 'search'::character varying, 'export'::character varying, 'verify'::character varying, 'save'::character varying, 'badge_impression'::character varying, 'enrich'::character varying])::text[]))),
    CONSTRAINT usage_event_miss_shape CHECK ((((action)::text <> 'reveal_miss'::text) OR ((subject_id IS NULL) AND (subject_fingerprint IS NOT NULL)))),
    CONSTRAINT usage_event_quantity_positive CHECK ((quantity > 0))
);


--
-- Name: user_mfa_methods; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_mfa_methods (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    user_id uuid NOT NULL,
    type character varying(20) NOT NULL,
    secret_enc bytea,
    label character varying(100),
    verified_at timestamp with time zone,
    last_used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: user_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_sessions (
    id character varying(255) NOT NULL,
    user_id uuid NOT NULL,
    tenant_id uuid,
    workspace_id uuid,
    device_id uuid,
    refresh_token_hash character varying(255),
    rotated_from character varying(255),
    app_origin character varying(255),
    expires_at timestamp with time zone NOT NULL,
    last_seen_at timestamp with time zone,
    revoked_at timestamp with time zone,
    ip_address text,
    user_agent character varying(500),
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    email public.citext NOT NULL,
    username public.citext,
    full_name character varying(255),
    avatar_url character varying(500),
    password_hash character varying(255),
    auth_provider character varying(50) DEFAULT 'password'::character varying NOT NULL,
    email_verified_at timestamp with time zone,
    scim_external_id character varying(255),
    last_login_at timestamp with time zone,
    status character varying(50) DEFAULT 'active'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    is_platform_admin boolean DEFAULT false NOT NULL,
    is_bootstrap_admin boolean DEFAULT false NOT NULL
);


--
-- Name: validation_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.validation_rules (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    name character varying(120) NOT NULL,
    field character varying(60) NOT NULL,
    check_type character varying(30) NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.validation_rules FORCE ROW LEVEL SECURITY;


--
-- Name: verification_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.verification_jobs (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    started_at timestamp with time zone NOT NULL,
    finished_at timestamp with time zone NOT NULL,
    scanned integer DEFAULT 0 NOT NULL,
    reverified integer DEFAULT 0 NOT NULL,
    errored integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.verification_jobs FORCE ROW LEVEL SECURITY;


--
-- Name: webauthn_credentials; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.webauthn_credentials (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    user_id uuid NOT NULL,
    credential_id text NOT NULL,
    public_key bytea NOT NULL,
    counter integer DEFAULT 0 NOT NULL,
    transports text[],
    aaguid character varying(36),
    backed_up boolean DEFAULT false NOT NULL,
    label character varying(100),
    last_used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: webhook_deliveries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.webhook_deliveries (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    webhook_id uuid,
    event_type character varying(50) NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    response_code integer,
    attempted_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT webhook_deliveries_status_enum CHECK (((status)::text = ANY ((ARRAY['succeeded'::character varying, 'failed'::character varying, 'pending'::character varying])::text[])))
);

ALTER TABLE ONLY public.webhook_deliveries FORCE ROW LEVEL SECURITY;


--
-- Name: webhook_subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.webhook_subscriptions (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    url character varying(2000) NOT NULL,
    events jsonb DEFAULT '[]'::jsonb NOT NULL,
    signing_secret_enc bytea NOT NULL,
    secret_prefix character varying(32) NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_by_user_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.webhook_subscriptions FORCE ROW LEVEL SECURITY;


--
-- Name: worker_outbox; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.worker_outbox (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    topic character varying(60) NOT NULL,
    payload jsonb NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    enqueued_at timestamp with time zone DEFAULT now() NOT NULL,
    published_at timestamp with time zone,
    last_error character varying(500),
    CONSTRAINT worker_outbox_status_enum CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'published'::character varying, 'failed'::character varying])::text[])))
);


--
-- Name: workspace_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_members (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    workspace_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role character varying(50) DEFAULT 'member'::character varying NOT NULL,
    invited_by_user_id uuid,
    invited_at timestamp with time zone DEFAULT now() NOT NULL,
    joined_at timestamp with time zone,
    status character varying(50) DEFAULT 'invited'::character varying NOT NULL
);


--
-- Name: workspaces; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspaces (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tenant_id uuid NOT NULL,
    name character varying(255) NOT NULL,
    slug public.citext NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    created_by_user_id uuid,
    settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: activities_2026_08; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activities ATTACH PARTITION public.activities_2026_08 FOR VALUES FROM ('2026-08-01 00:00:00+00') TO ('2026-09-01 00:00:00+00');


--
-- Name: activities_2026_09; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activities ATTACH PARTITION public.activities_2026_09 FOR VALUES FROM ('2026-09-01 00:00:00+00') TO ('2026-10-01 00:00:00+00');


--
-- Name: activities_2026_10; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activities ATTACH PARTITION public.activities_2026_10 FOR VALUES FROM ('2026-10-01 00:00:00+00') TO ('2026-11-01 00:00:00+00');


--
-- Name: activities_2026_11; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activities ATTACH PARTITION public.activities_2026_11 FOR VALUES FROM ('2026-11-01 00:00:00+00') TO ('2026-12-01 00:00:00+00');


--
-- Name: activities_default; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activities ATTACH PARTITION public.activities_default DEFAULT;


--
-- Name: platform_audit_log_2026_08; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_audit_log ATTACH PARTITION public.platform_audit_log_2026_08 FOR VALUES FROM ('2026-08-01 00:00:00+00') TO ('2026-09-01 00:00:00+00');


--
-- Name: platform_audit_log_2026_09; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_audit_log ATTACH PARTITION public.platform_audit_log_2026_09 FOR VALUES FROM ('2026-09-01 00:00:00+00') TO ('2026-10-01 00:00:00+00');


--
-- Name: platform_audit_log_2026_10; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_audit_log ATTACH PARTITION public.platform_audit_log_2026_10 FOR VALUES FROM ('2026-10-01 00:00:00+00') TO ('2026-11-01 00:00:00+00');


--
-- Name: platform_audit_log_2026_11; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_audit_log ATTACH PARTITION public.platform_audit_log_2026_11 FOR VALUES FROM ('2026-11-01 00:00:00+00') TO ('2026-12-01 00:00:00+00');


--
-- Name: platform_audit_log_default; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_audit_log ATTACH PARTITION public.platform_audit_log_default DEFAULT;


--
-- Name: provenance_event_2026_08; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provenance_event ATTACH PARTITION public.provenance_event_2026_08 FOR VALUES FROM ('2026-08-01 00:00:00+00') TO ('2026-09-01 00:00:00+00');


--
-- Name: provenance_event_2026_09; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provenance_event ATTACH PARTITION public.provenance_event_2026_09 FOR VALUES FROM ('2026-09-01 00:00:00+00') TO ('2026-10-01 00:00:00+00');


--
-- Name: provenance_event_2026_10; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provenance_event ATTACH PARTITION public.provenance_event_2026_10 FOR VALUES FROM ('2026-10-01 00:00:00+00') TO ('2026-11-01 00:00:00+00');


--
-- Name: provenance_event_2026_11; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provenance_event ATTACH PARTITION public.provenance_event_2026_11 FOR VALUES FROM ('2026-11-01 00:00:00+00') TO ('2026-12-01 00:00:00+00');


--
-- Name: provenance_event_default; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provenance_event ATTACH PARTITION public.provenance_event_default DEFAULT;


--
-- Name: usage_event_2026_08; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_event ATTACH PARTITION public.usage_event_2026_08 FOR VALUES FROM ('2026-08-01 00:00:00+00') TO ('2026-09-01 00:00:00+00');


--
-- Name: usage_event_2026_09; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_event ATTACH PARTITION public.usage_event_2026_09 FOR VALUES FROM ('2026-09-01 00:00:00+00') TO ('2026-10-01 00:00:00+00');


--
-- Name: usage_event_2026_10; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_event ATTACH PARTITION public.usage_event_2026_10 FOR VALUES FROM ('2026-10-01 00:00:00+00') TO ('2026-11-01 00:00:00+00');


--
-- Name: usage_event_2026_11; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_event ATTACH PARTITION public.usage_event_2026_11 FOR VALUES FROM ('2026-11-01 00:00:00+00') TO ('2026-12-01 00:00:00+00');


--
-- Name: usage_event_default; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_event ATTACH PARTITION public.usage_event_default DEFAULT;


--
-- Name: __drizzle_migrations id; Type: DEFAULT; Schema: drizzle; Owner: -
--

ALTER TABLE ONLY drizzle.__drizzle_migrations ALTER COLUMN id SET DEFAULT nextval('drizzle.__drizzle_migrations_id_seq'::regclass);


--
-- Name: forge_audit_log seq; Type: DEFAULT; Schema: forge; Owner: -
--

ALTER TABLE ONLY forge.forge_audit_log ALTER COLUMN seq SET DEFAULT nextval('forge.forge_audit_log_seq_seq'::regclass);


--
-- Name: __drizzle_migrations __drizzle_migrations_pkey; Type: CONSTRAINT; Schema: drizzle; Owner: -
--

ALTER TABLE ONLY drizzle.__drizzle_migrations
    ADD CONSTRAINT __drizzle_migrations_pkey PRIMARY KEY (id);


--
-- Name: approval_requests approval_requests_pkey; Type: CONSTRAINT; Schema: forge; Owner: -
--

ALTER TABLE ONLY forge.approval_requests
    ADD CONSTRAINT approval_requests_pkey PRIMARY KEY (id);


--
-- Name: capture_batches capture_batches_pkey; Type: CONSTRAINT; Schema: forge; Owner: -
--

ALTER TABLE ONLY forge.capture_batches
    ADD CONSTRAINT capture_batches_pkey PRIMARY KEY (id);


--
-- Name: contributor_consent contributor_consent_pkey; Type: CONSTRAINT; Schema: forge; Owner: -
--

ALTER TABLE ONLY forge.contributor_consent
    ADD CONSTRAINT contributor_consent_pkey PRIMARY KEY (id);


--
-- Name: contributor contributor_pkey; Type: CONSTRAINT; Schema: forge; Owner: -
--

ALTER TABLE ONLY forge.contributor
    ADD CONSTRAINT contributor_pkey PRIMARY KEY (id);


--
-- Name: extraction_candidates extraction_candidates_pkey; Type: CONSTRAINT; Schema: forge; Owner: -
--

ALTER TABLE ONLY forge.extraction_candidates
    ADD CONSTRAINT extraction_candidates_pkey PRIMARY KEY (id);


--
-- Name: extraction_runs extraction_runs_pkey; Type: CONSTRAINT; Schema: forge; Owner: -
--

ALTER TABLE ONLY forge.extraction_runs
    ADD CONSTRAINT extraction_runs_pkey PRIMARY KEY (id);


--
-- Name: forge_audit_log forge_audit_log_pkey; Type: CONSTRAINT; Schema: forge; Owner: -
--

ALTER TABLE ONLY forge.forge_audit_log
    ADD CONSTRAINT forge_audit_log_pkey PRIMARY KEY (seq);


--
-- Name: master_id_map master_id_map_pkey; Type: CONSTRAINT; Schema: forge; Owner: -
--

ALTER TABLE ONLY forge.master_id_map
    ADD CONSTRAINT master_id_map_pkey PRIMARY KEY (id);


--
-- Name: match_candidates match_candidates_pkey; Type: CONSTRAINT; Schema: forge; Owner: -
--

ALTER TABLE ONLY forge.match_candidates
    ADD CONSTRAINT match_candidates_pkey PRIMARY KEY (id);


--
-- Name: match_links match_links_pkey; Type: CONSTRAINT; Schema: forge; Owner: -
--

ALTER TABLE ONLY forge.match_links
    ADD CONSTRAINT match_links_pkey PRIMARY KEY (id);


--
-- Name: merge_log merge_log_pkey; Type: CONSTRAINT; Schema: forge; Owner: -
--

ALTER TABLE ONLY forge.merge_log
    ADD CONSTRAINT merge_log_pkey PRIMARY KEY (id);


--
-- Name: parsed_records parsed_records_pkey; Type: CONSTRAINT; Schema: forge; Owner: -
--

ALTER TABLE ONLY forge.parsed_records
    ADD CONSTRAINT parsed_records_pkey PRIMARY KEY (id);


--
-- Name: parser_versions parser_versions_pkey; Type: CONSTRAINT; Schema: forge; Owner: -
--

ALTER TABLE ONLY forge.parser_versions
    ADD CONSTRAINT parser_versions_pkey PRIMARY KEY (id);


--
-- Name: parsers parsers_pkey; Type: CONSTRAINT; Schema: forge; Owner: -
--

ALTER TABLE ONLY forge.parsers
    ADD CONSTRAINT parsers_pkey PRIMARY KEY (id);


--
-- Name: quarantine quarantine_pkey; Type: CONSTRAINT; Schema: forge; Owner: -
--

ALTER TABLE ONLY forge.quarantine
    ADD CONSTRAINT quarantine_pkey PRIMARY KEY (id);


--
-- Name: raw_captures raw_captures_pkey; Type: CONSTRAINT; Schema: forge; Owner: -
--

ALTER TABLE ONLY forge.raw_captures
    ADD CONSTRAINT raw_captures_pkey PRIMARY KEY (id);


--
-- Name: review_tasks review_tasks_pkey; Type: CONSTRAINT; Schema: forge; Owner: -
--

ALTER TABLE ONLY forge.review_tasks
    ADD CONSTRAINT review_tasks_pkey PRIMARY KEY (id);


--
-- Name: sync_outbox sync_outbox_pkey; Type: CONSTRAINT; Schema: forge; Owner: -
--

ALTER TABLE ONLY forge.sync_outbox
    ADD CONSTRAINT sync_outbox_pkey PRIMARY KEY (id);


--
-- Name: sync_state sync_state_pkey; Type: CONSTRAINT; Schema: forge; Owner: -
--

ALTER TABLE ONLY forge.sync_state
    ADD CONSTRAINT sync_state_pkey PRIMARY KEY (id);


--
-- Name: verified_record_events verified_record_events_pkey; Type: CONSTRAINT; Schema: forge; Owner: -
--

ALTER TABLE ONLY forge.verified_record_events
    ADD CONSTRAINT verified_record_events_pkey PRIMARY KEY (id);


--
-- Name: verified_records verified_records_pkey; Type: CONSTRAINT; Schema: forge; Owner: -
--

ALTER TABLE ONLY forge.verified_records
    ADD CONSTRAINT verified_records_pkey PRIMARY KEY (id);


--
-- Name: account_domains account_domains_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_domains
    ADD CONSTRAINT account_domains_pkey PRIMARY KEY (id);


--
-- Name: account_holds account_holds_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_holds
    ADD CONSTRAINT account_holds_pkey PRIMARY KEY (id);


--
-- Name: account_locations account_locations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_locations
    ADD CONSTRAINT account_locations_pkey PRIMARY KEY (id);


--
-- Name: accounts accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_pkey PRIMARY KEY (id);


--
-- Name: activities activities_pkey1; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activities
    ADD CONSTRAINT activities_pkey1 PRIMARY KEY (id, occurred_at);


--
-- Name: activities_2026_08 activities_2026_08_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activities_2026_08
    ADD CONSTRAINT activities_2026_08_pkey PRIMARY KEY (id, occurred_at);


--
-- Name: activities_2026_09 activities_2026_09_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activities_2026_09
    ADD CONSTRAINT activities_2026_09_pkey PRIMARY KEY (id, occurred_at);


--
-- Name: activities_2026_10 activities_2026_10_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activities_2026_10
    ADD CONSTRAINT activities_2026_10_pkey PRIMARY KEY (id, occurred_at);


--
-- Name: activities_2026_11 activities_2026_11_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activities_2026_11
    ADD CONSTRAINT activities_2026_11_pkey PRIMARY KEY (id, occurred_at);


--
-- Name: activities_default activities_default_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activities_default
    ADD CONSTRAINT activities_default_pkey PRIMARY KEY (id, occurred_at);


--
-- Name: ai_requests ai_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_requests
    ADD CONSTRAINT ai_requests_pkey PRIMARY KEY (id);


--
-- Name: announcements announcements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.announcements
    ADD CONSTRAINT announcements_pkey PRIMARY KEY (id);


--
-- Name: approval_requests approval_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approval_requests
    ADD CONSTRAINT approval_requests_pkey PRIMARY KEY (id);


--
-- Name: audit_log audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);


--
-- Name: auth_allowed_origins auth_allowed_origins_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_allowed_origins
    ADD CONSTRAINT auth_allowed_origins_pkey PRIMARY KEY (id);


--
-- Name: auth_email_tokens auth_email_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_email_tokens
    ADD CONSTRAINT auth_email_tokens_pkey PRIMARY KEY (token_hash);


--
-- Name: auth_policies auth_policies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_policies
    ADD CONSTRAINT auth_policies_pkey PRIMARY KEY (id);


--
-- Name: billing_cycles billing_cycles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_cycles
    ADD CONSTRAINT billing_cycles_pkey PRIMARY KEY (id);


--
-- Name: consent_records consent_records_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.consent_records
    ADD CONSTRAINT consent_records_pkey PRIMARY KEY (id);


--
-- Name: contact_emails contact_emails_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_emails
    ADD CONSTRAINT contact_emails_pkey PRIMARY KEY (id);


--
-- Name: contact_phones contact_phones_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_phones
    ADD CONSTRAINT contact_phones_pkey PRIMARY KEY (id);


--
-- Name: contact_reveals contact_reveals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_reveals
    ADD CONSTRAINT contact_reveals_pkey PRIMARY KEY (id);


--
-- Name: contacts contacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_pkey PRIMARY KEY (id);


--
-- Name: contribution_exclusion contribution_exclusion_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contribution_exclusion
    ADD CONSTRAINT contribution_exclusion_pkey PRIMARY KEY (id);


--
-- Name: contribution_policy contribution_policy_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contribution_policy
    ADD CONSTRAINT contribution_policy_pkey PRIMARY KEY (workspace_id);


--
-- Name: credit_ledger credit_ledger_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_ledger
    ADD CONSTRAINT credit_ledger_pkey PRIMARY KEY (id);


--
-- Name: credit_packs credit_packs_key_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_packs
    ADD CONSTRAINT credit_packs_key_unique UNIQUE (key);


--
-- Name: credit_packs credit_packs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_packs
    ADD CONSTRAINT credit_packs_pkey PRIMARY KEY (id);


--
-- Name: crm_connections crm_connections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_connections
    ADD CONSTRAINT crm_connections_pkey PRIMARY KEY (id);


--
-- Name: crm_field_mappings crm_field_mappings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_field_mappings
    ADD CONSTRAINT crm_field_mappings_pkey PRIMARY KEY (id);


--
-- Name: crm_inbound_events crm_inbound_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_inbound_events
    ADD CONSTRAINT crm_inbound_events_pkey PRIMARY KEY (id);


--
-- Name: crm_oauth_states crm_oauth_states_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_oauth_states
    ADD CONSTRAINT crm_oauth_states_pkey PRIMARY KEY (id);


--
-- Name: crm_object_contribution crm_object_contribution_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_object_contribution
    ADD CONSTRAINT crm_object_contribution_pkey PRIMARY KEY (connection_id, object_type);


--
-- Name: crm_record_links crm_record_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_record_links
    ADD CONSTRAINT crm_record_links_pkey PRIMARY KEY (id);


--
-- Name: crm_sync_conflicts crm_sync_conflicts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_sync_conflicts
    ADD CONSTRAINT crm_sync_conflicts_pkey PRIMARY KEY (id);


--
-- Name: crm_sync_dead_letter crm_sync_dead_letter_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_sync_dead_letter
    ADD CONSTRAINT crm_sync_dead_letter_pkey PRIMARY KEY (id);


--
-- Name: crm_sync_runs crm_sync_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_sync_runs
    ADD CONSTRAINT crm_sync_runs_pkey PRIMARY KEY (id);


--
-- Name: crm_sync_state crm_sync_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_sync_state
    ADD CONSTRAINT crm_sync_state_pkey PRIMARY KEY (id);


--
-- Name: custom_field_definitions custom_field_definitions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custom_field_definitions
    ADD CONSTRAINT custom_field_definitions_pkey PRIMARY KEY (id);


--
-- Name: data_quality_snapshots data_quality_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.data_quality_snapshots
    ADD CONSTRAINT data_quality_snapshots_pkey PRIMARY KEY (id);


--
-- Name: dsar_requests dsar_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dsar_requests
    ADD CONSTRAINT dsar_requests_pkey PRIMARY KEY (id);


--
-- Name: email_event email_event_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_event
    ADD CONSTRAINT email_event_pkey PRIMARY KEY (id);


--
-- Name: email_message email_message_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_message
    ADD CONSTRAINT email_message_pkey PRIMARY KEY (id);


--
-- Name: email_template email_template_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_template
    ADD CONSTRAINT email_template_pkey PRIMARY KEY (id);


--
-- Name: email_template_version email_template_version_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_template_version
    ADD CONSTRAINT email_template_version_pkey PRIMARY KEY (id);


--
-- Name: email_thread email_thread_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_thread
    ADD CONSTRAINT email_thread_pkey PRIMARY KEY (id);


--
-- Name: enrichment_job_chunks enrichment_job_chunks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enrichment_job_chunks
    ADD CONSTRAINT enrichment_job_chunks_pkey PRIMARY KEY (id);


--
-- Name: enrichment_job_rows enrichment_job_rows_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enrichment_job_rows
    ADD CONSTRAINT enrichment_job_rows_pkey PRIMARY KEY (id);


--
-- Name: enrichment_jobs enrichment_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enrichment_jobs
    ADD CONSTRAINT enrichment_jobs_pkey PRIMARY KEY (id);


--
-- Name: enrichment_policy enrichment_policy_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enrichment_policy
    ADD CONSTRAINT enrichment_policy_pkey PRIMARY KEY (id);


--
-- Name: entitlement entitlement_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entitlement
    ADD CONSTRAINT entitlement_pkey PRIMARY KEY (tenant_id, key, source);


--
-- Name: event_outbox event_outbox_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_outbox
    ADD CONSTRAINT event_outbox_pkey PRIMARY KEY (id);


--
-- Name: feature_flags feature_flags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feature_flags
    ADD CONSTRAINT feature_flags_pkey PRIMARY KEY (key);


--
-- Name: idempotency_keys idempotency_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.idempotency_keys
    ADD CONSTRAINT idempotency_keys_pkey PRIMARY KEY (id);


--
-- Name: impersonation_sessions impersonation_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.impersonation_sessions
    ADD CONSTRAINT impersonation_sessions_pkey PRIMARY KEY (id);


--
-- Name: import_job_chunks import_job_chunks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_job_chunks
    ADD CONSTRAINT import_job_chunks_pkey PRIMARY KEY (id);


--
-- Name: import_job_rows import_job_rows_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_job_rows
    ADD CONSTRAINT import_job_rows_pkey PRIMARY KEY (id);


--
-- Name: import_jobs import_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_jobs
    ADD CONSTRAINT import_jobs_pkey PRIMARY KEY (id);


--
-- Name: import_mapping_templates import_mapping_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_mapping_templates
    ADD CONSTRAINT import_mapping_templates_pkey PRIMARY KEY (id);


--
-- Name: import_policy import_policy_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_policy
    ADD CONSTRAINT import_policy_pkey PRIMARY KEY (id);


--
-- Name: intent_signals intent_signals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.intent_signals
    ADD CONSTRAINT intent_signals_pkey PRIMARY KEY (id);


--
-- Name: invitations invitations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invitations
    ADD CONSTRAINT invitations_pkey PRIMARY KEY (id);


--
-- Name: invitations invitations_token_hash_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invitations
    ADD CONSTRAINT invitations_token_hash_unique UNIQUE (token_hash);


--
-- Name: jit_elevations jit_elevations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jit_elevations
    ADD CONSTRAINT jit_elevations_pkey PRIMARY KEY (id);


--
-- Name: list_members list_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.list_members
    ADD CONSTRAINT list_members_pkey PRIMARY KEY (id);


--
-- Name: lists lists_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lists
    ADD CONSTRAINT lists_pkey PRIMARY KEY (id);


--
-- Name: mailbox_integration mailbox_integration_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mailbox_integration
    ADD CONSTRAINT mailbox_integration_pkey PRIMARY KEY (id);


--
-- Name: master_companies master_companies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.master_companies
    ADD CONSTRAINT master_companies_pkey PRIMARY KEY (id);


--
-- Name: master_emails master_emails_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.master_emails
    ADD CONSTRAINT master_emails_pkey PRIMARY KEY (id);


--
-- Name: master_employment master_employment_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.master_employment
    ADD CONSTRAINT master_employment_pkey PRIMARY KEY (id);


--
-- Name: master_persons master_persons_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.master_persons
    ADD CONSTRAINT master_persons_pkey PRIMARY KEY (id);


--
-- Name: master_phones master_phones_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.master_phones
    ADD CONSTRAINT master_phones_pkey PRIMARY KEY (id);


--
-- Name: match_links match_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.match_links
    ADD CONSTRAINT match_links_pkey PRIMARY KEY (id);


--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);


--
-- Name: oauth_connect_state oauth_connect_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_connect_state
    ADD CONSTRAINT oauth_connect_state_pkey PRIMARY KEY (id);


--
-- Name: outreach_log outreach_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outreach_log
    ADD CONSTRAINT outreach_log_pkey PRIMARY KEY (id);


--
-- Name: outreach_sequences outreach_sequences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outreach_sequences
    ADD CONSTRAINT outreach_sequences_pkey PRIMARY KEY (id);


--
-- Name: outreach_steps outreach_steps_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outreach_steps
    ADD CONSTRAINT outreach_steps_pkey PRIMARY KEY (id);


--
-- Name: pipeline_stages pipeline_stages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pipeline_stages
    ADD CONSTRAINT pipeline_stages_pkey PRIMARY KEY (id);


--
-- Name: plan_templates plan_templates_key_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plan_templates
    ADD CONSTRAINT plan_templates_key_unique UNIQUE (key);


--
-- Name: plan_templates plan_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plan_templates
    ADD CONSTRAINT plan_templates_pkey PRIMARY KEY (id);


--
-- Name: platform_audit_log platform_audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_audit_log
    ADD CONSTRAINT platform_audit_log_pkey PRIMARY KEY (id, occurred_at);


--
-- Name: platform_audit_log_2026_08 platform_audit_log_2026_08_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_audit_log_2026_08
    ADD CONSTRAINT platform_audit_log_2026_08_pkey PRIMARY KEY (id, occurred_at);


--
-- Name: platform_audit_log_2026_09 platform_audit_log_2026_09_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_audit_log_2026_09
    ADD CONSTRAINT platform_audit_log_2026_09_pkey PRIMARY KEY (id, occurred_at);


--
-- Name: platform_audit_log_2026_10 platform_audit_log_2026_10_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_audit_log_2026_10
    ADD CONSTRAINT platform_audit_log_2026_10_pkey PRIMARY KEY (id, occurred_at);


--
-- Name: platform_audit_log_2026_11 platform_audit_log_2026_11_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_audit_log_2026_11
    ADD CONSTRAINT platform_audit_log_2026_11_pkey PRIMARY KEY (id, occurred_at);


--
-- Name: platform_audit_log_default platform_audit_log_default_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_audit_log_default
    ADD CONSTRAINT platform_audit_log_default_pkey PRIMARY KEY (id, occurred_at);


--
-- Name: platform_staff platform_staff_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_staff
    ADD CONSTRAINT platform_staff_pkey PRIMARY KEY (id);


--
-- Name: processed_sync_events processed_sync_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.processed_sync_events
    ADD CONSTRAINT processed_sync_events_pkey PRIMARY KEY (event_id);


--
-- Name: projection_outbox projection_outbox_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projection_outbox
    ADD CONSTRAINT projection_outbox_pkey PRIMARY KEY (id);


--
-- Name: provenance_event provenance_event_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provenance_event
    ADD CONSTRAINT provenance_event_pkey PRIMARY KEY (id, recorded_at);


--
-- Name: provenance_event_2026_08 provenance_event_2026_08_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provenance_event_2026_08
    ADD CONSTRAINT provenance_event_2026_08_pkey PRIMARY KEY (id, recorded_at);


--
-- Name: provenance_event_2026_09 provenance_event_2026_09_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provenance_event_2026_09
    ADD CONSTRAINT provenance_event_2026_09_pkey PRIMARY KEY (id, recorded_at);


--
-- Name: provenance_event_2026_10 provenance_event_2026_10_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provenance_event_2026_10
    ADD CONSTRAINT provenance_event_2026_10_pkey PRIMARY KEY (id, recorded_at);


--
-- Name: provenance_event_2026_11 provenance_event_2026_11_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provenance_event_2026_11
    ADD CONSTRAINT provenance_event_2026_11_pkey PRIMARY KEY (id, recorded_at);


--
-- Name: provenance_event_default provenance_event_default_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provenance_event_default
    ADD CONSTRAINT provenance_event_default_pkey PRIMARY KEY (id, recorded_at);


--
-- Name: provider_calls provider_calls_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_calls
    ADD CONSTRAINT provider_calls_pkey PRIMARY KEY (id);


--
-- Name: provider_configs provider_configs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_configs
    ADD CONSTRAINT provider_configs_pkey PRIMARY KEY (provider);


--
-- Name: purchases purchases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchases
    ADD CONSTRAINT purchases_pkey PRIMARY KEY (id);


--
-- Name: purchases purchases_stripe_event_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchases
    ADD CONSTRAINT purchases_stripe_event_id_unique UNIQUE (stripe_event_id);


--
-- Name: record_tags record_tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.record_tags
    ADD CONSTRAINT record_tags_pkey PRIMARY KEY (id);


--
-- Name: retention_class_policies retention_class_policies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.retention_class_policies
    ADD CONSTRAINT retention_class_policies_pkey PRIMARY KEY (data_class);


--
-- Name: retention_policies retention_policies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.retention_policies
    ADD CONSTRAINT retention_policies_pkey PRIMARY KEY (id);


--
-- Name: retention_runs retention_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.retention_runs
    ADD CONSTRAINT retention_runs_pkey PRIMARY KEY (id);


--
-- Name: reveal_job_rows reveal_job_rows_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reveal_job_rows
    ADD CONSTRAINT reveal_job_rows_pkey PRIMARY KEY (id);


--
-- Name: reveal_jobs reveal_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reveal_jobs
    ADD CONSTRAINT reveal_jobs_pkey PRIMARY KEY (id);


--
-- Name: sales_nav_links sales_nav_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_nav_links
    ADD CONSTRAINT sales_nav_links_pkey PRIMARY KEY (id);


--
-- Name: saved_searches saved_searches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.saved_searches
    ADD CONSTRAINT saved_searches_pkey PRIMARY KEY (id);


--
-- Name: scheduled_imports scheduled_imports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduled_imports
    ADD CONSTRAINT scheduled_imports_pkey PRIMARY KEY (id);


--
-- Name: scim_tokens scim_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scim_tokens
    ADD CONSTRAINT scim_tokens_pkey PRIMARY KEY (id);


--
-- Name: scim_tokens scim_tokens_token_hash_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scim_tokens
    ADD CONSTRAINT scim_tokens_token_hash_unique UNIQUE (token_hash);


--
-- Name: scores scores_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scores
    ADD CONSTRAINT scores_pkey PRIMARY KEY (id);


--
-- Name: sending_domain sending_domain_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sending_domain
    ADD CONSTRAINT sending_domain_pkey PRIMARY KEY (id);


--
-- Name: source_imports source_imports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_imports
    ADD CONSTRAINT source_imports_pkey PRIMARY KEY (id);


--
-- Name: source_records source_records_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_records
    ADD CONSTRAINT source_records_pkey PRIMARY KEY (id);


--
-- Name: stripe_customers stripe_customers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stripe_customers
    ADD CONSTRAINT stripe_customers_pkey PRIMARY KEY (tenant_id);


--
-- Name: stripe_customers stripe_customers_stripe_customer_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stripe_customers
    ADD CONSTRAINT stripe_customers_stripe_customer_id_unique UNIQUE (stripe_customer_id);


--
-- Name: sub_processors sub_processors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sub_processors
    ADD CONSTRAINT sub_processors_pkey PRIMARY KEY (id);


--
-- Name: subscriptions subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_pkey PRIMARY KEY (id);


--
-- Name: subscriptions subscriptions_stripe_subscription_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_stripe_subscription_id_unique UNIQUE (stripe_subscription_id);


--
-- Name: support_notes support_notes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_notes
    ADD CONSTRAINT support_notes_pkey PRIMARY KEY (id);


--
-- Name: suppression_list suppression_list_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.suppression_list
    ADD CONSTRAINT suppression_list_pkey PRIMARY KEY (id);


--
-- Name: tags tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tags
    ADD CONSTRAINT tags_pkey PRIMARY KEY (id);


--
-- Name: team_members team_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_members
    ADD CONSTRAINT team_members_pkey PRIMARY KEY (id);


--
-- Name: teams teams_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teams
    ADD CONSTRAINT teams_pkey PRIMARY KEY (id);


--
-- Name: tenant_auth_policies tenant_auth_policies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_auth_policies
    ADD CONSTRAINT tenant_auth_policies_pkey PRIMARY KEY (tenant_id);


--
-- Name: tenant_domains tenant_domains_domain_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_domains
    ADD CONSTRAINT tenant_domains_domain_unique UNIQUE (domain);


--
-- Name: tenant_domains tenant_domains_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_domains
    ADD CONSTRAINT tenant_domains_pkey PRIMARY KEY (id);


--
-- Name: tenant_feature_flags tenant_feature_flags_flag_key_tenant_id_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_feature_flags
    ADD CONSTRAINT tenant_feature_flags_flag_key_tenant_id_pk PRIMARY KEY (flag_key, tenant_id);


--
-- Name: tenant_members tenant_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_members
    ADD CONSTRAINT tenant_members_pkey PRIMARY KEY (id);


--
-- Name: tenant_sso_configs tenant_sso_configs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_sso_configs
    ADD CONSTRAINT tenant_sso_configs_pkey PRIMARY KEY (tenant_id);


--
-- Name: tenants tenants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenants
    ADD CONSTRAINT tenants_pkey PRIMARY KEY (id);


--
-- Name: tenants tenants_slug_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenants
    ADD CONSTRAINT tenants_slug_unique UNIQUE (slug);


--
-- Name: trusted_devices trusted_devices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trusted_devices
    ADD CONSTRAINT trusted_devices_pkey PRIMARY KEY (id);


--
-- Name: accounts uniq_accounts_ws_id; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT uniq_accounts_ws_id UNIQUE (workspace_id, id);


--
-- Name: usage_event usage_event_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_event
    ADD CONSTRAINT usage_event_pkey PRIMARY KEY (id, occurred_at);


--
-- Name: usage_event_2026_08 usage_event_2026_08_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_event_2026_08
    ADD CONSTRAINT usage_event_2026_08_pkey PRIMARY KEY (id, occurred_at);


--
-- Name: usage_event_2026_09 usage_event_2026_09_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_event_2026_09
    ADD CONSTRAINT usage_event_2026_09_pkey PRIMARY KEY (id, occurred_at);


--
-- Name: usage_event_2026_10 usage_event_2026_10_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_event_2026_10
    ADD CONSTRAINT usage_event_2026_10_pkey PRIMARY KEY (id, occurred_at);


--
-- Name: usage_event_2026_11 usage_event_2026_11_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_event_2026_11
    ADD CONSTRAINT usage_event_2026_11_pkey PRIMARY KEY (id, occurred_at);


--
-- Name: usage_event_default usage_event_default_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_event_default
    ADD CONSTRAINT usage_event_default_pkey PRIMARY KEY (id, occurred_at);


--
-- Name: user_mfa_methods user_mfa_methods_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_mfa_methods
    ADD CONSTRAINT user_mfa_methods_pkey PRIMARY KEY (id);


--
-- Name: user_sessions user_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_sessions
    ADD CONSTRAINT user_sessions_pkey PRIMARY KEY (id);


--
-- Name: users users_email_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_unique UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: users users_username_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_unique UNIQUE (username);


--
-- Name: validation_rules validation_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.validation_rules
    ADD CONSTRAINT validation_rules_pkey PRIMARY KEY (id);


--
-- Name: verification_jobs verification_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.verification_jobs
    ADD CONSTRAINT verification_jobs_pkey PRIMARY KEY (id);


--
-- Name: webauthn_credentials webauthn_credentials_credential_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webauthn_credentials
    ADD CONSTRAINT webauthn_credentials_credential_id_unique UNIQUE (credential_id);


--
-- Name: webauthn_credentials webauthn_credentials_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webauthn_credentials
    ADD CONSTRAINT webauthn_credentials_pkey PRIMARY KEY (id);


--
-- Name: webhook_deliveries webhook_deliveries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webhook_deliveries
    ADD CONSTRAINT webhook_deliveries_pkey PRIMARY KEY (id);


--
-- Name: webhook_subscriptions webhook_subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webhook_subscriptions
    ADD CONSTRAINT webhook_subscriptions_pkey PRIMARY KEY (id);


--
-- Name: worker_outbox worker_outbox_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.worker_outbox
    ADD CONSTRAINT worker_outbox_pkey PRIMARY KEY (id);


--
-- Name: workspace_members workspace_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_members
    ADD CONSTRAINT workspace_members_pkey PRIMARY KEY (id);


--
-- Name: workspaces workspaces_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspaces
    ADD CONSTRAINT workspaces_pkey PRIMARY KEY (id);


--
-- Name: idx_extraction_runs_drift; Type: INDEX; Schema: forge; Owner: -
--

CREATE INDEX idx_extraction_runs_drift ON forge.extraction_runs USING btree (extract_schema_version, model);


--
-- Name: idx_forge_audit_row_hash; Type: INDEX; Schema: forge; Owner: -
--

CREATE INDEX idx_forge_audit_row_hash ON forge.forge_audit_log USING btree (row_hash);


--
-- Name: idx_forge_contributor_consent_live; Type: INDEX; Schema: forge; Owner: -
--

CREATE INDEX idx_forge_contributor_consent_live ON forge.contributor_consent USING btree (contributor_id) WHERE (revoked_at IS NULL);


--
-- Name: idx_match_candidates_block; Type: INDEX; Schema: forge; Owner: -
--

CREATE INDEX idx_match_candidates_block ON forge.match_candidates USING btree (block_key);


--
-- Name: idx_match_links_cluster; Type: INDEX; Schema: forge; Owner: -
--

CREATE INDEX idx_match_links_cluster ON forge.match_links USING btree (entity_type, cluster_id);


--
-- Name: idx_raw_captures_ingested_at; Type: INDEX; Schema: forge; Owner: -
--

CREATE INDEX idx_raw_captures_ingested_at ON forge.raw_captures USING btree (ingested_at);


--
-- Name: idx_review_tasks_rank; Type: INDEX; Schema: forge; Owner: -
--

CREATE INDEX idx_review_tasks_rank ON forge.review_tasks USING btree (status, priority);


--
-- Name: idx_review_tasks_sla; Type: INDEX; Schema: forge; Owner: -
--

CREATE INDEX idx_review_tasks_sla ON forge.review_tasks USING btree (sla_due_at);


--
-- Name: idx_sync_outbox_pending; Type: INDEX; Schema: forge; Owner: -
--

CREATE INDEX idx_sync_outbox_pending ON forge.sync_outbox USING btree (status, available_at);


--
-- Name: uniq_approval_requests_pending_subject; Type: INDEX; Schema: forge; Owner: -
--

CREATE UNIQUE INDEX uniq_approval_requests_pending_subject ON forge.approval_requests USING btree (op_class, subject_ref) WHERE (status = 'pending'::text);


--
-- Name: uniq_capture_batches_idempotency_key; Type: INDEX; Schema: forge; Owner: -
--

CREATE UNIQUE INDEX uniq_capture_batches_idempotency_key ON forge.capture_batches USING btree (idempotency_key);


--
-- Name: uniq_extraction_candidates_capture_path; Type: INDEX; Schema: forge; Owner: -
--

CREATE UNIQUE INDEX uniq_extraction_candidates_capture_path ON forge.extraction_candidates USING btree (raw_capture_id, path);


--
-- Name: uniq_forge_contributor_user_channel; Type: INDEX; Schema: forge; Owner: -
--

CREATE UNIQUE INDEX uniq_forge_contributor_user_channel ON forge.contributor USING btree (user_id, channel);


--
-- Name: uniq_master_id_map_forge; Type: INDEX; Schema: forge; Owner: -
--

CREATE UNIQUE INDEX uniq_master_id_map_forge ON forge.master_id_map USING btree (forge_id);


--
-- Name: uniq_parsed_records_capture_version; Type: INDEX; Schema: forge; Owner: -
--

CREATE UNIQUE INDEX uniq_parsed_records_capture_version ON forge.parsed_records USING btree (raw_capture_id, parser_version_id);


--
-- Name: uniq_parser_versions_one_active; Type: INDEX; Schema: forge; Owner: -
--

CREATE UNIQUE INDEX uniq_parser_versions_one_active ON forge.parser_versions USING btree (parser_id) WHERE (status = 'active'::text);


--
-- Name: uniq_parsers_source_endpoint; Type: INDEX; Schema: forge; Owner: -
--

CREATE UNIQUE INDEX uniq_parsers_source_endpoint ON forge.parsers USING btree (source, endpoint);


--
-- Name: uniq_quarantine_capture_route; Type: INDEX; Schema: forge; Owner: -
--

CREATE UNIQUE INDEX uniq_quarantine_capture_route ON forge.quarantine USING btree (raw_capture_id, route);


--
-- Name: uniq_raw_captures_tenant_content_hash; Type: INDEX; Schema: forge; Owner: -
--

CREATE UNIQUE INDEX uniq_raw_captures_tenant_content_hash ON forge.raw_captures USING btree (target_tenant_id, content_hash);


--
-- Name: uniq_review_tasks_one_open; Type: INDEX; Schema: forge; Owner: -
--

CREATE UNIQUE INDEX uniq_review_tasks_one_open ON forge.review_tasks USING btree (subject_ref, task_type) WHERE (status = 'open'::text);


--
-- Name: uniq_sync_state_entity; Type: INDEX; Schema: forge; Owner: -
--

CREATE UNIQUE INDEX uniq_sync_state_entity ON forge.sync_state USING btree (entity_kind, verified_id);


--
-- Name: uniq_verified_records_content_hash; Type: INDEX; Schema: forge; Owner: -
--

CREATE UNIQUE INDEX uniq_verified_records_content_hash ON forge.verified_records USING btree (content_hash);


--
-- Name: account_holds_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX account_holds_tenant_idx ON public.account_holds USING btree (tenant_id, id);


--
-- Name: idx_activities_ws_contact_occurred; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_activities_ws_contact_occurred ON ONLY public.activities USING btree (workspace_id, contact_id, occurred_at DESC NULLS LAST);


--
-- Name: activities_2026_08_workspace_id_contact_id_occurred_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX activities_2026_08_workspace_id_contact_id_occurred_at_idx ON public.activities_2026_08 USING btree (workspace_id, contact_id, occurred_at DESC NULLS LAST);


--
-- Name: idx_activities_ws_occurred_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_activities_ws_occurred_type ON ONLY public.activities USING btree (workspace_id, occurred_at DESC, activity_type);


--
-- Name: activities_2026_08_workspace_id_occurred_at_activity_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX activities_2026_08_workspace_id_occurred_at_activity_type_idx ON public.activities_2026_08 USING btree (workspace_id, occurred_at DESC, activity_type);


--
-- Name: activities_2026_09_workspace_id_contact_id_occurred_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX activities_2026_09_workspace_id_contact_id_occurred_at_idx ON public.activities_2026_09 USING btree (workspace_id, contact_id, occurred_at DESC NULLS LAST);


--
-- Name: activities_2026_09_workspace_id_occurred_at_activity_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX activities_2026_09_workspace_id_occurred_at_activity_type_idx ON public.activities_2026_09 USING btree (workspace_id, occurred_at DESC, activity_type);


--
-- Name: activities_2026_10_workspace_id_contact_id_occurred_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX activities_2026_10_workspace_id_contact_id_occurred_at_idx ON public.activities_2026_10 USING btree (workspace_id, contact_id, occurred_at DESC NULLS LAST);


--
-- Name: activities_2026_10_workspace_id_occurred_at_activity_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX activities_2026_10_workspace_id_occurred_at_activity_type_idx ON public.activities_2026_10 USING btree (workspace_id, occurred_at DESC, activity_type);


--
-- Name: activities_2026_11_workspace_id_contact_id_occurred_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX activities_2026_11_workspace_id_contact_id_occurred_at_idx ON public.activities_2026_11 USING btree (workspace_id, contact_id, occurred_at DESC NULLS LAST);


--
-- Name: activities_2026_11_workspace_id_occurred_at_activity_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX activities_2026_11_workspace_id_occurred_at_activity_type_idx ON public.activities_2026_11 USING btree (workspace_id, occurred_at DESC, activity_type);


--
-- Name: activities_default_workspace_id_contact_id_occurred_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX activities_default_workspace_id_contact_id_occurred_at_idx ON public.activities_default USING btree (workspace_id, contact_id, occurred_at DESC NULLS LAST);


--
-- Name: activities_default_workspace_id_occurred_at_activity_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX activities_default_workspace_id_occurred_at_activity_type_idx ON public.activities_default USING btree (workspace_id, occurred_at DESC, activity_type);


--
-- Name: announcements_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX announcements_active_idx ON public.announcements USING btree (active, id);


--
-- Name: approval_requests_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX approval_requests_status_idx ON public.approval_requests USING btree (status, id);


--
-- Name: idx_account_domains_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_account_domains_account ON public.account_domains USING btree (account_id) WHERE (deleted_at IS NULL);


--
-- Name: idx_accounts_custom_fields_gin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_accounts_custom_fields_gin ON public.accounts USING gin (custom_fields);


--
-- Name: idx_accounts_master; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_accounts_master ON public.accounts USING btree (master_company_id) WHERE (master_company_id IS NOT NULL);


--
-- Name: idx_accounts_technologies_gin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_accounts_technologies_gin ON public.accounts USING gin (technologies);


--
-- Name: idx_accounts_trgm_domain; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_accounts_trgm_domain ON public.accounts USING gin (((domain)::text) public.gin_trgm_ops);


--
-- Name: idx_accounts_trgm_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_accounts_trgm_name ON public.accounts USING gin (name public.gin_trgm_ops);


--
-- Name: idx_accounts_ws_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_accounts_ws_created_at ON public.accounts USING btree (workspace_id, created_at);


--
-- Name: idx_accounts_ws_employee_count; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_accounts_ws_employee_count ON public.accounts USING btree (workspace_id, employee_count);


--
-- Name: idx_accounts_ws_industry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_accounts_ws_industry ON public.accounts USING btree (workspace_id, industry);


--
-- Name: idx_accounts_ws_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_accounts_ws_name ON public.accounts USING btree (workspace_id, name);


--
-- Name: idx_accounts_ws_root; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_accounts_ws_root ON public.accounts USING btree (workspace_id, root_account_id) WHERE (root_account_id IS NOT NULL);


--
-- Name: idx_ai_requests_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ai_requests_created ON public.ai_requests USING btree (created_at);


--
-- Name: idx_ai_requests_workspace_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ai_requests_workspace_created ON public.ai_requests USING btree (workspace_id, created_at);


--
-- Name: idx_audit_log_tenant_auth_occurred_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_log_tenant_auth_occurred_at ON public.audit_log USING btree (tenant_id, occurred_at DESC NULLS LAST) WHERE ((action)::text = ANY ((ARRAY['login.success'::character varying, 'login.failure'::character varying, 'login.locked'::character varying, 'mfa.challenge'::character varying, 'mfa.success'::character varying, 'mfa.failure'::character varying, 'password.reset.request'::character varying, 'password.reset.complete'::character varying, 'sso.initiated'::character varying, 'sso.callback'::character varying, 'token.issued'::character varying, 'token.refresh'::character varying, 'token.revoke'::character varying, 'device.trusted'::character varying, 'device.revoked'::character varying, 'session.revoked'::character varying, 'code.issued'::character varying, 'code.exchanged'::character varying, 'signup'::character varying, 'oauth.link'::character varying])::text[]));


--
-- Name: idx_audit_log_tenant_occurred_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_log_tenant_occurred_at ON public.audit_log USING btree (tenant_id, occurred_at DESC NULLS LAST);


--
-- Name: idx_billing_cycles_pending_grant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_billing_cycles_pending_grant ON public.billing_cycles USING btree (period_start) WHERE ((granted_at IS NULL) AND ((status)::text = 'open'::text));


--
-- Name: idx_billing_cycles_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_billing_cycles_tenant ON public.billing_cycles USING btree (tenant_id, period_start DESC);


--
-- Name: idx_contact_emails_ws_contact; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contact_emails_ws_contact ON public.contact_emails USING btree (workspace_id, contact_id);


--
-- Name: idx_contact_emails_ws_domain; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contact_emails_ws_domain ON public.contact_emails USING btree (workspace_id, email_domain) WHERE (deleted_at IS NULL);


--
-- Name: idx_contact_phones_ws_contact; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contact_phones_ws_contact ON public.contact_phones USING btree (workspace_id, contact_id);


--
-- Name: idx_contact_phones_ws_e164; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contact_phones_ws_e164 ON public.contact_phones USING btree (workspace_id, e164_blind_index) WHERE ((e164_blind_index IS NOT NULL) AND (deleted_at IS NULL));


--
-- Name: idx_contact_reveals_ws_revealed_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contact_reveals_ws_revealed_at ON public.contact_reveals USING btree (workspace_id, revealed_at DESC NULLS LAST);


--
-- Name: idx_contacts_custom_fields_gin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contacts_custom_fields_gin ON public.contacts USING gin (custom_fields);


--
-- Name: idx_contacts_duplicate_of; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contacts_duplicate_of ON public.contacts USING btree (duplicate_of_contact_id) WHERE (duplicate_of_contact_id IS NOT NULL);


--
-- Name: idx_contacts_master; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contacts_master ON public.contacts USING btree (master_person_id) WHERE (master_person_id IS NOT NULL);


--
-- Name: idx_contacts_merged_into; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contacts_merged_into ON public.contacts USING btree (merged_into_contact_id) WHERE (merged_into_contact_id IS NOT NULL);


--
-- Name: idx_contacts_trgm_email_domain; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contacts_trgm_email_domain ON public.contacts USING gin (((email_domain)::text) public.gin_trgm_ops);


--
-- Name: idx_contacts_trgm_first_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contacts_trgm_first_name ON public.contacts USING gin (first_name public.gin_trgm_ops);


--
-- Name: idx_contacts_trgm_full_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contacts_trgm_full_name ON public.contacts USING gin (((((COALESCE(first_name, ''::character varying))::text || ' '::text) || (COALESCE(last_name, ''::character varying))::text)) public.gin_trgm_ops);


--
-- Name: idx_contacts_trgm_job_title; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contacts_trgm_job_title ON public.contacts USING gin (job_title public.gin_trgm_ops);


--
-- Name: idx_contacts_trgm_last_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contacts_trgm_last_name ON public.contacts USING gin (last_name public.gin_trgm_ops);


--
-- Name: idx_contacts_trgm_linkedin_url; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contacts_trgm_linkedin_url ON public.contacts USING gin (linkedin_url public.gin_trgm_ops);


--
-- Name: idx_contacts_unresolved; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contacts_unresolved ON public.contacts USING btree (workspace_id, id) WHERE ((master_person_id IS NULL) AND (deleted_at IS NULL));


--
-- Name: idx_contacts_ws_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contacts_ws_account ON public.contacts USING btree (workspace_id, account_id) WHERE (account_id IS NOT NULL);


--
-- Name: idx_contacts_ws_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contacts_ws_created_at ON public.contacts USING btree (workspace_id, created_at DESC, id DESC) WHERE (deleted_at IS NULL);


--
-- Name: idx_contacts_ws_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contacts_ws_owner ON public.contacts USING btree (workspace_id, owner_user_id);


--
-- Name: idx_contacts_ws_priority_score; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contacts_ws_priority_score ON public.contacts USING btree (workspace_id, priority_score DESC NULLS LAST) WHERE ((deleted_at IS NULL) AND (priority_score IS NOT NULL));


--
-- Name: idx_contacts_ws_priority_score_coalesced; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contacts_ws_priority_score_coalesced ON public.contacts USING btree (workspace_id, COALESCE(priority_score, '-1'::integer) DESC, id DESC) WHERE (deleted_at IS NULL);


--
-- Name: idx_contribution_exclusion_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contribution_exclusion_workspace ON public.contribution_exclusion USING btree (workspace_id, kind);


--
-- Name: idx_credit_ledger_tenant_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_credit_ledger_tenant_created ON public.credit_ledger USING btree (tenant_id, created_at DESC);


--
-- Name: idx_crm_connections_sweep; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_connections_sweep ON public.crm_connections USING btree (status, next_poll_at);


--
-- Name: idx_crm_inbound_events_unprocessed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_inbound_events_unprocessed ON public.crm_inbound_events USING btree (connection_id, process_status, received_at);


--
-- Name: idx_crm_record_links_recon; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_record_links_recon ON public.crm_record_links USING btree (connection_id, last_inbound_modstamp);


--
-- Name: idx_crm_sync_conflicts_open; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_sync_conflicts_open ON public.crm_sync_conflicts USING btree (workspace_id, status, created_at DESC NULLS LAST);


--
-- Name: idx_crm_sync_dead_letter_open; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_sync_dead_letter_open ON public.crm_sync_dead_letter USING btree (workspace_id, status, created_at DESC NULLS LAST);


--
-- Name: idx_crm_sync_runs_conn_started; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_sync_runs_conn_started ON public.crm_sync_runs USING btree (connection_id, started_at DESC NULLS LAST);


--
-- Name: idx_crm_sync_runs_ws_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_sync_runs_ws_created ON public.crm_sync_runs USING btree (workspace_id, created_at DESC NULLS LAST);


--
-- Name: idx_data_quality_snapshots_ws_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_data_quality_snapshots_ws_created ON public.data_quality_snapshots USING btree (workspace_id, created_at);


--
-- Name: idx_dsar_requests_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dsar_requests_due ON public.dsar_requests USING btree (due_at) WHERE ((status)::text <> ALL ((ARRAY['completed'::character varying, 'rejected'::character varying])::text[]));


--
-- Name: idx_email_event_log; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_email_event_log ON public.email_event USING btree (outreach_log_id) WHERE (outreach_log_id IS NOT NULL);


--
-- Name: idx_email_event_ws_occurred; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_email_event_ws_occurred ON public.email_event USING btree (workspace_id, occurred_at);


--
-- Name: idx_email_message_rfc822; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_email_message_rfc822 ON public.email_message USING btree (workspace_id, rfc822_message_id) WHERE (rfc822_message_id IS NOT NULL);


--
-- Name: idx_email_message_thread; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_email_message_thread ON public.email_message USING btree (thread_id, occurred_at);


--
-- Name: idx_email_message_ws_occurred; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_email_message_ws_occurred ON public.email_message USING btree (workspace_id, occurred_at);


--
-- Name: idx_email_template_ws_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_email_template_ws_owner ON public.email_template USING btree (workspace_id, owner_user_id);


--
-- Name: idx_email_thread_ws_last_message; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_email_thread_ws_last_message ON public.email_thread USING btree (workspace_id, last_message_at);


--
-- Name: idx_email_thread_ws_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_email_thread_ws_owner ON public.email_thread USING btree (workspace_id, owner_user_id);


--
-- Name: idx_employment_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_employment_company ON public.master_employment USING btree (master_company_id) WHERE is_current;


--
-- Name: idx_employment_current; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_employment_current ON public.master_employment USING btree (master_person_id) WHERE is_current;


--
-- Name: idx_enrichment_job_rows_job; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_enrichment_job_rows_job ON public.enrichment_job_rows USING btree (job_id);


--
-- Name: idx_enrichment_job_rows_ws_outcome; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_enrichment_job_rows_ws_outcome ON public.enrichment_job_rows USING btree (workspace_id, match_outcome);


--
-- Name: idx_enrichment_jobs_ws_creator_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_enrichment_jobs_ws_creator_created ON public.enrichment_jobs USING btree (workspace_id, created_by_user_id, created_at DESC, id DESC);


--
-- Name: idx_enrichment_jobs_ws_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_enrichment_jobs_ws_status ON public.enrichment_jobs USING btree (workspace_id, status);


--
-- Name: idx_entitlement_expiring; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_entitlement_expiring ON public.entitlement USING btree (expires_at) WHERE (expires_at IS NOT NULL);


--
-- Name: idx_event_outbox_status_occurred; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_event_outbox_status_occurred ON public.event_outbox USING btree (status, occurred_at);


--
-- Name: idx_import_job_rows_job; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_import_job_rows_job ON public.import_job_rows USING btree (job_id);


--
-- Name: idx_import_job_rows_ws_outcome; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_import_job_rows_ws_outcome ON public.import_job_rows USING btree (workspace_id, outcome);


--
-- Name: idx_import_jobs_ws_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_import_jobs_ws_created ON public.import_jobs USING btree (workspace_id, created_at DESC, id DESC);


--
-- Name: idx_import_jobs_ws_creator_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_import_jobs_ws_creator_created ON public.import_jobs USING btree (workspace_id, created_by_user_id, created_at DESC, id DESC);


--
-- Name: idx_import_jobs_ws_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_import_jobs_ws_status ON public.import_jobs USING btree (workspace_id, status);


--
-- Name: idx_list_members_contact; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_list_members_contact ON public.list_members USING btree (contact_id);


--
-- Name: idx_list_members_list_added_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_list_members_list_added_at ON public.list_members USING btree (list_id, added_at DESC, id DESC);


--
-- Name: idx_mailbox_integration_ws; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mailbox_integration_ws ON public.mailbox_integration USING btree (workspace_id, created_at);


--
-- Name: idx_master_persons_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_master_persons_company ON public.master_persons USING btree (current_company_id);


--
-- Name: idx_master_persons_merged_into; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_master_persons_merged_into ON public.master_persons USING btree (merged_into_person_id) WHERE (merged_into_person_id IS NOT NULL);


--
-- Name: idx_match_links_cluster; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_match_links_cluster ON public.match_links USING btree (entity_type, cluster_id);


--
-- Name: idx_notifications_unread; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notifications_unread ON public.notifications USING btree (workspace_id, user_id) WHERE (read_at IS NULL);


--
-- Name: idx_notifications_user_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notifications_user_created ON public.notifications USING btree (workspace_id, user_id, created_at);


--
-- Name: idx_oauth_connect_state_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_oauth_connect_state_tenant ON public.oauth_connect_state USING btree (tenant_id, created_at);


--
-- Name: idx_pipeline_stages_ws_ordering; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pipeline_stages_ws_ordering ON public.pipeline_stages USING btree (workspace_id, ordering);


--
-- Name: idx_platform_audit_tenant_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_platform_audit_tenant_time ON ONLY public.platform_audit_log USING btree (tenant_id, occurred_at DESC) WHERE (tenant_id IS NOT NULL);


--
-- Name: idx_projection_outbox_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_projection_outbox_status ON public.projection_outbox USING btree (status, enqueued_at);


--
-- Name: idx_prov_event_badge; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_prov_event_badge ON ONLY public.provenance_event USING btree (entity_type, entity_id, observed_at DESC);


--
-- Name: idx_prov_event_entity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_prov_event_entity ON ONLY public.provenance_event USING btree (entity_type, entity_id, field, recorded_at DESC);


--
-- Name: idx_prov_event_source_record; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_prov_event_source_record ON ONLY public.provenance_event USING btree (source_record_id, entity_type, entity_id, field) WHERE (source_record_id IS NOT NULL);


--
-- Name: idx_provider_calls_ws_called_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_provider_calls_ws_called_at ON public.provider_calls USING btree (workspace_id, called_at DESC NULLS LAST);


--
-- Name: idx_retention_runs_tenant_class; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_retention_runs_tenant_class ON public.retention_runs USING btree (tenant_id, data_class, created_at);


--
-- Name: idx_reveal_job_rows_job_row; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reveal_job_rows_job_row ON public.reveal_job_rows USING btree (job_id, row_index);


--
-- Name: idx_reveal_job_rows_ws_outcome; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reveal_job_rows_ws_outcome ON public.reveal_job_rows USING btree (workspace_id, outcome);


--
-- Name: idx_reveal_jobs_ws_creator_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reveal_jobs_ws_creator_created ON public.reveal_jobs USING btree (workspace_id, created_by_user_id, created_at DESC, id DESC);


--
-- Name: idx_reveal_jobs_ws_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reveal_jobs_ws_status ON public.reveal_jobs USING btree (workspace_id, status);


--
-- Name: idx_scheduled_imports_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_scheduled_imports_due ON public.scheduled_imports USING btree (next_run_at) WHERE (enabled = true);


--
-- Name: idx_sending_domain_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sending_domain_tenant ON public.sending_domain USING btree (tenant_id, created_at);


--
-- Name: idx_source_imports_ws_imported_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_source_imports_ws_imported_at ON public.source_imports USING btree (workspace_id, imported_at DESC NULLS LAST);


--
-- Name: idx_source_imports_ws_importer_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_source_imports_ws_importer_at ON public.source_imports USING btree (workspace_id, imported_by_user_id, imported_at DESC);


--
-- Name: idx_source_records_employment; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_source_records_employment ON public.source_records USING btree (resolved_person_id, resolved_company_id) WHERE ((resolved_person_id IS NOT NULL) AND (resolved_company_id IS NOT NULL));


--
-- Name: idx_subscriptions_renewal_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_subscriptions_renewal_due ON public.subscriptions USING btree (current_period_end) WHERE ((auto_renew = true) AND ((status)::text = 'active'::text));


--
-- Name: idx_subscriptions_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_subscriptions_tenant ON public.subscriptions USING btree (tenant_id, created_at DESC);


--
-- Name: idx_suppression_contact; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_suppression_contact ON public.suppression_list USING btree (contact_id) WHERE (contact_id IS NOT NULL);


--
-- Name: idx_suppression_domain; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_suppression_domain ON public.suppression_list USING btree (domain) WHERE (domain IS NOT NULL);


--
-- Name: idx_suppression_email_blind_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_suppression_email_blind_index ON public.suppression_list USING btree (email_blind_index) WHERE (email_blind_index IS NOT NULL);


--
-- Name: idx_suppression_phone_blind_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_suppression_phone_blind_index ON public.suppression_list USING btree (phone_blind_index) WHERE (phone_blind_index IS NOT NULL);


--
-- Name: idx_team_members_ws; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_team_members_ws ON public.team_members USING btree (workspace_id);


--
-- Name: idx_usage_event_cap; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_usage_event_cap ON ONLY public.usage_event USING btree (tenant_id, entitlement_key, occurred_at);


--
-- Name: idx_usage_event_wanted; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_usage_event_wanted ON ONLY public.usage_event USING btree (action, subject_fingerprint) WHERE ((action)::text = 'reveal_miss'::text);


--
-- Name: idx_usage_event_ws; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_usage_event_ws ON ONLY public.usage_event USING btree (workspace_id, occurred_at DESC);


--
-- Name: idx_validation_rules_field; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_validation_rules_field ON public.validation_rules USING btree (field);


--
-- Name: idx_verification_jobs_ws_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_verification_jobs_ws_created ON public.verification_jobs USING btree (workspace_id, created_at);


--
-- Name: idx_webauthn_credentials_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_webauthn_credentials_user ON public.webauthn_credentials USING btree (user_id);


--
-- Name: idx_webhook_deliveries_webhook; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_webhook_deliveries_webhook ON public.webhook_deliveries USING btree (webhook_id);


--
-- Name: idx_webhook_deliveries_ws; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_webhook_deliveries_ws ON public.webhook_deliveries USING btree (workspace_id, attempted_at);


--
-- Name: idx_webhook_subscriptions_ws; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_webhook_subscriptions_ws ON public.webhook_subscriptions USING btree (workspace_id, created_at);


--
-- Name: idx_worker_outbox_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_worker_outbox_status ON public.worker_outbox USING btree (status, enqueued_at);


--
-- Name: jit_elevations_staff_action_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jit_elevations_staff_action_status_idx ON public.jit_elevations USING btree (staff_user_id, action, status);


--
-- Name: platform_audit_log_2026_08_tenant_id_occurred_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX platform_audit_log_2026_08_tenant_id_occurred_at_idx ON public.platform_audit_log_2026_08 USING btree (tenant_id, occurred_at DESC) WHERE (tenant_id IS NOT NULL);


--
-- Name: platform_audit_log_2026_09_tenant_id_occurred_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX platform_audit_log_2026_09_tenant_id_occurred_at_idx ON public.platform_audit_log_2026_09 USING btree (tenant_id, occurred_at DESC) WHERE (tenant_id IS NOT NULL);


--
-- Name: platform_audit_log_2026_10_tenant_id_occurred_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX platform_audit_log_2026_10_tenant_id_occurred_at_idx ON public.platform_audit_log_2026_10 USING btree (tenant_id, occurred_at DESC) WHERE (tenant_id IS NOT NULL);


--
-- Name: platform_audit_log_2026_11_tenant_id_occurred_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX platform_audit_log_2026_11_tenant_id_occurred_at_idx ON public.platform_audit_log_2026_11 USING btree (tenant_id, occurred_at DESC) WHERE (tenant_id IS NOT NULL);


--
-- Name: platform_audit_log_default_tenant_id_occurred_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX platform_audit_log_default_tenant_id_occurred_at_idx ON public.platform_audit_log_default USING btree (tenant_id, occurred_at DESC) WHERE (tenant_id IS NOT NULL);


--
-- Name: provenance_event_2026_08_entity_type_entity_id_field_record_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX provenance_event_2026_08_entity_type_entity_id_field_record_idx ON public.provenance_event_2026_08 USING btree (entity_type, entity_id, field, recorded_at DESC);


--
-- Name: provenance_event_2026_08_entity_type_entity_id_observed_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX provenance_event_2026_08_entity_type_entity_id_observed_at_idx ON public.provenance_event_2026_08 USING btree (entity_type, entity_id, observed_at DESC);


--
-- Name: provenance_event_2026_08_source_record_id_entity_type_entit_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX provenance_event_2026_08_source_record_id_entity_type_entit_idx ON public.provenance_event_2026_08 USING btree (source_record_id, entity_type, entity_id, field) WHERE (source_record_id IS NOT NULL);


--
-- Name: provenance_event_2026_09_entity_type_entity_id_field_record_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX provenance_event_2026_09_entity_type_entity_id_field_record_idx ON public.provenance_event_2026_09 USING btree (entity_type, entity_id, field, recorded_at DESC);


--
-- Name: provenance_event_2026_09_entity_type_entity_id_observed_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX provenance_event_2026_09_entity_type_entity_id_observed_at_idx ON public.provenance_event_2026_09 USING btree (entity_type, entity_id, observed_at DESC);


--
-- Name: provenance_event_2026_09_source_record_id_entity_type_entit_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX provenance_event_2026_09_source_record_id_entity_type_entit_idx ON public.provenance_event_2026_09 USING btree (source_record_id, entity_type, entity_id, field) WHERE (source_record_id IS NOT NULL);


--
-- Name: provenance_event_2026_10_entity_type_entity_id_field_record_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX provenance_event_2026_10_entity_type_entity_id_field_record_idx ON public.provenance_event_2026_10 USING btree (entity_type, entity_id, field, recorded_at DESC);


--
-- Name: provenance_event_2026_10_entity_type_entity_id_observed_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX provenance_event_2026_10_entity_type_entity_id_observed_at_idx ON public.provenance_event_2026_10 USING btree (entity_type, entity_id, observed_at DESC);


--
-- Name: provenance_event_2026_10_source_record_id_entity_type_entit_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX provenance_event_2026_10_source_record_id_entity_type_entit_idx ON public.provenance_event_2026_10 USING btree (source_record_id, entity_type, entity_id, field) WHERE (source_record_id IS NOT NULL);


--
-- Name: provenance_event_2026_11_entity_type_entity_id_field_record_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX provenance_event_2026_11_entity_type_entity_id_field_record_idx ON public.provenance_event_2026_11 USING btree (entity_type, entity_id, field, recorded_at DESC);


--
-- Name: provenance_event_2026_11_entity_type_entity_id_observed_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX provenance_event_2026_11_entity_type_entity_id_observed_at_idx ON public.provenance_event_2026_11 USING btree (entity_type, entity_id, observed_at DESC);


--
-- Name: provenance_event_2026_11_source_record_id_entity_type_entit_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX provenance_event_2026_11_source_record_id_entity_type_entit_idx ON public.provenance_event_2026_11 USING btree (source_record_id, entity_type, entity_id, field) WHERE (source_record_id IS NOT NULL);


--
-- Name: provenance_event_default_entity_type_entity_id_field_record_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX provenance_event_default_entity_type_entity_id_field_record_idx ON public.provenance_event_default USING btree (entity_type, entity_id, field, recorded_at DESC);


--
-- Name: provenance_event_default_entity_type_entity_id_observed_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX provenance_event_default_entity_type_entity_id_observed_at_idx ON public.provenance_event_default USING btree (entity_type, entity_id, observed_at DESC);


--
-- Name: provenance_event_default_source_record_id_entity_type_entit_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX provenance_event_default_source_record_id_entity_type_entit_idx ON public.provenance_event_default USING btree (source_record_id, entity_type, entity_id, field) WHERE (source_record_id IS NOT NULL);


--
-- Name: retention_policies_entity_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX retention_policies_entity_idx ON public.retention_policies USING btree (entity, id);


--
-- Name: sub_processors_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sub_processors_active_idx ON public.sub_processors USING btree (active, id);


--
-- Name: support_notes_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX support_notes_tenant_idx ON public.support_notes USING btree (tenant_id, id);


--
-- Name: uniq_account_domains_primary; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_account_domains_primary ON public.account_domains USING btree (account_id) WHERE (is_primary AND (deleted_at IS NULL));


--
-- Name: uniq_account_domains_ws_domain; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_account_domains_ws_domain ON public.account_domains USING btree (workspace_id, domain) WHERE (deleted_at IS NULL);


--
-- Name: uniq_account_locations_primary; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_account_locations_primary ON public.account_locations USING btree (account_id) WHERE (is_primary AND (deleted_at IS NULL));


--
-- Name: uniq_accounts_ws_domain; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_accounts_ws_domain ON public.accounts USING btree (workspace_id, domain) WHERE ((domain IS NOT NULL) AND (deleted_at IS NULL));


--
-- Name: uniq_auth_allowed_origin; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_auth_allowed_origin ON public.auth_allowed_origins USING btree (scope, tenant_id, origin) NULLS NOT DISTINCT;


--
-- Name: uniq_auth_policy_scope_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_auth_policy_scope_key ON public.auth_policies USING btree (scope, tenant_id, workspace_id, key) NULLS NOT DISTINCT;


--
-- Name: uniq_billing_cycles_sub_period; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_billing_cycles_sub_period ON public.billing_cycles USING btree (subscription_id, period_start);


--
-- Name: uniq_contact_emails_contact_value; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_contact_emails_contact_value ON public.contact_emails USING btree (contact_id, blind_index) WHERE (deleted_at IS NULL);


--
-- Name: uniq_contact_emails_primary; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_contact_emails_primary ON public.contact_emails USING btree (contact_id) WHERE (is_primary AND (deleted_at IS NULL));


--
-- Name: uniq_contact_emails_ws_value; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_contact_emails_ws_value ON public.contact_emails USING btree (workspace_id, blind_index) WHERE (deleted_at IS NULL);


--
-- Name: uniq_contact_phones_contact_value; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_contact_phones_contact_value ON public.contact_phones USING btree (contact_id, blind_index) WHERE (deleted_at IS NULL);


--
-- Name: uniq_contact_phones_primary; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_contact_phones_primary ON public.contact_phones USING btree (contact_id) WHERE (is_primary AND (deleted_at IS NULL));


--
-- Name: uniq_contact_reveals_claim; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_contact_reveals_claim ON public.contact_reveals USING btree (workspace_id, contact_id, reveal_type);


--
-- Name: uniq_contacts_ws_email; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_contacts_ws_email ON public.contacts USING btree (workspace_id, email_blind_index) WHERE (email_blind_index IS NOT NULL);


--
-- Name: uniq_contacts_ws_external_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_contacts_ws_external_id ON public.contacts USING btree (workspace_id, external_id) WHERE ((external_id IS NOT NULL) AND (deleted_at IS NULL));


--
-- Name: uniq_contacts_ws_linkedin; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_contacts_ws_linkedin ON public.contacts USING btree (workspace_id, linkedin_public_id) WHERE (linkedin_public_id IS NOT NULL);


--
-- Name: uniq_contacts_ws_salesnav; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_contacts_ws_salesnav ON public.contacts USING btree (workspace_id, sales_nav_lead_id) WHERE (sales_nav_lead_id IS NOT NULL);


--
-- Name: uniq_contribution_exclusion_account; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_contribution_exclusion_account ON public.contribution_exclusion USING btree (workspace_id, account_id) WHERE ((kind)::text = 'account'::text);


--
-- Name: uniq_contribution_exclusion_contact; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_contribution_exclusion_contact ON public.contribution_exclusion USING btree (workspace_id, contact_id) WHERE ((kind)::text = 'contact'::text);


--
-- Name: uniq_contribution_exclusion_domain; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_contribution_exclusion_domain ON public.contribution_exclusion USING btree (workspace_id, domain) WHERE ((kind)::text = 'domain'::text);


--
-- Name: uniq_credit_ledger_tenant_idem; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_credit_ledger_tenant_idem ON public.credit_ledger USING btree (tenant_id, idempotency_key);


--
-- Name: uniq_crm_connections_ws_provider_account; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_crm_connections_ws_provider_account ON public.crm_connections USING btree (workspace_id, provider, external_account_id) WHERE (external_account_id IS NOT NULL);


--
-- Name: uniq_crm_field_mappings; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_crm_field_mappings ON public.crm_field_mappings USING btree (connection_id, object_type, tp_field, crm_field);


--
-- Name: uniq_crm_inbound_events_provider_event; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_crm_inbound_events_provider_event ON public.crm_inbound_events USING btree (connection_id, provider_event_id);


--
-- Name: uniq_crm_oauth_states_state; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_crm_oauth_states_state ON public.crm_oauth_states USING btree (state);


--
-- Name: uniq_crm_record_links_account; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_crm_record_links_account ON public.crm_record_links USING btree (connection_id, account_id) WHERE (account_id IS NOT NULL);


--
-- Name: uniq_crm_record_links_contact; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_crm_record_links_contact ON public.crm_record_links USING btree (connection_id, contact_id) WHERE (contact_id IS NOT NULL);


--
-- Name: uniq_crm_record_links_crm; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_crm_record_links_crm ON public.crm_record_links USING btree (connection_id, crm_object_type, crm_record_id);


--
-- Name: uniq_crm_sync_state_stream; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_crm_sync_state_stream ON public.crm_sync_state USING btree (connection_id, object_type, direction);


--
-- Name: uniq_custom_field_defs_ws_entity_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_custom_field_defs_ws_entity_key ON public.custom_field_definitions USING btree (workspace_id, entity, key);


--
-- Name: uniq_device_user_fp; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_device_user_fp ON public.trusted_devices USING btree (user_id, fingerprint_hash);


--
-- Name: uniq_email_event_provider_event_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_email_event_provider_event_id ON public.email_event USING btree (provider_event_id) WHERE (provider_event_id IS NOT NULL);


--
-- Name: uniq_email_message_provider; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_email_message_provider ON public.email_message USING btree (mailbox_integration_id, provider_message_id) WHERE (provider_message_id IS NOT NULL);


--
-- Name: uniq_email_template_version; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_email_template_version ON public.email_template_version USING btree (template_id, version);


--
-- Name: uniq_email_template_ws_name; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_email_template_ws_name ON public.email_template USING btree (workspace_id, name);


--
-- Name: uniq_email_thread_provider; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_email_thread_provider ON public.email_thread USING btree (mailbox_integration_id, provider_thread_id) WHERE (provider_thread_id IS NOT NULL);


--
-- Name: uniq_employment_primary; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_employment_primary ON public.master_employment USING btree (master_person_id) WHERE is_primary;


--
-- Name: uniq_employment_stint; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_employment_stint ON public.master_employment USING btree (master_person_id, master_company_id, started_on);


--
-- Name: uniq_enrichment_job_chunks_job_chunk; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_enrichment_job_chunks_job_chunk ON public.enrichment_job_chunks USING btree (job_id, chunk_index);


--
-- Name: uniq_enrichment_jobs_ws_idempotency; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_enrichment_jobs_ws_idempotency ON public.enrichment_jobs USING btree (workspace_id, idempotency_key) WHERE (idempotency_key IS NOT NULL);


--
-- Name: uniq_enrichment_policy_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_enrichment_policy_workspace ON public.enrichment_policy USING btree (workspace_id);


--
-- Name: uniq_idempotency_tenant_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_idempotency_tenant_key ON public.idempotency_keys USING btree (tenant_id, key);


--
-- Name: uniq_import_job_chunks_job_chunk; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_import_job_chunks_job_chunk ON public.import_job_chunks USING btree (job_id, chunk_index);


--
-- Name: uniq_import_jobs_ws_idempotency; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_import_jobs_ws_idempotency ON public.import_jobs USING btree (workspace_id, idempotency_key) WHERE (idempotency_key IS NOT NULL);


--
-- Name: uniq_import_mapping_templates_ws_lower_name; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_import_mapping_templates_ws_lower_name ON public.import_mapping_templates USING btree (workspace_id, lower((name)::text));


--
-- Name: uniq_import_policy_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_import_policy_workspace ON public.import_policy USING btree (workspace_id);


--
-- Name: uniq_list_members_list_contact; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_list_members_list_contact ON public.list_members USING btree (list_id, contact_id);


--
-- Name: uniq_lists_ws_name; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_lists_ws_name ON public.lists USING btree (workspace_id, name) WHERE (deleted_at IS NULL);


--
-- Name: uniq_mailbox_integration_ws_address; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_mailbox_integration_ws_address ON public.mailbox_integration USING btree (workspace_id, address);


--
-- Name: uniq_master_companies_linkedin; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_master_companies_linkedin ON public.master_companies USING btree (linkedin_company_id) WHERE (linkedin_company_id IS NOT NULL);


--
-- Name: uniq_master_companies_primary_domain; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_master_companies_primary_domain ON public.master_companies USING btree (primary_domain) WHERE (primary_domain IS NOT NULL);


--
-- Name: uniq_master_emails_blind_index; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_master_emails_blind_index ON public.master_emails USING btree (email_blind_index);


--
-- Name: uniq_master_persons_linkedin; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_master_persons_linkedin ON public.master_persons USING btree (linkedin_public_id) WHERE (linkedin_public_id IS NOT NULL);


--
-- Name: uniq_master_phones_blind_index; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_master_phones_blind_index ON public.master_phones USING btree (phone_blind_index);


--
-- Name: uniq_member_ws_user; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_member_ws_user ON public.workspace_members USING btree (workspace_id, user_id);


--
-- Name: uniq_oauth_connect_state_token; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_oauth_connect_state_token ON public.oauth_connect_state USING btree (state_token);


--
-- Name: uniq_outreach_log_seq_contact; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_outreach_log_seq_contact ON public.outreach_log USING btree (sequence_id, contact_id);


--
-- Name: uniq_outreach_sequences_ws_name; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_outreach_sequences_ws_name ON public.outreach_sequences USING btree (workspace_id, name);


--
-- Name: uniq_outreach_steps_seq_order; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_outreach_steps_seq_order ON public.outreach_steps USING btree (sequence_id, step_order);


--
-- Name: uniq_pipeline_stages_ws_name; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_pipeline_stages_ws_name ON public.pipeline_stages USING btree (workspace_id, name) WHERE (archived = false);


--
-- Name: uniq_platform_staff_user; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_platform_staff_user ON public.platform_staff USING btree (user_id);


--
-- Name: uniq_provider_calls_ws_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_provider_calls_ws_hash ON public.provider_calls USING btree (workspace_id, request_hash);


--
-- Name: uniq_record_tags_tag_record; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_record_tags_tag_record ON public.record_tags USING btree (tag_id, entity, record_id);


--
-- Name: uniq_reveal_job_rows_job_contact; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_reveal_job_rows_job_contact ON public.reveal_job_rows USING btree (job_id, contact_id);


--
-- Name: uniq_reveal_jobs_ws_idempotency; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_reveal_jobs_ws_idempotency ON public.reveal_jobs USING btree (workspace_id, idempotency_key) WHERE (idempotency_key IS NOT NULL);


--
-- Name: uniq_sales_nav_links_ws_lead_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_sales_nav_links_ws_lead_id ON public.sales_nav_links USING btree (workspace_id, sales_nav_lead_id) WHERE (sales_nav_lead_id IS NOT NULL);


--
-- Name: uniq_sales_nav_links_ws_url; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_sales_nav_links_ws_url ON public.sales_nav_links USING btree (workspace_id, url);


--
-- Name: uniq_scheduled_imports_ws_lower_name; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_scheduled_imports_ws_lower_name ON public.scheduled_imports USING btree (workspace_id, lower((name)::text));


--
-- Name: uniq_sending_domain_domain; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_sending_domain_domain ON public.sending_domain USING btree (domain);


--
-- Name: uniq_source_imports_ws_content; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_source_imports_ws_content ON public.source_imports USING btree (workspace_id, content_hash) WHERE (content_hash IS NOT NULL);


--
-- Name: uniq_source_records_content_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_source_records_content_hash ON public.source_records USING btree (content_hash);


--
-- Name: uniq_subscriptions_tenant_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_subscriptions_tenant_active ON public.subscriptions USING btree (tenant_id) WHERE ((status)::text = ANY ((ARRAY['trialing'::character varying, 'active'::character varying, 'past_due'::character varying, 'paused'::character varying])::text[]));


--
-- Name: uniq_tags_ws_name; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_tags_ws_name ON public.tags USING btree (workspace_id, lower((name)::text));


--
-- Name: uniq_team_members_team_user; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_team_members_team_user ON public.team_members USING btree (team_id, user_id);


--
-- Name: uniq_teams_ws_name; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_teams_ws_name ON public.teams USING btree (workspace_id, name);


--
-- Name: uniq_tenant_member; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_tenant_member ON public.tenant_members USING btree (tenant_id, user_id);


--
-- Name: uniq_user_sessions_refresh_token_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_user_sessions_refresh_token_hash ON public.user_sessions USING btree (refresh_token_hash) WHERE (revoked_at IS NULL);


--
-- Name: uniq_workspaces_tenant_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_workspaces_tenant_slug ON public.workspaces USING btree (tenant_id, slug);


--
-- Name: usage_event_2026_08_action_subject_fingerprint_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX usage_event_2026_08_action_subject_fingerprint_idx ON public.usage_event_2026_08 USING btree (action, subject_fingerprint) WHERE ((action)::text = 'reveal_miss'::text);


--
-- Name: usage_event_2026_08_tenant_id_entitlement_key_occurred_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX usage_event_2026_08_tenant_id_entitlement_key_occurred_at_idx ON public.usage_event_2026_08 USING btree (tenant_id, entitlement_key, occurred_at);


--
-- Name: usage_event_2026_08_workspace_id_occurred_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX usage_event_2026_08_workspace_id_occurred_at_idx ON public.usage_event_2026_08 USING btree (workspace_id, occurred_at DESC);


--
-- Name: usage_event_2026_09_action_subject_fingerprint_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX usage_event_2026_09_action_subject_fingerprint_idx ON public.usage_event_2026_09 USING btree (action, subject_fingerprint) WHERE ((action)::text = 'reveal_miss'::text);


--
-- Name: usage_event_2026_09_tenant_id_entitlement_key_occurred_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX usage_event_2026_09_tenant_id_entitlement_key_occurred_at_idx ON public.usage_event_2026_09 USING btree (tenant_id, entitlement_key, occurred_at);


--
-- Name: usage_event_2026_09_workspace_id_occurred_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX usage_event_2026_09_workspace_id_occurred_at_idx ON public.usage_event_2026_09 USING btree (workspace_id, occurred_at DESC);


--
-- Name: usage_event_2026_10_action_subject_fingerprint_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX usage_event_2026_10_action_subject_fingerprint_idx ON public.usage_event_2026_10 USING btree (action, subject_fingerprint) WHERE ((action)::text = 'reveal_miss'::text);


--
-- Name: usage_event_2026_10_tenant_id_entitlement_key_occurred_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX usage_event_2026_10_tenant_id_entitlement_key_occurred_at_idx ON public.usage_event_2026_10 USING btree (tenant_id, entitlement_key, occurred_at);


--
-- Name: usage_event_2026_10_workspace_id_occurred_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX usage_event_2026_10_workspace_id_occurred_at_idx ON public.usage_event_2026_10 USING btree (workspace_id, occurred_at DESC);


--
-- Name: usage_event_2026_11_action_subject_fingerprint_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX usage_event_2026_11_action_subject_fingerprint_idx ON public.usage_event_2026_11 USING btree (action, subject_fingerprint) WHERE ((action)::text = 'reveal_miss'::text);


--
-- Name: usage_event_2026_11_tenant_id_entitlement_key_occurred_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX usage_event_2026_11_tenant_id_entitlement_key_occurred_at_idx ON public.usage_event_2026_11 USING btree (tenant_id, entitlement_key, occurred_at);


--
-- Name: usage_event_2026_11_workspace_id_occurred_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX usage_event_2026_11_workspace_id_occurred_at_idx ON public.usage_event_2026_11 USING btree (workspace_id, occurred_at DESC);


--
-- Name: usage_event_default_action_subject_fingerprint_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX usage_event_default_action_subject_fingerprint_idx ON public.usage_event_default USING btree (action, subject_fingerprint) WHERE ((action)::text = 'reveal_miss'::text);


--
-- Name: usage_event_default_tenant_id_entitlement_key_occurred_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX usage_event_default_tenant_id_entitlement_key_occurred_at_idx ON public.usage_event_default USING btree (tenant_id, entitlement_key, occurred_at);


--
-- Name: usage_event_default_workspace_id_occurred_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX usage_event_default_workspace_id_occurred_at_idx ON public.usage_event_default USING btree (workspace_id, occurred_at DESC);


--
-- Name: activities_2026_08_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.activities_pkey1 ATTACH PARTITION public.activities_2026_08_pkey;


--
-- Name: activities_2026_08_workspace_id_contact_id_occurred_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_activities_ws_contact_occurred ATTACH PARTITION public.activities_2026_08_workspace_id_contact_id_occurred_at_idx;


--
-- Name: activities_2026_08_workspace_id_occurred_at_activity_type_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_activities_ws_occurred_type ATTACH PARTITION public.activities_2026_08_workspace_id_occurred_at_activity_type_idx;


--
-- Name: activities_2026_09_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.activities_pkey1 ATTACH PARTITION public.activities_2026_09_pkey;


--
-- Name: activities_2026_09_workspace_id_contact_id_occurred_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_activities_ws_contact_occurred ATTACH PARTITION public.activities_2026_09_workspace_id_contact_id_occurred_at_idx;


--
-- Name: activities_2026_09_workspace_id_occurred_at_activity_type_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_activities_ws_occurred_type ATTACH PARTITION public.activities_2026_09_workspace_id_occurred_at_activity_type_idx;


--
-- Name: activities_2026_10_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.activities_pkey1 ATTACH PARTITION public.activities_2026_10_pkey;


--
-- Name: activities_2026_10_workspace_id_contact_id_occurred_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_activities_ws_contact_occurred ATTACH PARTITION public.activities_2026_10_workspace_id_contact_id_occurred_at_idx;


--
-- Name: activities_2026_10_workspace_id_occurred_at_activity_type_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_activities_ws_occurred_type ATTACH PARTITION public.activities_2026_10_workspace_id_occurred_at_activity_type_idx;


--
-- Name: activities_2026_11_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.activities_pkey1 ATTACH PARTITION public.activities_2026_11_pkey;


--
-- Name: activities_2026_11_workspace_id_contact_id_occurred_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_activities_ws_contact_occurred ATTACH PARTITION public.activities_2026_11_workspace_id_contact_id_occurred_at_idx;


--
-- Name: activities_2026_11_workspace_id_occurred_at_activity_type_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_activities_ws_occurred_type ATTACH PARTITION public.activities_2026_11_workspace_id_occurred_at_activity_type_idx;


--
-- Name: activities_default_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.activities_pkey1 ATTACH PARTITION public.activities_default_pkey;


--
-- Name: activities_default_workspace_id_contact_id_occurred_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_activities_ws_contact_occurred ATTACH PARTITION public.activities_default_workspace_id_contact_id_occurred_at_idx;


--
-- Name: activities_default_workspace_id_occurred_at_activity_type_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_activities_ws_occurred_type ATTACH PARTITION public.activities_default_workspace_id_occurred_at_activity_type_idx;


--
-- Name: platform_audit_log_2026_08_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.platform_audit_log_pkey ATTACH PARTITION public.platform_audit_log_2026_08_pkey;


--
-- Name: platform_audit_log_2026_08_tenant_id_occurred_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_platform_audit_tenant_time ATTACH PARTITION public.platform_audit_log_2026_08_tenant_id_occurred_at_idx;


--
-- Name: platform_audit_log_2026_09_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.platform_audit_log_pkey ATTACH PARTITION public.platform_audit_log_2026_09_pkey;


--
-- Name: platform_audit_log_2026_09_tenant_id_occurred_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_platform_audit_tenant_time ATTACH PARTITION public.platform_audit_log_2026_09_tenant_id_occurred_at_idx;


--
-- Name: platform_audit_log_2026_10_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.platform_audit_log_pkey ATTACH PARTITION public.platform_audit_log_2026_10_pkey;


--
-- Name: platform_audit_log_2026_10_tenant_id_occurred_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_platform_audit_tenant_time ATTACH PARTITION public.platform_audit_log_2026_10_tenant_id_occurred_at_idx;


--
-- Name: platform_audit_log_2026_11_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.platform_audit_log_pkey ATTACH PARTITION public.platform_audit_log_2026_11_pkey;


--
-- Name: platform_audit_log_2026_11_tenant_id_occurred_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_platform_audit_tenant_time ATTACH PARTITION public.platform_audit_log_2026_11_tenant_id_occurred_at_idx;


--
-- Name: platform_audit_log_default_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.platform_audit_log_pkey ATTACH PARTITION public.platform_audit_log_default_pkey;


--
-- Name: platform_audit_log_default_tenant_id_occurred_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_platform_audit_tenant_time ATTACH PARTITION public.platform_audit_log_default_tenant_id_occurred_at_idx;


--
-- Name: provenance_event_2026_08_entity_type_entity_id_field_record_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_prov_event_entity ATTACH PARTITION public.provenance_event_2026_08_entity_type_entity_id_field_record_idx;


--
-- Name: provenance_event_2026_08_entity_type_entity_id_observed_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_prov_event_badge ATTACH PARTITION public.provenance_event_2026_08_entity_type_entity_id_observed_at_idx;


--
-- Name: provenance_event_2026_08_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.provenance_event_pkey ATTACH PARTITION public.provenance_event_2026_08_pkey;


--
-- Name: provenance_event_2026_08_source_record_id_entity_type_entit_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_prov_event_source_record ATTACH PARTITION public.provenance_event_2026_08_source_record_id_entity_type_entit_idx;


--
-- Name: provenance_event_2026_09_entity_type_entity_id_field_record_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_prov_event_entity ATTACH PARTITION public.provenance_event_2026_09_entity_type_entity_id_field_record_idx;


--
-- Name: provenance_event_2026_09_entity_type_entity_id_observed_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_prov_event_badge ATTACH PARTITION public.provenance_event_2026_09_entity_type_entity_id_observed_at_idx;


--
-- Name: provenance_event_2026_09_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.provenance_event_pkey ATTACH PARTITION public.provenance_event_2026_09_pkey;


--
-- Name: provenance_event_2026_09_source_record_id_entity_type_entit_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_prov_event_source_record ATTACH PARTITION public.provenance_event_2026_09_source_record_id_entity_type_entit_idx;


--
-- Name: provenance_event_2026_10_entity_type_entity_id_field_record_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_prov_event_entity ATTACH PARTITION public.provenance_event_2026_10_entity_type_entity_id_field_record_idx;


--
-- Name: provenance_event_2026_10_entity_type_entity_id_observed_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_prov_event_badge ATTACH PARTITION public.provenance_event_2026_10_entity_type_entity_id_observed_at_idx;


--
-- Name: provenance_event_2026_10_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.provenance_event_pkey ATTACH PARTITION public.provenance_event_2026_10_pkey;


--
-- Name: provenance_event_2026_10_source_record_id_entity_type_entit_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_prov_event_source_record ATTACH PARTITION public.provenance_event_2026_10_source_record_id_entity_type_entit_idx;


--
-- Name: provenance_event_2026_11_entity_type_entity_id_field_record_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_prov_event_entity ATTACH PARTITION public.provenance_event_2026_11_entity_type_entity_id_field_record_idx;


--
-- Name: provenance_event_2026_11_entity_type_entity_id_observed_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_prov_event_badge ATTACH PARTITION public.provenance_event_2026_11_entity_type_entity_id_observed_at_idx;


--
-- Name: provenance_event_2026_11_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.provenance_event_pkey ATTACH PARTITION public.provenance_event_2026_11_pkey;


--
-- Name: provenance_event_2026_11_source_record_id_entity_type_entit_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_prov_event_source_record ATTACH PARTITION public.provenance_event_2026_11_source_record_id_entity_type_entit_idx;


--
-- Name: provenance_event_default_entity_type_entity_id_field_record_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_prov_event_entity ATTACH PARTITION public.provenance_event_default_entity_type_entity_id_field_record_idx;


--
-- Name: provenance_event_default_entity_type_entity_id_observed_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_prov_event_badge ATTACH PARTITION public.provenance_event_default_entity_type_entity_id_observed_at_idx;


--
-- Name: provenance_event_default_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.provenance_event_pkey ATTACH PARTITION public.provenance_event_default_pkey;


--
-- Name: provenance_event_default_source_record_id_entity_type_entit_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_prov_event_source_record ATTACH PARTITION public.provenance_event_default_source_record_id_entity_type_entit_idx;


--
-- Name: usage_event_2026_08_action_subject_fingerprint_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_usage_event_wanted ATTACH PARTITION public.usage_event_2026_08_action_subject_fingerprint_idx;


--
-- Name: usage_event_2026_08_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.usage_event_pkey ATTACH PARTITION public.usage_event_2026_08_pkey;


--
-- Name: usage_event_2026_08_tenant_id_entitlement_key_occurred_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_usage_event_cap ATTACH PARTITION public.usage_event_2026_08_tenant_id_entitlement_key_occurred_at_idx;


--
-- Name: usage_event_2026_08_workspace_id_occurred_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_usage_event_ws ATTACH PARTITION public.usage_event_2026_08_workspace_id_occurred_at_idx;


--
-- Name: usage_event_2026_09_action_subject_fingerprint_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_usage_event_wanted ATTACH PARTITION public.usage_event_2026_09_action_subject_fingerprint_idx;


--
-- Name: usage_event_2026_09_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.usage_event_pkey ATTACH PARTITION public.usage_event_2026_09_pkey;


--
-- Name: usage_event_2026_09_tenant_id_entitlement_key_occurred_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_usage_event_cap ATTACH PARTITION public.usage_event_2026_09_tenant_id_entitlement_key_occurred_at_idx;


--
-- Name: usage_event_2026_09_workspace_id_occurred_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_usage_event_ws ATTACH PARTITION public.usage_event_2026_09_workspace_id_occurred_at_idx;


--
-- Name: usage_event_2026_10_action_subject_fingerprint_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_usage_event_wanted ATTACH PARTITION public.usage_event_2026_10_action_subject_fingerprint_idx;


--
-- Name: usage_event_2026_10_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.usage_event_pkey ATTACH PARTITION public.usage_event_2026_10_pkey;


--
-- Name: usage_event_2026_10_tenant_id_entitlement_key_occurred_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_usage_event_cap ATTACH PARTITION public.usage_event_2026_10_tenant_id_entitlement_key_occurred_at_idx;


--
-- Name: usage_event_2026_10_workspace_id_occurred_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_usage_event_ws ATTACH PARTITION public.usage_event_2026_10_workspace_id_occurred_at_idx;


--
-- Name: usage_event_2026_11_action_subject_fingerprint_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_usage_event_wanted ATTACH PARTITION public.usage_event_2026_11_action_subject_fingerprint_idx;


--
-- Name: usage_event_2026_11_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.usage_event_pkey ATTACH PARTITION public.usage_event_2026_11_pkey;


--
-- Name: usage_event_2026_11_tenant_id_entitlement_key_occurred_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_usage_event_cap ATTACH PARTITION public.usage_event_2026_11_tenant_id_entitlement_key_occurred_at_idx;


--
-- Name: usage_event_2026_11_workspace_id_occurred_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_usage_event_ws ATTACH PARTITION public.usage_event_2026_11_workspace_id_occurred_at_idx;


--
-- Name: usage_event_default_action_subject_fingerprint_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_usage_event_wanted ATTACH PARTITION public.usage_event_default_action_subject_fingerprint_idx;


--
-- Name: usage_event_default_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.usage_event_pkey ATTACH PARTITION public.usage_event_default_pkey;


--
-- Name: usage_event_default_tenant_id_entitlement_key_occurred_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_usage_event_cap ATTACH PARTITION public.usage_event_default_tenant_id_entitlement_key_occurred_at_idx;


--
-- Name: usage_event_default_workspace_id_occurred_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_usage_event_ws ATTACH PARTITION public.usage_event_default_workspace_id_occurred_at_idx;


--
-- Name: account_domains account_domains_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER account_domains_set_updated_at BEFORE UPDATE ON public.account_domains FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: account_locations account_locations_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER account_locations_set_updated_at BEFORE UPDATE ON public.account_locations FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: accounts accounts_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER accounts_set_updated_at BEFORE UPDATE ON public.accounts FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: activities activities_sync_last_activity; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER activities_sync_last_activity AFTER INSERT ON public.activities REFERENCING NEW TABLE AS new_activities FOR EACH STATEMENT EXECUTE FUNCTION public.sync_last_activity();


--
-- Name: audit_log audit_log_no_mutation; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER audit_log_no_mutation BEFORE DELETE OR UPDATE ON public.audit_log FOR EACH ROW EXECUTE FUNCTION public.audit_log_append_only();


--
-- Name: billing_cycles billing_cycles_no_regrant; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER billing_cycles_no_regrant BEFORE DELETE OR UPDATE ON public.billing_cycles FOR EACH ROW EXECUTE FUNCTION public.billing_cycles_grant_immutable();


--
-- Name: contact_emails contact_emails_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER contact_emails_set_updated_at BEFORE UPDATE ON public.contact_emails FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: contact_phones contact_phones_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER contact_phones_set_updated_at BEFORE UPDATE ON public.contact_phones FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: contact_reveals contact_reveals_set_ownership; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER contact_reveals_set_ownership AFTER INSERT ON public.contact_reveals FOR EACH ROW EXECUTE FUNCTION public.set_reveal_ownership();


--
-- Name: contacts contacts_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER contacts_set_updated_at BEFORE UPDATE ON public.contacts FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: credit_ledger credit_ledger_no_mutation; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER credit_ledger_no_mutation BEFORE DELETE OR UPDATE ON public.credit_ledger FOR EACH ROW EXECUTE FUNCTION public.credit_ledger_append_only();


--
-- Name: crm_connections crm_connections_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER crm_connections_set_updated_at BEFORE UPDATE ON public.crm_connections FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: crm_field_mappings crm_field_mappings_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER crm_field_mappings_set_updated_at BEFORE UPDATE ON public.crm_field_mappings FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: crm_record_links crm_record_links_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER crm_record_links_set_updated_at BEFORE UPDATE ON public.crm_record_links FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: crm_sync_state crm_sync_state_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER crm_sync_state_set_updated_at BEFORE UPDATE ON public.crm_sync_state FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: custom_field_definitions custom_field_definitions_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER custom_field_definitions_set_updated_at BEFORE UPDATE ON public.custom_field_definitions FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: email_template email_template_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER email_template_set_updated_at BEFORE UPDATE ON public.email_template FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: email_thread email_thread_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER email_thread_set_updated_at BEFORE UPDATE ON public.email_thread FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: enrichment_policy enrichment_policy_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER enrichment_policy_set_updated_at BEFORE UPDATE ON public.enrichment_policy FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: import_mapping_templates import_mapping_templates_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER import_mapping_templates_set_updated_at BEFORE UPDATE ON public.import_mapping_templates FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: import_policy import_policy_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER import_policy_set_updated_at BEFORE UPDATE ON public.import_policy FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: lists lists_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER lists_set_updated_at BEFORE UPDATE ON public.lists FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: mailbox_integration mailbox_integration_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER mailbox_integration_set_updated_at BEFORE UPDATE ON public.mailbox_integration FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: master_companies master_companies_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER master_companies_set_updated_at BEFORE UPDATE ON public.master_companies FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: master_employment master_employment_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER master_employment_set_updated_at BEFORE UPDATE ON public.master_employment FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: master_persons master_persons_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER master_persons_set_updated_at BEFORE UPDATE ON public.master_persons FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: outreach_sequences outreach_sequences_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER outreach_sequences_set_updated_at BEFORE UPDATE ON public.outreach_sequences FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: pipeline_stages pipeline_stages_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER pipeline_stages_set_updated_at BEFORE UPDATE ON public.pipeline_stages FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: platform_audit_log platform_audit_log_no_mutation; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER platform_audit_log_no_mutation BEFORE DELETE OR UPDATE ON public.platform_audit_log FOR EACH ROW EXECUTE FUNCTION public.platform_audit_log_append_only();


--
-- Name: provenance_event provenance_event_no_mutation; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER provenance_event_no_mutation BEFORE DELETE OR UPDATE ON public.provenance_event FOR EACH ROW EXECUTE FUNCTION public.provenance_event_append_only();


--
-- Name: saved_searches saved_searches_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER saved_searches_set_updated_at BEFORE UPDATE ON public.saved_searches FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: scheduled_imports scheduled_imports_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER scheduled_imports_set_updated_at BEFORE UPDATE ON public.scheduled_imports FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: scores scores_sync_priority; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER scores_sync_priority AFTER INSERT ON public.scores FOR EACH ROW EXECUTE FUNCTION public.sync_priority_score();


--
-- Name: sending_domain sending_domain_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sending_domain_set_updated_at BEFORE UPDATE ON public.sending_domain FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: tags tags_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tags_set_updated_at BEFORE UPDATE ON public.tags FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: teams teams_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER teams_set_updated_at BEFORE UPDATE ON public.teams FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: contributor_consent contributor_consent_contributor_id_fkey; Type: FK CONSTRAINT; Schema: forge; Owner: -
--

ALTER TABLE ONLY forge.contributor_consent
    ADD CONSTRAINT contributor_consent_contributor_id_fkey FOREIGN KEY (contributor_id) REFERENCES forge.contributor(id) ON DELETE CASCADE;


--
-- Name: extraction_candidates extraction_candidates_raw_capture_id_fkey; Type: FK CONSTRAINT; Schema: forge; Owner: -
--

ALTER TABLE ONLY forge.extraction_candidates
    ADD CONSTRAINT extraction_candidates_raw_capture_id_fkey FOREIGN KEY (raw_capture_id) REFERENCES forge.raw_captures(id) ON DELETE CASCADE;


--
-- Name: parsed_records parsed_records_parser_version_id_fkey; Type: FK CONSTRAINT; Schema: forge; Owner: -
--

ALTER TABLE ONLY forge.parsed_records
    ADD CONSTRAINT parsed_records_parser_version_id_fkey FOREIGN KEY (parser_version_id) REFERENCES forge.parser_versions(id);


--
-- Name: parsed_records parsed_records_raw_capture_id_fkey; Type: FK CONSTRAINT; Schema: forge; Owner: -
--

ALTER TABLE ONLY forge.parsed_records
    ADD CONSTRAINT parsed_records_raw_capture_id_fkey FOREIGN KEY (raw_capture_id) REFERENCES forge.raw_captures(id) ON DELETE CASCADE;


--
-- Name: parser_versions parser_versions_parser_id_fkey; Type: FK CONSTRAINT; Schema: forge; Owner: -
--

ALTER TABLE ONLY forge.parser_versions
    ADD CONSTRAINT parser_versions_parser_id_fkey FOREIGN KEY (parser_id) REFERENCES forge.parsers(id) ON DELETE CASCADE;


--
-- Name: quarantine quarantine_raw_capture_id_fkey; Type: FK CONSTRAINT; Schema: forge; Owner: -
--

ALTER TABLE ONLY forge.quarantine
    ADD CONSTRAINT quarantine_raw_capture_id_fkey FOREIGN KEY (raw_capture_id) REFERENCES forge.raw_captures(id) ON DELETE CASCADE;


--
-- Name: verified_record_events verified_record_events_verified_id_fkey; Type: FK CONSTRAINT; Schema: forge; Owner: -
--

ALTER TABLE ONLY forge.verified_record_events
    ADD CONSTRAINT verified_record_events_verified_id_fkey FOREIGN KEY (verified_id) REFERENCES forge.verified_records(id) ON DELETE CASCADE;


--
-- Name: account_domains account_domains_account_id_accounts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_domains
    ADD CONSTRAINT account_domains_account_id_accounts_id_fk FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: account_domains account_domains_source_import_id_source_imports_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_domains
    ADD CONSTRAINT account_domains_source_import_id_source_imports_id_fk FOREIGN KEY (source_import_id) REFERENCES public.source_imports(id) ON DELETE SET NULL;


--
-- Name: account_domains account_domains_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_domains
    ADD CONSTRAINT account_domains_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: account_domains account_domains_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_domains
    ADD CONSTRAINT account_domains_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: account_locations account_locations_account_id_accounts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_locations
    ADD CONSTRAINT account_locations_account_id_accounts_id_fk FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: account_locations account_locations_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_locations
    ADD CONSTRAINT account_locations_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: account_locations account_locations_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_locations
    ADD CONSTRAINT account_locations_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: accounts accounts_master_company_id_master_companies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_master_company_id_master_companies_id_fk FOREIGN KEY (master_company_id) REFERENCES public.master_companies(id);


--
-- Name: accounts accounts_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: accounts accounts_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: accounts accounts_ws_parent_account_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_ws_parent_account_fk FOREIGN KEY (workspace_id, parent_account_id) REFERENCES public.accounts(workspace_id, id) ON DELETE SET NULL (parent_account_id);


--
-- Name: activities activities_actor_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.activities
    ADD CONSTRAINT activities_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES public.users(id);


--
-- Name: activities activities_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.activities
    ADD CONSTRAINT activities_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE CASCADE;


--
-- Name: activities activities_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.activities
    ADD CONSTRAINT activities_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: activities activities_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.activities
    ADD CONSTRAINT activities_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: ai_requests ai_requests_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_requests
    ADD CONSTRAINT ai_requests_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: ai_requests ai_requests_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_requests
    ADD CONSTRAINT ai_requests_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: ai_requests ai_requests_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_requests
    ADD CONSTRAINT ai_requests_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: audit_log audit_log_actor_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_actor_user_id_users_id_fk FOREIGN KEY (actor_user_id) REFERENCES public.users(id);


--
-- Name: audit_log audit_log_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: audit_log audit_log_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE SET NULL;


--
-- Name: auth_allowed_origins auth_allowed_origins_created_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_allowed_origins
    ADD CONSTRAINT auth_allowed_origins_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: auth_allowed_origins auth_allowed_origins_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_allowed_origins
    ADD CONSTRAINT auth_allowed_origins_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: auth_email_tokens auth_email_tokens_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_email_tokens
    ADD CONSTRAINT auth_email_tokens_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: auth_policies auth_policies_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_policies
    ADD CONSTRAINT auth_policies_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: auth_policies auth_policies_updated_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_policies
    ADD CONSTRAINT auth_policies_updated_by_users_id_fk FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: auth_policies auth_policies_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_policies
    ADD CONSTRAINT auth_policies_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: billing_cycles billing_cycles_grant_ledger_id_credit_ledger_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_cycles
    ADD CONSTRAINT billing_cycles_grant_ledger_id_credit_ledger_id_fk FOREIGN KEY (grant_ledger_id) REFERENCES public.credit_ledger(id) ON DELETE SET NULL;


--
-- Name: billing_cycles billing_cycles_subscription_id_subscriptions_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_cycles
    ADD CONSTRAINT billing_cycles_subscription_id_subscriptions_id_fk FOREIGN KEY (subscription_id) REFERENCES public.subscriptions(id) ON DELETE CASCADE;


--
-- Name: billing_cycles billing_cycles_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_cycles
    ADD CONSTRAINT billing_cycles_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: consent_records consent_records_contact_id_contacts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.consent_records
    ADD CONSTRAINT consent_records_contact_id_contacts_id_fk FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE CASCADE;


--
-- Name: consent_records consent_records_recorded_by_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.consent_records
    ADD CONSTRAINT consent_records_recorded_by_user_id_users_id_fk FOREIGN KEY (recorded_by_user_id) REFERENCES public.users(id);


--
-- Name: consent_records consent_records_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.consent_records
    ADD CONSTRAINT consent_records_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: consent_records consent_records_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.consent_records
    ADD CONSTRAINT consent_records_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: contact_emails contact_emails_contact_id_contacts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_emails
    ADD CONSTRAINT contact_emails_contact_id_contacts_id_fk FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE CASCADE;


--
-- Name: contact_emails contact_emails_source_import_id_source_imports_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_emails
    ADD CONSTRAINT contact_emails_source_import_id_source_imports_id_fk FOREIGN KEY (source_import_id) REFERENCES public.source_imports(id) ON DELETE SET NULL;


--
-- Name: contact_emails contact_emails_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_emails
    ADD CONSTRAINT contact_emails_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: contact_emails contact_emails_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_emails
    ADD CONSTRAINT contact_emails_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: contact_phones contact_phones_contact_id_contacts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_phones
    ADD CONSTRAINT contact_phones_contact_id_contacts_id_fk FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE CASCADE;


--
-- Name: contact_phones contact_phones_source_import_id_source_imports_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_phones
    ADD CONSTRAINT contact_phones_source_import_id_source_imports_id_fk FOREIGN KEY (source_import_id) REFERENCES public.source_imports(id) ON DELETE SET NULL;


--
-- Name: contact_phones contact_phones_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_phones
    ADD CONSTRAINT contact_phones_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: contact_phones contact_phones_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_phones
    ADD CONSTRAINT contact_phones_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: contact_reveals contact_reveals_contact_id_contacts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_reveals
    ADD CONSTRAINT contact_reveals_contact_id_contacts_id_fk FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE CASCADE;


--
-- Name: contact_reveals contact_reveals_revealed_by_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_reveals
    ADD CONSTRAINT contact_reveals_revealed_by_user_id_users_id_fk FOREIGN KEY (revealed_by_user_id) REFERENCES public.users(id);


--
-- Name: contact_reveals contact_reveals_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_reveals
    ADD CONSTRAINT contact_reveals_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: contact_reveals contact_reveals_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_reveals
    ADD CONSTRAINT contact_reveals_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: contacts contacts_account_id_accounts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_account_id_accounts_id_fk FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE SET NULL;


--
-- Name: contacts contacts_duplicate_of_contact_id_contacts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_duplicate_of_contact_id_contacts_id_fk FOREIGN KEY (duplicate_of_contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL;


--
-- Name: contacts contacts_master_person_id_master_persons_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_master_person_id_master_persons_id_fk FOREIGN KEY (master_person_id) REFERENCES public.master_persons(id);


--
-- Name: contacts contacts_merged_into_contact_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_merged_into_contact_id_fk FOREIGN KEY (merged_into_contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL;


--
-- Name: contacts contacts_owner_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_owner_user_id_users_id_fk FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: contacts contacts_pipeline_stage_id_pipeline_stages_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_pipeline_stage_id_pipeline_stages_id_fk FOREIGN KEY (pipeline_stage_id) REFERENCES public.pipeline_stages(id) ON DELETE SET NULL;


--
-- Name: contacts contacts_revealed_by_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_revealed_by_user_id_users_id_fk FOREIGN KEY (revealed_by_user_id) REFERENCES public.users(id);


--
-- Name: contacts contacts_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: contacts contacts_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: contribution_exclusion contribution_exclusion_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contribution_exclusion
    ADD CONSTRAINT contribution_exclusion_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: contribution_exclusion contribution_exclusion_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contribution_exclusion
    ADD CONSTRAINT contribution_exclusion_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE CASCADE;


--
-- Name: contribution_exclusion contribution_exclusion_created_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contribution_exclusion
    ADD CONSTRAINT contribution_exclusion_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: contribution_exclusion contribution_exclusion_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contribution_exclusion
    ADD CONSTRAINT contribution_exclusion_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: contribution_exclusion contribution_exclusion_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contribution_exclusion
    ADD CONSTRAINT contribution_exclusion_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: contribution_policy contribution_policy_enabled_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contribution_policy
    ADD CONSTRAINT contribution_policy_enabled_by_user_id_fkey FOREIGN KEY (enabled_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: contribution_policy contribution_policy_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contribution_policy
    ADD CONSTRAINT contribution_policy_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: contribution_policy contribution_policy_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contribution_policy
    ADD CONSTRAINT contribution_policy_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: credit_ledger credit_ledger_actor_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_ledger
    ADD CONSTRAINT credit_ledger_actor_user_id_users_id_fk FOREIGN KEY (actor_user_id) REFERENCES public.users(id);


--
-- Name: credit_ledger credit_ledger_purchase_id_purchases_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_ledger
    ADD CONSTRAINT credit_ledger_purchase_id_purchases_id_fk FOREIGN KEY (purchase_id) REFERENCES public.purchases(id) ON DELETE SET NULL;


--
-- Name: credit_ledger credit_ledger_reveal_id_contact_reveals_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_ledger
    ADD CONSTRAINT credit_ledger_reveal_id_contact_reveals_id_fk FOREIGN KEY (reveal_id) REFERENCES public.contact_reveals(id) ON DELETE SET NULL;


--
-- Name: credit_ledger credit_ledger_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_ledger
    ADD CONSTRAINT credit_ledger_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: credit_ledger credit_ledger_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_ledger
    ADD CONSTRAINT credit_ledger_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE SET NULL;


--
-- Name: crm_connections crm_connections_owner_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_connections
    ADD CONSTRAINT crm_connections_owner_user_id_users_id_fk FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: crm_connections crm_connections_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_connections
    ADD CONSTRAINT crm_connections_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: crm_connections crm_connections_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_connections
    ADD CONSTRAINT crm_connections_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: crm_field_mappings crm_field_mappings_connection_id_crm_connections_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_field_mappings
    ADD CONSTRAINT crm_field_mappings_connection_id_crm_connections_id_fk FOREIGN KEY (connection_id) REFERENCES public.crm_connections(id) ON DELETE CASCADE;


--
-- Name: crm_field_mappings crm_field_mappings_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_field_mappings
    ADD CONSTRAINT crm_field_mappings_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: crm_field_mappings crm_field_mappings_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_field_mappings
    ADD CONSTRAINT crm_field_mappings_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: crm_inbound_events crm_inbound_events_connection_id_crm_connections_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_inbound_events
    ADD CONSTRAINT crm_inbound_events_connection_id_crm_connections_id_fk FOREIGN KEY (connection_id) REFERENCES public.crm_connections(id) ON DELETE CASCADE;


--
-- Name: crm_inbound_events crm_inbound_events_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_inbound_events
    ADD CONSTRAINT crm_inbound_events_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: crm_inbound_events crm_inbound_events_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_inbound_events
    ADD CONSTRAINT crm_inbound_events_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: crm_oauth_states crm_oauth_states_owner_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_oauth_states
    ADD CONSTRAINT crm_oauth_states_owner_user_id_users_id_fk FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: crm_oauth_states crm_oauth_states_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_oauth_states
    ADD CONSTRAINT crm_oauth_states_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: crm_oauth_states crm_oauth_states_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_oauth_states
    ADD CONSTRAINT crm_oauth_states_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: crm_object_contribution crm_object_contribution_connection_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_object_contribution
    ADD CONSTRAINT crm_object_contribution_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES public.crm_connections(id) ON DELETE CASCADE;


--
-- Name: crm_object_contribution crm_object_contribution_enabled_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_object_contribution
    ADD CONSTRAINT crm_object_contribution_enabled_by_user_id_fkey FOREIGN KEY (enabled_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: crm_object_contribution crm_object_contribution_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_object_contribution
    ADD CONSTRAINT crm_object_contribution_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: crm_object_contribution crm_object_contribution_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_object_contribution
    ADD CONSTRAINT crm_object_contribution_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: crm_record_links crm_record_links_account_id_accounts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_record_links
    ADD CONSTRAINT crm_record_links_account_id_accounts_id_fk FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: crm_record_links crm_record_links_connection_id_crm_connections_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_record_links
    ADD CONSTRAINT crm_record_links_connection_id_crm_connections_id_fk FOREIGN KEY (connection_id) REFERENCES public.crm_connections(id) ON DELETE CASCADE;


--
-- Name: crm_record_links crm_record_links_contact_id_contacts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_record_links
    ADD CONSTRAINT crm_record_links_contact_id_contacts_id_fk FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE CASCADE;


--
-- Name: crm_record_links crm_record_links_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_record_links
    ADD CONSTRAINT crm_record_links_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: crm_record_links crm_record_links_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_record_links
    ADD CONSTRAINT crm_record_links_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: crm_sync_conflicts crm_sync_conflicts_connection_id_crm_connections_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_sync_conflicts
    ADD CONSTRAINT crm_sync_conflicts_connection_id_crm_connections_id_fk FOREIGN KEY (connection_id) REFERENCES public.crm_connections(id) ON DELETE CASCADE;


--
-- Name: crm_sync_conflicts crm_sync_conflicts_record_link_id_crm_record_links_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_sync_conflicts
    ADD CONSTRAINT crm_sync_conflicts_record_link_id_crm_record_links_id_fk FOREIGN KEY (record_link_id) REFERENCES public.crm_record_links(id) ON DELETE SET NULL;


--
-- Name: crm_sync_conflicts crm_sync_conflicts_resolved_by_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_sync_conflicts
    ADD CONSTRAINT crm_sync_conflicts_resolved_by_user_id_users_id_fk FOREIGN KEY (resolved_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: crm_sync_conflicts crm_sync_conflicts_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_sync_conflicts
    ADD CONSTRAINT crm_sync_conflicts_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: crm_sync_conflicts crm_sync_conflicts_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_sync_conflicts
    ADD CONSTRAINT crm_sync_conflicts_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: crm_sync_dead_letter crm_sync_dead_letter_connection_id_crm_connections_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_sync_dead_letter
    ADD CONSTRAINT crm_sync_dead_letter_connection_id_crm_connections_id_fk FOREIGN KEY (connection_id) REFERENCES public.crm_connections(id) ON DELETE CASCADE;


--
-- Name: crm_sync_dead_letter crm_sync_dead_letter_run_id_crm_sync_runs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_sync_dead_letter
    ADD CONSTRAINT crm_sync_dead_letter_run_id_crm_sync_runs_id_fk FOREIGN KEY (run_id) REFERENCES public.crm_sync_runs(id) ON DELETE SET NULL;


--
-- Name: crm_sync_dead_letter crm_sync_dead_letter_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_sync_dead_letter
    ADD CONSTRAINT crm_sync_dead_letter_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: crm_sync_dead_letter crm_sync_dead_letter_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_sync_dead_letter
    ADD CONSTRAINT crm_sync_dead_letter_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: crm_sync_runs crm_sync_runs_connection_id_crm_connections_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_sync_runs
    ADD CONSTRAINT crm_sync_runs_connection_id_crm_connections_id_fk FOREIGN KEY (connection_id) REFERENCES public.crm_connections(id) ON DELETE CASCADE;


--
-- Name: crm_sync_runs crm_sync_runs_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_sync_runs
    ADD CONSTRAINT crm_sync_runs_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: crm_sync_runs crm_sync_runs_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_sync_runs
    ADD CONSTRAINT crm_sync_runs_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: crm_sync_state crm_sync_state_connection_id_crm_connections_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_sync_state
    ADD CONSTRAINT crm_sync_state_connection_id_crm_connections_id_fk FOREIGN KEY (connection_id) REFERENCES public.crm_connections(id) ON DELETE CASCADE;


--
-- Name: crm_sync_state crm_sync_state_last_run_id_crm_sync_runs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_sync_state
    ADD CONSTRAINT crm_sync_state_last_run_id_crm_sync_runs_id_fk FOREIGN KEY (last_run_id) REFERENCES public.crm_sync_runs(id) ON DELETE SET NULL;


--
-- Name: crm_sync_state crm_sync_state_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_sync_state
    ADD CONSTRAINT crm_sync_state_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: crm_sync_state crm_sync_state_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_sync_state
    ADD CONSTRAINT crm_sync_state_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: custom_field_definitions custom_field_definitions_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custom_field_definitions
    ADD CONSTRAINT custom_field_definitions_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: custom_field_definitions custom_field_definitions_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custom_field_definitions
    ADD CONSTRAINT custom_field_definitions_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: data_quality_snapshots data_quality_snapshots_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.data_quality_snapshots
    ADD CONSTRAINT data_quality_snapshots_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: data_quality_snapshots data_quality_snapshots_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.data_quality_snapshots
    ADD CONSTRAINT data_quality_snapshots_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: email_event email_event_contact_id_contacts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_event
    ADD CONSTRAINT email_event_contact_id_contacts_id_fk FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL;


--
-- Name: email_event email_event_outreach_log_id_outreach_log_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_event
    ADD CONSTRAINT email_event_outreach_log_id_outreach_log_id_fk FOREIGN KEY (outreach_log_id) REFERENCES public.outreach_log(id) ON DELETE SET NULL;


--
-- Name: email_event email_event_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_event
    ADD CONSTRAINT email_event_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: email_event email_event_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_event
    ADD CONSTRAINT email_event_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: email_message email_message_contact_id_contacts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_message
    ADD CONSTRAINT email_message_contact_id_contacts_id_fk FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL;


--
-- Name: email_message email_message_mailbox_integration_id_mailbox_integration_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_message
    ADD CONSTRAINT email_message_mailbox_integration_id_mailbox_integration_id_fk FOREIGN KEY (mailbox_integration_id) REFERENCES public.mailbox_integration(id) ON DELETE SET NULL;


--
-- Name: email_message email_message_outreach_log_id_outreach_log_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_message
    ADD CONSTRAINT email_message_outreach_log_id_outreach_log_id_fk FOREIGN KEY (outreach_log_id) REFERENCES public.outreach_log(id) ON DELETE SET NULL;


--
-- Name: email_message email_message_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_message
    ADD CONSTRAINT email_message_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: email_message email_message_thread_id_email_thread_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_message
    ADD CONSTRAINT email_message_thread_id_email_thread_id_fk FOREIGN KEY (thread_id) REFERENCES public.email_thread(id) ON DELETE CASCADE;


--
-- Name: email_message email_message_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_message
    ADD CONSTRAINT email_message_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: email_template email_template_owner_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_template
    ADD CONSTRAINT email_template_owner_user_id_users_id_fk FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: email_template email_template_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_template
    ADD CONSTRAINT email_template_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: email_template_version email_template_version_created_by_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_template_version
    ADD CONSTRAINT email_template_version_created_by_user_id_users_id_fk FOREIGN KEY (created_by_user_id) REFERENCES public.users(id);


--
-- Name: email_template_version email_template_version_template_id_email_template_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_template_version
    ADD CONSTRAINT email_template_version_template_id_email_template_id_fk FOREIGN KEY (template_id) REFERENCES public.email_template(id) ON DELETE CASCADE;


--
-- Name: email_template_version email_template_version_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_template_version
    ADD CONSTRAINT email_template_version_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: email_template_version email_template_version_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_template_version
    ADD CONSTRAINT email_template_version_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: email_template email_template_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_template
    ADD CONSTRAINT email_template_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: email_thread email_thread_assignee_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_thread
    ADD CONSTRAINT email_thread_assignee_user_id_users_id_fk FOREIGN KEY (assignee_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: email_thread email_thread_contact_id_contacts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_thread
    ADD CONSTRAINT email_thread_contact_id_contacts_id_fk FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL;


--
-- Name: email_thread email_thread_mailbox_integration_id_mailbox_integration_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_thread
    ADD CONSTRAINT email_thread_mailbox_integration_id_mailbox_integration_id_fk FOREIGN KEY (mailbox_integration_id) REFERENCES public.mailbox_integration(id) ON DELETE SET NULL;


--
-- Name: email_thread email_thread_owner_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_thread
    ADD CONSTRAINT email_thread_owner_user_id_users_id_fk FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: email_thread email_thread_sequence_id_outreach_sequences_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_thread
    ADD CONSTRAINT email_thread_sequence_id_outreach_sequences_id_fk FOREIGN KEY (sequence_id) REFERENCES public.outreach_sequences(id) ON DELETE SET NULL;


--
-- Name: email_thread email_thread_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_thread
    ADD CONSTRAINT email_thread_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: email_thread email_thread_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_thread
    ADD CONSTRAINT email_thread_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: enrichment_job_chunks enrichment_job_chunks_job_id_enrichment_jobs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enrichment_job_chunks
    ADD CONSTRAINT enrichment_job_chunks_job_id_enrichment_jobs_id_fk FOREIGN KEY (job_id) REFERENCES public.enrichment_jobs(id) ON DELETE CASCADE;


--
-- Name: enrichment_job_rows enrichment_job_rows_chunk_id_enrichment_job_chunks_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enrichment_job_rows
    ADD CONSTRAINT enrichment_job_rows_chunk_id_enrichment_job_chunks_id_fk FOREIGN KEY (chunk_id) REFERENCES public.enrichment_job_chunks(id) ON DELETE CASCADE;


--
-- Name: enrichment_job_rows enrichment_job_rows_job_id_enrichment_jobs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enrichment_job_rows
    ADD CONSTRAINT enrichment_job_rows_job_id_enrichment_jobs_id_fk FOREIGN KEY (job_id) REFERENCES public.enrichment_jobs(id) ON DELETE CASCADE;


--
-- Name: enrichment_job_rows enrichment_job_rows_matched_contact_id_contacts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enrichment_job_rows
    ADD CONSTRAINT enrichment_job_rows_matched_contact_id_contacts_id_fk FOREIGN KEY (matched_contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL;


--
-- Name: enrichment_job_rows enrichment_job_rows_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enrichment_job_rows
    ADD CONSTRAINT enrichment_job_rows_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: enrichment_jobs enrichment_jobs_created_by_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enrichment_jobs
    ADD CONSTRAINT enrichment_jobs_created_by_user_id_users_id_fk FOREIGN KEY (created_by_user_id) REFERENCES public.users(id);


--
-- Name: enrichment_jobs enrichment_jobs_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enrichment_jobs
    ADD CONSTRAINT enrichment_jobs_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: enrichment_jobs enrichment_jobs_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enrichment_jobs
    ADD CONSTRAINT enrichment_jobs_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: enrichment_policy enrichment_policy_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enrichment_policy
    ADD CONSTRAINT enrichment_policy_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: enrichment_policy enrichment_policy_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enrichment_policy
    ADD CONSTRAINT enrichment_policy_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: entitlement entitlement_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entitlement
    ADD CONSTRAINT entitlement_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: event_outbox event_outbox_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_outbox
    ADD CONSTRAINT event_outbox_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: event_outbox event_outbox_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_outbox
    ADD CONSTRAINT event_outbox_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: idempotency_keys idempotency_keys_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.idempotency_keys
    ADD CONSTRAINT idempotency_keys_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: import_job_chunks import_job_chunks_job_id_import_jobs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_job_chunks
    ADD CONSTRAINT import_job_chunks_job_id_import_jobs_id_fk FOREIGN KEY (job_id) REFERENCES public.import_jobs(id) ON DELETE CASCADE;


--
-- Name: import_job_rows import_job_rows_chunk_id_import_job_chunks_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_job_rows
    ADD CONSTRAINT import_job_rows_chunk_id_import_job_chunks_id_fk FOREIGN KEY (chunk_id) REFERENCES public.import_job_chunks(id) ON DELETE CASCADE;


--
-- Name: import_job_rows import_job_rows_job_id_import_jobs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_job_rows
    ADD CONSTRAINT import_job_rows_job_id_import_jobs_id_fk FOREIGN KEY (job_id) REFERENCES public.import_jobs(id) ON DELETE CASCADE;


--
-- Name: import_job_rows import_job_rows_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_job_rows
    ADD CONSTRAINT import_job_rows_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: import_jobs import_jobs_created_by_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_jobs
    ADD CONSTRAINT import_jobs_created_by_user_id_users_id_fk FOREIGN KEY (created_by_user_id) REFERENCES public.users(id);


--
-- Name: import_jobs import_jobs_mapping_template_id_import_mapping_templates_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_jobs
    ADD CONSTRAINT import_jobs_mapping_template_id_import_mapping_templates_id_fk FOREIGN KEY (mapping_template_id) REFERENCES public.import_mapping_templates(id) ON DELETE SET NULL;


--
-- Name: import_jobs import_jobs_parent_job_id_import_jobs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_jobs
    ADD CONSTRAINT import_jobs_parent_job_id_import_jobs_id_fk FOREIGN KEY (parent_job_id) REFERENCES public.import_jobs(id) ON DELETE SET NULL;


--
-- Name: import_jobs import_jobs_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_jobs
    ADD CONSTRAINT import_jobs_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: import_jobs import_jobs_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_jobs
    ADD CONSTRAINT import_jobs_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: import_mapping_templates import_mapping_templates_created_by_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_mapping_templates
    ADD CONSTRAINT import_mapping_templates_created_by_user_id_users_id_fk FOREIGN KEY (created_by_user_id) REFERENCES public.users(id);


--
-- Name: import_mapping_templates import_mapping_templates_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_mapping_templates
    ADD CONSTRAINT import_mapping_templates_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: import_mapping_templates import_mapping_templates_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_mapping_templates
    ADD CONSTRAINT import_mapping_templates_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: import_policy import_policy_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_policy
    ADD CONSTRAINT import_policy_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: import_policy import_policy_updated_by_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_policy
    ADD CONSTRAINT import_policy_updated_by_user_id_users_id_fk FOREIGN KEY (updated_by_user_id) REFERENCES public.users(id);


--
-- Name: import_policy import_policy_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_policy
    ADD CONSTRAINT import_policy_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: intent_signals intent_signals_contact_id_contacts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.intent_signals
    ADD CONSTRAINT intent_signals_contact_id_contacts_id_fk FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE CASCADE;


--
-- Name: intent_signals intent_signals_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.intent_signals
    ADD CONSTRAINT intent_signals_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: intent_signals intent_signals_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.intent_signals
    ADD CONSTRAINT intent_signals_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: invitations invitations_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invitations
    ADD CONSTRAINT invitations_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: invitations invitations_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invitations
    ADD CONSTRAINT invitations_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: list_members list_members_added_by_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.list_members
    ADD CONSTRAINT list_members_added_by_user_id_users_id_fk FOREIGN KEY (added_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: list_members list_members_contact_id_contacts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.list_members
    ADD CONSTRAINT list_members_contact_id_contacts_id_fk FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE CASCADE;


--
-- Name: list_members list_members_list_id_lists_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.list_members
    ADD CONSTRAINT list_members_list_id_lists_id_fk FOREIGN KEY (list_id) REFERENCES public.lists(id) ON DELETE CASCADE;


--
-- Name: list_members list_members_source_import_id_source_imports_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.list_members
    ADD CONSTRAINT list_members_source_import_id_source_imports_id_fk FOREIGN KEY (source_import_id) REFERENCES public.source_imports(id) ON DELETE SET NULL;


--
-- Name: list_members list_members_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.list_members
    ADD CONSTRAINT list_members_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: list_members list_members_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.list_members
    ADD CONSTRAINT list_members_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: lists lists_owner_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lists
    ADD CONSTRAINT lists_owner_user_id_users_id_fk FOREIGN KEY (owner_user_id) REFERENCES public.users(id);


--
-- Name: lists lists_saved_search_id_saved_searches_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lists
    ADD CONSTRAINT lists_saved_search_id_saved_searches_id_fk FOREIGN KEY (saved_search_id) REFERENCES public.saved_searches(id) ON DELETE SET NULL;


--
-- Name: lists lists_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lists
    ADD CONSTRAINT lists_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: lists lists_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lists
    ADD CONSTRAINT lists_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: mailbox_integration mailbox_integration_owner_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mailbox_integration
    ADD CONSTRAINT mailbox_integration_owner_user_id_users_id_fk FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: mailbox_integration mailbox_integration_sending_domain_id_sending_domain_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mailbox_integration
    ADD CONSTRAINT mailbox_integration_sending_domain_id_sending_domain_id_fk FOREIGN KEY (sending_domain_id) REFERENCES public.sending_domain(id) ON DELETE SET NULL;


--
-- Name: mailbox_integration mailbox_integration_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mailbox_integration
    ADD CONSTRAINT mailbox_integration_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: mailbox_integration mailbox_integration_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mailbox_integration
    ADD CONSTRAINT mailbox_integration_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: master_companies master_companies_parent_company_id_master_companies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.master_companies
    ADD CONSTRAINT master_companies_parent_company_id_master_companies_id_fk FOREIGN KEY (parent_company_id) REFERENCES public.master_companies(id);


--
-- Name: master_emails master_emails_master_person_id_master_persons_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.master_emails
    ADD CONSTRAINT master_emails_master_person_id_master_persons_id_fk FOREIGN KEY (master_person_id) REFERENCES public.master_persons(id) ON DELETE CASCADE;


--
-- Name: master_employment master_employment_master_company_id_master_companies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.master_employment
    ADD CONSTRAINT master_employment_master_company_id_master_companies_id_fk FOREIGN KEY (master_company_id) REFERENCES public.master_companies(id) ON DELETE CASCADE;


--
-- Name: master_employment master_employment_master_person_id_master_persons_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.master_employment
    ADD CONSTRAINT master_employment_master_person_id_master_persons_id_fk FOREIGN KEY (master_person_id) REFERENCES public.master_persons(id) ON DELETE CASCADE;


--
-- Name: master_persons master_persons_current_company_id_master_companies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.master_persons
    ADD CONSTRAINT master_persons_current_company_id_master_companies_id_fk FOREIGN KEY (current_company_id) REFERENCES public.master_companies(id);


--
-- Name: master_persons master_persons_merged_into_person_id_master_persons_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.master_persons
    ADD CONSTRAINT master_persons_merged_into_person_id_master_persons_id_fk FOREIGN KEY (merged_into_person_id) REFERENCES public.master_persons(id) ON DELETE SET NULL;


--
-- Name: master_phones master_phones_master_person_id_master_persons_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.master_phones
    ADD CONSTRAINT master_phones_master_person_id_master_persons_id_fk FOREIGN KEY (master_person_id) REFERENCES public.master_persons(id) ON DELETE CASCADE;


--
-- Name: match_links match_links_source_record_id_source_records_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.match_links
    ADD CONSTRAINT match_links_source_record_id_source_records_id_fk FOREIGN KEY (source_record_id) REFERENCES public.source_records(id) ON DELETE CASCADE;


--
-- Name: notifications notifications_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: notifications notifications_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: notifications notifications_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: oauth_connect_state oauth_connect_state_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_connect_state
    ADD CONSTRAINT oauth_connect_state_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: oauth_connect_state oauth_connect_state_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_connect_state
    ADD CONSTRAINT oauth_connect_state_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: oauth_connect_state oauth_connect_state_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_connect_state
    ADD CONSTRAINT oauth_connect_state_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: outreach_log outreach_log_contact_id_contacts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outreach_log
    ADD CONSTRAINT outreach_log_contact_id_contacts_id_fk FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE CASCADE;


--
-- Name: outreach_log outreach_log_sequence_id_outreach_sequences_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outreach_log
    ADD CONSTRAINT outreach_log_sequence_id_outreach_sequences_id_fk FOREIGN KEY (sequence_id) REFERENCES public.outreach_sequences(id) ON DELETE CASCADE;


--
-- Name: outreach_log outreach_log_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outreach_log
    ADD CONSTRAINT outreach_log_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: outreach_log outreach_log_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outreach_log
    ADD CONSTRAINT outreach_log_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: outreach_sequences outreach_sequences_created_by_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outreach_sequences
    ADD CONSTRAINT outreach_sequences_created_by_user_id_users_id_fk FOREIGN KEY (created_by_user_id) REFERENCES public.users(id);


--
-- Name: outreach_sequences outreach_sequences_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outreach_sequences
    ADD CONSTRAINT outreach_sequences_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: outreach_sequences outreach_sequences_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outreach_sequences
    ADD CONSTRAINT outreach_sequences_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: outreach_steps outreach_steps_sequence_id_outreach_sequences_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outreach_steps
    ADD CONSTRAINT outreach_steps_sequence_id_outreach_sequences_id_fk FOREIGN KEY (sequence_id) REFERENCES public.outreach_sequences(id) ON DELETE CASCADE;


--
-- Name: outreach_steps outreach_steps_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outreach_steps
    ADD CONSTRAINT outreach_steps_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: outreach_steps outreach_steps_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outreach_steps
    ADD CONSTRAINT outreach_steps_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: pipeline_stages pipeline_stages_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pipeline_stages
    ADD CONSTRAINT pipeline_stages_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: pipeline_stages pipeline_stages_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pipeline_stages
    ADD CONSTRAINT pipeline_stages_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: platform_staff platform_staff_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_staff
    ADD CONSTRAINT platform_staff_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: provenance_event provenance_event_source_record_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.provenance_event
    ADD CONSTRAINT provenance_event_source_record_id_fkey FOREIGN KEY (source_record_id) REFERENCES public.source_records(id) ON DELETE SET NULL;


--
-- Name: provider_calls provider_calls_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_calls
    ADD CONSTRAINT provider_calls_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: provider_calls provider_calls_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_calls
    ADD CONSTRAINT provider_calls_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: purchases purchases_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchases
    ADD CONSTRAINT purchases_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: record_tags record_tags_tag_id_tags_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.record_tags
    ADD CONSTRAINT record_tags_tag_id_tags_id_fk FOREIGN KEY (tag_id) REFERENCES public.tags(id) ON DELETE CASCADE;


--
-- Name: record_tags record_tags_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.record_tags
    ADD CONSTRAINT record_tags_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: record_tags record_tags_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.record_tags
    ADD CONSTRAINT record_tags_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: retention_runs retention_runs_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.retention_runs
    ADD CONSTRAINT retention_runs_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: reveal_job_rows reveal_job_rows_contact_id_contacts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reveal_job_rows
    ADD CONSTRAINT reveal_job_rows_contact_id_contacts_id_fk FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL;


--
-- Name: reveal_job_rows reveal_job_rows_job_id_reveal_jobs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reveal_job_rows
    ADD CONSTRAINT reveal_job_rows_job_id_reveal_jobs_id_fk FOREIGN KEY (job_id) REFERENCES public.reveal_jobs(id) ON DELETE CASCADE;


--
-- Name: reveal_job_rows reveal_job_rows_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reveal_job_rows
    ADD CONSTRAINT reveal_job_rows_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: reveal_jobs reveal_jobs_created_by_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reveal_jobs
    ADD CONSTRAINT reveal_jobs_created_by_user_id_users_id_fk FOREIGN KEY (created_by_user_id) REFERENCES public.users(id);


--
-- Name: reveal_jobs reveal_jobs_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reveal_jobs
    ADD CONSTRAINT reveal_jobs_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: reveal_jobs reveal_jobs_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reveal_jobs
    ADD CONSTRAINT reveal_jobs_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: sales_nav_links sales_nav_links_account_id_accounts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_nav_links
    ADD CONSTRAINT sales_nav_links_account_id_accounts_id_fk FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE SET NULL;


--
-- Name: sales_nav_links sales_nav_links_contact_id_contacts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_nav_links
    ADD CONSTRAINT sales_nav_links_contact_id_contacts_id_fk FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL;


--
-- Name: sales_nav_links sales_nav_links_created_by_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_nav_links
    ADD CONSTRAINT sales_nav_links_created_by_user_id_users_id_fk FOREIGN KEY (created_by_user_id) REFERENCES public.users(id);


--
-- Name: sales_nav_links sales_nav_links_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_nav_links
    ADD CONSTRAINT sales_nav_links_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: sales_nav_links sales_nav_links_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_nav_links
    ADD CONSTRAINT sales_nav_links_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: saved_searches saved_searches_owner_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.saved_searches
    ADD CONSTRAINT saved_searches_owner_user_id_users_id_fk FOREIGN KEY (owner_user_id) REFERENCES public.users(id);


--
-- Name: saved_searches saved_searches_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.saved_searches
    ADD CONSTRAINT saved_searches_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: saved_searches saved_searches_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.saved_searches
    ADD CONSTRAINT saved_searches_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: scheduled_imports scheduled_imports_created_by_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduled_imports
    ADD CONSTRAINT scheduled_imports_created_by_user_id_users_id_fk FOREIGN KEY (created_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: scheduled_imports scheduled_imports_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduled_imports
    ADD CONSTRAINT scheduled_imports_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: scheduled_imports scheduled_imports_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduled_imports
    ADD CONSTRAINT scheduled_imports_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: scim_tokens scim_tokens_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scim_tokens
    ADD CONSTRAINT scim_tokens_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: scores scores_contact_id_contacts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scores
    ADD CONSTRAINT scores_contact_id_contacts_id_fk FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE CASCADE;


--
-- Name: scores scores_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scores
    ADD CONSTRAINT scores_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: scores scores_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scores
    ADD CONSTRAINT scores_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: sending_domain sending_domain_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sending_domain
    ADD CONSTRAINT sending_domain_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: source_imports source_imports_contact_id_contacts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_imports
    ADD CONSTRAINT source_imports_contact_id_contacts_id_fk FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE CASCADE;


--
-- Name: source_imports source_imports_imported_by_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_imports
    ADD CONSTRAINT source_imports_imported_by_user_id_users_id_fk FOREIGN KEY (imported_by_user_id) REFERENCES public.users(id);


--
-- Name: source_imports source_imports_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_imports
    ADD CONSTRAINT source_imports_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: source_imports source_imports_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_imports
    ADD CONSTRAINT source_imports_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: source_records source_records_resolved_company_id_master_companies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_records
    ADD CONSTRAINT source_records_resolved_company_id_master_companies_id_fk FOREIGN KEY (resolved_company_id) REFERENCES public.master_companies(id);


--
-- Name: source_records source_records_resolved_person_id_master_persons_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_records
    ADD CONSTRAINT source_records_resolved_person_id_master_persons_id_fk FOREIGN KEY (resolved_person_id) REFERENCES public.master_persons(id);


--
-- Name: stripe_customers stripe_customers_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stripe_customers
    ADD CONSTRAINT stripe_customers_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: subscriptions subscriptions_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: suppression_list suppression_list_contact_id_contacts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.suppression_list
    ADD CONSTRAINT suppression_list_contact_id_contacts_id_fk FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE CASCADE;


--
-- Name: suppression_list suppression_list_created_by_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.suppression_list
    ADD CONSTRAINT suppression_list_created_by_user_id_users_id_fk FOREIGN KEY (created_by_user_id) REFERENCES public.users(id);


--
-- Name: suppression_list suppression_list_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.suppression_list
    ADD CONSTRAINT suppression_list_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: suppression_list suppression_list_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.suppression_list
    ADD CONSTRAINT suppression_list_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: tags tags_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tags
    ADD CONSTRAINT tags_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: tags tags_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tags
    ADD CONSTRAINT tags_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: team_members team_members_team_id_teams_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_members
    ADD CONSTRAINT team_members_team_id_teams_id_fk FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE CASCADE;


--
-- Name: team_members team_members_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_members
    ADD CONSTRAINT team_members_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: team_members team_members_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_members
    ADD CONSTRAINT team_members_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: team_members team_members_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_members
    ADD CONSTRAINT team_members_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: teams teams_created_by_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teams
    ADD CONSTRAINT teams_created_by_user_id_users_id_fk FOREIGN KEY (created_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: teams teams_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teams
    ADD CONSTRAINT teams_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: teams teams_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teams
    ADD CONSTRAINT teams_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: tenant_auth_policies tenant_auth_policies_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_auth_policies
    ADD CONSTRAINT tenant_auth_policies_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: tenant_domains tenant_domains_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_domains
    ADD CONSTRAINT tenant_domains_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: tenant_feature_flags tenant_feature_flags_flag_key_feature_flags_key_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_feature_flags
    ADD CONSTRAINT tenant_feature_flags_flag_key_feature_flags_key_fk FOREIGN KEY (flag_key) REFERENCES public.feature_flags(key) ON DELETE CASCADE;


--
-- Name: tenant_feature_flags tenant_feature_flags_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_feature_flags
    ADD CONSTRAINT tenant_feature_flags_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: tenant_members tenant_members_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_members
    ADD CONSTRAINT tenant_members_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: tenant_members tenant_members_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_members
    ADD CONSTRAINT tenant_members_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: tenant_sso_configs tenant_sso_configs_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_sso_configs
    ADD CONSTRAINT tenant_sso_configs_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: trusted_devices trusted_devices_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trusted_devices
    ADD CONSTRAINT trusted_devices_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: usage_event usage_event_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.usage_event
    ADD CONSTRAINT usage_event_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: usage_event usage_event_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.usage_event
    ADD CONSTRAINT usage_event_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: usage_event usage_event_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.usage_event
    ADD CONSTRAINT usage_event_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: user_mfa_methods user_mfa_methods_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_mfa_methods
    ADD CONSTRAINT user_mfa_methods_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_sessions user_sessions_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_sessions
    ADD CONSTRAINT user_sessions_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: verification_jobs verification_jobs_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.verification_jobs
    ADD CONSTRAINT verification_jobs_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: verification_jobs verification_jobs_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.verification_jobs
    ADD CONSTRAINT verification_jobs_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: webauthn_credentials webauthn_credentials_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webauthn_credentials
    ADD CONSTRAINT webauthn_credentials_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: webhook_deliveries webhook_deliveries_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webhook_deliveries
    ADD CONSTRAINT webhook_deliveries_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: webhook_deliveries webhook_deliveries_webhook_id_webhook_subscriptions_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webhook_deliveries
    ADD CONSTRAINT webhook_deliveries_webhook_id_webhook_subscriptions_id_fk FOREIGN KEY (webhook_id) REFERENCES public.webhook_subscriptions(id) ON DELETE SET NULL;


--
-- Name: webhook_deliveries webhook_deliveries_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webhook_deliveries
    ADD CONSTRAINT webhook_deliveries_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: webhook_subscriptions webhook_subscriptions_created_by_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webhook_subscriptions
    ADD CONSTRAINT webhook_subscriptions_created_by_user_id_users_id_fk FOREIGN KEY (created_by_user_id) REFERENCES public.users(id);


--
-- Name: webhook_subscriptions webhook_subscriptions_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webhook_subscriptions
    ADD CONSTRAINT webhook_subscriptions_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: webhook_subscriptions webhook_subscriptions_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webhook_subscriptions
    ADD CONSTRAINT webhook_subscriptions_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: worker_outbox worker_outbox_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.worker_outbox
    ADD CONSTRAINT worker_outbox_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: worker_outbox worker_outbox_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.worker_outbox
    ADD CONSTRAINT worker_outbox_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: workspace_members workspace_members_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_members
    ADD CONSTRAINT workspace_members_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: workspace_members workspace_members_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_members
    ADD CONSTRAINT workspace_members_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: workspaces workspaces_tenant_id_tenants_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspaces
    ADD CONSTRAINT workspaces_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: account_domains; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.account_domains ENABLE ROW LEVEL SECURITY;

--
-- Name: account_domains account_domains_workspace_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY account_domains_workspace_isolation ON public.account_domains USING ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif"))) WITH CHECK ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif")));


--
-- Name: account_holds; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.account_holds ENABLE ROW LEVEL SECURITY;

--
-- Name: account_locations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.account_locations ENABLE ROW LEVEL SECURITY;

--
-- Name: account_locations account_locations_workspace_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY account_locations_workspace_isolation ON public.account_locations USING ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif"))) WITH CHECK ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif")));


--
-- Name: accounts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.accounts ENABLE ROW LEVEL SECURITY;

--
-- Name: accounts accounts_workspace_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY accounts_workspace_isolation ON public.accounts USING ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif"))) WITH CHECK ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif")));


--
-- Name: activities; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.activities ENABLE ROW LEVEL SECURITY;

--
-- Name: activities activities_workspace_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY activities_workspace_isolation ON public.activities USING ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif"))) WITH CHECK ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif")));


--
-- Name: ai_requests; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ai_requests ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_requests ai_requests_workspace_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ai_requests_workspace_isolation ON public.ai_requests USING ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif"))) WITH CHECK ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif")));


--
-- Name: announcements; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.announcements ENABLE ROW LEVEL SECURITY;

--
-- Name: approval_requests; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.approval_requests ENABLE ROW LEVEL SECURITY;

--
-- Name: audit_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;

--
-- Name: audit_log audit_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY audit_tenant_isolation ON public.audit_log USING ((tenant_id = ( SELECT (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid AS "nullif"))) WITH CHECK ((tenant_id = ( SELECT (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid AS "nullif")));


--
-- Name: auth_allowed_origins; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.auth_allowed_origins ENABLE ROW LEVEL SECURITY;

--
-- Name: auth_allowed_origins auth_allowed_origins_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY auth_allowed_origins_isolation ON public.auth_allowed_origins USING (((tenant_id = ( SELECT (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid AS "nullif")) OR (tenant_id IS NULL))) WITH CHECK ((tenant_id = ( SELECT (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid AS "nullif")));


--
-- Name: auth_policies; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.auth_policies ENABLE ROW LEVEL SECURITY;

--
-- Name: auth_policies auth_policies_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY auth_policies_isolation ON public.auth_policies USING (((tenant_id = ( SELECT (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid AS "nullif")) OR (tenant_id IS NULL))) WITH CHECK ((tenant_id = ( SELECT (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid AS "nullif")));


--
-- Name: billing_cycles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.billing_cycles ENABLE ROW LEVEL SECURITY;

--
-- Name: billing_cycles billing_cycles_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY billing_cycles_tenant_isolation ON public.billing_cycles USING ((tenant_id = ( SELECT (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid AS "nullif"))) WITH CHECK ((tenant_id = ( SELECT (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid AS "nullif")));


--
-- Name: consent_records; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.consent_records ENABLE ROW LEVEL SECURITY;

--
-- Name: consent_records consent_workspace_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY consent_workspace_isolation ON public.consent_records USING ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif"))) WITH CHECK ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif")));


--
-- Name: contact_emails; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.contact_emails ENABLE ROW LEVEL SECURITY;

--
-- Name: contact_emails contact_emails_workspace_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY contact_emails_workspace_isolation ON public.contact_emails USING ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif"))) WITH CHECK ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif")));


--
-- Name: contact_phones; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.contact_phones ENABLE ROW LEVEL SECURITY;

--
-- Name: contact_phones contact_phones_workspace_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY contact_phones_workspace_isolation ON public.contact_phones USING ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif"))) WITH CHECK ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif")));


--
-- Name: contact_reveals; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.contact_reveals ENABLE ROW LEVEL SECURITY;

--
-- Name: contact_reveals contact_reveals_workspace_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY contact_reveals_workspace_isolation ON public.contact_reveals USING ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif"))) WITH CHECK ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif")));


--
-- Name: contacts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;

--
-- Name: contacts contacts_workspace_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY contacts_workspace_isolation ON public.contacts USING ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif"))) WITH CHECK ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif")));


--
-- Name: contribution_exclusion; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.contribution_exclusion ENABLE ROW LEVEL SECURITY;

--
-- Name: contribution_exclusion contribution_exclusion_workspace; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY contribution_exclusion_workspace ON public.contribution_exclusion USING ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif"))) WITH CHECK (((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif")) AND (tenant_id = ( SELECT (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid AS "nullif"))));


--
-- Name: contribution_policy; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.contribution_policy ENABLE ROW LEVEL SECURITY;

--
-- Name: contribution_policy contribution_policy_workspace; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY contribution_policy_workspace ON public.contribution_policy USING ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif"))) WITH CHECK (((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif")) AND (tenant_id = ( SELECT (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid AS "nullif"))));


--
-- Name: credit_ledger; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.credit_ledger ENABLE ROW LEVEL SECURITY;

--
-- Name: credit_ledger credit_ledger_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY credit_ledger_tenant_isolation ON public.credit_ledger USING ((tenant_id = ( SELECT (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid AS "nullif"))) WITH CHECK ((tenant_id = ( SELECT (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid AS "nullif")));


--
-- Name: credit_packs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.credit_packs ENABLE ROW LEVEL SECURITY;

--
-- Name: crm_connections; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.crm_connections ENABLE ROW LEVEL SECURITY;

--
-- Name: crm_connections crm_connections_workspace_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY crm_connections_workspace_isolation ON public.crm_connections USING ((workspace_id = (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid));


--
-- Name: crm_field_mappings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.crm_field_mappings ENABLE ROW LEVEL SECURITY;

--
-- Name: crm_field_mappings crm_field_mappings_workspace_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY crm_field_mappings_workspace_isolation ON public.crm_field_mappings USING ((workspace_id = (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid));


--
-- Name: crm_inbound_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.crm_inbound_events ENABLE ROW LEVEL SECURITY;

--
-- Name: crm_inbound_events crm_inbound_events_workspace_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY crm_inbound_events_workspace_insert ON public.crm_inbound_events FOR INSERT WITH CHECK ((workspace_id = (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid));


--
-- Name: crm_inbound_events crm_inbound_events_workspace_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY crm_inbound_events_workspace_read ON public.crm_inbound_events FOR SELECT USING ((workspace_id = (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid));


--
-- Name: crm_oauth_states; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.crm_oauth_states ENABLE ROW LEVEL SECURITY;

--
-- Name: crm_oauth_states crm_oauth_states_workspace_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY crm_oauth_states_workspace_isolation ON public.crm_oauth_states USING ((workspace_id = (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid));


--
-- Name: crm_object_contribution; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.crm_object_contribution ENABLE ROW LEVEL SECURITY;

--
-- Name: crm_object_contribution crm_object_contribution_workspace; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY crm_object_contribution_workspace ON public.crm_object_contribution USING ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif"))) WITH CHECK (((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif")) AND (tenant_id = ( SELECT (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid AS "nullif"))));


--
-- Name: crm_record_links; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.crm_record_links ENABLE ROW LEVEL SECURITY;

--
-- Name: crm_record_links crm_record_links_workspace_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY crm_record_links_workspace_isolation ON public.crm_record_links USING ((workspace_id = (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid));


--
-- Name: crm_sync_conflicts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.crm_sync_conflicts ENABLE ROW LEVEL SECURITY;

--
-- Name: crm_sync_conflicts crm_sync_conflicts_workspace_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY crm_sync_conflicts_workspace_isolation ON public.crm_sync_conflicts USING ((workspace_id = (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid));


--
-- Name: crm_sync_dead_letter; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.crm_sync_dead_letter ENABLE ROW LEVEL SECURITY;

--
-- Name: crm_sync_dead_letter crm_sync_dead_letter_workspace_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY crm_sync_dead_letter_workspace_insert ON public.crm_sync_dead_letter FOR INSERT WITH CHECK ((workspace_id = (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid));


--
-- Name: crm_sync_dead_letter crm_sync_dead_letter_workspace_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY crm_sync_dead_letter_workspace_read ON public.crm_sync_dead_letter FOR SELECT USING ((workspace_id = (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid));


--
-- Name: crm_sync_runs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.crm_sync_runs ENABLE ROW LEVEL SECURITY;

--
-- Name: crm_sync_runs crm_sync_runs_workspace_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY crm_sync_runs_workspace_insert ON public.crm_sync_runs FOR INSERT WITH CHECK ((workspace_id = (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid));


--
-- Name: crm_sync_runs crm_sync_runs_workspace_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY crm_sync_runs_workspace_read ON public.crm_sync_runs FOR SELECT USING ((workspace_id = (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid));


--
-- Name: crm_sync_runs crm_sync_runs_workspace_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY crm_sync_runs_workspace_update ON public.crm_sync_runs FOR UPDATE USING ((workspace_id = (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid));


--
-- Name: crm_sync_state; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.crm_sync_state ENABLE ROW LEVEL SECURITY;

--
-- Name: crm_sync_state crm_sync_state_workspace_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY crm_sync_state_workspace_isolation ON public.crm_sync_state USING ((workspace_id = (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid));


--
-- Name: custom_field_definitions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.custom_field_definitions ENABLE ROW LEVEL SECURITY;

--
-- Name: custom_field_definitions custom_field_definitions_workspace_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY custom_field_definitions_workspace_isolation ON public.custom_field_definitions USING ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif"))) WITH CHECK ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif")));


--
-- Name: data_quality_snapshots; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.data_quality_snapshots ENABLE ROW LEVEL SECURITY;

--
-- Name: data_quality_snapshots data_quality_snapshots_workspace_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY data_quality_snapshots_workspace_isolation ON public.data_quality_snapshots USING ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif"))) WITH CHECK ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif")));


--
-- Name: dsar_requests; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.dsar_requests ENABLE ROW LEVEL SECURITY;

--
-- Name: email_event; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.email_event ENABLE ROW LEVEL SECURITY;

--
-- Name: email_event email_event_workspace_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY email_event_workspace_isolation ON public.email_event USING ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif"))) WITH CHECK ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif")));


--
-- Name: email_message; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.email_message ENABLE ROW LEVEL SECURITY;

--
-- Name: email_message email_message_workspace_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY email_message_workspace_isolation ON public.email_message USING ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif"))) WITH CHECK ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif")));


--
-- Name: email_template; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.email_template ENABLE ROW LEVEL SECURITY;

--
-- Name: email_template_version; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.email_template_version ENABLE ROW LEVEL SECURITY;

--
-- Name: email_template_version email_template_version_workspace_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY email_template_version_workspace_isolation ON public.email_template_version USING ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif"))) WITH CHECK ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif")));


--
-- Name: email_template email_template_workspace_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY email_template_workspace_isolation ON public.email_template USING ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif"))) WITH CHECK ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif")));


--
-- Name: email_thread; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.email_thread ENABLE ROW LEVEL SECURITY;

--
-- Name: email_thread email_thread_workspace_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY email_thread_workspace_isolation ON public.email_thread USING ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif"))) WITH CHECK ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif")));


--
-- Name: enrichment_job_chunks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.enrichment_job_chunks ENABLE ROW LEVEL SECURITY;

--
-- Name: enrichment_job_chunks enrichment_job_chunks_workspace_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY enrichment_job_chunks_workspace_isolation ON public.enrichment_job_chunks USING ((EXISTS ( SELECT 1
   FROM public.enrichment_jobs j
  WHERE ((j.id = enrichment_job_chunks.job_id) AND (j.workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif")))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.enrichment_jobs j
  WHERE ((j.id = enrichment_job_chunks.job_id) AND (j.workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif"))))));


--
-- Name: enrichment_job_rows; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.enrichment_job_rows ENABLE ROW LEVEL SECURITY;

--
-- Name: enrichment_job_rows enrichment_job_rows_workspace_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY enrichment_job_rows_workspace_isolation ON public.enrichment_job_rows USING ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif"))) WITH CHECK ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif")));


--
-- Name: enrichment_jobs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.enrichment_jobs ENABLE ROW LEVEL SECURITY;

--
-- Name: enrichment_jobs enrichment_jobs_workspace_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY enrichment_jobs_workspace_isolation ON public.enrichment_jobs USING ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif"))) WITH CHECK ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif")));


--
-- Name: enrichment_policy; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.enrichment_policy ENABLE ROW LEVEL SECURITY;

--
-- Name: enrichment_policy enrichment_policy_workspace_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY enrichment_policy_workspace_isolation ON public.enrichment_policy USING ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif"))) WITH CHECK ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif")));


--
-- Name: entitlement; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.entitlement ENABLE ROW LEVEL SECURITY;

--
-- Name: entitlement entitlement_tenant_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY entitlement_tenant_read ON public.entitlement FOR SELECT USING ((tenant_id = ( SELECT (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid AS "nullif")));


--
-- Name: event_outbox; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.event_outbox ENABLE ROW LEVEL SECURITY;

--
-- Name: event_outbox event_outbox_workspace_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY event_outbox_workspace_isolation ON public.event_outbox USING ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif"))) WITH CHECK ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif")));


--
-- Name: feature_flags; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.feature_flags ENABLE ROW LEVEL SECURITY;

--
-- Name: feature_flags feature_flags_app_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY feature_flags_app_read ON public.feature_flags FOR SELECT USING (true);


--
-- Name: idempotency_keys; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.idempotency_keys ENABLE ROW LEVEL SECURITY;

--
-- Name: idempotency_keys idempotency_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY idempotency_tenant_isolation ON public.idempotency_keys USING ((tenant_id = ( SELECT (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid AS "nullif"))) WITH CHECK ((tenant_id = ( SELECT (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid AS "nullif")));


--
-- Name: impersonation_sessions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.impersonation_sessions ENABLE ROW LEVEL SECURITY;

--
-- Name: import_job_chunks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.import_job_chunks ENABLE ROW LEVEL SECURITY;

--
-- Name: import_job_chunks import_job_chunks_workspace_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY import_job_chunks_workspace_isolation ON public.import_job_chunks USING ((EXISTS ( SELECT 1
   FROM public.import_jobs j
  WHERE ((j.id = import_job_chunks.job_id) AND (j.workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif")))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.import_jobs j
  WHERE ((j.id = import_job_chunks.job_id) AND (j.workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif"))))));


--
-- Name: import_job_rows; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.import_job_rows ENABLE ROW LEVEL SECURITY;

--
-- Name: import_job_rows import_job_rows_workspace_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY import_job_rows_workspace_isolation ON public.import_job_rows USING ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif"))) WITH CHECK ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif")));


--
-- Name: import_jobs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.import_jobs ENABLE ROW LEVEL SECURITY;

--
-- Name: import_jobs import_jobs_workspace_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY import_jobs_workspace_isolation ON public.import_jobs USING ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif"))) WITH CHECK ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif")));


--
-- Name: import_mapping_templates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.import_mapping_templates ENABLE ROW LEVEL SECURITY;

--
-- Name: import_mapping_templates import_mapping_templates_workspace_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY import_mapping_templates_workspace_isolation ON public.import_mapping_templates USING ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif"))) WITH CHECK ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif")));


--
-- Name: import_policy; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.import_policy ENABLE ROW LEVEL SECURITY;

--
-- Name: import_policy import_policy_workspace_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY import_policy_workspace_isolation ON public.import_policy USING ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif"))) WITH CHECK ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif")));


--
-- Name: intent_signals; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.intent_signals ENABLE ROW LEVEL SECURITY;

--
-- Name: intent_signals intent_signals_workspace_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY intent_signals_workspace_isolation ON public.intent_signals USING ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif"))) WITH CHECK ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif")));


--
-- Name: invitations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.invitations ENABLE ROW LEVEL SECURITY;

--
-- Name: invitations invitations_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY invitations_isolation ON public.invitations USING ((tenant_id = ( SELECT (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid AS "nullif")));


--
-- Name: jit_elevations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.jit_elevations ENABLE ROW LEVEL SECURITY;

--
-- Name: list_members; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.list_members ENABLE ROW LEVEL SECURITY;

--
-- Name: list_members list_members_workspace_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY list_members_workspace_isolation ON public.list_members USING ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif"))) WITH CHECK ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif")));


--
-- Name: lists; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.lists ENABLE ROW LEVEL SECURITY;

--
-- Name: lists lists_workspace_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lists_workspace_isolation ON public.lists USING ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif"))) WITH CHECK ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif")));


--
-- Name: mailbox_integration; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.mailbox_integration ENABLE ROW LEVEL SECURITY;

--
-- Name: mailbox_integration mailbox_integration_workspace_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY mailbox_integration_workspace_isolation ON public.mailbox_integration USING ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif"))) WITH CHECK ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif")));


--
-- Name: workspace_members members_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY members_tenant_isolation ON public.workspace_members USING ((workspace_id IN ( SELECT workspaces.id
   FROM public.workspaces
  WHERE (workspaces.tenant_id = ( SELECT (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid AS "nullif")))));


--
-- Name: notifications; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

--
-- Name: notifications notifications_workspace_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY notifications_workspace_isolation ON public.notifications USING ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif"))) WITH CHECK ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif")));


--
-- Name: oauth_connect_state; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.oauth_connect_state ENABLE ROW LEVEL SECURITY;

--
-- Name: oauth_connect_state oauth_connect_state_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY oauth_connect_state_tenant_isolation ON public.oauth_connect_state USING ((tenant_id = ( SELECT (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid AS "nullif"))) WITH CHECK ((tenant_id = ( SELECT (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid AS "nullif")));


--
-- Name: outreach_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.outreach_log ENABLE ROW LEVEL SECURITY;

--
-- Name: outreach_log outreach_log_workspace_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY outreach_log_workspace_isolation ON public.outreach_log USING ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif"))) WITH CHECK ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif")));


--
-- Name: outreach_sequences; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.outreach_sequences ENABLE ROW LEVEL SECURITY;

--
-- Name: outreach_sequences outreach_sequences_workspace_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY outreach_sequences_workspace_isolation ON public.outreach_sequences USING ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif"))) WITH CHECK ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif")));


--
-- Name: outreach_steps; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.outreach_steps ENABLE ROW LEVEL SECURITY;

--
-- Name: outreach_steps outreach_steps_workspace_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY outreach_steps_workspace_isolation ON public.outreach_steps USING ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif"))) WITH CHECK ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif")));


--
-- Name: pipeline_stages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pipeline_stages ENABLE ROW LEVEL SECURITY;

--
-- Name: pipeline_stages pipeline_stages_workspace_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY pipeline_stages_workspace_isolation ON public.pipeline_stages USING ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif"))) WITH CHECK ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif")));


--
-- Name: plan_templates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.plan_templates ENABLE ROW LEVEL SECURITY;

--
-- Name: platform_audit_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.platform_audit_log ENABLE ROW LEVEL SECURITY;

--
-- Name: platform_staff; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.platform_staff ENABLE ROW LEVEL SECURITY;

--
-- Name: provider_calls; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.provider_calls ENABLE ROW LEVEL SECURITY;

--
-- Name: provider_calls provider_calls_workspace_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY provider_calls_workspace_isolation ON public.provider_calls USING ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif"))) WITH CHECK ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif")));


--
-- Name: provider_configs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.provider_configs ENABLE ROW LEVEL SECURITY;

--
-- Name: provider_configs provider_configs_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY provider_configs_read ON public.provider_configs FOR SELECT USING (true);


--
-- Name: purchases; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.purchases ENABLE ROW LEVEL SECURITY;

--
-- Name: purchases purchases_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY purchases_tenant_isolation ON public.purchases USING ((tenant_id = ( SELECT (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid AS "nullif"))) WITH CHECK ((tenant_id = ( SELECT (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid AS "nullif")));


--
-- Name: record_tags; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.record_tags ENABLE ROW LEVEL SECURITY;

--
-- Name: record_tags record_tags_workspace_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY record_tags_workspace_isolation ON public.record_tags USING ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif"))) WITH CHECK ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif")));


--
-- Name: retention_class_policies; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.retention_class_policies ENABLE ROW LEVEL SECURITY;

--
-- Name: retention_class_policies retention_class_policies_app_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY retention_class_policies_app_read ON public.retention_class_policies FOR SELECT USING (true);


--
-- Name: retention_policies; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.retention_policies ENABLE ROW LEVEL SECURITY;

--
-- Name: retention_runs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.retention_runs ENABLE ROW LEVEL SECURITY;

--
-- Name: retention_runs retention_runs_tenant_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY retention_runs_tenant_insert ON public.retention_runs FOR INSERT WITH CHECK ((tenant_id = ( SELECT (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid AS "nullif")));


--
-- Name: retention_runs retention_runs_tenant_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY retention_runs_tenant_read ON public.retention_runs FOR SELECT USING ((tenant_id = ( SELECT (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid AS "nullif")));


--
-- Name: reveal_job_rows; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.reveal_job_rows ENABLE ROW LEVEL SECURITY;

--
-- Name: reveal_job_rows reveal_job_rows_workspace_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY reveal_job_rows_workspace_isolation ON public.reveal_job_rows USING ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif"))) WITH CHECK ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif")));


--
-- Name: reveal_jobs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.reveal_jobs ENABLE ROW LEVEL SECURITY;

--
-- Name: reveal_jobs reveal_jobs_workspace_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY reveal_jobs_workspace_isolation ON public.reveal_jobs USING ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif"))) WITH CHECK ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif")));


--
-- Name: sales_nav_links; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sales_nav_links ENABLE ROW LEVEL SECURITY;

--
-- Name: sales_nav_links sales_nav_links_workspace_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sales_nav_links_workspace_isolation ON public.sales_nav_links USING ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif"))) WITH CHECK ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif")));


--
-- Name: saved_searches; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.saved_searches ENABLE ROW LEVEL SECURITY;

--
-- Name: saved_searches saved_searches_workspace_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY saved_searches_workspace_isolation ON public.saved_searches USING ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif"))) WITH CHECK ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif")));


--
-- Name: scheduled_imports; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.scheduled_imports ENABLE ROW LEVEL SECURITY;

--
-- Name: scheduled_imports scheduled_imports_workspace_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY scheduled_imports_workspace_isolation ON public.scheduled_imports USING ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif"))) WITH CHECK ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif")));


--
-- Name: scim_tokens; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.scim_tokens ENABLE ROW LEVEL SECURITY;

--
-- Name: scim_tokens scim_tokens_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY scim_tokens_tenant_isolation ON public.scim_tokens USING ((tenant_id = ( SELECT (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid AS "nullif"))) WITH CHECK ((tenant_id = ( SELECT (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid AS "nullif")));


--
-- Name: scores; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.scores ENABLE ROW LEVEL SECURITY;

--
-- Name: scores scores_workspace_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY scores_workspace_isolation ON public.scores USING ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif"))) WITH CHECK ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif")));


--
-- Name: sending_domain; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sending_domain ENABLE ROW LEVEL SECURITY;

--
-- Name: sending_domain sending_domain_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sending_domain_tenant_isolation ON public.sending_domain USING ((tenant_id = ( SELECT (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid AS "nullif"))) WITH CHECK ((tenant_id = ( SELECT (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid AS "nullif")));


--
-- Name: source_imports; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.source_imports ENABLE ROW LEVEL SECURITY;

--
-- Name: source_imports source_imports_workspace_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY source_imports_workspace_isolation ON public.source_imports USING ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif"))) WITH CHECK ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif")));


--
-- Name: stripe_customers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.stripe_customers ENABLE ROW LEVEL SECURITY;

--
-- Name: stripe_customers stripe_customers_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY stripe_customers_tenant_isolation ON public.stripe_customers USING ((tenant_id = ( SELECT (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid AS "nullif"))) WITH CHECK ((tenant_id = ( SELECT (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid AS "nullif")));


--
-- Name: sub_processors; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sub_processors ENABLE ROW LEVEL SECURITY;

--
-- Name: subscriptions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;

--
-- Name: subscriptions subscriptions_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY subscriptions_tenant_isolation ON public.subscriptions USING ((tenant_id = ( SELECT (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid AS "nullif"))) WITH CHECK ((tenant_id = ( SELECT (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid AS "nullif")));


--
-- Name: support_notes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.support_notes ENABLE ROW LEVEL SECURITY;

--
-- Name: suppression_list suppression_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY suppression_delete ON public.suppression_list FOR DELETE USING (((((scope)::text = 'tenant'::text) AND (tenant_id = ( SELECT (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid AS "nullif"))) OR (((scope)::text = 'workspace'::text) AND (workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif")))));


--
-- Name: suppression_list; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.suppression_list ENABLE ROW LEVEL SECURITY;

--
-- Name: suppression_list suppression_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY suppression_read ON public.suppression_list FOR SELECT USING ((((scope)::text = 'global'::text) OR (((scope)::text = 'tenant'::text) AND (tenant_id = ( SELECT (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid AS "nullif"))) OR (((scope)::text = 'workspace'::text) AND (workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif")))));


--
-- Name: suppression_list suppression_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY suppression_write ON public.suppression_list FOR INSERT WITH CHECK (((((scope)::text = 'tenant'::text) AND (tenant_id = ( SELECT (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid AS "nullif"))) OR (((scope)::text = 'workspace'::text) AND (workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif")))));


--
-- Name: tags; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.tags ENABLE ROW LEVEL SECURITY;

--
-- Name: tags tags_workspace_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tags_workspace_isolation ON public.tags USING ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif"))) WITH CHECK ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif")));


--
-- Name: team_members; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.team_members ENABLE ROW LEVEL SECURITY;

--
-- Name: team_members team_members_workspace_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY team_members_workspace_isolation ON public.team_members USING ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif"))) WITH CHECK ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif")));


--
-- Name: teams; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.teams ENABLE ROW LEVEL SECURITY;

--
-- Name: teams teams_workspace_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY teams_workspace_isolation ON public.teams USING ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif"))) WITH CHECK ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif")));


--
-- Name: tenant_auth_policies; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.tenant_auth_policies ENABLE ROW LEVEL SECURITY;

--
-- Name: tenant_auth_policies tenant_auth_policy_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_auth_policy_isolation ON public.tenant_auth_policies USING ((tenant_id = ( SELECT (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid AS "nullif"))) WITH CHECK ((tenant_id = ( SELECT (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid AS "nullif")));


--
-- Name: tenant_domains; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.tenant_domains ENABLE ROW LEVEL SECURITY;

--
-- Name: tenant_domains tenant_domains_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_domains_isolation ON public.tenant_domains USING ((tenant_id = ( SELECT (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid AS "nullif"))) WITH CHECK ((tenant_id = ( SELECT (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid AS "nullif")));


--
-- Name: tenant_feature_flags; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.tenant_feature_flags ENABLE ROW LEVEL SECURITY;

--
-- Name: tenant_feature_flags tenant_feature_flags_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_feature_flags_read ON public.tenant_feature_flags FOR SELECT USING ((tenant_id = ( SELECT (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid AS "nullif")));


--
-- Name: tenant_members; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.tenant_members ENABLE ROW LEVEL SECURITY;

--
-- Name: tenant_members tenant_members_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_members_isolation ON public.tenant_members USING ((tenant_id = ( SELECT (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid AS "nullif")));


--
-- Name: tenant_sso_configs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.tenant_sso_configs ENABLE ROW LEVEL SECURITY;

--
-- Name: tenant_sso_configs tenant_sso_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_sso_isolation ON public.tenant_sso_configs USING ((tenant_id = ( SELECT (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid AS "nullif"))) WITH CHECK ((tenant_id = ( SELECT (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid AS "nullif")));


--
-- Name: tenants; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;

--
-- Name: tenants tenants_self; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenants_self ON public.tenants USING ((id = ( SELECT (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid AS "nullif"))) WITH CHECK ((id = ( SELECT (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid AS "nullif")));


--
-- Name: usage_event; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.usage_event ENABLE ROW LEVEL SECURITY;

--
-- Name: usage_event usage_event_workspace_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY usage_event_workspace_isolation ON public.usage_event USING ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif"))) WITH CHECK ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif")));


--
-- Name: validation_rules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.validation_rules ENABLE ROW LEVEL SECURITY;

--
-- Name: validation_rules validation_rules_app_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY validation_rules_app_read ON public.validation_rules FOR SELECT USING (true);


--
-- Name: verification_jobs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.verification_jobs ENABLE ROW LEVEL SECURITY;

--
-- Name: verification_jobs verification_jobs_workspace_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY verification_jobs_workspace_isolation ON public.verification_jobs USING ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif"))) WITH CHECK ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif")));


--
-- Name: webhook_deliveries; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.webhook_deliveries ENABLE ROW LEVEL SECURITY;

--
-- Name: webhook_deliveries webhook_deliveries_workspace_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY webhook_deliveries_workspace_isolation ON public.webhook_deliveries USING ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif"))) WITH CHECK ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif")));


--
-- Name: webhook_subscriptions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.webhook_subscriptions ENABLE ROW LEVEL SECURITY;

--
-- Name: webhook_subscriptions webhook_subscriptions_workspace_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY webhook_subscriptions_workspace_isolation ON public.webhook_subscriptions USING ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif"))) WITH CHECK ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif")));


--
-- Name: worker_outbox; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.worker_outbox ENABLE ROW LEVEL SECURITY;

--
-- Name: worker_outbox worker_outbox_workspace_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY worker_outbox_workspace_isolation ON public.worker_outbox USING ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif"))) WITH CHECK ((workspace_id = ( SELECT (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::uuid AS "nullif")));


--
-- Name: workspace_members; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.workspace_members ENABLE ROW LEVEL SECURITY;

--
-- Name: workspaces; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.workspaces ENABLE ROW LEVEL SECURITY;

--
-- Name: workspaces workspaces_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY workspaces_tenant_isolation ON public.workspaces USING ((tenant_id = ( SELECT (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid AS "nullif")));


--
-- Name: SCHEMA forge; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA forge TO leadwolf_forge;


--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA public TO leadwolf_app;
GRANT USAGE ON SCHEMA public TO leadwolf_admin;
GRANT USAGE ON SCHEMA public TO leadwolf_er;


--
-- Name: FUNCTION ensure_month_partitions(target regclass, months_ahead integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.ensure_month_partitions(target regclass, months_ahead integer) FROM PUBLIC;


--
-- Name: TABLE approval_requests; Type: ACL; Schema: forge; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE forge.approval_requests TO leadwolf_forge;


--
-- Name: TABLE capture_batches; Type: ACL; Schema: forge; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE forge.capture_batches TO leadwolf_forge;


--
-- Name: TABLE contributor; Type: ACL; Schema: forge; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE forge.contributor TO leadwolf_forge;


--
-- Name: TABLE contributor_consent; Type: ACL; Schema: forge; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE forge.contributor_consent TO leadwolf_forge;


--
-- Name: TABLE extraction_candidates; Type: ACL; Schema: forge; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE forge.extraction_candidates TO leadwolf_forge;


--
-- Name: TABLE extraction_runs; Type: ACL; Schema: forge; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE forge.extraction_runs TO leadwolf_forge;


--
-- Name: TABLE forge_audit_log; Type: ACL; Schema: forge; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE forge.forge_audit_log TO leadwolf_forge;


--
-- Name: SEQUENCE forge_audit_log_seq_seq; Type: ACL; Schema: forge; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE forge.forge_audit_log_seq_seq TO leadwolf_forge;


--
-- Name: TABLE master_id_map; Type: ACL; Schema: forge; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE forge.master_id_map TO leadwolf_forge;


--
-- Name: TABLE match_candidates; Type: ACL; Schema: forge; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE forge.match_candidates TO leadwolf_forge;


--
-- Name: TABLE match_links; Type: ACL; Schema: forge; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE forge.match_links TO leadwolf_forge;


--
-- Name: TABLE merge_log; Type: ACL; Schema: forge; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE forge.merge_log TO leadwolf_forge;


--
-- Name: TABLE parsed_records; Type: ACL; Schema: forge; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE forge.parsed_records TO leadwolf_forge;


--
-- Name: TABLE parser_versions; Type: ACL; Schema: forge; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE forge.parser_versions TO leadwolf_forge;


--
-- Name: TABLE parsers; Type: ACL; Schema: forge; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE forge.parsers TO leadwolf_forge;


--
-- Name: TABLE quarantine; Type: ACL; Schema: forge; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE forge.quarantine TO leadwolf_forge;


--
-- Name: TABLE raw_captures; Type: ACL; Schema: forge; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE forge.raw_captures TO leadwolf_forge;


--
-- Name: TABLE review_tasks; Type: ACL; Schema: forge; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE forge.review_tasks TO leadwolf_forge;


--
-- Name: TABLE sync_outbox; Type: ACL; Schema: forge; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE forge.sync_outbox TO leadwolf_forge;


--
-- Name: TABLE sync_state; Type: ACL; Schema: forge; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE forge.sync_state TO leadwolf_forge;


--
-- Name: TABLE verified_record_events; Type: ACL; Schema: forge; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE forge.verified_record_events TO leadwolf_forge;


--
-- Name: TABLE verified_records; Type: ACL; Schema: forge; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE forge.verified_records TO leadwolf_forge;


--
-- Name: TABLE account_domains; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.account_domains TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.account_domains TO leadwolf_admin;


--
-- Name: TABLE account_holds; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.account_holds TO leadwolf_admin;


--
-- Name: TABLE account_locations; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.account_locations TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.account_locations TO leadwolf_admin;


--
-- Name: TABLE accounts; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.accounts TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.accounts TO leadwolf_admin;


--
-- Name: TABLE activities; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.activities TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.activities TO leadwolf_admin;


--
-- Name: TABLE activities_2026_08; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.activities_2026_08 TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.activities_2026_08 TO leadwolf_admin;


--
-- Name: TABLE activities_2026_09; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.activities_2026_09 TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.activities_2026_09 TO leadwolf_admin;


--
-- Name: TABLE activities_2026_10; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.activities_2026_10 TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.activities_2026_10 TO leadwolf_admin;


--
-- Name: TABLE activities_2026_11; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.activities_2026_11 TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.activities_2026_11 TO leadwolf_admin;


--
-- Name: TABLE activities_default; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.activities_default TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.activities_default TO leadwolf_admin;


--
-- Name: TABLE ai_requests; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.ai_requests TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.ai_requests TO leadwolf_admin;


--
-- Name: TABLE announcements; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.announcements TO leadwolf_admin;


--
-- Name: TABLE approval_requests; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.approval_requests TO leadwolf_admin;


--
-- Name: TABLE audit_log; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.audit_log TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.audit_log TO leadwolf_admin;


--
-- Name: TABLE auth_allowed_origins; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.auth_allowed_origins TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.auth_allowed_origins TO leadwolf_admin;


--
-- Name: TABLE auth_email_tokens; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.auth_email_tokens TO leadwolf_admin;


--
-- Name: TABLE auth_policies; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.auth_policies TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.auth_policies TO leadwolf_admin;


--
-- Name: TABLE billing_cycles; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.billing_cycles TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.billing_cycles TO leadwolf_admin;


--
-- Name: TABLE consent_records; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.consent_records TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.consent_records TO leadwolf_admin;


--
-- Name: TABLE contact_emails; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.contact_emails TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.contact_emails TO leadwolf_admin;


--
-- Name: TABLE contact_phones; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.contact_phones TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.contact_phones TO leadwolf_admin;


--
-- Name: TABLE contact_reveals; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.contact_reveals TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.contact_reveals TO leadwolf_admin;


--
-- Name: TABLE contacts; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.contacts TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.contacts TO leadwolf_admin;


--
-- Name: TABLE contribution_exclusion; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.contribution_exclusion TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.contribution_exclusion TO leadwolf_admin;


--
-- Name: TABLE contribution_policy; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.contribution_policy TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.contribution_policy TO leadwolf_admin;


--
-- Name: TABLE credit_ledger; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.credit_ledger TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.credit_ledger TO leadwolf_admin;


--
-- Name: TABLE credit_packs; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.credit_packs TO leadwolf_admin;


--
-- Name: TABLE crm_connections; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.crm_connections TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.crm_connections TO leadwolf_admin;


--
-- Name: TABLE crm_field_mappings; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.crm_field_mappings TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.crm_field_mappings TO leadwolf_admin;


--
-- Name: TABLE crm_inbound_events; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.crm_inbound_events TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.crm_inbound_events TO leadwolf_admin;


--
-- Name: TABLE crm_oauth_states; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.crm_oauth_states TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.crm_oauth_states TO leadwolf_admin;


--
-- Name: TABLE crm_object_contribution; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.crm_object_contribution TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.crm_object_contribution TO leadwolf_admin;


--
-- Name: TABLE crm_record_links; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.crm_record_links TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.crm_record_links TO leadwolf_admin;


--
-- Name: TABLE crm_sync_conflicts; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.crm_sync_conflicts TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.crm_sync_conflicts TO leadwolf_admin;


--
-- Name: TABLE crm_sync_dead_letter; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.crm_sync_dead_letter TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.crm_sync_dead_letter TO leadwolf_admin;


--
-- Name: TABLE crm_sync_runs; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.crm_sync_runs TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.crm_sync_runs TO leadwolf_admin;


--
-- Name: TABLE crm_sync_state; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.crm_sync_state TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.crm_sync_state TO leadwolf_admin;


--
-- Name: TABLE custom_field_definitions; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.custom_field_definitions TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.custom_field_definitions TO leadwolf_admin;


--
-- Name: TABLE data_quality_snapshots; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.data_quality_snapshots TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.data_quality_snapshots TO leadwolf_admin;


--
-- Name: TABLE dsar_requests; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.dsar_requests TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.dsar_requests TO leadwolf_admin;


--
-- Name: TABLE email_event; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.email_event TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.email_event TO leadwolf_admin;


--
-- Name: TABLE email_message; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.email_message TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.email_message TO leadwolf_admin;


--
-- Name: TABLE email_template; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.email_template TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.email_template TO leadwolf_admin;


--
-- Name: TABLE email_template_version; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.email_template_version TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.email_template_version TO leadwolf_admin;


--
-- Name: TABLE email_thread; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.email_thread TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.email_thread TO leadwolf_admin;


--
-- Name: TABLE enrichment_job_chunks; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.enrichment_job_chunks TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.enrichment_job_chunks TO leadwolf_admin;


--
-- Name: TABLE enrichment_job_rows; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.enrichment_job_rows TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.enrichment_job_rows TO leadwolf_admin;


--
-- Name: TABLE enrichment_jobs; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.enrichment_jobs TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.enrichment_jobs TO leadwolf_admin;


--
-- Name: TABLE enrichment_policy; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.enrichment_policy TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.enrichment_policy TO leadwolf_admin;


--
-- Name: TABLE entitlement; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.entitlement TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.entitlement TO leadwolf_admin;


--
-- Name: TABLE event_outbox; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.event_outbox TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.event_outbox TO leadwolf_admin;


--
-- Name: TABLE feature_flags; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.feature_flags TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.feature_flags TO leadwolf_admin;


--
-- Name: TABLE idempotency_keys; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.idempotency_keys TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.idempotency_keys TO leadwolf_admin;


--
-- Name: TABLE impersonation_sessions; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.impersonation_sessions TO leadwolf_admin;


--
-- Name: TABLE import_job_chunks; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.import_job_chunks TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.import_job_chunks TO leadwolf_admin;


--
-- Name: TABLE import_job_rows; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.import_job_rows TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.import_job_rows TO leadwolf_admin;


--
-- Name: TABLE import_jobs; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.import_jobs TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.import_jobs TO leadwolf_admin;


--
-- Name: TABLE import_mapping_templates; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.import_mapping_templates TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.import_mapping_templates TO leadwolf_admin;


--
-- Name: TABLE import_policy; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.import_policy TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.import_policy TO leadwolf_admin;


--
-- Name: TABLE intent_signals; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.intent_signals TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.intent_signals TO leadwolf_admin;


--
-- Name: TABLE invitations; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.invitations TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.invitations TO leadwolf_admin;


--
-- Name: TABLE jit_elevations; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.jit_elevations TO leadwolf_admin;


--
-- Name: TABLE list_members; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.list_members TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.list_members TO leadwolf_admin;


--
-- Name: TABLE lists; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.lists TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.lists TO leadwolf_admin;


--
-- Name: TABLE mailbox_integration; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.mailbox_integration TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.mailbox_integration TO leadwolf_admin;


--
-- Name: TABLE master_companies; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.master_companies TO leadwolf_admin;
GRANT SELECT,INSERT,UPDATE ON TABLE public.master_companies TO leadwolf_er;


--
-- Name: TABLE master_emails; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.master_emails TO leadwolf_admin;
GRANT SELECT,INSERT,UPDATE ON TABLE public.master_emails TO leadwolf_er;


--
-- Name: TABLE master_employment; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.master_employment TO leadwolf_admin;
GRANT SELECT,INSERT,UPDATE ON TABLE public.master_employment TO leadwolf_er;


--
-- Name: TABLE master_persons; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.master_persons TO leadwolf_admin;
GRANT SELECT,INSERT,UPDATE ON TABLE public.master_persons TO leadwolf_er;


--
-- Name: TABLE master_phones; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.master_phones TO leadwolf_admin;
GRANT SELECT,INSERT,UPDATE ON TABLE public.master_phones TO leadwolf_er;


--
-- Name: TABLE match_links; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.match_links TO leadwolf_admin;
GRANT SELECT,INSERT,UPDATE ON TABLE public.match_links TO leadwolf_er;


--
-- Name: TABLE notifications; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.notifications TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.notifications TO leadwolf_admin;


--
-- Name: TABLE oauth_connect_state; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.oauth_connect_state TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.oauth_connect_state TO leadwolf_admin;


--
-- Name: TABLE outreach_log; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.outreach_log TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.outreach_log TO leadwolf_admin;


--
-- Name: TABLE outreach_sequences; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.outreach_sequences TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.outreach_sequences TO leadwolf_admin;


--
-- Name: TABLE outreach_steps; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.outreach_steps TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.outreach_steps TO leadwolf_admin;


--
-- Name: TABLE pipeline_stages; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.pipeline_stages TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.pipeline_stages TO leadwolf_admin;


--
-- Name: TABLE plan_templates; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.plan_templates TO leadwolf_admin;


--
-- Name: TABLE platform_audit_log; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.platform_audit_log TO leadwolf_admin;


--
-- Name: TABLE platform_audit_log_2026_08; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.platform_audit_log_2026_08 TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.platform_audit_log_2026_08 TO leadwolf_admin;


--
-- Name: TABLE platform_audit_log_2026_09; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.platform_audit_log_2026_09 TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.platform_audit_log_2026_09 TO leadwolf_admin;


--
-- Name: TABLE platform_audit_log_2026_10; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.platform_audit_log_2026_10 TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.platform_audit_log_2026_10 TO leadwolf_admin;


--
-- Name: TABLE platform_audit_log_2026_11; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.platform_audit_log_2026_11 TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.platform_audit_log_2026_11 TO leadwolf_admin;


--
-- Name: TABLE platform_audit_log_default; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.platform_audit_log_default TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.platform_audit_log_default TO leadwolf_admin;


--
-- Name: TABLE platform_staff; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.platform_staff TO leadwolf_admin;


--
-- Name: TABLE processed_sync_events; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.processed_sync_events TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.processed_sync_events TO leadwolf_admin;
GRANT SELECT,INSERT,UPDATE ON TABLE public.processed_sync_events TO leadwolf_er;


--
-- Name: TABLE projection_outbox; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.projection_outbox TO leadwolf_admin;
GRANT SELECT,INSERT,UPDATE ON TABLE public.projection_outbox TO leadwolf_er;


--
-- Name: TABLE provenance_event; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.provenance_event TO leadwolf_admin;
GRANT SELECT,INSERT,UPDATE ON TABLE public.provenance_event TO leadwolf_er;


--
-- Name: TABLE provenance_event_2026_08; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.provenance_event_2026_08 TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.provenance_event_2026_08 TO leadwolf_admin;


--
-- Name: TABLE provenance_event_2026_09; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.provenance_event_2026_09 TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.provenance_event_2026_09 TO leadwolf_admin;


--
-- Name: TABLE provenance_event_2026_10; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.provenance_event_2026_10 TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.provenance_event_2026_10 TO leadwolf_admin;


--
-- Name: TABLE provenance_event_2026_11; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.provenance_event_2026_11 TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.provenance_event_2026_11 TO leadwolf_admin;


--
-- Name: TABLE provenance_event_default; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.provenance_event_default TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.provenance_event_default TO leadwolf_admin;


--
-- Name: TABLE provider_calls; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.provider_calls TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.provider_calls TO leadwolf_admin;


--
-- Name: TABLE provider_configs; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.provider_configs TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.provider_configs TO leadwolf_admin;


--
-- Name: TABLE purchases; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.purchases TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.purchases TO leadwolf_admin;


--
-- Name: TABLE record_tags; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.record_tags TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.record_tags TO leadwolf_admin;


--
-- Name: TABLE retention_class_policies; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.retention_class_policies TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.retention_class_policies TO leadwolf_admin;


--
-- Name: TABLE retention_policies; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.retention_policies TO leadwolf_admin;


--
-- Name: TABLE retention_runs; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.retention_runs TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.retention_runs TO leadwolf_admin;


--
-- Name: TABLE reveal_job_rows; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.reveal_job_rows TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.reveal_job_rows TO leadwolf_admin;


--
-- Name: TABLE reveal_jobs; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.reveal_jobs TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.reveal_jobs TO leadwolf_admin;


--
-- Name: TABLE sales_nav_links; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.sales_nav_links TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.sales_nav_links TO leadwolf_admin;


--
-- Name: TABLE saved_searches; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.saved_searches TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.saved_searches TO leadwolf_admin;


--
-- Name: TABLE scheduled_imports; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.scheduled_imports TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.scheduled_imports TO leadwolf_admin;


--
-- Name: TABLE scim_tokens; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.scim_tokens TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.scim_tokens TO leadwolf_admin;


--
-- Name: TABLE scores; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.scores TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.scores TO leadwolf_admin;


--
-- Name: TABLE sending_domain; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.sending_domain TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.sending_domain TO leadwolf_admin;


--
-- Name: TABLE source_imports; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.source_imports TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.source_imports TO leadwolf_admin;


--
-- Name: TABLE source_records; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.source_records TO leadwolf_admin;
GRANT SELECT,INSERT,UPDATE ON TABLE public.source_records TO leadwolf_er;


--
-- Name: TABLE stripe_customers; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.stripe_customers TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.stripe_customers TO leadwolf_admin;


--
-- Name: TABLE sub_processors; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.sub_processors TO leadwolf_admin;


--
-- Name: TABLE subscriptions; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.subscriptions TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.subscriptions TO leadwolf_admin;


--
-- Name: TABLE support_notes; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.support_notes TO leadwolf_admin;


--
-- Name: TABLE suppression_list; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.suppression_list TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.suppression_list TO leadwolf_admin;


--
-- Name: TABLE tags; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.tags TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.tags TO leadwolf_admin;


--
-- Name: TABLE team_members; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.team_members TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.team_members TO leadwolf_admin;


--
-- Name: TABLE teams; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.teams TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.teams TO leadwolf_admin;


--
-- Name: TABLE tenant_auth_policies; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.tenant_auth_policies TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.tenant_auth_policies TO leadwolf_admin;


--
-- Name: TABLE tenant_domains; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.tenant_domains TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.tenant_domains TO leadwolf_admin;


--
-- Name: TABLE tenant_feature_flags; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.tenant_feature_flags TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.tenant_feature_flags TO leadwolf_admin;


--
-- Name: TABLE tenant_members; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.tenant_members TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.tenant_members TO leadwolf_admin;


--
-- Name: TABLE tenant_sso_configs; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.tenant_sso_configs TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.tenant_sso_configs TO leadwolf_admin;


--
-- Name: TABLE tenants; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.tenants TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.tenants TO leadwolf_admin;


--
-- Name: TABLE trusted_devices; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.trusted_devices TO leadwolf_admin;


--
-- Name: TABLE usage_event; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.usage_event TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.usage_event TO leadwolf_admin;


--
-- Name: TABLE usage_event_2026_08; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.usage_event_2026_08 TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.usage_event_2026_08 TO leadwolf_admin;


--
-- Name: TABLE usage_event_2026_09; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.usage_event_2026_09 TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.usage_event_2026_09 TO leadwolf_admin;


--
-- Name: TABLE usage_event_2026_10; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.usage_event_2026_10 TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.usage_event_2026_10 TO leadwolf_admin;


--
-- Name: TABLE usage_event_2026_11; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.usage_event_2026_11 TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.usage_event_2026_11 TO leadwolf_admin;


--
-- Name: TABLE usage_event_default; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.usage_event_default TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.usage_event_default TO leadwolf_admin;


--
-- Name: TABLE user_mfa_methods; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.user_mfa_methods TO leadwolf_admin;


--
-- Name: TABLE user_sessions; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.user_sessions TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.user_sessions TO leadwolf_admin;


--
-- Name: TABLE users; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.users TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.users TO leadwolf_admin;


--
-- Name: TABLE validation_rules; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.validation_rules TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.validation_rules TO leadwolf_admin;


--
-- Name: TABLE verification_jobs; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.verification_jobs TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.verification_jobs TO leadwolf_admin;


--
-- Name: TABLE webauthn_credentials; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.webauthn_credentials TO leadwolf_admin;


--
-- Name: TABLE webhook_deliveries; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.webhook_deliveries TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.webhook_deliveries TO leadwolf_admin;


--
-- Name: TABLE webhook_subscriptions; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.webhook_subscriptions TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.webhook_subscriptions TO leadwolf_admin;


--
-- Name: TABLE worker_outbox; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.worker_outbox TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.worker_outbox TO leadwolf_admin;


--
-- Name: TABLE workspace_members; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.workspace_members TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.workspace_members TO leadwolf_admin;


--
-- Name: TABLE workspaces; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.workspaces TO leadwolf_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.workspaces TO leadwolf_admin;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: forge; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA forge GRANT SELECT,USAGE ON SEQUENCES TO leadwolf_forge;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: forge; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA forge GRANT SELECT,INSERT,DELETE,UPDATE ON TABLES TO leadwolf_forge;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT,USAGE ON SEQUENCES TO leadwolf_app;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT,INSERT,DELETE,UPDATE ON TABLES TO leadwolf_app;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT,INSERT,DELETE,UPDATE ON TABLES TO leadwolf_admin;


--
-- PostgreSQL database dump complete
--


INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (1, '91b17f652d490dda42c9f5e0baef7129525ab9885fdcbd6e24ab21417e6e6dae', 1781474524318);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (2, 'c4e1a42d3b47af7867938321aca3ae0898e299432fcfb10142d6bc0f6e12a214', 1781610856824);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (3, 'a443fae3e282f3114d5e3e7af56969b4cb1ed50014a9f30b3f10a4e10d479188', 1781685995251);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (4, 'd605262aafc73654ea596b6a1b8049066e8a11978d17dd7e0f675c4eaf92a52d', 1781789512248);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (5, 'ea2e422a4f92ab3bb037a3f11952732a47c6fcceb3fa25252c5c8565249c38bf', 1782080927315);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (6, 'b5ddf2f64fa8c5645a0b0d48c28d296c67e6bcf04732e497f49567d9075722c2', 1782113776580);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (7, '26bbd86139be74f8665c1290bc891d7469179fca65aa0acac9f2977fe243a979', 1782194518804);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (8, 'b7c10683d11a48055710157915f578e96da73bab59e192974e3ff7b1472984b1', 1782195578530);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (9, 'f74a8a2eb55729117d2813587a59b4a2df668fe2e62faabc2d4b9ec486e0074c', 1782198320200);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (10, '11c37d1ff031ab1869415719e3cde16707b3e15595c5bb474e1aa5454cebcfa3', 1782217851248);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (11, '0191526dc7e01236f3ca1ef7768fa4ffb0d2d8ceedd4beb9f48170de7767566e', 1782219006682);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (12, '29e4e565b5005401d8438b9a8997df1ff2c84bf62bb0ac4f509167682f8cb034', 1782233431765);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (13, '6bd9e3bac329e3c61916f5686d22fa07afcf9943e83740022631593d467deb44', 1782295144431);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (14, '62e405155c655599c062ead4bb95d08c8c27e9ff19cce0597fe741b081c73427', 1782302823887);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (15, '78c8b6d13f7caf63798ca6f19536a7abcdbf54dae143a67955a2ed7e2f185c3f', 1782340187529);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (16, '926a91c584ef83dd906fa86917249baa830dc346be805132a044f1bf2b24a88f', 1782349876837);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (17, 'a95ef372fb6b6a1a1f5b6fa2c860f07f1676e8f88c40c409dc0e87d8d1ff042c', 1782352354718);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (18, 'cbadd3fc26ed01ac172a938bd31cf37cd646796b7b36f663ee0c2313f07ff3f5', 1782423540267);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (19, 'a44c9c51122721c1d8f52a62d01daba671daa84b52c8572615ae0bcf2428fd31', 1782426590174);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (20, '9e6155fda043ae94bff6373ca25b66a1667c74a91f8f42767c6dcb3d3629c0ef', 1782507523308);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (21, 'f3d5fc28831b8a350fbbf14e8481b0179d9fe9f28dbf91948fcc46382ae50474', 1782509481035);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (22, '7b379fde347b8d014ff12e0b502077184a5f7d71e15ac2f40ff1440f2842e997', 1782526241426);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (23, 'b4c4778ca9f6ac164fab4fa98f1fae8bac733f25cc5f573f0770c798b20c00f4', 1782528241616);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (24, '4df04c1582417050cff09c9a5449be5d5ecf1cbd0b4b56ceaa99a615d5558769', 1782531193124);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (25, '5aa434d09e511e280beb56c095ceba31636d3ccce61b9c49f55635313dd1fad6', 1782532098910);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (26, 'daba9ca6e7e3ab00f3265513ea55f5f25b8843b7c633678aa4c9b5a6f40acde0', 1782533291982);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (27, 'fd3b17ee40a538228c024a560b3d6d6281806a708c304ec7e96ce886ecb796dc', 1782534006277);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (28, '78329fb58e4984886f5914ad57ca4413cdeb8fda78dbb9e7f988d17cb27276cd', 1782536930020);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (29, 'c96973d6ed5b4984f5d618bb494c861f7641d6b98fc1473affd80770498ade9a', 1782538112130);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (30, '0a9044ad82e50f4d14175a38440154fbc97bfec7751ce12db0a9159b73aa32af', 1782577399311);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (31, 'cec537c4d647dc37dbb25693a0aa1e27ec92d4e544013ec3dd83c8e825a7c690', 1782588181690);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (32, 'ada5fb4cf42997ea23bfe7230ad2b8e9575925d3d832006476596f243579e8e3', 1782591829917);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (33, '897d4027bf8a18628e286011aed9a64467eb404677d98442b6d0d047de6d7120', 1782632526254);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (34, '5ef9f331b4f66068722de05be98e718eba5db8deb1dad7a01a9113227df0e90c', 1782700000000);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (35, '8802ade58b24ac7583c4fc86ae7d275dd5fa2dd7300af8a693cdbd7e9edfb0e4', 1782800000000);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (36, 'e6f2c0ba26e41d1e643561849b538a5480cacfe3725bb5b218c172f1de5e5ad1', 1782900000000);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (37, '7790dfa77ffd40582a42a6d5f696f2d3c0f14e241e7222236b7e280cc9a295d2', 1783000000000);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (38, '9c26531846c1f434bdf60a0be9c5b530984bf2247e92d5a3023b3ddca5c8c057', 1783100000000);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (39, '277f19d55f7c8eb7304fb229e421e68b39763ced95f5696ec70c0ebbc9549d80', 1783200000000);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (40, 'cdb50d274de72f1926478472eda7efbdd41d44abb53883069e65b0274dbf7c12', 1783300000000);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (41, '05ca194700b8e04e170a6d6cacf6427b35875dcb70b87b4b854c66c0d7bd68e3', 1783400000000);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (42, '531c7b217977add234d4c089b1c37538d761e19771f562b42e18bfe66350671e', 1783500000000);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (43, '0ca85ff0a305c35688e80a2bd05d3c1749141555359e98456709ff279f5047d1', 1783600000000);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (44, '84e50f9f43c9fdc10c3110d74ba8a1ea2e0c09bcb6b492123bdc35ba45051ba8', 1783700000000);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (45, '0bbddfd9d128a8e29ca4cc2228f94bd8eec26af202c705d5542f5cba88dc669b', 1783800000000);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (46, '5ca2bc672539e7b314674562ec78f33298184a7a019b541b713b7ed7c629cd9b', 1783900000000);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (47, 'c0024add73b72beda38409f3344599953260a7bd3c01e9150090608e14e27054', 1784000000000);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (48, '6167ec45bb17a635789bba42eddc42817e1fc9c769bf090b04468bd1104bc7de', 1784100000000);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (49, 'faca8bc7bf23450509987fcec231b3fe51283155e47fd8051c2b32f960689d85', 1784200000000);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (50, '551845f3099a0874f21d060f2044ff5cba1d47bfd31cbf84f651671ba854136c', 1784300000000);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (51, '034ca05964b8a2719609157f2a76115f6b48bfd3a2402999398ec7e4ccf6d49c', 1784400000000);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (52, '07ae6742c6f04c8a1648de45145deca4a54d2cb6c4a2a339a197daa89f573f0b', 1784500000000);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (53, '235628bbbdc4ed05f3df8b0ad3506f31983e0acc0bad6780d95b09b8342ac6f1', 1784600000000);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (54, '923c2826d49db47d47d427882e58c1acc2d0ea70030d20958f365d7a1bef28b9', 1784700000000);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (55, '427b9f4e834c377b44ab1f0412ea11f6eb46b0cb838e9df46c85e2faf45deae7', 1784800000000);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (56, '7f1ed66c8f84117696bff73dd03a957998d071b49b2084f044427af1b04736cf', 1784900000000);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (57, 'c2de74a68e8a1e59d9a0b8c86ccd0e800e46110170d4816bd4ff518051502ebb', 1785000000000);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (58, '830fab7b209092403d98265f2bc094c8b0853307a59a60d5c3c4a73743490442', 1785100000000);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (59, '7aa70e8917518a1758c53bba683676a4f3f7e8dfa065d786d72b3bdd4835bf92', 1785200000000);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (60, '08ca380075e7bdd29587b67a0d856cabd87f779c986dd8d4a8319888ec4ef7aa', 1785300000000);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (61, '8ca960b6bdddbed24cd6cd1409ab74ce53378ef733c22f790ba15c7800ef8dfa', 1785400000000);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (62, '627b7fabdda1c19de8686f716bcb817f42e6aa35378baa48da75d710fa12f004', 1785500000000);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (63, '9364d93cb7039e48227c95b65bb0e8300af0a2beeb2790f6efcdc725f87c8e3a', 1785600000000);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (64, '5bfefdbd3f9fcb2c151e3b0fb88a91e3232cb6be1d024ee86124586998b71025', 1785700000000);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (65, '27a7e4c5d0f50b7eec2c4795c794071f232c48b4222d2a7187df560b94106eaa', 1785800000000);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (66, '68b900b3c942d0754d809d656224595da0a4e67febf3f84809c717836610dac3', 1785900000000);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (67, '5800d24ccb2248a883861fef577536193ba3c76eada0e8cc0b1fa6213cb58446', 1786000000000);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (68, '2cb6afdc0a7383d2f0ebc177017bb4167ca1e5cd59c36e5e62c31d07d332ef63', 1786100000000);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (69, 'c3fe6ef10cca0a1c7ce3caeee54f87ab0357785dc31963bdaddb7a445d516543', 1786200000000);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (70, '6731c798936b03cb1047d85c47505073a37d510867ddd09408ce0756cc92e5e9', 1786300000000);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (71, '7342e0ae0d99c6092352c5ffcd3c862c9e60c25fc66c53dda346c65a17c2b747', 1786400000000);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (72, '168aaf92a439ac8df8078ea10ecd9ecb4e330fc5c7053dee44a8aa44ee64f118', 1786500000000);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (73, '247573c71348cd4c048cbb86e211189191cc39255a7dd22bccccbd93eae7ea0f', 1786600000000);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (74, '39c13d695d557bb14d2972ca41040b7975cd39c91a0952f3f85e8c5637069f97', 1786700000000);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (75, 'c134d85b26ff0487f12ea179fc38d5e98a88585277c245ba2266109c9a50eeef', 1786800000000);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (76, '692050b54f4812e1fe085a183c4b2b31bfda32f9aef9ecd8d8691f7caf3c9563', 1786900000000);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (77, 'cd1e063c4419da4e4872d01597f6a92b55f13b996470fc0c05c1951938661599', 1787000000000);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (78, 'e41afb6d140606a055e21bcee898d11af6b784baebd64c9af12d6aa88c3c87b3', 1787100000000);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (79, '676dfd5fd7dd2d38bace9d20ef7bcac513c48e80b19037f20a99cbb43616fb76', 1787200000000);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (80, '5a126f54063a7d8f60978e190366f360713fa6426bb1fb244435bbd14d96fccd', 1787300000000);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (81, 'a711fd4d7b1704a5173936f382455fce36c382fd109e6d8c7138dcc7e5a24e8c', 1787400000000);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (82, 'db4a770b67a7a8098aaabb34a988a6d49daa07917de37b032c63e98b41c63ce4', 1787500000000);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (83, '4c2c5c98f1ed870ebeebd772da6fe0ebe6c249c4a5324f28c8ac2d66eb9277e4', 1787600000000);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (84, 'ddbc4961a791b2fc687dbf1357c04ad1002e7855145f23c9bd51e6ce95afdea1', 1785139425015);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (85, '872320a86d4c3d8277555855f583877fc14602598ddbf742f381af1e7556f79d', 1785139425016);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (86, '94ea300d5550d32ea63a7c5359d3b3e4eb658cfea0e485c99bd69782629a8cae', 1785139425017);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (87, 'e7f4190ebe9f867ccf44208f040dc668463e9060cd0d998027863ec3770a15e7', 1785139425018);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (88, '175bcb0eb0fcab910157db75a876f505c7334e86a4714b726752faba1eecac47', 1785229501624);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (89, 'a62421c8ade4c352d4f9de801d93ea53b397e94d730bdb5ab4722a88a26f8789', 1785229501625);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (90, '578f518b3263b463f973cc7d28363de40540a22995ec2307316a912e528a7b50', 1785229501626);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (91, 'a3b9021c4420ba0afc777f54bcfa5ff2eac1161090a985a49f4363c6fed5207d', 1785229501627);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (92, 'b77d056f504ba6f9eac62b24bc5d88a7b6e9be63069322084ab73e57009f47ec', 1785229501628);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (93, '7339d402076ee624e22823a46f7e6e087a5096f2fd28abb1af7a61be768c7eb7', 1785229501629);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (94, 'b8d27511d31cbaa3f2c73f7e3dd2632481fd9209ab6d1c1fa2d473a9263542fb', 1785229501630);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (95, 'f38212b3623fed2d0e5fe6c72c966ec8de9027cce6b37184a6f38d9e8b41dd9e', 1785229501631);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (96, 'c5bf2b7980b20be58e4829d8f27367ac3fdaca270e4be0ee221d338b909d3382', 1785494892871);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (97, '59cb06deec63e85bf290ed32c6abc202f60fdde5aa24257fd9da56e4677ad034', 1785524719135);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (98, '50d21c1f8a653abb4174f8c7a5d5a28370423d796e0525fe3f4853dafb321676', 1785799200000);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (99, 'b770bcd4b64db6eb451bae472647abac8972bb4df9e5c77e2184e97fc0ecd212', 1785830060473);
