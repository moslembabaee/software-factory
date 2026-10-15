# User Journeys v1 — normative
Audience: nontechnical builders and professional developers. One project, one runtime, two presentation modes.

## New project journey
1. State desired outcome in natural language. Never require Git knowledge.
2. Ask only blocking questions; distinguish assumptions from confirmed requirements.
3. Present editable scope: features, explicit exclusions, dependencies, risks, acceptance criteria, estimated cost range and uncertainty.
4. Require approval of scope and budget before billable implementation; record plan version.
5. Execute with status expressed as user-visible capabilities, not execution counts.
6. Provide runnable preview when supported; otherwise state why and provide alternate verification.
7. Collect feedback, generate revision plan and show impact before changing accepted features.
8. Deliver with evidence, ownership, setup instructions, artifact references, and next steps.

## Existing project journey
Import a repository read-only; scan supported tech, dependencies, run instructions and secrets exposure. Produce confidence-labeled inventory, ask for confirmation before modifying. No automatic deployment.

## Interrupted journey
Persist conversation, approvals and active operations. On return show last accepted state, in-flight actions, changed estimates and one clear next action.

## Journey contract
Every screen must answer: what is ready? what is happening? what needs my decision? what will it cost? what can I inspect or undo?

## Failure / edge states
Unknown requirements -> ask question. No repository -> create isolated starter only after consent. Unsupported stack -> explain limitation. Budget exhausted -> pause safely. Agent unavailable -> show recoverable status. Preview unavailable -> offer local instructions. External side effects -> explicitly label non-reversible operations.
