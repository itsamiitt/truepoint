# TruePoint Forge — Research Corpus

> **Purpose.** This is the deduplicated, citation-indexed reference behind the whole TruePoint Forge
> planning suite. Every other doc cites a claim by its `[S#]` number here instead of re-deriving it.
> The corpus is the synthesis + verification output over the 16 web-research workstreams (one theme,
> `ws03 — ETL/ELT orchestration`, returned only a stub and is flagged as a research gap, not a source).
> Rules obeyed: (1) claims that repeat across workstreams are **cited once** at the highest-confidence
> source and reused by `[S#]`; (2) every claim carries a `(confidence)` tag (`high` / `medium` /
> `low-contested`); (3) the five locked Forge architecture decisions each get a CONFIRM / AMEND /
> ESCALATE verdict; (4) every low-contested finding and unresolved disagreement is carried into the
> Open-research-questions register. Locking ADRs for the suite: **ADR-0046** (raw API interception as
> primary capture) and **ADR-0047** (Forge owns ER + versioned master-sync). Current-state TruePoint
> facts are owned by `_context/ecosystem-facts.md`; the frozen vocabulary by `_context/decision-ledger.md`.

---

## Citation index

Numbered, deduplicated by URL. `[S24]` (Confluent Schema Evolution) and `[S64]` (Monte Carlo "What Is
Data Observability") are each shared by two workstreams and cited once. 132 unique sources.

**Sales-intelligence platforms & data business models (ws01)**
- **[S1]** Surfe — Waterfall Data Enrichment guide — https://www.surfe.com/blog/waterfall-data-enrichment-how-intelligent-source-orchestration-maximizes-your-b2b-coverage/
- **[S2]** UpliftGTM — Apollo vs ZoomInfo 2026 — https://www.upliftgtm.com/blog/apollo-vs-zoominfo
- **[S3]** Cleanlist — Apollo vs ZoomInfo benchmark — https://www.cleanlist.ai/blog/2026-03-07-apollo-vs-zoominfo
- **[S4]** ZoomInfo — Our Data — https://www.zoominfo.com/data
- **[S5]** SyncGTM — People Data Labs Review 2026 — https://syncgtm.com/blog/people-data-labs-review
- **[S6]** Cleanlist — 15 Best B2B Data Enrichment Providers (tested on 1,000 leads) — https://www.cleanlist.ai/blog/15-best-b2b-data-enrichment-providers-in-2025-ranked
- **[S7]** Cognism — Diamond Data — https://www.cognism.com/diamond-data
- **[S8]** Cognism — Lusha vs ZoomInfo 2026 — https://www.cognism.com/blog/lusha-vs-zoominfo
- **[S9]** Lantern — Waterfall Enrichment guide — https://withlantern.com/articles/waterfall-enrichment-guide

**Raw API interception, browser capture & legal/ToS/abuse risk (ws02)**
- **[S10]** SPB Privacy World — hiQ settlement / consent-judgment analysis — https://www.privacyworld.blog/2022/12/linkedins-data-scraping-battle-with-hiq-labs-ends-with-proposed-judgment/
- **[S11]** Courthouse News — Meta v. Bright Data ruling — https://www.courthousenews.com/federal-judge-rules-against-meta-in-data-scraping-case/
- **[S12]** Jenner & Block — CFAA / Van Buren client alert — https://www.jenner.com/en/news-insights/publications/client-alert-data-scraping-in-hiq-v-linkedin-the-ninth-circuit-reaffirms-narrow-interpretation-of-cfaa
- **[S13]** DEV Community — Chrome Extension Network Interception (Instagram/Voyager patterns) — https://dev.to/hamdi_laadhari/chrome-extension-network-interception-the-modern-way-to-scrape-instagram-and-beyond-49bl
- **[S14]** Chrome for Developers — Limited Use program policy (official) — https://developer.chrome.com/docs/webstore/program-policies/limited-use
- **[S15]** Chrome for Developers blog — 2026 policy updates — https://developer.chrome.com/blog/cws-policy-updates-2026
- **[S16]** GDPR-info.eu — Article 14 (primary text) — https://gdpr-info.eu/art-14-gdpr/
- **[S17]** Fieldfisher — Data Scraping and Privacy Issues — https://www.fieldfisher.com/en/services/privacy-security-and-information/privacy-security-and-information-law-blog/data-scraping-considering-the-privacy-issues
- **[S18]** Deep Tech Insights (Medium) — GDPR scraping enforcement roundup — https://medium.com/deep-tech-insights/web-scraping-in-2025-the-20-million-gdpr-mistake-you-cant-afford-to-make-07a3ce240f4f
- **[S19]** TechCrunch — Meta drops Bright Data suit — https://techcrunch.com/2024/02/26/meta-drops-lawsuit-against-web-scraping-firm-bright-data-that-sold-millions-of-instagram-records/

**Streaming, CDC & cross-database synchronization (ws04)**
- **[S20]** microservices.io — Transactional Outbox pattern (Chris Richardson) — https://microservices.io/patterns/data/transactional-outbox.html
- **[S21]** Conduktor — Transactional Outbox: Database-Kafka Consistency — https://www.conduktor.io/blog/transactional-outbox-pattern-database-kafka
- **[S22]** Conduktor — Kafka Exactly-Once: Producers + Transactions — https://www.conduktor.io/glossary/exactly-once-semantics-in-kafka
- **[S23]** Strimzi — Exactly-once semantics with Kafka transactions — https://strimzi.io/blog/2023/05/03/kafka-transactions/
- **[S24]** Confluent Documentation — Schema Evolution & Compatibility Types *(shared with ws07)* — https://docs.confluent.io/platform/current/schema-registry/fundamentals/schema-evolution.html
- **[S25]** Airbyte — What is Data Reconciliation — https://airbyte.com/data-engineering-resources/data-reconciliation

**Master data management & golden-record governance (ws05)**
- **[S26]** Informatica MDM Multidomain — About Trust / Trust Settings (official) — https://docs.informatica.com/master-data-management/multidomain-mdm/10-4/configuration-guide/part-4--configuring-the-data-flow/configuring-the-load-process/configuring-trust-for-source-systems/about-trust.html
- **[S27]** Informatica Data Director — Best Version of the Truth and Trust Scores — https://docs.informatica.com/master-data-management/multidomain-mdm/10-3/data-director-user-guide/data-director-with-business-entities/resolving-duplicate-records/resolving-duplicate-records-overview/best-version-of-the-truth-and-trust-scores.html
- **[S28]** Reltio Community — MDM Survivorship best practices — https://community.reltio.com/reltio-best-practices/mdm-survivorship
- **[S29]** Semarchy xDM — Match and Merge documentation — https://www.semarchy.com/doc/semarchy-xdm/xdm/latest/Design/matching/matching.html
- **[S30]** Reltio Glossary — MDM Implementation Styles — https://www.reltio.com/glossary/master-data-management/what-are-mdm-implementation-styles/
- **[S31]** Semarchy — MDM Hub Patterns (Back to Basics) — https://www.semarchy.com/blog/backtobasics-mdm-hub-patterns/
- **[S32]** Tamr — AI-Native vs Rules-Based MDM — https://www.tamr.com/ai-native-vs-traditional-mdm
- **[S33]** Profisee — MDM Survivorship: How to Choose the Right Record — https://profisee.com/blog/mdm-survivorship/
- **[S34]** Data Ladder — Guide to Data Survivorship — https://dataladder.com/guide-to-data-survivorship-how-to-build-the-golden-record/

**Entity resolution & duplicate detection engines (ws06)**
- **[S35]** Splink docs — The Fellegi-Sunter Model (UK MoJ) — https://moj-analytical-services.github.io/splink/topic_guides/theory/fellegi_sunter.html
- **[S36]** Splink docs — Term-frequency adjustments — https://moj-analytical-services.github.io/splink/topic_guides/comparisons/term-frequency.html
- **[S37]** Splink docs — Estimating model parameters / clustering — https://moj-analytical-services.github.io/splink/demos/tutorials/04_Estimating_model_parameters.html
- **[S38]** Splink docs — Predicting results / threshold selection — https://moj-analytical-services.github.io/splink/demos/tutorials/05_Predicting_results.html
- **[S39]** Zingg — Entity Resolution at Scale Part 3: Blocking — https://www.zingg.ai/post/entity-resolution-at-scale-part-3-blocking
- **[S40]** Tilores — Best OSS Entity Resolution Libraries (Splink/Zingg/dedupe) — https://tilores.io/content/best-open-source-entity-resolution-and-record-linkage-libraries-splink-zingg-dedupe-and-when-to-move-beyond-them/
- **[S41]** Senzing — What is Principle-Based Entity Resolution — https://senzing.com/what-is-principle-based-entity-resolution/
- **[S42]** UK Data in Government blog — Splink: fast, accurate, scalable record linkage — https://dataingovernment.blog.gov.uk/2022/09/23/splink-fast-accurate-and-scalable-record-linkage/

**Parser & schema versioning / event-schema registries (ws07)**
- *(Confluent Schema Evolution = **[S24]**, shared)*
- **[S43]** Snowplow Documentation — Versioning schemas (SchemaVer / $supersedes) — https://docs.snowplow.io/docs/fundamentals/schemas/versioning/
- **[S44]** Twilio Segment Docs — Protocols Overview — https://segment.com/docs/protocols/
- **[S45]** Twilio Segment Docs — Customize Schema Controls — https://segment.com/docs/protocols/enforce/schema-configuration/
- **[S46]** getsentry/relay — Sentry event forwarding & ingestion service — https://github.com/getsentry/relay

**AI-assisted structured extraction (LLM) (ws08)**
- **[S47]** Claude Platform Docs — Structured Outputs — https://platform.claude.com/docs/en/build-with-claude/structured-outputs
- **[S48]** google/langextract (GitHub) — https://github.com/google/langextract
- **[S49]** Microsoft Learn — Interpret model accuracy and confidence scores (Doc Intelligence) — https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/concept/accuracy-confidence?view=doc-intel-4.0.0
- **[S50]** MM-JudgeBias (arXiv) — LLM-as-judge bias study — https://arxiv.org/pdf/2604.18164
- **[S51]** Evidently AI — LLM-as-a-judge guide — https://www.evidentlyai.com/llm-guide/llm-as-a-judge
- **[S52]** Instructor docs (Pydantic validation + retries; constrained-decoding ecosystem) — https://python.useinstructor.com/
- **[S53]** Technical deep dive into Google LangExtract (Medium) — https://shubh7.medium.com/a-technical-deep-dive-into-googles-langextract-grounded-visual-and-scalable-information-afb0e7216da0

**Human-in-the-loop verification, labeling & review-tool UX (ws09)**
- **[S54]** Label Studio — Measuring Inter-Annotator Agreement / Build Human Consensus — https://labelstud.io/tutorials/how_to_measure_inter_annotator_agreement_and_build_human_consensus
- **[S55]** CVAT — Annotation Quality Assurance — https://www.cvat.ai/resources/blog/annotation-quality-assurance
- **[S56]** Label Studio — Onboard and Evaluate Annotators — https://labelstud.io/blog/scaling-ai-data-quality-best-practices-for-onboarding-and-evaluating-annotators/
- **[S57]** Opcito — Maker-Checker Implementation Guide for Secure Fintech Systems — https://www.opcito.com/blogs/maker-checker-implementation-guide-for-secure-fintech-systems
- **[S58]** Hevo — Building a Maker-Checker System with Audit Trail — https://medium.com/hevo-data-engineering/building-a-maker-checker-system-with-audit-trail-8dd3ea9bf29d
- **[S59]** High Table — ISO 27001 Annex A 5.3 Segregation of Duties — https://hightable.io/iso-27001-annex-a-5-3-segregation-of-duties/
- **[S60]** Eleken — Bulk Action UX Guidelines — https://www.eleken.co/blog-posts/bulk-actions-ux
- **[S61]** BoldTech — QA & Compliance Retool Review Template — https://blog.boldtech.dev/qa-and-compliance-retool-template/
- **[S62]** Snorkel AI — Scaling Human Preferences (Programmatic Approach) — https://snorkel.ai/blog/scaling-human-preferences-in-ai-snorkel-s-programmatic-approach/

**Data-quality & validation frameworks (ws10)**
- **[S63]** DAMA UK — The Six Primary Dimensions for Data Quality Assessment — https://www.dama-uk.org/resources/the-six-primary-dimensions-for-data-quality-assessment
- **[S64]** Monte Carlo — What Is Data Observability *(shared with ws14)* — https://montecarlo.ai/blog-what-is-data-observability
- **[S65]** Databricks — Anomaly Detection (Unity Catalog) — https://docs.databricks.com/aws/en/data-governance/unity-catalog/data-quality-monitoring/anomaly-detection
- **[S66]** Soda — Data Contracts: Implement and Enforce — https://soda.io/blog/data-contracts-implement-and-enforce-with-soda
- **[S67]** Great Expectations — Checkpoint reference (CreateQuarantineData) — https://docs.greatexpectations.io/docs/0.18/reference/learn/terms/checkpoint/
- **[S68]** dbt Labs — Data Quality Testing — https://www.getdbt.com/blog/data-quality-testing
- **[S69]** Datasumi — Great Expectations, Soda, Deequ, and dbt Tests — https://en.datasumi.com/great-expectations-soda-deequ-and-dbt-tests
- **[S70]** Monte Carlo — Data Contracts Explained — https://montecarlo.ai/blog-data-contracts-explained
- **[S71]** AWS Glue — Data Quality Anomaly Detection — https://docs.aws.amazon.com/glue/latest/dg/data-quality-anomaly-detection.html

**Queue & worker orchestration at scale (ws11)**
- **[S72]** task-queues.com — Queue Fundamentals / DLQ & Poison Messages — https://www.task-queues.com/queue-fundamentals-architecture/dead-letter-queues-poison-messages/
- **[S73]** BullMQ official docs — Retrying failing jobs — https://docs.bullmq.io/guide/retrying-failing-jobs
- **[S74]** OneUptime — Implementing Dead Letter Queues in BullMQ — https://oneuptime.com/blog/post/2026-01-21-bullmq-dead-letter-queue/view
- **[S75]** BullMQ official docs — Deduplication — https://docs.bullmq.io/guide/jobs/deduplication
- **[S76]** Temporal engineering blog — Beyond State Machines — https://temporal.io/blog/temporal-replaces-state-machines-for-distributed-applications
- **[S77]** System Design Series — Sagas, Outbox, Durable Execution (Khurana) — https://medium.com/@sanilkhurana7/system-design-series-the-story-and-present-of-durable-execution-and-how-to-use-it-in-your-52509b94d01e
- **[S78]** BullMQ GitHub Discussion #2018 — KEDA Autoscaler for Bull Workers — https://github.com/taskforcesh/bullmq/discussions/2018
- **[S79]** klippa-app/keda-celery-scaler (KEDA load scaler) — https://github.com/klippa-app/keda-celery-scaler
- **[S80]** Baxchain — Idempotency, Retries, and Dead-Letter Queues — https://baxchain.com/blogs/resilient-event-driven-architecture-idempotency-retries-and-dead-letter-queues/

**Storage substrate & medallion (bronze/silver/gold) modeling (ws12)**
- **[S81]** Microsoft Learn — What is the medallion lakehouse architecture? (Azure Databricks) — https://learn.microsoft.com/en-us/azure/databricks/lakehouse/medallion
- **[S82]** Evan Jones — Postgres large JSON value query performance — https://www.evanjones.ca/postgres-large-json-performance.html
- **[S83]** Snowflake Engineering — Postgres JSONB Columns and TOAST: A Performance Guide — https://www.snowflake.com/en/blog/engineering/postgres-jsonb-columns-and-toast/
- **[S84]** AWS Big Data Blog — Improve operational efficiencies of Apache Iceberg tables on Amazon S3 — https://aws.amazon.com/blogs/big-data/improve-operational-efficiencies-of-apache-iceberg-tables-built-on-amazon-s3-data-lakes/
- **[S85]** Onehouse — Amazon S3 Data Lakes: A Complete Guide — https://www.onehouse.ai/blog/amazon-s3-data-lakes-a-complete-guide
- **[S86]** Dremio — Apache Iceberg vs Delta Lake — https://www.dremio.com/blog/apache-iceberg-vs-delta-lake/

**Audit, data lineage & provenance (ws13)**
- **[S87]** OpenLineage spec — ColumnLineage Dataset Facet — https://openlineage.io/docs/spec/facets/dataset-facets/column_lineage_facet/
- **[S88]** Marquez Project — https://marquezproject.ai/
- **[S89]** W3C PROV-O ontology — https://www.w3.org/TR/prov-o/
- **[S90]** Microsoft Azure Architecture Center — Event Sourcing pattern — https://learn.microsoft.com/en-us/azure/architecture/patterns/event-sourcing
- **[S91]** DesignGurus — tamper-evident audit logs (Merkle trees / hashing) — https://www.designgurus.io/answers/detail/how-do-you-design-tamperevident-audit-logs-merkle-trees-hashing
- **[S92]** Dong et al. — "Data Fusion: Resolving Conflicts from Multiple Sources" (VLDB) — https://research.google.com/pubs/pub41657.html
- **[S93]** Glavic & Dittrich — "Data Provenance: A Categorization of Existing Approaches" — http://cs.iit.edu/~dbgroup/assets/pdfpubls/GD07.pdf
- **[S94]** MarquezProject/marquez (GitHub) — https://github.com/MarquezProject/marquez
- **[S95]** W3C PROV-DM data model — https://www.w3.org/TR/prov-dm/

**Observability & pipeline monitoring (ws14)**
- **[S96]** Monte Carlo — The 5 Pillars of Data Observability — https://www.montecarlodata.com/blog-introducing-the-5-pillars-of-data-observability/
- *(Monte Carlo "What Is Data Observability" = **[S64]**, shared)*
- **[S97]** OpenTelemetry — Traces (official docs) — https://opentelemetry.io/docs/concepts/signals/traces/
- **[S98]** OpenTelemetry — Messaging Spans semantic conventions — https://opentelemetry.io/docs/specs/semconv/messaging/messaging-spans/
- **[S99]** Ope Onikute — Distributed Tracing for Batch Workloads with OpenTelemetry — https://opeonikute.dev/posts/distributed-tracing-for-batch-workloads
- **[S100]** Bigeye — Monte Carlo vs Bigeye feature comparison — https://www.bigeye.com/blog/monte-carlo-vs-bigeye-an-in-depth-feature-comparison
- **[S101]** OneUptime — How to Export BullMQ Metrics to Prometheus — https://oneuptime.com/blog/post/2026-01-21-bullmq-prometheus-metrics/view
- **[S102]** BullMQ — Metrics (official docs) — https://docs.bullmq.io/guide/metrics
- **[S103]** TechTarget — 5 pillars of data observability — https://www.techtarget.com/searchdatamanagement/tip/Pillars-of-data-observability-bolster-data-pipeline

**Deployment, infrastructure & scalability (ws15)**
- **[S104]** KEDA (Kubernetes Event-driven Autoscaling) official site — https://keda.sh/
- **[S105]** OneUptime — Deploying BullMQ Workers on Kubernetes — https://oneuptime.com/blog/post/2026-01-21-bullmq-workers-kubernetes/view
- **[S106]** CloudZero — ECS vs EKS (2026 TCO analyses) — https://www.cloudzero.com/blog/ecs-vs-eks/
- **[S107]** Tech-Insider — ECS vs EKS vs Fargate 2026 — https://tech-insider.org/ecs-vs-eks-vs-fargate-2026/
- **[S108]** AWS Aurora User Guide — Fast failover / High availability — https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/AuroraPostgreSQL.BestPractices.FastFailover.html
- **[S109]** AWS Database Blog — Improve application availability on Amazon Aurora — https://aws.amazon.com/blogs/database/improve-application-availability-on-amazon-aurora/
- **[S110]** AWS Aurora User Guide — Managing connection churn with pooling — https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/AuroraPostgreSQL.BestPractices.connection_pooling.html
- **[S111]** TO THE NEW — RDS Proxy in Production: lessons & limitations — https://www.tothenew.com/blog/rds-proxy-in-production-real-world-lessons-limitations-and-why-we-use-it/
- **[S112]** Argo Rollouts — Concepts & Best Practices — https://argo-rollouts.readthedocs.io/en/stable/best-practices/
- **[S113]** Argo Rollouts — Concepts — https://argo-rollouts.readthedocs.io/en/stable/concepts/
- **[S114]** AWS Database Blog — Highly available PgBouncer + HAProxy with Aurora readers — https://aws.amazon.com/blogs/database/set-up-highly-available-pgbouncer-and-haproxy-with-amazon-aurora-postgresql-readers/

**Security & compliance for an internal data tool (ws16)**
- **[S115]** NIST SP 800-162 — Guide to Attribute-Based Access Control (ABAC) — https://csrc.nist.gov/pubs/sp/800/162/upd2/final
- **[S116]** EDPB — Dutch SA fines Clearview for illegal data collection (2024) — https://www.edpb.europa.eu/news/national-news/2024/dutch-supervisory-authority-imposes-fine-clearview-because-illegal-data_en
- **[S117]** GDPR Article 17 — Right to erasure (gdpr-info.eu / ICO guidance) — https://gdpr-info.eu/art-17-gdpr/
- **[S118]** DPDP Act 2023 Section 7 — Legitimate uses (dpdpa.com) — https://www.dpdpa.com/dpdpa2023/chapter-2/section7.html
- **[S119]** Aembit — SPIFFE vs OAuth: access control for nonhuman identities — https://aembit.io/blog/spiffe-vs-oauth-access-control-nonhuman-identities/
- **[S120]** The Backend Developers — Zero-Trust Service-to-Service Auth in 2026 — https://thebackenddevelopers.substack.com/p/zero-trust-service-to-service-auth
- **[S121]** Konfirmity — SOC 2 Cloud Compliance on AWS (2026) — https://www.konfirmity.com/blog/soc-2-cloud-compliance-on-aws
- **[S122]** Axipro — SOC 2 Encryption Requirements: What Auditors Actually Expect — https://axipro.co/soc-2-encryption-requirements/

**Testing strategy for data pipelines & contracts (ws17)**
- **[S123]** Characterization test — Wikipedia — https://en.wikipedia.org/wiki/Characterization_test
- **[S124]** Parker Landon — Testing Parsers Thoroughly with Property-Based Testing — https://parkerlandon.com/posts/testing-parsers-thoroughly-with-property-based-testing
- **[S125]** MarkTechPost — Property-Based Testing Using Hypothesis (stateful/differential/metamorphic) — https://www.marktechpost.com/2026/04/18/a-coding-guide-for-property-based-testing-using-hypothesis-with-stateful-differential-and-metamorphic-test-design/
- **[S126]** Pact Docs — Introduction — https://docs.pact.io/
- **[S127]** Craig Risi — The Pros and Cons of Using Pact for Contract Testing — https://www.craigrisi.com/post/the-pros-and-cons-of-using-pact-for-contract-testing
- **[S128]** Datafold — Data Diff: Value-Level Differences of Tables — https://www.datafold.com/data-diff/
- **[S129]** Datafold — Best practices for data diffing in CI/CD — https://www.datafold.com/blog/best-practices-for-data-diffing
- **[S130]** Start Data Engineering — Integration Tests for Python Data Pipelines — https://www.startdataengineering.com/post/python-datapipeline-integration-test/
- **[S131]** Autonoma — Test Data Generation: Synthetic, Masked, Branch-Based — https://getautonoma.com/blog/test-data-generation
- **[S132]** IRI — How to Build Realistic but Fake PII — https://www.iri.com/blog/data-protection/how-to-build-realistic-but-fake-pii/

---

## Findings by theme

> Dedup note: where a claim appeared in more than one workstream, it is stated once under its most
> authoritative theme and the same `[S#]` is reused elsewhere. Confidence tags are preserved verbatim
> from the source workstreams. Layer names follow the Decision Ledger:
> `raw_captures → parsed_records → verified_records → (sync) → TruePoint master graph`.

### Sales-intelligence data operations (ws01)
- Waterfall enrichment chains providers in a fixed sequence (cheapest/most-accurate first, fall through on miss); it works because single-source gaps are large but *uncorrelated*, so layering fills more total fields than any one provider. [S1] (high)
- Multi-provider/real-time waterfall beats single-source on freshness *and* accuracy because a stale value in source 1 is caught by source 2/3 — reconciliation across sources is where accuracy is won. [S9] (medium)
- Apollo.io claims ~91% email accuracy, <1% invalid direct phones, a 7-step real-time email verification, a 2M+ contributory network, and auto-refresh on any new data signal (event-driven, not batch). Vendor-reported — treat as a marketing ceiling. [S2] (medium)
- ZoomInfo aggregates ML scanning of ~28M domains/day, third-party partner data on ~95M businesses, a 200,000+-user contributory network, and 300+ in-house researchers doing NLP/AI validation — four parallel ingestion sources plus a human-verification tier. [S3] (medium)
- ZoomInfo brands itself the "golden referential dataset": runs dedup to merge records, assigns matched unique identifiers as primary keys, and builds parent/child company hierarchies via **in-house** entity resolution. [S4] (medium)
- People Data Labs is API-first (REST + bulk), claims 3B+ person records / ~90% accuracy, but is criticized for over-trusting LinkedIn (uncorroborated titles) and refreshes its cached dataset only **monthly** — pulled records can already be weeks stale. [S5] (medium)
- B2B contact data decays ~30%/yr (~2.5%/mo), up to ~22.5%/yr for fast segments (SaaS); single-database providers averaged ~82% email accuracy in testing vs higher for multi-source/waterfall. [S6] (medium)
- Cognism "Diamond Data" uses human researchers who phone-call mobiles to confirm the right person answers, and screens the DB against DNC/registries in ~15 countries for GDPR/CCPA-compliant, consent-verified records — the highest-trust maker-checker tier plus a per-record compliance gate. [S7] (high)
- The contributory "co-op" network (customers' connected inboxes/CRMs feeding the shared dataset; ZoomInfo 200k+, Apollo 2M+) is a **primary** ingestion source and network-effect moat, distinct from crawling/interception. [S2] (medium)
- Recency is handled by event-driven monitoring, not periodic re-scans: ZoomInfo's Tracker watches contacts for job/title changes and auto-refreshes; Apollo refreshes on any new inbound signal. [S2] (medium)
- Commercial axis: ZoomInfo/Apollo meter access via credits/export limits; Cognism differentiates on unrestricted/credit-free usage and individual-level export. Vendor-framed. [S8] (low-contested)

### ETL / ELT & orchestration (ws03 — research gap)
- **No substantive findings returned.** The workstream that was to cover Airflow/Dagster/Prefect/dbt orchestration, connector frameworks (Airbyte/Fivetran/Meltano), and scheduling/backfill patterns returned only a stub. This is a **known coverage gap** carried into the Open-research-questions register (OQ-R7); the CDC/queue/medallion workstreams partially cover the transport and scheduling concerns, but connector-framework and DAG-orchestration comparison is unresearched. (n/a)

### Streaming, CDC & cross-database synchronization (ws04)
- The dual-write problem (DB write + broker/second-system write as two separate ops) is a fundamental hazard: a crash between the two leaves systems permanently inconsistent; 2PC/distributed transactions are rejected because they tightly couple services to both DB and broker. [S20] (high)
- The transactional outbox writes business rows + an event row in one local ACID transaction, then a separate relay publishes — guaranteeing "messages sent iff the DB transaction commits" and preserving order. [S20] (high)
- The relay has two forms — polling publisher (queries the outbox table) vs transaction-log tailing / CDC (reads the DB log); CDC (e.g. Debezium WAL) is preferred for lower latency and no constant polling load. [S20] (high)
- The relay may publish more than once (crash after publish, before recording success), so outbox/CDC is inherently **at-least-once** and mandates idempotent consumers that dedupe by message ID. [S20] (high)
- Concrete recipe: combine the outbox with a dedicated idempotent-consumer event-ID table, deduped in the **same transaction** as the business write, to approximate exactly-once end-to-end. [S21] (high)
- Kafka exactly-once is built from only two mechanisms — idempotent producers (producer-ID + epoch, monotonic per-partition sequence numbers) and transactions (atomic multi-partition writes + coordinated offset commits); the guarantee holds only within one producer connection and one partition. [S22] (high)
- Kafka EOS costs ~10-20% throughput and a few ms latency vs at-least-once, plus config/ops complexity — for a low-volume verified-record stream the argument for EOS is correctness, not throughput. [S22] (medium)
- Across heterogeneous databases, exactly-once is generally unachievable end-to-end; the practical target is "effectively-once" = at-least-once delivery + idempotent processing (dedup + idempotent upsert). [S23] (medium)
- Schema Registry defines seven compatibility modes (BACKWARD default, +TRANSITIVE variants, FORWARD, FULL, NONE); the mode dictates upgrade order — BACKWARD = upgrade consumers first, FORWARD = producers first, FULL = either order. [S24] (high)
- BACKWARD allows adding optional (defaulted) and deleting fields; FORWARD allows adding and removing optional fields; FULL permits only add/remove of optional-with-default in both directions — additive/optional-with-default is safe; required-field additions and type narrowing are breaking. [S24] (high)
- Periodic reconciliation jobs (hourly/daily) comparing key aggregates or checksums (CRC/MD5) between source and sink, with deterministic key matching, are the recommended safety net to detect CDC drift/loss/corruption. [S25] (medium)
- Idempotent-consumer duplicate suppression = a processed-event-ID table + idempotent upserts (`INSERT … ON CONFLICT`) keyed on a stable business/event key, letting at-least-once converge to a single correct state. [S21] (medium)

### Master data management & golden-record governance (ws05)
- Informatica's trust framework assigns each source-column pair a 0-100 trust level with a time-based **decay curve** (linear / slow-initial / rapid-initial) plus syntax validation; the highest-trust value survives into the Best Version of Truth, and trust gates whether a source update may overwrite the master. [S26] (high)
- Survivorship is computed at the **cell/attribute** level (BVT), so a golden record assembles its strongest fields from different source records rather than picking one whole winning record. [S27] (high)
- Reltio resolves survivorship per-attribute into an Operational Value, **defaults to Recency** when no rule is defined, and supports per-role survivorship groups — but recency-default is a footgun (a stale-but-authoritative source can be overwritten by a fresh low-quality one). [S28] (medium)
- Semarchy scores each candidate pair (exact=100, fuzzy name>85% + address>65% ≈85, weak partials ≈20), auto-merges above a threshold, and drops below-threshold pairs into steward review — a concrete two-threshold (auto-merge / review / no-match) design. [S29] (high)
- Semarchy computes golden records via two-tier survivorship (a Consolidation Rule + an Override Rule where steward-entered values win) and treats **unmerge/split as a manual steward action**, not automatic. [S29] (high)
- The four MDM implementation styles trade cost vs control: Registry (read-only algorithmic golden records, sources unchanged), Consolidation (+ human steward correction), Coexistence (+ loopback writes mastered values back to sources), Centralized (authored at the hub). [S30] (high)
- Match-merge (repository) style physically consolidates duplicates into a stored golden record and can push it back to sources; registry style keeps data distributed and only maintains cross-reference links — registry is cheaper but **cannot be the authoritative write master**. [S31] (high)
- Tamr argues deterministic hand-written match rules fail at scale on accuracy/cost and advocates a probabilistic/ML + select-deterministic hybrid; in both, confidence thresholds auto-merge and route uncertain pairs to human review that feeds back as training labels. Vendor-contested (Tamr sells ML). [S32] (medium)
- Survivorship should rank source systems by reliability (authority wins on conflict) blended with completeness, standardization, and validation quality — the highest-quality value can survive even when not the newest. [S33] (high)
- Semarchy assigns merge groups explicit confirmation states (Not/Partially/Previously/Confirmed) so steward confirmation is durable and distinguishes machine-proposed from human-ratified groupings. [S29] (high)
- Golden-record construction is a per-attribute mix of strategies — source priority/authority, most-recent (LUD), most-frequent (voting), longest/most-complete, aggregation — not a single global rule. [S34] (medium)
- Consolidation/coexistence styles explicitly interpose a data-steward review layer where algorithm-flagged / below-threshold records are corrected before becoming golden — automated matching + human stewardship (maker-checker) is the industry-standard governance model. [S30] (high)

### Entity resolution & duplicate detection (ws06)
- The Fellegi-Sunter model scores each pair as additive log2 "bits of evidence": match weight = `log2(λ/(1-λ)) + Σ log2(m_i/u_i)`, then probability = `2^w/(1+2^w)` (w=0→0.5, w=4→~0.95, w=7→~0.99). This is the math Forge's ER engine implements. [S35] (high)
- Basic Fellegi-Sunter is distorted by skewed value distributions, so a per-value **term-frequency adjustment** is mandatory: rare surnames get a match-weight bonus, common ones a penalty (TF corrects `u`, computed from the data without EM) — without it, common-name matches over-score. [S36] (high)
- Match weights (m, u) are trainable **unsupervised via Expectation-Maximization** (no labeled corpus), and pairwise predictions collapse into entity clusters via connected-components. [S37] (high)
- The match-weight threshold is the single precision/recall knob (raise = fewer false merges, lower = fewer missed dupes); clusters are cut at a chosen threshold — supporting a two-threshold design (auto-merge high / auto-reject low / human review between). [S38] (high)
- Blocking is mandatory to beat O(n²): group records into candidate buckets (surname prefix, phonetic/Soundex, postcode prefix, email domain, combined keys) and **UNION multiple keys (OR)** rather than intersect, to protect recall. [S39] (high)
- Effective blocking reduces comparisons to ~0.05-1% of the full cartesian product (reported Zingg runtimes: 120k in 5 min/4 cores; 9M in 45 min/96 cores; 80M in <2 hrs). Vendor-reported scale envelope. [S39] (medium)
- Over-permissive blocking silently kills quality (misses true matches or explodes block size), so a block-size-distribution diagnostic (sample the largest blocks) should gate any blocking model before production. [S39] (high)
- Active-learning ER (Zingg, dedupe.io) reaches high accuracy from ~30-50 human-labeled Match/Non-Match pairs by targeting the most ambiguous pairs; reviewer decisions are written back for retraining and audit. [S40] (high)
- Tool choice is scale-driven: dedupe.io <~1M; Zingg/Splink ~1-100M+ (Splink via DuckDB locally, Spark/Athena/Postgres beyond); 100M+ shifts toward graph methods / dedicated engines — validating a Splink-style Fellegi-Sunter build for Forge's band. [S40] (medium)
- Senzing "principle-based" ER: attributes carry expected behaviors (frequency, exclusivity, stability — SSN exclusive, DOB high-frequency) and the engine ships pre-configured needing no training; maps closely to what m/u + TF encode probabilistically. [S41] (high)
- Senzing detects "generic" values (an SSN shared by many) in real time, demotes them, and **re-evaluates all prior records already resolved on that value** without a reload — arguing ER must be incremental/re-opening, not forward-only batch. [S41] (high)
- Log base 2 makes each field's contribution readable as a "bits of evidence" waterfall, which is what makes probabilistic merge decisions **auditable/explainable** to reviewers (and defensible for DSAR/audit). [S42] (high)

### Parser & schema versioning (ws07)
- Confluent's seven compatibility types (BACKWARD default …); non-transitive modes check only the immediately previous version, TRANSITIVE modes verify against **all** prior versions — TRANSITIVE matters when replaying old raw through a new parser so the new version stays valid against full history. [S24] (high)
- Compatibility rules are mechanical and map to parser deploy ordering: a new parser (consumer of raw) should be BACKWARD-compatible so it can roll out ahead of any source/producer change. [S24] (high)
- Kafka Streams apps support **only** BACKWARD, forcing the stream/transform stage to upgrade before upstream producers — the transform layer's compatibility constraint can be stricter than the registry default. [S24] (high)
- Snowplow Iglu versions every schema with **SchemaVer** (MODEL-REVISION-ADDITION): MODEL = breaking (can't validate history), REVISION = may break some history, ADDITION = compatible with all history — the version number itself encodes compatibility. [S43] (high)
- Snowplow's `$supersedes` lets a corrected schema version auto-re-validate historical/failed events that failed under an earlier version, emitting a `validation_info` entity (original vs corrected version) — the closest industry analogue to Forge "replay historical raw through a new parser version." [S43] (high)
- Whether a change is breaking is **destination-dependent** (required→optional is breaking in Redshift, non-breaking in Snowflake/BigQuery) — compatibility is defined relative to the consumer, not as an absolute property of the schema. [S43] (high)
- Snowplow treats upstream drift as "failed events": with `additionalProperties:false`, an event with an undefined field is routed to a failed-events stream rather than silently accepted; the fix is a new schema version (or supersede). [S43] (high)
- Iglu pipeline components cache schemas (default 10 min), so publishing/superseding a schema is **not** immediate fleet-wide — parser-version rollout needs a cache-invalidation/propagation story. [S43] (medium)
- Segment Protocols validates every event in real time against a central Tracking Plan; non-matching events generate "violations" surfaced both in aggregate (trends) and in detail (individual resolution). [S44] (high)
- Segment's "Block Event" control drops non-conforming events at source and can forward/quarantine them to a separate source for review, with violation alerting (e.g. Slack) — the quarantine-lane + alert pattern for drift. [S45] (high)
- Segment layers enforcement into tiers (standard JSON-Schema violations vs advanced common-schema controls), enabling graduated strictness / observe-only vs block per source during rollout. [S45] (medium)
- Sentry Relay runs **normalization before filtering/PII-scrubbing/metric-extraction**, and when processing is enabled it fully normalizes then produces onto a Kafka topic rather than forwarding synchronously — establishing stage ordering (normalize → filter/scrub → emit) and decoupling via a durable queue. [S46] (high)

### AI-assisted structured extraction (ws08)
- Anthropic Structured Outputs uses grammar-constrained sampling (schema compiled into a cached grammar, 24h TTL) guaranteeing parse-valid, schema-conformant JSON; invalid output occurs **only** on safety refusal (`stop_reason: refusal`) or truncation (`max_tokens`). GA on Opus 4.5+, Sonnet 4.5+, Haiku 4.5. [S47] (high)
- Claude's grammar schema is materially restricted: `additionalProperties:false`, no numeric/string-length constraints, no recursion, `minItems` only 0/1, hard per-request limits (20 strict tools / 24 optional params / 16 union types); semantic constraints must be enforced by a downstream validator. [S47] (high)
- Grammar/schema constraint guarantees **structure, not correctness** — the model can emit a well-typed hallucinated value, so structured-output success is not evidence the extraction is accurate. [S47] (high)
- Google LangExtract's core reliability mechanism is **source grounding**: every extracted entity/attribute maps to its exact character offset in the source, making each field independently verifiable against the raw input; also uses few-shot schema enforcement, multi-pass recall, and parallel chunking. [S48] (high)
- Azure Document Intelligence emits per-field confidence (0-1) and recommends threshold-gated routing: ≥0.80 straight-through, human review below, ~100% for sensitive data, thresholds calibrated per use case via a pilot. [S49] (high)
- LLMs do not natively produce calibrated confidence — Azure's is a purpose-built model output, not a self-report; industry treats a model's self-declared confidence as unreliable, favoring grounding + validator agreement + judge scores. [S49] (medium)
- LLM-as-judge carries measurable biases — position bias (up to ~75% first-position preference), verbosity bias, self-enhancement bias. [S50] (high)
- LLM-as-judge mitigations: randomize order, hide model identity, instruct how verbosity is scored, run multiple judges/prompts analyzing disagreement; because same-prompt+model runs are approximately reproducible, judges enable A/B and regression detection across versions. [S51] (high)
- Instructor is the dominant portable fallback (Pydantic validation + ≤3 feedback retries appending the validation error) for providers lacking native constrained decoding — strictly weaker than grammar constraint and costs extra round-trips. [S52] (medium)
- Native constrained/grammar decoding for local models exists via vLLM/SGLang (XGrammar/Outlines) and llama.cpp grammars, but runtime coverage is uneven, so JSON-mode tool-calling remains a common fallback. [S52] (medium)
- Structured outputs add cost/latency (injected system prompt raises input tokens; first schema use incurs grammar-compile latency; grammar cached 24h) — but caches invalidate when schema **structure** or tool set changes, so keep extraction schemas stable/versioned. [S47] (high)
- LangExtract (v1.2.0, Apache-2.0, multi-model) names the four canonical LLM-extraction failure modes to guard against: hallucination, schema drift, non-determinism, and lack of source traceability. [S53] (medium)

### Human-in-the-loop verification & review-tool UX (ws09)
- Inter-annotator agreement (IAA) via pairwise agreement is the industry-standard proxy for annotation quality; **low agreement signals ambiguous guidelines or genuine edge cases**, not just careless annotators. [S54] (high)
- Order the review queue **by agreement** so the most uncertain/contentious tasks are reviewed first ("don't boil the ocean") — argues for confidence/disagreement ranking over FIFO. [S54] (high)
- When annotators disagree (with each other or ground truth), **adjudication by a senior expert** producing the single final label is the standard resolution — model a distinct adjudication tier above ordinary checker. [S55] (high)
- Ground-truth / gold-standard "honeypot" tasks seeded into the queue score individual annotator accuracy and drive onboarding/retraining, with real-time per-annotator dashboards. [S56] (high)
- Maker-checker (four-eyes) requires ≥2 distinct individuals per transaction and the initiator can never approve their own request — **segregation of duties enforced at the code level, not just permissions**. [S57] (high)
- In a correct maker-checker system the operation does **not** execute on submission — it sits in an explicit pending state and executes only after checker approval. [S57] (high)
- A tamper-proof audit trail logging maker initiation, checker review, and final decision (timestamps + identities) is core to the pattern and the primary compliance/fraud-investigation evidence artifact. [S58] (high)
- ISO/IEC 27001 Annex A 5.3 formally mandates segregation of duties, giving maker-checker an external compliance basis beyond fintech convention. [S59] (medium)
- Bulk-action UX: support "select all across the filtered set" with an explicit count, reserve confirmation dialogs for destructive/irreversible actions, and offer immediate undo via toast for recoverable ones. [S60] (medium)
- Bulk operations at scale need multi-level async feedback: per-row loading, a succeeded/failed summary, and inline drill-down per failed item (e.g. "180 approved, 20 blocked by dedup conflict"). [S60] (medium)
- Complex multi-step bulk edits favor a wizard flow (select → choose fields → resolve conflicts → review diff → apply) over a single mega-action. [S60] (medium)
- Review/approval console pattern (Retool): a searchable/filterable queue of pending requests + a detail panel showing metadata plus the full before/after diff of what's changing. [S61] (medium)
- A genuine vendor split exists between managed human labeling (Scale AI — SLAs, expert review) and programmatic weak supervision (Snorkel — labeling functions combined by a generative label model), trading labeling-function engineering cost vs human throughput. Snorkel note: Forge's versioned parsers *are* labeling functions. [S62] (low-contested)

### Data-quality & validation (ws10)
- The DAMA-DMBOK six dimensions (accuracy, completeness, consistency, timeliness, validity, uniqueness) are the standard vocabulary; a useful quality **score is a weighted composite** where critical issues (null in a join key) far outweigh cosmetic ones (trailing whitespace) — a flat unweighted score is discouraged. [S63] (high)
- Data observability catches "unknown unknowns" via ML-learned baselines; rule-based testing only covers "known unknowns" — the two are complementary layers, and teams with hundreds of tests still miss failures without observability. [S64] (high)
- Monte Carlo's five pillars: Freshness, Volume (row-count completeness — a drop from millions to thousands flags an issue), Schema (structural changes + who/when), Quality (null %, unique distribution, in-range), Lineage. [S64] (high)
- Databricks builds a **per-table** model from commit history to predict next-commit time (freshness) and expected row-count range (completeness), flagging out-of-bounds tables with data-driven (not fixed) thresholds; tables get status classes (Healthy/Unhealthy/Training/…), and a "Training" warm-up state is a real design consideration for new tables. [S65] (high)
- Databricks uses "intelligent scanning" to prioritize anomaly checks on high-impact tables by popularity/downstream usage rather than monitoring every table equally — tier monitoring by criticality. [S65] (high)
- Enforcement is tiered by criticality: "warn only" (log + alert) for less-critical data vs "hard fail" (stop downstream) for Tier 1, with contract violations also blocking PRs in CI/CD. [S66] (high)
- Great Expectations supports quarantining failing records via `CreateQuarantineData` in a Checkpoint's action_list — segregating failures for investigation rather than discarding them. [S67] (high)
- At ingestion, validate schemas/required fields/reference values **early** and reject-or-quarantine at the boundary ("so bad data doesn't become normal") — shift-left rather than clean downstream. [S68] (high)
- Data contracts formalize producer/consumer expectations across schema (types, nullability), dataset-level rules (row-count, uniqueness-across-field-combinations, freshness SLAs), and column-level rules (valid value sets, ranges, format/pattern) — uniqueness-across-combinations ties directly into dedup/merge. [S66] (high)
- The prevailing 2025-26 stack is a division of labor: dbt tests for in-transformation checks, Great Expectations for rigorous ingestion/critical-asset validation, Soda for continuous production monitoring — teams combine tools rather than pick one. [S69] (medium)
- Contracts and observability are complementary: contracts prevent structural/rule breaks; observability catches freshness/volume/distribution **drift** — run both. [S70] (medium)
- AWS Glue Data Quality provides learned-baseline anomaly detection (completeness, freshness) per table — confirming learned-baseline anomaly detection is now commodity across AWS, Databricks, and Monte Carlo. [S71] (medium)

### Queue & worker orchestration (ws11)
- End-to-end exactly-once is generally impractical (the ack confirming delivery can itself be lost), so at-least-once is the production default for BullMQ/Sidekiq/Celery/SQS — correctness comes from **idempotent consumers**. [S72] (high)
- BullMQ retries use `attempts` + a backoff strategy (exponential `2^(n-1)*delay`, or fixed; optional jitter; a custom `backoffStrategy` can return 0 to re-queue immediately or -1 to stop). [S73] (high)
- BullMQ has **no built-in DLQ**: exhausted jobs land in the `failed` set, so a DLQ must be hand-built (move payload to a parking queue on final failure), with 3-5 attempts + exponential backoff as a practical start. [S74] (high)
- BullMQ counts a job failed on processor throw or on "stalled" (lock not renewed because the worker crashed/blocked the event loop) beyond `maxStalledCount`; stalled jobs auto-re-add — itself a source of duplicate execution (long AI calls can trip the stall detector; tune `lockDuration`). [S73] (high)
- BullMQ supports native dedup/idempotent enqueue: adding a job with an existing custom `jobId`/dedup id is ignored while present — an idempotency key at the producer boundary (use raw-payload hash as jobId). [S75] (medium)
- Temporal gives **exactly-once workflow orchestration** and **at-least-once activities** via an append-only event history + deterministic replay that resumes a crashed workflow where it stopped without locks/checkpoints — so any Anthropic call or external write inside an activity must be idempotent. [S76] (high)
- Temporal's server mediates every step so only one worker executes a given task, eliminating the need to build your own locking/leader-election. [S76] (high)
- The saga pattern (long-running transaction with compensating undo, no held locks) is the standard multi-service consistency mechanism; Temporal collapses saga bookkeeping into ordinary try/catch — Forge's raw→parsed→verified→production advancement with rollback on downstream reject is a saga. [S77] (medium)
- KEDA autoscales workers on queue depth (Redis `listLength` on `bull:<queue>:wait`), including scale-to-zero, unlike CPU-based HPA which is a "silent failure" for growing queues. [S78] (high)
- Scaling purely on queue length lags latency-sensitive work (pods spin up only after backlog forms); prefer a load-based signal ≈ `(active + queued)/workers`. [S79] (medium)
- DLQs implement backpressure + poison-message isolation: a bad message is diverted after an attempt limit to a separate destination for inspection/replay rather than retrying forever or being silently dropped. [S72] (high)
- Resilient event-driven pipelines are the triad of idempotency (dedup keys) + bounded retries with exponential backoff + a DLQ terminal path, treated as one pattern. [S80] (medium)

### Storage substrate & medallion modeling (ws12)
- In the bronze layer, Databricks recommends storing fields as string/VARIANT/binary with **no cleanup/validation**, in original format, appended incrementally, immutable — the single source of truth enabling reprocessing/audit (bronze ≈ `raw_captures`). [S81] (high)
- Databricks explicitly does **not** recommend writing to silver directly from ingestion (schema changes / corrupt records cause failures); silver must be built by reading **from** bronze — validating the versioned-parser stage between `raw_captures` and `parsed_records`. [S81] (high)
- Silver is where dedup, normalization, schema enforcement, null/late/out-of-order handling, and type casting happen, and it must retain ≥1 validated non-aggregated representation per record (aggregation deferred to gold). [S81] (high)
- Postgres JSONB queries degrade **2-10×** once a value exceeds the ~2,032-byte TOAST threshold (externally-TOASTed ~5× slower, compressed ~2× slower) — pushes large raw payloads to object storage; pull hot/queryable keys into real columns. [S82] (high)
- TOAST was not designed for updates — updating an out-of-line value rewrites the entire value, making large JSONB cheap to append but expensive to mutate (supports append-only, write-once `raw_captures`). [S83] (high)
- Iceberg-on-S3 supports write/delete object tagging; with `s3.delete-enabled=false` it tags "deleted" objects so an S3 lifecycle policy transitions them to Glacier Instant Retrieval (up to ~68% cheaper) — a concrete hot/cold tiering + retention mechanism. [S84] (high)
- Iceberg's `ObjectStoreLocationProvider` appends a deterministic hash prefix to data-file paths to spread writes across S3 prefixes and avoid request-rate throttling on high-volume/bursty ingestion. [S84] (high)
- Busy append-only Iceberg/Delta tables accumulate thousands of snapshots and millions of small files; **snapshot expiration + compaction + orphan-file cleanup are mandatory maintenance**, not optional. [S84] (high)
- AWS S3 Tables provide fully managed Iceberg with automatic compaction/snapshot management/orphan cleanup, claiming up to 3× faster queries and 10× higher TPS vs self-managed. Vendor claim, single source. [S85] (medium)
- Iceberg is a vendor-neutral spec (multi-engine concurrent read/write; ~2-5s manifest-pruned planning on a 500k-file table vs Delta's ~8-15s log replay per cited benchmark); Delta is tightest to Spark with strongest streaming. Vendors disagree — pick Iceberg for engine-neutrality, Delta for Spark/streaming. [S86] (low-contested)
- Gold is highly aggregated / dimensionally modeled for serving (often materialized views); large historical detail stays in silver — maps to Forge syncing `verified_records` into the production CRM master graph (serving tier) while detail history stays in the verified/silver tier. [S81] (high)
- Ingestion cadence is an explicit cost/latency lever: continuous streaming (higher cost, lower latency) vs triggered incremental vs batch partition-overwrite (lowest cost, requires datetime partitioning) — datetime-partitioning `raw_captures` enables cheap batch reprocessing. [S81] (high)

### Audit, lineage & provenance (ws13)
- OpenLineage's ColumnLineage facet records, per output column, an `inputFields` array + a `transformations` list carrying type (DIRECT|INDIRECT), subtype (IDENTITY/AGGREGATION/JOIN/FILTER/…), a description, and a **`masking` boolean** flagging obfuscated/PII-derived values — an adoptable schema for field-level provenance across `raw_captures→parsed_records→verified_records`. [S87] (high)
- OpenLineage models pipelines as Run/Job/Dataset with RunEvents at START/COMPLETE/FAIL plus extensible facets; column lineage travels in the COMPLETE event and is simply omitted when uncollectable (graceful degradation) — custom facets can carry parser-version, AI-model-id, and verifier identity without forking. [S87] (high)
- Marquez is the LF AI & Data reference OpenLineage backend (a Postgres metadata service + lineage-graph API/UI for governance, root-cause, backfills) — a build-vs-adopt option for the lineage store. [S88] (high)
- W3C PROV defines Entity / Activity / Agent with `wasDerivedFrom` and subtypes `wasRevisionOf`, `wasQuotedFrom`, **`hadPrimarySource`** — the last maps exactly onto raw-interception-primary (a verified field asserts `hadPrimarySource` → the intercepted raw API response); Agent distinguishes AI-extractor vs human maker/checker. [S89] (high)
- Event sourcing stores every change as an immutable append-only event sequence that is the authoritative source of truth; state is re-derived by replay, and the only sanctioned undo is a **compensating event** — validating the medallion layers as replayable append-only projections with free time-travel/rebuild. [S90] (high)
- Tamper-evident audit logs use hash-chaining (verify the whole prefix) or Merkle trees (O(log n) inclusion + consistency proofs, as in Certificate Transparency); tamper-evidence **only holds if the Merkle root is externally anchored** somewhere hard to rewrite. Append-only alone is not tamper-evident. [S91] (high)
- Deciding which source's value "wins" a field is the data-fusion / truth-discovery problem: leading methods **jointly estimate source trustworthiness and value truthfulness** rather than naive majority vote (many low-quality/copying sources can be wrong together). [S92] (high)
- Provenance theory distinguishes why-provenance (all contributing source items) from where-provenance (the concrete origin a value was copied from), recordable at table/column/tuple/subset granularity — field-level "which source won" is cell-granularity where-provenance. [S93] (medium)
- OpenLineage separates per-output-column lineage from dataset-level lineage capturing input columns that affected the output **indirectly** (ORDER BY / filter predicates) — Forge should model both value-flow fields and selection/dedup-influencing fields (confidence score, match key). [S87] (high)
- Marquez exposes lineage via a queryable API explicitly for automating backfills and root-cause by traversing the run/dataset graph — to rebuild verified golden records after a parser bug, traverse lineage and re-run only impacted runs. [S94] (high)
- PROV's `wasDerivedFrom` can be asserted between entities without an explicit Activity (it infers one), enabling lightweight lineage links where the transform isn't fully instrumented — supports incremental provenance rollout. [S95] (medium)

### Observability & pipeline monitoring (ws14)
- The five-pillar data-observability model (freshness/volume/schema/distribution/lineage) is distinct from and complementary to system observability (metrics/traces/logs over services) — structure data monitors around all five, applied per medallion layer. [S96] (high)
- A data-freshness SLO is a latency-percentile budget (e.g. "95% of change events arrive within 60s of source commit") — a usable template for per-layer freshness SLOs (raw→parsed→verified→production lag). [S64] (medium)
- Message queues break OTel's automatic context propagation, so the producer must inject the W3C `traceparent` into the job payload and the consumer must extract it to continue the trace across async workers. [S97] (high)
- OTel messaging conventions make span **LINKS** (not parent-child) the default producer↔consumer correlation, because a span can have only one parent and links are the only option for batch/fan-out consumption — Forge's parse→verify→merge→sync fan-out should use span links. [S98] (high)
- OTel prescribes span kinds by role — PRODUCER for the send (else CLIENT), CONSUMER for receive/process — with the producer injecting the creation context into the message. [S98] (high)
- Batch tracing injects trace context into a carrier map alongside the payload, but the manual propagation API is poorly documented and vendor-specific — budget engineering time and favor vendor-neutral OTLP export to avoid lock-in. [S99] (medium)
- Monte Carlo learns historical patterns and flags freshness/volume/null anomalies with no preset thresholds, but its broad default coverage produces **high alert volume** that must be tuned. Vendor-authored (Bigeye) — weigh bias, but the alert-fatigue trade-off is corroborated. [S100] (low-contested)
- Bigeye's Autometrics/Autothresholds auto-profile datasets and apply 70+ prebuilt checks with adaptive ML thresholds, favoring configurable metric depth over Monte Carlo's fully-automatic breadth — suggesting Forge can build in-house monitors combining autothresholds with a curated check catalog. [S100] (medium)
- Queue depth is a first-class health signal: monitor BullMQ via Prometheus+Grafana for queue size, job wait time, duration p95/p99, failed-job counts, and retry histograms sized to SLO buckets. [S101] (high)
- For permanently failed jobs, alert when a job **exhausts all retries** (DLQ pattern), not on individual transient failures. [S102] (medium)
- SRE alerting guidance: alert on user-facing symptoms (latency, backlog growth, missing data) rather than every internal cause, to keep alert volume actionable. [S101] (medium)
- Schema + distribution monitors catch upstream structural changes and out-of-range/null shifts — precisely the failure a private-API change + drifting versioned parser produces; parser-drift detection = per-parser-version schema+distribution monitors on the parsed layer, tied to the raw-response fingerprint. [S103] (medium)

### Deployment, infrastructure & scale (ws15)
- KEDA's Redis-list scaler autoscales BullMQ workers on queue depth and to zero when idle (caveat: in BullMQ v4.1.0+ the `:wait` key may be absent for priority-jobs queues, breaking the scaler — validate the trigger key per version). [S104] (high)
- Queue depth is a poor autoscaling signal when job durations vary widely (100ms vs 30s), so KEDA worker deployments must set `terminationGracePeriodSeconds`, liveness/readiness/startup probes, anti-affinity, and resource requests/limits — and consider **per-stage queues** so each scales on a homogeneous job profile. [S105] (medium)
- ECS Fargate is favored below ~10-15 continuously-running containers (2-4 hrs/week ops, no control-plane fee); EKS wins above ~15, and EKS-on-EC2 + Savings Plans + Karpenter + Spot is ~50-65% cheaper than Fargate but needs 6-12 hrs/week ops. EKS unlocks KEDA/Argo/Karpenter that ECS lacks. Vendors disagree on the exact crossover. [S106] (medium)
- EKS Auto Mode (GA Dec 2024) one-click-enables managed Karpenter + AWS-managed compute/networking/storage, narrowing EKS's ops-overhead gap vs Fargate. [S107] (medium)
- Aurora PostgreSQL Multi-AZ (writer + ≥1 cross-AZ reader) gives a 99.99% SLA with failover typically ~30s, reader promotion tiers (0-15), and app connection via cluster/reader endpoints with retry logic. [S108] (high)
- The AWS JDBC Driver cuts failover time by caching cluster topology, and RDS Proxy reduces Aurora Multi-AZ failover times by up to 66% while hiding AZ/restart turbulence. [S109] (high)
- A connection pooler (RDS Proxy or PgBouncer) is the remedy for connection churn: a pgbench test reusing connections processed 9,042 vs 495 transactions in 60s (~18-20× more throughput) — mandatory pooling in front of an RLS Postgres. [S110] (high)
- RDS Proxy (managed, multiplexing, IAM/Secrets-Manager auth) suits elastic ECS/Lambda fleets; PgBouncer sidecars give fine-grained K8s control; RDS Proxy does **not** support Aurora Serverless v2 and adds little for apps already holding long-lived pooled connections — use transaction-mode pooling for RLS-safe reuse. [S111] (medium)
- Progressive delivery: start with blue-green (one version live, instant rollback) and graduate to metric-analysis-driven canaries (Argo Rollouts) that shift a traffic % and auto-promote/rollback on KPIs. [S112] (high)
- Canary/blue-green requires the app to tolerate two versions running in parallel and is for brief rollouts (15-20 min, max 1-2 hrs) — forcing **expand/contract backward-compatible** schema + versioned-parser migrations so old/new workers coexist mid-deploy. [S113] (medium)
- AWS's HA read-scaling reference puts HAProxy + PgBouncer in front of Aurora reader instances to pool read-only connections separately from the writer — supports routing Forge's read-heavy verification/search to readers while writes (golden-record sync) hit the writer. [S114] (high)

### Security & compliance (ws16)
- NIST SP 800-162 defines ABAC (subject/object/action/environment attributes vs Boolean policy); pure RBAC suffers "role explosion" at scale, so most enterprises deploy a **hybrid RBAC+ABAC** model — RBAC roles (ingest/parse/verify/approve/sync) + ABAC conditions for data-sensitivity and tenant/environment. [S115] (high)
- ABAC can express separation-of-duties as a policy comparing a user attribute to a resource-owner attribute (no user may approve their own request) — the exact enforcement primitive for maker-checker at the verified→production gate. [S115] (high)
- The Dutch DPA fined Clearview AI **€30.5M** for scraping images into an aggregated DB with **no Article 6 lawful basis** + processing special-category biometrics (Art 9(1)), and held that a company's own **business interest does not qualify as GDPR "legitimate interest."** [S116] (high)
- Clearview also breached transparency/access (Arts 12, 14, 15) by failing to inform subjects and respond to access requests — an aggregated-PII store with no subject-notice/lookup path is a standalone violation even with a lawful basis. [S116] (high)
- GDPR Article 17 erasure must be "verifiable and irreversible," but regulators accept that immutable backups need not be destroyed if data is put "beyond use" and overwritten within the normal backup-retention cycle — erasure must reach the **raw layer**, with short retention + tombstoning so raw PII ages out of backups. [S117] (high)
- Controllers must respond to a DSAR/erasure request without undue delay and within **one month** — Forge needs a subject-lookup index spanning raw→parsed→verified→production. [S117] (high)
- India's DPDP Act 2023 makes **consent the primary lawful ground** with only a closed Section 7 "legitimate uses" list and **no GDPR-style legitimate-interest balancing test**; the Data Fiduciary remains liable regardless of processor contract — treat India-origin data as highest-restriction (consent-or-not-processable). [S118] (high)
- Zero-trust service-to-service auth splits identity from authorization: SPIFFE issues cryptographic workload identities (X.509/JWT SVIDs — "is this really service X?") while OAuth/OIDC client-credentials answer "can X access Y?", with mTLS securing the channel — authenticate the Forge→CRM sync with mTLS + SPIFFE identity + scoped client-credentials, not a shared static token. [S119] (high)
- Zero-trust practice sets intentionally short certificate lifetimes (~1 day) with automated proactive rotation (SPIRE→Envoy), eliminating long-lived static service secrets. Secondary/opinion source, corroborated by SPIFFE/SPIRE docs. [S120] (medium)
- SOC 2 rests on five Trust Services Criteria (Security, Availability, Processing Integrity, Confidentiality, Privacy); a Type II report evaluates design + operating effectiveness over a 6-12 month window — Processing Integrity maps to parser-versioning + DQ validation. [S121] (medium)
- SOC 2 auditors expect encryption at rest + in transit via centralized KMS (AWS KMS/HSM), at-least-annual key rotation, revocation, **separation of duties between key admins and developers/security**, and audit logging of all key events — envelope encryption (per-record/tenant DEK wrapped by a KMS KEK) satisfies this. [S122] (medium)
- Least-privilege for a data platform requires fine-grained distinct roles + MFA/federated login; the customer retains responsibility for identity/encryption/logging under shared responsibility — Forge DB roles should be per-layer/per-function (raw-writer, parser, verifier-read, sync-reader) so no single role reads raw PII **and** writes production. [S121] (medium)

### Testing strategy for data pipelines & contracts (ws17)
- Golden-master / characterization tests capture the actual current output as a reference file and fail on any unintended change — the standard technique for pinning versioned-parser output before a refactor/version bump (freeze vN output, re-run vN+1 on the same raw fixtures, diff). [S123] (high)
- The canonical parser property test is the roundtrip invariant `parse(prettyPrint(a)) == a` over generated valid ASTs, with shrinking reducing counterexamples to minimal failing cases; trade-off is generator complexity vs coverage. [S124] (medium)
- Hypothesis is the dominant Python PBT library (`@given` + strategies) and supports **differential testing** (two parsers must agree on structured inputs) and metamorphic testing — differential = run old vs new parser on the same intercepted payload and assert equivalence except intended diffs. [S125] (medium)
- Pact is a code-first consumer-driven contract tool: the consumer records expected request/response pairs into a "pact" the provider verifies against, catching mismatches without full integration environments — for `POST /api/v1/master-sync`, the production CRM is the **consumer** and should own the pact. [S126] (high)
- Pact excels at HTTP/REST but has limited native support for gRPC/Kafka/async, needing plugins — reinforces keeping the sync as HTTP-push (cleanly Pact-testable) rather than event-based. [S127] (medium)
- A data diff is a value-level table comparison surfacing exact differing rows/columns, catching regressions row-count/schema-only tests miss; Datafold ships a cloud product and an OSS `data-diff` CLI. [S128] (high)
- Datafold's cross-database diff uses per-key-range hash "fingerprints" to diff across different DB systems efficiently, with sampling giving large speedups (~24× on 1M rows) — practical for diffing golden records against the production CRM after sync (`key_columns` = primary key). [S129] (high)
- Best practice: run data-diff early as a PR gate using "Slim Diff" (only modified models) + SQL filters, and explicitly exclude expected-to-differ columns (timestamps, run metadata) so noise doesn't mask real regressions. [S129] (high)
- For async multi-stage pipelines, replicate external systems with Docker Compose containers + mocking libs (Moto), seed representative fixtures, then assert on the **final output layer** (schema/partitioning/presence) rather than inspecting intermediate stages. [S130] (high)
- Integration-test ROI is maximized by focusing on custom code and skipping framework/third-party-connector internals; multi-source join fixtures are acknowledged expensive — heavily test parsers/dedup/merge and lean on contracts + diff for the sync boundary. [S130] (medium)
- Synthetic test data must preserve referential integrity (same input deterministically maps to the same synthetic output across tables/runs); Faker+factory covers most needs, SDV/Synthea/K2view for relational integrity at scale. [S131] (medium)
- When production data is used for realistic fixtures, it must be masked/tokenized into synthetic equivalents keeping realistic formatting + referential integrity — so any captured-payload fixture must be scrubbed to synthetic PII before entering the test corpus (no live prospect PII in fixtures). [S132] (medium)

---

## Research verdict on locked decisions

Each verdict is CONFIRM (research supports the decision as locked), AMEND (direction holds but research
adds a mandatory change), or ESCALATE (research surfaces an unresolved risk that must go to a
decision-maker before GA). Layer names and decisions per `_context/decision-ledger.md` L2-L5.

### (a) Raw API interception as the PRIMARY ingestion shape (pivot the extension to MAIN-world interception) — **ESCALATE**
The **technique** is confirmed and industry-standard; the **"primary" designation** carries an
unresolved legal/ToS/channel and compliance risk that must be signed off (maps to OQ-2, GA-blocking).
- The MAIN-world monkey-patch of `fetch` + `XMLHttpRequest.prototype`, CustomEvent bridge to the content script, and secret redaction before the process boundary is the current MV3 industry-standard method (Apollo/PhantomBuster/TexAu) — the architecture is sound. [S13] (high)
- But the pro-scraping precedents protect only **logged-out scraping of public data**: Meta v. Bright Data held a ToS breach would exist only if data was scraped **while logged in** (Forge's exact fact pattern), and hiQ lost on contract/trespass/misappropriation with a $500K judgment despite the narrow-CFAA "win." [S11] [S10] (high)
- The industry's actual **primary** ingestion moat is the customer contributory "co-op" network (ZoomInfo 200k+, Apollo 2M+), not interception/crawling — Forge should evaluate a contributory channel as a complement rather than resting on interception as the sole primary. [S2] (medium)
- Compliance is directly adverse: Clearview (€30.5M) shows aggregating scraped PII with no Art 6 basis is penalized and "business interest" ≠ legitimate interest; DPDP §7 has no legitimate-interest escape for India data; GDPR Art 14 imposes a ≤1-month notice duty; the KASPR CNIL fine is on-point for a LinkedIn contact-scraper. [S116] [S118] [S16] [S18] (high/high/high/medium)

### (b) Forge OWNS entity resolution; TruePoint `master_*` becomes a downstream serving projection — **CONFIRM**
Strongly corroborated across MDM, ER, data-fusion, and storage workstreams.
- Match-merge/repository-style MDM (Semarchy, Informatica) is the correct pattern for an authoritative master that **stores and pushes** golden records; a registry-style pointer index cannot be the write master. [S31] (high)
- ZoomInfo, the category leader, runs dedup, matched-unique-ID primary keys, and parent/child hierarchy **in-house** and brands itself the "golden referential dataset" — leaders build ER internally, they do not delegate it. [S4] (medium)
- A transparent, EM-trainable Fellegi-Sunter engine (Splink, UK MoJ) is production-viable at 1-100M+ records with connected-components clustering already matching the verified→production merge step. [S35] [S40] (high/medium)
- *Amendments (mechanics, not direction):* term-frequency adjustment is mandatory [S36]; use two thresholds with a maker-checker grey-zone band [S38]; ship a blocking-size diagnostic [S39]; make ER incremental/re-openable when a generic value is later detected [S41]; select field winners by trustworthiness+truthfulness, not majority vote [S92].

### (c) Sync via HTTP push to a versioned `POST /api/v1/master-sync` with idempotent upsert (reject direct-DB + event-bus-as-primary) — **AMEND**
The transport and idempotent-upsert contract are confirmed; research adds **mandatory mechanism
amendments** the naive "POST after write" reading omits.
- HTTP push is a valid transport and the coexistence-MDM loopback (master values written back to consuming systems) is exactly how authoritative MDM propagates verified golden records; Pact CDC testing fits HTTP/REST cleanly, reinforcing HTTP over event-based. [S30] [S126] (high)
- *Amendment 1 — outbox, not inline POST:* to avoid a dual-write hazard, the "record verified" event must be emitted via a **transactional outbox written in the same transaction** as the verified-record write, with the HTTP push driven by a relay reading that outbox — not a separate post-commit HTTP call. [S20] (high)
- *Amendment 2 — idempotent apply is non-negotiable:* every mainstream queue/outbox is at-least-once, so the `/master-sync` apply MUST be idempotent (dedup/event-ID table + keyed UPSERT on golden-record id + content hash); true exactly-once across the heterogeneous Forge-DB → CRM boundary is unachievable, target effectively-once. [S21] [S23] [S72] (high/medium/high)
- *Amendment 3 — reconciliation + versioned contract:* add a periodic reconciliation/checksum job comparing Forge `verified_records` vs CRM master state [S25], evolve the contract under BACKWARD/FULL compatibility (additive/optional-with-default only) [S24], and instrument the push as an OTel-linked span with retry-exhaustion/DLQ alerting + a freshness SLO (not fire-and-forget) [S98] [S101]. Direct-DB and event-bus-as-primary remain correctly rejected; buffering the internal hop through a durable outbox/queue is **not** event-bus-as-primary. [S46]

### (d) Anthropic Claude for AI-assisted structured extraction — **CONFIRM**
Confirmed as production-grade, with a guardrail amendment about what constrained decoding does *not* buy.
- Claude Structured Outputs is GA (Opus 4.5+/Sonnet 4.5+/Haiku 4.5) with grammar-constrained sampling guaranteeing schema-valid JSON, failing only on refusal/`max_tokens` — production-grade native constrained decoding, not bolt-on. [S47] (high)
- *Guardrail amendment:* grammar constraint guarantees **structure, not correctness** (well-typed hallucinations are possible), so maker-checker + DQ validation remain mandatory layers on top; and confidence for auto-approve routing must derive from source-grounding match + validator agreement + judge score, **not** a model-self-reported confidence field. [S47] [S49] (high/medium)
- Reusable supporting mechanisms: LangExtract-style char-offset **source grounding** to let checkers verify each field against the raw payload [S48]; Azure-style confidence-threshold routing (≥0.80 auto / below → human / ~100% sensitive) [S49]; LLM-as-judge for regression with bias mitigations against a versioned golden set [S51] [S50]; keep schemas stable/versioned to preserve the 24h grammar+prompt cache [S47].

### (e) The four-layer medallion model `raw_captures → parsed_records → verified_records → production` — **CONFIRM**
Corroborated by nearly every workstream (storage, MDM, DQ, lineage, queues, testing, HITL).
- Databricks' bronze (immutable/append-only raw, no cleanup) → silver (dedup/normalize/enforce, retain row-level) → gold (aggregated serving) maps cleanly; the explicit "never ingest directly to silver" rule validates the versioned-parser stage between `raw_captures` and `parsed_records`. [S81] (high)
- The maker-checker "pending state, execute-only-on-approval" pattern maps exactly onto the verified layer as a pending proposal that syncs only after approval; event-sourcing gives the replayable append-only substrate. [S57] [S90] (high)
- *Amendments:* Forge has **four** tiers where classic medallion has three — `verified_records` is a governed sub-tier of silver, "production" is the gold/serving CRM [S81]; default failed records to **quarantine-not-reject** (GX `CreateQuarantineData`) so they feed the maker-checker loop [S67]; score quality as a **weighted** DAMA composite (join-key nulls ≫ cosmetic) [S63]; add an ML anomaly-detection layer over verified/production to catch parser drift that no static rule anticipates [S64]; GDPR Art 17 erasure must reach the raw layer with tombstoning [S117]; store large raw blobs in object storage, not JSONB, past the ~2 kB TOAST cliff [S82].

**Verdict summary:** (a) ESCALATE · (b) CONFIRM · (c) AMEND · (d) CONFIRM · (e) CONFIRM.

---

## Open research questions

Compiled from every low-contested finding and every unresolved cross-workstream disagreement/decision
point. `OQ-R#` are research-register IDs (distinct from the Decision-Ledger `OQ-#`, cross-referenced
where they overlap).

- **OQ-R1 — Interception legal/compliance sign-off (GA-blocking; = Ledger OQ-2, verdict (a)).** Documented per-source Art 6(1)(f) LIA before collection, GDPR Art 14 ≤1-month notice mechanism for EU prospects, DPDP §7 consent posture for India data, and the Clearview/KASPR risk. Needs counsel, not planning. [S116] [S118] [S16] [S17] [S18]
- **OQ-R2 — Chrome Web Store single-purpose declaration + Aug 1 2026 enforcement.** Whether the extension survives Limited Use (reaches derived/aggregated data; bars reselling to "information resellers"), or needs an off-store distribution path. Framing must be single-purpose / user-consent / user's-own-data. [S14] [S15]
- **OQ-R3 — Contributory "co-op" channel as a complement to interception.** The industry's primary moat is contributory data, which Forge's interception-primary model does not center. Add a contributory ingestion channel? [S2]
- **OQ-R4 — Sync relay: polling publisher vs Debezium WAL CDC.** Polling is simpler / no-Kafka / fits the no-Docker coordinator host but higher latency; Debezium is lower latency, more infra. Low-volume verified stream favors correctness over throughput. [S20] [S24]
- **OQ-R5 — Orchestration engine: chained BullMQ (+ hand-built DLQ/saga) vs Temporal durable execution.** Temporal gives exactly-once workflow + server-mediated single-execution (no Redis locks) but is net-new infra; TruePoint already ships BullMQ + outbox + leaderLock. [S76] [S73] [S74]
- **OQ-R6 — Compute topology: ECS Fargate vs EKS (+ EKS Auto Mode).** Committing to KEDA queue-autoscaling biases toward EKS; vendors disagree on the ~15-container crossover. [S106] [S107] [S104]
- **OQ-R7 — ETL/ELT orchestration & connector frameworks (research gap, ws03 stub).** No Airflow/Dagster/Prefect/dbt-orchestration or Airbyte/Fivetran/Meltano connector-framework comparison was returned; unresearched surface for DAG scheduling, backfills, and connector standardization. (n/a)
- **OQ-R8 — Table format for the raw/bronze substrate: Iceberg vs Delta (+ managed S3 Tables).** Vendor-contested; Iceberg for engine-neutrality + S3 tag-based Glacier tiering, Delta for Spark/streaming; overlaps Ledger OQ-4 (object-store-large vs JSONB-small). [S86] [S84] [S85]
- **OQ-R9 — Build vs buy data-quality anomaly detection.** Learned-baseline freshness/volume/null anomaly detection is commodity (Monte Carlo/Bigeye/Databricks/AWS Glue), but none natively understands Forge's raw-response→versioned-parser drift, which likely needs Forge-owned monitors keyed to parser version + raw-response fingerprint. [S64] [S100] [S71] [S103]
- **OQ-R10 — Human-only verification vs weak-supervision auto-verify.** Snorkel-style: treat versioned parsers + AI as labeling functions combined by a consensus/label model to auto-verify high-agreement records and reserve humans for the grey zone — vs human-review-every-record. Contested. [S62]
- **OQ-R11 — Deterministic-rule vs ML/probabilistic ER at scale.** Tamr contends deterministic rules fail at scale on cost/accuracy; capture every maker-checker merge/reject as ER training labels even if v1 stays rule-based. Vendor-contested. [S32] [S40]
- **OQ-R12 — Match-weight thresholds (auto-merge / auto-reject bands) need calibration.** The two-threshold design is confirmed but the actual cutoffs must be tuned on Forge data, with a blocking-size diagnostic gating production. [S38] [S29] [S39]
- **OQ-R13 — AI extraction confidence threshold value.** Azure's ≥0.80 straight-through / ~100% sensitive is a starting template requiring a Forge-specific pilot calibration; do not adopt a fixed number blind. [S49]
- **OQ-R14 — Field-level decay TTL + re-verification policy.** B2B data decays ~30%/yr (~2.5%/mo); "verified" production records need a per-field decay TTL and change-signal-triggered re-verification (rapid-decay for title/company, slow for stable fields), not permanent trust. [S6] [S26] [S2]
- **OQ-R15 — Survivorship default: authority+validation+completeness vs recency.** Reltio defaults to naive recency (a known footgun); Forge should rank source-authority + validation + completeness above recency, per-attribute — but the exact per-field strategy menu needs specifying. [S28] [S33] [S34]
- **OQ-R16 — Parser-version cache-invalidation / staged-rollout mechanism.** Iglu's 10-min cache and Streams' BACKWARD-only constraint show parser changes don't propagate atomically; needs an explicit invalidation + observe-only→block staged rollout plan. [S43] [S45]
- **OQ-R17 — Lineage store: adopt OpenLineage/Marquez vs hand-roll.** Emit OpenLineage RunEvents to a Marquez Postgres backend (reuses the HTTP-push posture) vs a bespoke lineage graph; plus the Merkle-root external-anchoring mechanism for tamper-evidence. [S87] [S88] [S91]
- **OQ-R18 — Service-identity depth: full SPIFFE/SPIRE vs mTLS + scoped service-JWT.** Short-lived (~1-day) auto-rotated workload identity is the target; whether Forge stands up SPIRE or uses mTLS + a client-credentials service JWT (Ledger L5) needs deciding. [S119] [S120]
- **OQ-R19 — Commercial/credit metering model (informational).** Credit-metering vs unlimited/credit-free is the category's core commercial axis; vendor-framed and not architecture-blocking, but relevant if Forge output ever meters downstream. [S8]
- **OQ-R20 — Alert-volume tuning for high-variance interception ingest.** ML anomaly detection over inherently high-variance raw-interception ingest will over-alert unless tuned to user-facing symptoms — a concrete SLO/alerting design task, not a yes/no question. [S100] [S101]
