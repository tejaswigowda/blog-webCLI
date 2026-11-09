# The workshop, as an experiment

Two hours, five people, each migrating their own WordPress site. It is five users, an onboarding measurement, and the empirical content of a paper on the construction thesis applied to publishing. It is run to *learn*, so it is instrumented; nobody is rescued before the stall is written down.

**The hypothesis under test:** the fine-grained GitHub token is the binding constraint on adoption. If it is not the blocker, every hour spent on sign-in engineering is an hour spent on the wrong thing, and no further sign-in or onboarding engineering is done until this reports.

## Before

- Each person brings a WordPress site they own (or a copy) and a GitHub account. Nothing else is prepared for them: no pre-made token, no pre-made repository.
- Five observers, one per person, or one observer with a screen recording each (with consent). The observer does **not help**, except to unblock after a stall has been timed out (below).
- A timer per person and a copy of the log below.

## What to record (one row per event)

| field | |
|---|---|
| person, site | an id, not a name |
| clock | wall time of the event, to the second |
| step | `export`, `sign-in`, `token`, `import-sources`, `import-pictures`, `commit`, `pages`, `look`, `live` |
| outcome | `ok`, `stall`, `refusal`, `gave up`, `helped` |
| refusal | the exact refusal code and message the app showed (`bad-token`, `pre-flight`, …) |
| note | what the person said, tried and expected, in their words |

**Time the token step separately.** Start the clock when the person is told they need access; stop it when the app accepts a token and shows their repositories. Record what they tried first (the classic token, the wrong scopes, the wrong repository, an expiry), and whether they used "Sign in with GitHub" if it is configured on the build in use.

**Record every refusal that fires.** The app refuses by name; the names are the data. Copy the code and message verbatim, not a paraphrase, and say whether the person understood it and acted on it.

**Note where each person stalls.** A stall is two minutes with no progress on the same step. Write the step, what the person was looking at, and what ended the stall (found it themselves, read the README, were helped, gave up). After ten minutes a stall is helped and marked `helped`.

## After

Each person: a live address (yes or no), total time from export to live, and three questions asked after, not during:

1. Which step did you think would fail?
2. Which step nearly stopped you?
3. Would you do this to your real site, and what would stop you?

## The result to report

| measure | |
|---|---|
| reached a live site | n of 5 |
| median time, export to live | |
| median time of the token step, and its share of the total | |
| the step with the most stall-minutes | |
| refusals fired, by code, with counts | |
| the stall that ended with "gave up" | |

**Decision rule, written before the workshop:** if the token step is the largest share of stall time for at least three of the five, the hypothesis holds and sign-in work is justified. If it is not, the roadmap changes to whatever the largest stall was (the export, the pre-flight wording, the pictures report, picking a look), and the token work stays frozen.

Five people cannot prove a rate; they can rule an explanation in or out, and they give every refusal a real person's reaction to it.
