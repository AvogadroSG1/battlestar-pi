# Joint Brief Howto

## Rules

- **Each Agent MUST write the other side's option.** If you cannot state your counterpart's position in a form they would endorse, you do not yet understand the disagreement.
- **Review Together**: Both Agents read the Join Brief after it's ready for escalation and decide within 4 rounds of communication through the Joint Brief if they discovered a way to move forward without escaltion.
- **Review Status**: During the "Review Together" Phase, the "Status" for each Agent is "Communication" until the rounds have passed.  Then each Agent changes their state to either "Resolved" or "Escalate".
- **Escalation**: If either party "Status" is in "Escalate" status, this goes to Arbitration Agent for decision.
- **Review is a real test.** If both parties "Status" is "Resolved" that ends the brief. Some disputes dissolve while writing the Joint Brief, because they were always about an unstated shared goal. This is a success and we MUST radiate the decision in minimal ODR.
- **Final Report**:  Final decision is maintained in the repo's docs/escalation/ directory.
- **Owner of Final Report**: If the Arbitration Agent decided, it is their responsbility, otherwise it is the orginal agent of escalation's job to own it.

## Arbitration Agent

- This is a Fresh GPT-5.6 Terra High Agent
- They recieve the joint proposal for review.
- They MUST decide based on the joint brief.
- They MUST NOT look through more code.  The Joint Brief is the context.

## Joint Brief Template

```markdown
# Joint Brief {Topic}

## Joint Escalation Brief: {short title}
Agents: {names}  ·  Triggered: {date}  ·  Trigger: {loop exceeded / agent-with-conviction / clock-time}

## 1. The outcome we both want
{Business or user outcome. Both Agents must agree on this sentence.
If you cannot agree here, that IS the dispute. Say so and stop.}

## 2. What we agree on
{Shared facts, data, technical constraints, business parameters.
Longer than you expect. Most disputes are 80% agreement.}

## 3. What horizon each side is optimizing for
- {Agent A}: e.g. 3-month speed to market
- {Agent B}: e.g. 2-year platform scalability
{Mismatched time horizons are the most common hidden cause.}

## 4. The options
**Option A**: path, tradeoffs, risks, who it costs
**Option B**: path, tradeoffs, risks, who it costs
{Each Agent writes the OTHER side's option. Steel man, not straw man.}

## 5. The exact decision needed
{One sentence, phrased as a question with a binary or clearly bounded answer.
"Should we X or Y?" rather than "What should we do about X?"}

## 6. Cost of delay
{What happens if this is not decided this week.}

## 7. Status
- Agent A: {Communication|Resolved|Escalate}
- Agent B: {Communication|Resolved|Escalate}

## 8. Escalation Decision
- **This section MUST ONLY be used by the Arbitration Agent
- Arbitration Decision: {Option}
- Arbitration Reason: {Why}

---

## Communication Ledger

**Format**: During the discussion phase this area is used for communication between the Agents to read if there is: resolution because of learning of a shared goal, or if there are refinements to the other's proposal.  We follow a turn based-structure shown below:

```mermaid
- {Agent Name} - {Question|Suggestion|Issue({blocking|non-blocking})|Praise} {Section Number} {Section Title} - {Comment}
```
