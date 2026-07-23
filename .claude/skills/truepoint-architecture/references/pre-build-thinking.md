# Pre-Build Thinking Protocol

> **Contents:** The Reasoning Pass — Source of Truth · Failure Modes · Duplicate
> Prevention · Audit and Change History · Security · Scalability · Monitoring and
> Observability · Rollback · Edge Cases · Assumptions · Misuse · Load Behaviour ·
> Worst Case — then What the Plan Looks Like · Shortcuts Are Bugs

Before writing a single line of code or creating any file, the agent must run
a full reasoning pass. This is not optional and it is not a formality. The
purpose is to surface problems, contradictions, missing context, and risky
assumptions before they are baked into code that is harder to change.

The agent answers every question in this file for itself — silently, through
genuine thinking — then presents a concise summary of what it found and a
proposed plan. The developer reads the plan, confirms or corrects it, and only
then does the agent write code.

**No code before the plan is confirmed.**

> **Where the answers come from.** This pass *asks* the hard questions; other
> skills *answer* them. Scale, queues, caching, tenancy, connection pooling →
> **truepoint-platform**. Data model, ownership/sharing, enrichment, search,
> deletion → **truepoint-data**. Access, IAM, residency, abuse, compliance →
> **truepoint-security**. Don't answer a scalability or tenancy question from
> first principles when a skill already fixes the answer — cite it.

---

## The Reasoning Pass

Work through every question below. Some will have short answers. Some will
reveal a problem that changes the entire approach. That is the point — finding
problems here costs nothing. Finding them in code costs a refactor.

Do not skip questions because they seem irrelevant. If a question genuinely
does not apply, write why in one sentence. That sentence is itself useful
information.

---

### Source of Truth

What is the single authoritative source for this data or state?

If two places claim to own the same piece of state, there will be sync bugs.
Find the one true owner before building anything. For UI state, it is usually
a hook or a query cache. For server state, it is a database table. For derived
state, name the thing it derives from.

Questions to answer:
- Where does this data live? (database table, cache, local state, query param)
- Who can write to it? Who reads from it?
- If two systems hold a copy, which one wins on conflict?
- Is there an existing owner already, or are we creating a new one?

---

### Failure Modes

What can go wrong, and what does the system do when each thing fails?

Agents that skip this build features that work in the happy path and break
silently in production. Every external call, every mutation, every async
operation has a failure mode.

Questions to answer:
- What happens if the API call fails? (network error, 4xx, 5xx, timeout)
- What happens if the user loses connection mid-operation?
- What happens if the data is in an unexpected shape?
- What happens if a required dependency (auth service, enrichment API) is down?
- Does the UI show the user a useful error, or does it silently break?
- Is the failure recoverable without user action? If yes, how does recovery work?

For every mutation: is it idempotent? Can the user safely retry it? If not,
what prevents a double-write?

---

### Duplicate Prevention

How do we ensure the same record is not created twice?

Users double-click. Networks retry. Queues re-deliver. The optimistic UI fires
before the server confirms. Any of these produces duplicates unless the system
is designed to prevent them.

Questions to answer:
- Is there a unique constraint at the database level?
- Does the mutation use an idempotency key?
- Does the UI disable the trigger button after the first fire?
- If a background job creates records, does it check for existing records first?
- What is the de-duplication key? (email, external ID, composite key)

---

### Audit and Change History

How do we know what happened, who did it, and when?

This applies to every mutation on data that matters to ops, compliance, or
support. "We can add audit logs later" is always more expensive than adding
them now.

Questions to answer:
- Does every write carry `actorId`, `timestamp`, and `action` metadata?
- Is there an audit log table or event stream this mutation must write to?
- Can support reconstruct the full history of a record from audit data alone?
- Are audit writes in the same transaction as the mutation, or fire-and-forget?
  (fire-and-forget means audit can be lost on failure — know which you're choosing)

---

### Security

What could a bad actor do with this feature, and how do we prevent it?

These are the thinking prompts; the `truepoint-security` skill is how you answer
each one correctly. If the task touches data, identity, input, secrets, or
external systems, read that skill — its threat checklist maps directly onto these
questions.

Questions to answer:
- Can a user access another user's data by guessing or incrementing an ID?
  (Always filter by `tenant_id`/`workspace_id` on every query — never trust a client-supplied ID alone)
- Is every API route protected by the auth middleware?
- Are we exposing fields the caller should not see? (strip server-only fields before sending)
- Is there rate limiting on this endpoint? (especially login, search, enrichment, exports)
- Does the UI accept any user-supplied content that gets rendered or stored?
  If yes, is it sanitised before storage and escaped before render?
- Can a user trigger expensive operations (enrichment, bulk export, search) in a tight loop?
- Does this make any outbound request from a user-influenced URL? (SSRF — enrichment)
- Could any secret reach the client bundle, logs, or git?

---

### Scalability

What breaks first under load, and when?

Questions to answer:
- How many records does this query return? Is there pagination?
- Is there a database query that will slow down as the table grows?
  (full table scans, missing indexes, N+1 queries)
- Does this feature make one API call or N calls in a loop?
  If N calls: is there a batch endpoint, or does it need a queue?
- What is the expected volume at 10x current usage?
- Does this write path need to be async to avoid blocking the response?

---

### Monitoring and Observability

How will we know when this feature is broken in production?

A feature without observability is invisible. When something goes wrong, the
first question is always "how long has this been broken?" — and without
monitoring, the answer is "we don't know."

Questions to answer:
- What analytics event fires on the primary success path?
- What is the error logged when this feature fails? Is it structured enough
  to alert on?
- Is there a metric or dashboard that would show an unexpected drop in usage?
- For async jobs: is there a way to see how many are pending, running, failed?
- What is the on-call runbook entry for this feature? (even one sentence)

---

### Rollback

If this feature causes a production incident, how do we turn it off without
a code deploy?

Questions to answer:
- Is there a feature flag that can disable this at runtime?
- If this writes to a database, is the migration reversible?
  (always write down migrations; always write up migrations)
- If this deploys a new API route, can we remove traffic from it without
  taking down the whole service?
- Is there a rollback plan documented before the deploy, not after the incident?

---

### Edge Cases

What inputs or states are we not handling?

Questions to answer:
- What happens with empty data? (empty list, zero results, null fields)
- What happens with the maximum volume? (10,000 records, 1MB payload)
- What happens if the user is mid-flow and their session expires?
- What happens if two users edit the same record simultaneously?
- What happens if a required field arrives as `null` or `undefined`?
- What happens if an enum value is one we don't recognise?
  (future-proof: always handle the default/unknown case)
- What happens on slow connections? (partial loads, race conditions between
  sequential fetches)

---

### Assumptions

What are we treating as true that we have not verified?

Every codebase has hidden assumptions. Making them explicit is how you find
the ones that are wrong.

Questions to answer:
- What do we assume about the data shape from the API? Is this documented?
- What do we assume about user behaviour? (e.g. "users will only have one
  active session" — is this enforced or just hoped for?)
- What do we assume about the infrastructure? (e.g. "this runs in a single
  region" — does it? Will it always?)
- What do we assume about volume? (e.g. "a list will never exceed 10,000 members")
- Write the assumption down as a comment if it is load-bearing:
  `// ASSUMES: one org per user — update if multi-org is added`

---

### Misuse

What happens if a user does something unexpected but technically valid?

Questions to answer:
- Can a user create an unreasonably large number of records?
  (e.g. 10,000 lists, 1,000,000 prospects in a single list)
- Can a user craft an input that causes a slow query or expensive operation?
- Can a user upload a file that is too large, the wrong type, or malicious?
- Can a user trigger a notification storm (e.g. add 10,000 prospects and
  fire 10,000 notifications)?
- What are the reasonable limits? Define them and enforce them.

---

### Load Behaviour

What degrades gracefully, and what falls over completely?

Questions to answer:
- Under 10x normal traffic: which component is the bottleneck first?
- Are database connections pooled and bounded?
- Are external API calls rate-limited from our side? (not just theirs)
- Does the frontend make fewer requests as load increases (debounce, cache)
  or more (polling, retry loops)?
- If the queue backs up, does it cause cascading failures elsewhere?

---

### Worst Case

What is the single worst thing that could happen with this feature, and have
we made it recoverable?

This is the last question because it is the most important. Force yourself to
name the scenario, not avoid it.

Examples of worst-case scenarios:
- A bug causes all users' data to be visible to each other
- A mutation runs twice and creates duplicate billing records
- A migration runs and cannot be reversed, corrupting a table
- A background job runs at full capacity and exhausts the database connection pool
- An enrichment loop fires 50,000 external API calls in 30 seconds

For every worst case identified: is it detectable before it completes?
Is it recoverable after it completes? If the answer to both is no, the feature
needs a circuit breaker, a dry-run mode, or a human approval gate before it
can ship.

---

## What the Plan Looks Like

After completing the reasoning pass, the agent produces a plan in this format.
The plan is written before any code. It is shown to the developer before
proceeding.

```
## Plan: [Feature Name]

**What I'm building**
One paragraph. What the feature does, who uses it, what it touches.

**Source of truth**
Where the data lives. Who owns it. How conflicts are resolved.

**Failure handling**
How each failure mode is handled. What the user sees. Whether it is retryable.

**Risk flags**
Anything from the reasoning pass that needs a decision or has no clear answer yet.
Each flag is one line. If there are no flags, say so explicitly.

**Dependencies to wire**
Which items from the dependency wiring checklist apply and how each will be handled.

**Files I will create or modify**
A list. No code yet — just paths and one-line descriptions of what each does.

**What I am NOT doing in this pass**
Explicitly scoped out. Prevents scope creep and makes follow-up tasks clear.
```

The developer confirms the plan or corrects it. Then and only then does the
agent write code.

---

## Shortcuts Are Bugs

The reasoning pass exists because skipping it feels fast but produces slow
outcomes. The features that take longest to fix in production are always the
ones where nobody asked "what happens when this fails?" before writing the code.

A two-minute thinking pass before a one-hour build is not overhead.
It is the build.
