# UI Writing

Words in the interface are design material, not filler. They are the single
fastest thing to get wrong in a way that makes a polished UI feel cheap —
vague buttons, apologetic errors, "Lorem ipsum" left in. Every word a user
reads should help them understand or act.

For brand voice and tone specifics, check `Guidelines/` in the codebase root —
it may define TruePoint's voice. This file covers the mechanics that apply
regardless of brand voice.

---

## Write From the User's Side

Name things by what the user controls and recognises, never by how the system
is built.

- "Notifications," not "webhook config."
- "Owner," not "assigned_user_id."
- "Add prospect," not "Create ProspectEntity."

The user manages contacts and deals and lists — they do not manage rows,
records, or entities. Speak their language, not the schema's.

---

## Buttons and Actions Say What Happens

A button's label is the action it performs, in the imperative.

- "Save changes," not "Submit."
- "Add prospect," not "OK."
- "Delete list," not "Confirm."
- "Send email," not "Go."

The label stays consistent through the flow: the button that says "Publish"
produces a toast that says "Published" — not "Saved" or "Success." Consistent
verbs are how users learn the product's vocabulary.

Avoid clever or cute labels. "Let's do this!" is not a button. Specific and
plain beats clever every time.

---

## Errors Explain and Direct

An error message has two jobs: say what went wrong, and say what to do about it.
It never apologises, never blames the user, and is never vague.

- "Enter a valid email address," not "Invalid input" and not "Oops!"
- "This list name is already taken — choose another," not "Error: duplicate."
- "Couldn't load prospects. Try again." (with a retry) — not "Something went
  wrong" with no recourse.

Errors speak in the interface's voice, plainly. They do not say "we're sorry" —
they tell the user how to move forward. Reserve any genuine apology for actual
service failures, and even then keep it brief and action-oriented.

---

## Empty States Invite Action

An empty screen is an opportunity to direct, not a dead end. Match the copy to
which empty it is (see `interaction.md`):

- First-run: "No prospects yet — add your first to get started." + the action.
- Filtered-to-zero: "No prospects match these filters." + clear-filters.

One line of direction, not a paragraph. Never leave a blank area with no
explanation.

---

## Labels, Hints, and Placeholders Each Do One Job

- **Label**: names the field. Always present. "Email address."
- **Hint** (`FieldGroup` hint): explains a constraint or format when needed.
  "We'll only use this for account notifications."
- **Placeholder**: shows an example of the input, and disappears on typing. It
  is not a substitute for a label — a field whose only label is its placeholder
  is unlabelled the moment the user starts typing, and is inaccessible.

Never make the placeholder do the label's job. Never repeat the label as the
placeholder ("Email" / placeholder "Email") — that is noise.

---

## Tone and Mechanics

- **Sentence case** for everything — labels, buttons, headings, menu items.
  Not Title Case, not ALL CAPS. "Add prospect," not "Add Prospect."
- Plain verbs, no filler. Cut "please," "simply," "just" — they add words
  without meaning.
- Be specific over general. "Saved 3 minutes ago" beats "Saved recently."
- Numbers that update use tabular figures (see `tokens.md`) so they do not
  shift the layout as they change.

---

## Never Ship Filler

- No "Lorem ipsum," no "Test data," no placeholder names like "John Doe" in
  anything that could reach a user or a screenshot.
- Every label, message, and piece of copy is real and considered. If you are
  building a surface and do not know the real copy, that is a question to
  resolve — not a reason to leave a placeholder.

Filler copy makes a design feel as unfinished as a broken layout. The words are
part of the work.
